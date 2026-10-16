// inventory.mjs（静的 HTML）と crawl.mjs（起動中のアプリ）で共通の、inventory.json 組み立て処理。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const LAYOUT = "_layout";
export const FLOWS = "_flows";
export const TYPES = [
  "page", "form", "input", "select", "radio", "checkbox", "switch", "button",
  "toggle", "tab", "menuitem", "action", "link", "external", "state", "flow",
];

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", times: "×", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓", laquo: "«", raquo: "»", hellip: "…", copy: "©", reg: "®", trade: "™",
  middot: "·", bull: "•", ndash: "–", mdash: "—", lsaquo: "‹", rsaquo: "›", yen: "¥", check: "✓",
};
export const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);

// 名前の無い要素（アイコンだけのボタンなど）に付ける名前の材料として使う class。
// 見た目の調整用（余白・色・表示幅など）や汎用の部品名は、その要素を言い当てないので除く
export const GENERIC_CLASS =
  /^(btn|btn-(sm|lg|block|primary|secondary|success|danger|warning|info|light|dark|link|outline-[a-z]+)|form-control|nav-link|nav-item|dropdown-item|dropdown-toggle|active|show|collapsed|disabled|rounded(-[a-z]+)?|shadow(-[a-z]+)?|border(-[a-z0-9]+)?|w-\d+|h-\d+|small|float-[a-z]+|clearfix)$|^([mp][trblxy]?|text|bg|col|font|align|justify|flex|order|gap|row-cols)-/i;
export function classHint(classes) {
  const list = String(classes ?? "").split(/\s+/).filter(Boolean);
  const icon = list.find((c) => /^(fa|fas|far|fab|bi|mdi|icon|material|glyphicon|ti|ri|la)-[a-z]/i.test(c) && !/^fa-(fw|lg|sm|xs|[0-9]x)$/i.test(c));
  if (icon) return icon;
  return list.filter((c) => !GENERIC_CLASS.test(c) && !/\d{3,}/.test(c) && !/^(fa|fas|far|fab|bi|mdi)$/i.test(c)).slice(0, 2).join(".");
}

// ID に使う文字列。長い本文がそのまま ID になると covers に写すときに崩れやすい
export const short = (s) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};

// 画面をまたいで同じ要素かを判定する指紋。連番の key は画面ごとにずれるので使わない。
// ctx（form の中か、active などの状態 class）と buttonType・件数は画面ごとに違ってよく、違いは variations として報告する
const NON_IDENTITY = new Set(["key", "ctx", "buttonType", "repeated", "example", "sig"]);
function signature(el) {
  const f = {};
  for (const [k, v] of Object.entries(el)) if (!NON_IDENTITY.has(k)) f[k] = v;
  if (!/^\d+$/.test(el.key)) f.key = el.key;
  return JSON.stringify(f);
}
const contextOf = (el) => JSON.stringify({ inForm: Boolean(el.ctx?.inForm), state: el.ctx?.state ?? [], buttonType: el.buttonType ?? null });

function assignIds(file, elements) {
  const used = new Set();
  return elements.map(({ key, ...rest }) => {
    const base = `${file}#${rest.type}${key ? `:${key}` : ""}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { id, ...rest, risk: "normal" };
  });
}

// raw: [{ file, title, elements: [{ type, key, ...fields }], ...画面の追加情報 }]
// 半数以上（最低 2）の画面に同じ形で現れる要素を擬似画面 _layout にまとめ、残りに ID を振る。
export function buildPages(raw) {
  const reached = raw.filter((p) => !p.unreached);
  // 同じ画面内の同一要素（モバイル用とデスクトップ用の検索フォームなど）を区別するため、出現順を指紋に足す
  const sigPages = new Map();
  const sigSample = new Map();
  const sigContexts = new Map(); // sig -> Map(context -> [file])
  for (const p of reached) {
    const nth = new Map();
    for (const el of p.elements) {
      if (el.type === "page") continue;
      const s0 = signature(el);
      const n = (nth.get(s0) ?? 0) + 1;
      nth.set(s0, n);
      el.sig = `${s0}#${n}`;
      if (!sigPages.has(el.sig)) sigPages.set(el.sig, new Set());
      sigPages.get(el.sig).add(p.file);
      if (!sigSample.has(el.sig)) sigSample.set(el.sig, el);
      if (!sigContexts.has(el.sig)) sigContexts.set(el.sig, new Map());
      const cm = sigContexts.get(el.sig);
      const c = contextOf(el);
      if (!cm.has(c)) cm.set(c, []);
      cm.get(c).push(p.file);
    }
  }

  const threshold = Math.max(2, Math.ceil(reached.length / 2));
  const layoutSigs = new Set([...sigPages].filter(([, s]) => s.size >= threshold).map(([sig]) => sig));

  const pages = [];
  if (layoutSigs.size > 0) {
    const sharedBy = reached.filter((p) => p.elements.some((e) => layoutSigs.has(e.sig))).map((p) => p.file);
    const els = [...layoutSigs].map((sig) => {
      // 多数派の文脈を基準にし、違う画面だけを variations に残す（例: その画面だけ form の中にあり、押すと送信される）
      const ctxs = [...sigContexts.get(sig)].sort((a, b) => b[1].length - a[1].length);
      const { sig: _s, ctx: _c, buttonType: _b, ...el } = sigSample.get(sig);
      const [main, ...others] = ctxs;
      const mainCtx = JSON.parse(main[0]);
      const out = { ...el, ...(mainCtx.buttonType ? { buttonType: mainCtx.buttonType } : {}), pages: [...sigPages.get(sig)] };
      if (others.length > 0) {
        out.variations = others.map(([c, files]) => {
          const v = JSON.parse(c);
          const differs = {};
          for (const k of Object.keys(v)) if (JSON.stringify(v[k]) !== JSON.stringify(mainCtx[k])) differs[k] = v[k];
          return { pages: files, differs, usual: Object.fromEntries(Object.keys(differs).map((k) => [k, mainCtx[k]])) };
        });
      }
      return out;
    });
    pages.push({ file: LAYOUT, title: "複数画面に共通する部品", sharedBy, elements: assignIds(LAYOUT, els) });
  }
  for (const { elements, ...page } of raw) {
    const own = elements.filter((e) => !layoutSigs.has(e.sig)).map(({ sig: _s, ctx: _c, ...e }) => e);
    const usesLayout = elements.some((e) => layoutSigs.has(e.sig));
    pages.push({ ...page, ...(usesLayout ? { usesLayout } : {}), elements: assignIds(page.file, own) });
  }
  return { pages, layoutCount: layoutSigs.size, threshold };
}

// 前回の inventory.json から、人が付けた risk と手動追記（source: "manual"）の要素を引き継ぐ
export function carryOver(pages, outPath) {
  const carried = { risk: 0, manual: 0 };
  if (!existsSync(outPath)) return carried;
  const prev = JSON.parse(readFileSync(outPath, "utf8"));
  const prevById = new Map((prev.pages ?? []).flatMap((p) => (p.elements ?? []).map((e) => [e.id, e])));
  for (const page of pages) {
    for (const el of page.elements) {
      const before = prevById.get(el.id);
      if (before?.risk && before.risk !== el.risk) {
        el.risk = before.risk;
        carried.risk++;
      }
    }
  }
  for (const prevPage of prev.pages ?? []) {
    const manual = (prevPage.elements ?? []).filter((e) => e.source === "manual");
    let page = pages.find((p) => p.file === prevPage.file);
    if (!page && (manual.length > 0 || prevPage.file === FLOWS)) {
      const { elements: _e, ...rest } = prevPage;
      page = { ...rest, elements: [] };
      pages.push(page);
    }
    for (const el of manual) {
      if (page.elements.some((e) => e.id === el.id)) continue;
      page.elements.push(el);
      carried.manual++;
    }
  }
  return carried;
}

export function writeInventory(outPath, data) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
}

export function printTable(pages) {
  const used = TYPES.filter((t) => pages.some((p) => p.elements.some((e) => e.type === t)));
  console.log(`| 画面 | タイトル | ${used.join(" | ")} |`);
  console.log(`|------|----------|${used.map(() => "---").join("|")}|`);
  for (const p of pages) {
    const c = (t) => p.elements.filter((e) => e.type === t).length;
    const title = p.unreached ? `（未到達: ${p.reason}）` : (p.title ?? "");
    console.log(`| ${p.file} | ${title} | ${used.map(c).join(" | ")} |`);
  }
}

// 共通部品のうち、一部の画面だけ文脈が違うもの。押したときの挙動が画面によって変わる不具合の手がかりになる
export function printVariations(pages) {
  const layout = pages.find((p) => p.file === LAYOUT);
  const risky = [];
  const stateOnly = new Map(); // page -> count
  for (const el of layout?.elements ?? []) {
    for (const v of el.variations ?? []) {
      const keys = Object.keys(v.differs);
      if (keys.every((k) => k === "state")) {
        for (const f of v.pages) stateOnly.set(f, (stateOnly.get(f) ?? 0) + 1);
        continue;
      }
      const d = keys.map((k) => `${k}: ${JSON.stringify(v.usual[k])} → ${JSON.stringify(v.differs[k])}`).join(", ");
      risky.push(`${v.pages.join(", ")}: ${el.id}（${d}）`);
    }
  }
  if (risky.length > 0) {
    console.log("\n要注意: 共通部品なのに、一部の画面だけ form の中にある・押したときの動作が違う要素（不具合の候補。ケースで確かめる）:");
    for (const t of risky) console.log(`  - ${t}`);
  }
  if (stateOnly.size > 0) {
    console.log(`\n共通部品の状態（active・collapsed など）が画面ごとに違う: ${[...stateOnly].map(([f, n]) => `${f} ${n}`).join(" / ")}`);
    console.log("  現在地の強調や、初期表示で開いているメニューの違い。画面ごとのケースで確かめる");
  }
}

// 描画を JS ライブラリに任せている画面。中の操作（並べ替え・ページ送り・グラフのツールチップなど）は抽出しきれないので手動追記を促す
export function printLibraries(pages) {
  const withLibs = pages.filter((p) => p.libraries?.length);
  if (withLibs.length === 0) return;
  console.log("\n既知の UI ライブラリを使う画面（ライブラリが描く操作・表示を state などとして手動追記する）:");
  for (const p of withLibs) console.log(`  ${p.file}: ${p.libraries.join(", ")}`);
}

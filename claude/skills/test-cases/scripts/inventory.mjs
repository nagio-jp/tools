#!/usr/bin/env node
// 使い方: node inventory.mjs <HTML のルートディレクトリ> [出力ディレクトリ=<ルート>/testcases]
// 静的 HTML からテスト対象の要素を機械的に抜き出し、<出力>/inventory.json に書く。
// 複数画面に同じ形で現れる要素（ナビ・ヘッダーなど）は、擬似画面 "_layout" に 1 回だけ載せる。
// 再実行しても、人が付けた risk と手動追記（source: "manual"）の要素は引き継ぐ。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const htmlRoot = resolve(process.argv[2] ?? ".");
const outDir = resolve(process.argv[3] ?? join(htmlRoot, "testcases"));
const outPath = join(outDir, "inventory.json");
const LAYOUT = "_layout";
const SKIP_DIRS = new Set(["node_modules", ".git", "testcases", "dist", "build", "coverage", "vendor"]);

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (/\.html?$/i.test(name)) files.push(path);
  }
  return files.sort();
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

const stripTags = (s) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const has = (attrs, key) => Object.prototype.hasOwnProperty.call(attrs, key);
// ID に使う文字列。長い本文がそのまま ID になると covers に写すときに崩れやすい
const short = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
const toggleOf = (a) => a["data-toggle"] ?? a["data-bs-toggle"];
const isButtonLike = (a) => /(^|\s)btn(\s|$|-)/.test(a.class ?? "") || a.role === "button";

// a 要素を種別に振り分ける。null は対象外（外部リンク）
function classifyAnchor(a) {
  if (toggleOf(a)) return "toggle";
  const href = a.href ?? "";
  if (href === "" || href.startsWith("#") || /^javascript:/i.test(href)) return "action";
  if (/^(https?:|mailto:|tel:|\/\/|data:)/i.test(href)) return null;
  return isButtonLike(a) ? "button" : "link";
}

function toggleFields(a, label) {
  const target = a["data-target"] ?? a["data-bs-target"] ?? (a.href && a.href !== "#" ? a.href : "");
  return { key: `${toggleOf(a)}:${target || a.id || short(label)}`, fields: { toggle: toggleOf(a), target, label } };
}

function extract(file, html) {
  // コメント・script・style の中の擬似タグを要素として拾わないよう先に除く
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");

  const title = stripTags(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const elements = [];
  const add = (type, key, fields) => elements.push({ type, key, ...fields });

  add("page", "", { title });

  let i = 0;
  for (const m of body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const a = parseAttrs(m[1]);
    const inputs = [...m[2].matchAll(/<(?:input|textarea|select)\b([^>]*)>/gi)]
      .map((x) => parseAttrs(x[1]))
      .filter((x) => (x.type ?? "").toLowerCase() !== "hidden")
      .map((x) => x.name || x.id || x.placeholder || x.type || "?");
    add("form", a.id || a.name || String(++i), { action: a.action ?? "", method: (a.method || "get").toLowerCase(), inputs });
  }

  const groups = new Map(); // radio / checkbox は name 単位で 1 要素にまとめる
  i = 0;
  for (const m of body.matchAll(/<input\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    const type = (a.type || "text").toLowerCase();
    if (type === "hidden") continue;
    if (["submit", "button", "reset", "image"].includes(type)) {
      add("button", a.id || a.name || a.value || String(++i), { label: a.value ?? "", buttonType: type });
      continue;
    }
    if (type === "radio" || type === "checkbox") {
      const key = a.name || a.id || String(++i);
      const gk = `${type}:${key}`;
      if (!groups.has(gk)) groups.set(gk, { type, key, options: [], required: false });
      const g = groups.get(gk);
      g.options.push(a.value ?? a.id ?? "");
      g.required ||= has(a, "required");
      continue;
    }
    const fields = { inputType: type, required: has(a, "required") };
    for (const k of ["pattern", "min", "max", "minlength", "maxlength", "placeholder"]) if (has(a, k)) fields[k] = a[k];
    add("input", a.name || a.id || String(++i), fields);
  }
  for (const g of groups.values()) add(g.type, g.key, { options: g.options, required: g.required });

  i = 0;
  for (const m of body.matchAll(/<textarea\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    const fields = { inputType: "textarea", required: has(a, "required") };
    for (const k of ["minlength", "maxlength", "placeholder"]) if (has(a, k)) fields[k] = a[k];
    add("input", a.name || a.id || `textarea-${++i}`, fields);
  }

  i = 0;
  for (const m of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const a = parseAttrs(m[1]);
    const options = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/option>|$)/gi)].map((o) => {
      const oa = parseAttrs(o[1]);
      return has(oa, "value") ? oa.value : stripTags(o[2]);
    });
    add("select", a.name || a.id || String(++i), { options, required: has(a, "required"), multiple: has(a, "multiple") });
  }

  i = 0;
  for (const m of body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const a = parseAttrs(m[1]);
    const label = stripTags(m[2]) || a["aria-label"] || a.title || "";
    if (toggleOf(a)) {
      const t = toggleFields(a, label);
      add("toggle", t.key, t.fields);
      continue;
    }
    // type 未指定の button は form 内で submit になるので、既定値を submit として残す
    add("button", a.id || a.name || short(label) || String(++i), { label, buttonType: (a.type || "submit").toLowerCase() });
  }

  i = 0;
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = parseAttrs(m[1]);
    const label = stripTags(m[2]) || a["aria-label"] || a.title || "";
    const kind = classifyAnchor(a);
    if (kind === null) continue;
    if (kind === "toggle") {
      const t = toggleFields(a, label);
      add("toggle", t.key, t.fields);
    } else if (kind === "action") {
      const anchor = a.href && a.href !== "#" ? a.href : "";
      add("action", a.id || short(label) || anchor || String(++i), { label, href: a.href ?? "" });
    } else if (kind === "button") {
      add("button", a.id || short(label) || a.href, { label, buttonType: "link", href: a.href });
    } else {
      add("link", `${short(label) || "?"}->${a.href}`, { label, href: a.href });
    }
  }

  return { file, title, elements };
}

// 画面をまたいで同じ要素かを判定する指紋。連番の key は画面ごとにずれるので使わない
function signature(el) {
  const { key, ...fields } = el;
  return JSON.stringify(/^\d+$/.test(key) ? fields : el);
}

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

if (!existsSync(htmlRoot)) {
  console.error(`ディレクトリがありません: ${htmlRoot}`);
  process.exit(2);
}

const files = walk(htmlRoot);
if (files.length === 0) {
  console.error(`HTML ファイルが見つかりません: ${htmlRoot}`);
  process.exit(2);
}

const raw = files.map((path) => extract(relative(htmlRoot, path).split(sep).join("/"), readFileSync(path, "utf8")));

// 同じ画面内の同一要素（モバイル用とデスクトップ用の検索フォームなど）を区別するため、出現順を指紋に足す
const sigPages = new Map(); // sig -> Set(file)
const sigSample = new Map(); // sig -> element
for (const p of raw) {
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
  }
}

const threshold = Math.max(2, Math.ceil(raw.length / 2));
const layoutSigs = new Set([...sigPages].filter(([, s]) => s.size >= threshold).map(([sig]) => sig));

const pages = [];
if (layoutSigs.size > 0) {
  const sharedBy = raw.filter((p) => p.elements.some((e) => layoutSigs.has(e.sig))).map((p) => p.file);
  const els = [...layoutSigs].map((sig) => {
    const { sig: _s, ...el } = sigSample.get(sig);
    return { ...el, pages: [...sigPages.get(sig)] };
  });
  pages.push({ file: LAYOUT, title: "複数画面に共通する部品", sharedBy, elements: assignIds(LAYOUT, els) });
}
for (const p of raw) {
  const own = p.elements.filter((e) => !layoutSigs.has(e.sig)).map(({ sig: _s, ...e }) => e);
  const usesLayout = p.elements.some((e) => layoutSigs.has(e.sig));
  pages.push({ file: p.file, title: p.title, usesLayout, elements: assignIds(p.file, own) });
}

const carried = { risk: 0, manual: 0 };
if (existsSync(outPath)) {
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
    if (manual.length === 0) continue;
    let page = pages.find((p) => p.file === prevPage.file);
    if (!page) {
      page = { file: prevPage.file, title: prevPage.title, elements: [] };
      pages.push(page);
    }
    for (const el of manual) {
      if (page.elements.some((e) => e.id === el.id)) continue;
      page.elements.push(el);
      carried.manual++;
    }
  }
}

mkdirSync(outDir, { recursive: true });
const root = relative(outDir, htmlRoot).split(sep).join("/") || ".";
writeFileSync(outPath, JSON.stringify({ root, pages }, null, 2) + "\n");

const TYPES = ["page", "form", "input", "select", "radio", "checkbox", "button", "toggle", "action", "link", "state"];
const total = pages.reduce((n, p) => n + p.elements.length, 0);
console.log(`HTML ファイル ${files.length} / 画面 ${raw.length}（+ 共通部品 ${layoutSigs.size > 0 ? 1 : 0}）/ 要素 ${total} -> ${outPath}`);
if (layoutSigs.size > 0) console.log(`共通部品: ${threshold} 画面以上に同じ形で現れる ${layoutSigs.size} 要素を ${LAYOUT} にまとめた`);
if (carried.risk || carried.manual) console.log(`前回から引き継ぎ: risk ${carried.risk} 件 / 手動追記 ${carried.manual} 件`);
console.log("");
console.log(`| 画面 | タイトル | ${TYPES.join(" | ")} |`);
console.log(`|------|----------|${TYPES.map(() => "---").join("|")}|`);
for (const p of pages) {
  const c = (t) => p.elements.filter((e) => e.type === t).length;
  console.log(`| ${p.file} | ${p.title} | ${TYPES.map(c).join(" | ")} |`);
}

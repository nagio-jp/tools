#!/usr/bin/env node
// 使い方: node crawl.mjs --base-url <URL> [--out <testcases ディレクトリ>] [--routes <routes.json>]
//          [--max-pages 40] [--storage-state <auth.json>] [--setup <setup.mjs>] [--session 名前[=setup.mjs|auth.json]]...
//          [--seed <URL>]... [--exclude <正規表現>] [--no-expand] [--headed] [--project <対象プロジェクト>]
// --seed には、リンクからたどれない画面やパラメータ付きの画面の実在する URL（/users/42 など）を渡す。
// --setup には default export で async (page, { baseUrl }) => {} を書いた ES モジュールを渡す。
// クロールの前に 1 回だけ実行するので、ログインや「一覧に行がある状態」を作るのに使う。
// 起動中のアプリを Playwright でたどり、描画後の DOM から操作できる要素を集めて inventory.json に書く。
// React・Vue などフレームワークを問わず、ブラウザに描画された結果だけを見る。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAYOUT, short, GENERIC_CLASS, buildPages, carryOver, writeInventory, printTable, printVariations, printLibraries } from "./lib/core.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args["base-url"]) {
  console.error("--base-url を指定してください（例: --base-url http://localhost:5173）");
  process.exit(2);
}
const base = new URL(args["base-url"]);
const outDir = resolve(args.out ?? "testcases");
const outPath = join(outDir, "inventory.json");
const routesPath = resolve(args.routes ?? join(outDir, "routes.json"));
const maxPages = Number(args["max-pages"] ?? 40);
const maxExpand = Number(args["max-expand"] ?? 15);
const expand = !args["no-expand"];
// たどるとセッションが切れる・ファイルを落とすだけのリンクは、要素としては残すが遷移はしない
const exclude = new RegExp(args.exclude ?? "log-?out|sign-?out|logoff|\\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4)$", "i");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (value !== true) i++;
    out[key] = key in out ? [].concat(out[key], value) : value;
  }
  return out;
}

async function loadChromium() {
  const bases = [args.project && join(resolve(args.project), "package.json"), join(process.cwd(), "package.json"), fileURLToPath(import.meta.url)].filter(Boolean);
  for (const b of bases) {
    for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
      try {
        const mod = await import(pathToFileURL(createRequire(b).resolve(name)).href);
        const chromium = mod.chromium ?? mod.default?.chromium;
        if (chromium) return chromium;
      } catch {}
    }
  }
  const skillScripts = fileURLToPath(new URL(".", import.meta.url));
  console.error(
    "Playwright が見つかりません。次のどちらかで入れてください。\n" +
      `  - スキル側に入れる: cd ${skillScripts} && npm install && npx playwright install chromium\n` +
      "  - 対象プロジェクトに Playwright があるなら --project <プロジェクトのルート> を付ける",
  );
  process.exit(2);
}

// /users/123 や /posts/550e8400-... を 1 つの画面として扱う
const isDynamicSegment = (s) =>
  /^\d+$/.test(s) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
  /^[0-9a-f]{10,}$/i.test(s) ||
  (s.length >= 12 && /\d/.test(s) && /[a-z]/i.test(s) && !/\.[a-z]+$/i.test(s));

function patternOf(url) {
  const u = new URL(url);
  const norm = (p) =>
    p
      .replace(/\/index\.html?$/i, "/")
      .split("/")
      .map((s) => (s && isDynamicSegment(decodeURIComponent(s)) ? ":id" : s))
      .join("/")
      .replace(/(.)\/$/, "$1") || "/";
  let pattern = norm(u.pathname);
  // ハッシュルーティング（#/active など）は別画面として扱う。ページ内アンカー（#top）は無視する
  const hash = u.hash.match(/^#!?(\/.*)$/)?.[1];
  const hashPath = hash ? norm(hash.split("?")[0]) : "/";
  if (hashPath !== "/") pattern += `#${hashPath}`;
  return pattern;
}

const sameOrigin = (url) => {
  try {
    return new URL(url).origin === base.origin;
  } catch {
    return false;
  }
};

// ---- ブラウザ内で実行する抽出処理 ----
function extractInPage({ maxLen, genericClass }) {
  const GENERIC = new RegExp(genericClass, "i");
  // CSS-in-JS などが生成する class・id（mui-1en7clp、css-xyz12、React の useId の «r1»）は名前にしない
  const GENERATED = /^(mui|css|sc|jsx|emotion|tss|chakra|mantine|svelte|astro|v|data-v)-[a-z0-9]{4,}$|^Private|^Mui|\d{3,}|__[a-z0-9]{5,}$/i;
  const genId = (v) => !v || /[«»]|^:r|^:R|^radix-|^headlessui-|^react-aria|^mui-\d/.test(v);
  const STATE = /^(active|show|open|collapsed|current|selected|disabled|is-active|is-open|Mui-selected|Mui-expanded)$/;
  const cut = (s) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
  };
  const visible = (el) => {
    if (el.closest("[aria-hidden='true'],[inert]")) return false;
    // UI ライブラリはチェックボックス・ラジオの実体を透明にしてラベル側を描くので、ラベルの見え方で判定する
    if (el.tagName === "INPUT" && ["checkbox", "radio"].includes(el.type)) {
      if ([...(el.labels ?? [])].some((l) => l.getBoundingClientRect().width > 0 && getComputedStyle(l).visibility !== "hidden")) return true;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0;
  };
  const text = (el) => (el.innerText ?? el.textContent ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const accName = (el) => {
    const al = el.getAttribute("aria-label");
    if (al?.trim()) return al.trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(" ");
      if (t) return t;
    }
    if (el.labels?.length) {
      const t = [...el.labels].map(text).join(" ");
      if (t) return t;
    }
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) return el.value || el.type;
    // for 属性で結び付いていないラベル（UI ライブラリの入力欄に多い）は、近くの祖先に 1 つだけあるラベルを使う
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.getAttribute("role") === "combobox") {
      for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
        const ls = n.querySelectorAll("label,legend");
        if (ls.length === 1 && text(ls[0])) return text(ls[0]);
        if (ls.length > 1) break;
      }
    }
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
      const t = text(el);
      if (t) return t;
      const img = el.querySelector("img[alt],svg title");
      const alt = img?.getAttribute?.("alt") ?? img?.textContent;
      if (alt?.trim()) return alt.trim();
    }
    return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || (genId(el.id) ? "" : el.id) || "";
  };
  // 名前の無い要素（アイコンだけのボタンなど）は、class と中のアイコンの class から名前を作る
  const hintOf = (el) => {
    const classes = [el, ...el.querySelectorAll("i,svg,span,img")].flatMap((n) => [...(n.classList ?? [])]);
    const icon = classes.find((c) => /^(fa|fas|far|fab|bi|mdi|icon|material|glyphicon|ti|ri|la)-[a-z]/i.test(c) && !/^fa-(fw|lg|sm|xs|[0-9]x)$/i.test(c));
    if (icon) return icon;
    const testid = el.getAttribute("data-testid") || el.querySelector("svg[data-testid]")?.getAttribute("data-testid");
    if (testid) return testid;
    // MUI の MuiAvatar-root のような class は部品名を表すので、部品名だけ取り出す
    const mui = [...el.classList].map((c) => c.match(/^Mui([A-Za-z]+)-root$/)?.[1]).filter((c) => c && !/^(ButtonBase|Box|Stack|Grid\d?|Paper|Typography|SvgIcon)$/.test(c));
    if (mui.length) return mui[mui.length - 1];
    const own = [...el.classList].filter((c) => !GENERIC.test(c) && !GENERATED.test(c)).slice(0, 2).join(".");
    if (own) return own;
    if (el.closest("thead,[role=columnheader]")) return "表の見出し";
    if (el.closest("tr,[role=row]")) return "表の行";
    return "";
  };
  const ctxOf = (el) => {
    const state = [...el.classList].filter((c) => STATE.test(c));
    if (el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") state.push("aria-current");
    if (el.getAttribute("aria-expanded") === "true") state.push("expanded");
    return { inForm: Boolean(el.closest("form")), state };
  };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden") return null;
      if (t === "checkbox") return el.getAttribute("switch") !== null ? "switch" : "checkbox";
      if (t === "radio") return "radio";
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      if (t === "range") return "slider";
      return "textbox";
    }
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    return null;
  };
  // 一覧の行のように同じ構造が繰り返す要素をまとめるための構造パス（CSS Modules などの生成クラスは使わない）
  const cls = (el) =>
    // 行の class は完了・選択などの状態で変わるので、行の構造の判定には使わない
    ["LI", "TR"].includes(el.tagName) ? [] : [...el.classList].filter((c) => /^[a-z][a-z0-9_-]*$/i.test(c) && !/\d{3,}|^(css|sc|jsx|emotion|Mui[A-Za-z]+-root)-|__[a-z0-9]{5,}$/i.test(c)).slice(0, 1);
  const structPath = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
      parts.unshift(n.tagName.toLowerCase() + cls(n).map((c) => `.${c}`).join(""));
    }
    return parts.join(">");
  };

  const INTERACTIVE = "a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex]:not([tabindex='-1'])";
  const KEEP_ROLES = new Set([
    "link", "button", "textbox", "searchbox", "spinbutton", "slider", "combobox", "listbox",
    "checkbox", "switch", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
  ]);
  // 前回の番号が隠れた要素に残ると、同じ番号が 2 つになってクリック先を取り違える
  for (const el of document.querySelectorAll("[data-nagio-idx]")) el.removeAttribute("data-nagio-idx");
  const items = [];
  const seenNodes = new Set();
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    // モーダルのフォーカストラップ用の番兵など、利用者が操作しない要素
    if (/^sentinel/i.test(el.getAttribute("data-testid") ?? "")) continue;
    // UI ライブラリが値の保持用に置く入力欄（フォーカスできず、ラベルも無い）
    if (el.tagName === "INPUT" && el.getAttribute("tabindex") === "-1" && !el.labels?.length) continue;
    let role = roleOf(el);
    // role は無いがフォーカスできる要素（並べ替えできる表の見出しなど）はクリックできるものとして扱う
    if (!role && el.matches("[tabindex]:not([tabindex='-1'])")) role = "clickable";
    if (!role || !(KEEP_ROLES.has(role) || role === "clickable")) continue;
    if (!visible(el)) continue;
    seenNodes.add(el);
    const name = cut(accName(el) || hintOf(el));
    const it = { role, name, path: structPath(el), ctx: ctxOf(el) };
    const tag = el.tagName.toLowerCase();
    if (role === "button") {
      it.buttonType =
        tag === "button" ? (el.getAttribute("type") || (el.form ? "submit" : "button")).toLowerCase()
        : tag === "input" ? el.type
        : tag === "a" ? (/^#|^javascript:/i.test(el.getAttribute("href") ?? "#") ? "js" : "link")
        : "js";
    }
    if (role === "link") {
      const href = el.getAttribute("href") ?? "";
      it.href = href;
      try {
        it.abs = new URL(href, location.href).href;
      } catch {}
    }
    if (["textbox", "searchbox", "spinbutton", "slider", "combobox", "listbox"].includes(role)) {
      it.inputType = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : tag === "textarea" ? "textarea" : role;
      for (const k of ["required", "pattern", "min", "max", "minlength", "maxlength", "placeholder"]) {
        if (el.hasAttribute(k)) it[k] = k === "required" ? true : el.getAttribute(k);
      }
      if (el.getAttribute("aria-required") === "true") it.required = true;
      if (tag === "select") it.options = [...el.options].map((o) => cut(o.value || o.text));
      else if (role === "listbox") {
        // 開いたメニューの一覧。中身の文字列は名前にせず、選択肢として持つ
        it.options = [...el.querySelectorAll("[role=option]")].map((o) => cut(text(o)));
        it.name = cut(el.getAttribute("aria-label") || "");
      }
      it.fieldName = el.getAttribute("name") || (genId(el.id) ? "" : el.id) || "";
    }
    if (role === "radio" || role === "checkbox") it.group = el.getAttribute("name") || "";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") it.disabled = true;
    const toggles = el.getAttribute("data-toggle") || el.getAttribute("data-bs-toggle");
    if (el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded") || toggles || tag === "summary") {
      it.toggle = toggles || el.getAttribute("aria-haspopup") || (tag === "summary" ? "details" : "expand");
      it.target = el.getAttribute("aria-controls") || el.getAttribute("data-target") || el.getAttribute("data-bs-target") || "";
      if (genId(it.target)) it.target = "";
    }
    if (el.id && !genId(el.id)) it.domId = el.id;
    if (role === "tab") it.selected = el.getAttribute("aria-selected") === "true";
    it.idx = items.length;
    el.setAttribute("data-nagio-idx", String(it.idx));
    items.push(it);
  }

  // role も href も無いが、カーソルが指になる要素（React の onClick を付けた div など）
  for (const el of document.querySelectorAll("body *")) {
    if (seenNodes.has(el) || el.closest(INTERACTIVE) || el.querySelector(INTERACTIVE)) continue;
    if (getComputedStyle(el).cursor !== "pointer") continue;
    if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue;
    if (!visible(el)) continue;
    const name = cut(accName(el) || hintOf(el));
    if (!name) continue;
    const it = { role: "clickable", name, path: structPath(el), ctx: ctxOf(el), idx: items.length };
    el.setAttribute("data-nagio-idx", String(it.idx));
    items.push(it);
  }

  const forms = [...document.forms].filter(visible).map((f, i) => ({
    key:
      f.id || f.getAttribute("name") || f.getAttribute("aria-label") || hintOf(f) ||
      (f.getAttribute("action") ? `action:${f.getAttribute("action")}` : "") ||
      cut(text(f.querySelector("h1,h2,h3,h4,h5,h6,legend,[class*=CardHeader-title],[class*=title]") ?? document.createElement("i"))) ||
      cut(accName(f.querySelector("button[type=submit],button:not([type]),input[type=submit]") ?? document.createElement("i"))) ||
      String(i + 1),
    action: f.getAttribute("action") ?? "",
    method: (f.getAttribute("method") || "get").toLowerCase(),
    inputs: [...f.elements]
      .filter((x) => x.type !== "hidden" && ["INPUT", "TEXTAREA", "SELECT"].includes(x.tagName))
      .map((x) => x.name || x.id || x.placeholder || x.type),
  }));

  const links = [...document.querySelectorAll("a[href]")].map((a) => a.href).filter(Boolean);
  const w = window;
  const libraries = [
    ["Chart.js", w.Chart],
    ["DataTables", w.jQuery?.fn?.dataTable || w.DataTable],
    ["Select2", w.jQuery?.fn?.select2],
    ["jQuery UI", w.jQuery?.ui],
    ["Leaflet", w.L?.map || document.querySelector(".leaflet-container")],
    ["Google Maps", w.google?.maps],
    ["Swiper", w.Swiper || document.querySelector(".swiper")],
    ["flatpickr", w.flatpickr],
    ["reCAPTCHA", w.grecaptcha],
    ["Stripe", w.Stripe],
    ["ApexCharts", w.ApexCharts || document.querySelector(".apexcharts-canvas")],
    ["ECharts", w.echarts],
    ["Highcharts", w.Highcharts],
    ["Recharts", document.querySelector(".recharts-wrapper")],
    ["MUI X DataGrid", document.querySelector(".MuiDataGrid-root")],
    ["MUI X Charts", document.querySelector(".MuiChartsSurface-root, .MuiResponsiveChart-container")],
    ["AG Grid", document.querySelector(".ag-root")],
    ["FullCalendar", w.FullCalendar || document.querySelector(".fc")],
    ["SweetAlert", w.Swal],
    ["リッチテキストエディタ", w.tinymce || w.CKEDITOR || w.Quill || document.querySelector(".ProseMirror, .ql-editor")],
    ["canvas 描画", document.querySelector("canvas")],
  ].filter(([, v]) => v).map(([n]) => n);
  const h1 = document.querySelector("h1");
  const fingerprint = `${document.title}|${text(document.body).slice(0, 300)}`;
  return { title: document.title, heading: h1 ? cut(text(h1)) : "", items, forms, links, fingerprint, libraries };
}

// ---- 抽出結果を inventory の要素に変換する ----
function rowGroupKeys(snap) {
  const groups = new Map();
  for (const it of snap.items) {
    const k = `${it.role}|${it.path}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return [...groups].filter(([, l]) => isRowGroup(l)).map(([k, l]) => [k, new Set(l.map((x) => x.name)).size === 1]);
}

// 一覧の行（データの件数だけ並ぶ要素）か。ナビやフォームの項目は構造が同じでも別要素なので、
// 「名前が全部同じ」「詳細画面へのリンクが並ぶ」「li・表の行の中の操作」のどれかを満たすときだけ行とみなす
function isRowGroup(list) {
  if (list.length < 2 || list[0].role === "radio") return false;
  if (new Set(list.map((x) => x.name)).size === 1) return true;
  if (list[0].role !== "link" && !list[0].toggle && /(^|>)li(>|$)/.test(list[0].path)) return true;
  if (list.length < 3) return false;
  if (list[0].role === "link" && list.every((x) => x.abs) && new Set(list.map((x) => patternOf(x.abs))).size === 1 && patternOf(list[0].abs).includes(":id")) return true;
  return /(^|>)(tr|tbody)(\.|>|$)/.test(list[0].path) || /\[role=row\]/.test(list[0].path);
}

function toElements(snap, rowPaths = new Map()) {
  const elements = [];
  const radios = new Map();
  const byPath = new Map();
  for (const it of snap.items) {
    const k = `${it.role}|${it.path}`;
    if (rowPaths.has(k)) byPath.set(k, (byPath.get(k) ?? 0) + 1);
  }
  const emittedRepeat = new Set();

  for (const it of snap.items) {
    const pk = `${it.role}|${it.path}`;
    const repeated = byPath.has(pk);
    if (repeated) {
      if (emittedRepeat.has(pk)) continue;
      emittedRepeat.add(pk);
    }
    const names = repeated ? [...new Set(snap.items.filter((x) => `${x.role}|${x.path}` === pk).map((x) => x.name))] : [it.name];
    const label = repeated ? (rowPaths.get(pk) ? names[0] : "一覧の各行") : it.name;
    const tail = `[${it.path.split(">").slice(-2).join(">")}]`;
    // 件数はデータで変わる（1 件なら repeated にならない）ので、key は単体のときと同じにする
    const key0 = repeated ? (rowPaths.get(pk) && names[0] ? short(names[0]) : tail) : short(it.name);
    const extra = repeated ? { repeated: byPath.get(pk), ...(rowPaths.get(pk) ? {} : { example: names[0] }) } : {};
    // 件数は画面・データで変わるので、共通部品の判定には使わない（core の NON_IDENTITY）
    extra.ctx = it.ctx;
    if (it.via) extra.revealedBy = it.via;
    if (it.disabled) extra.disabled = true;

    if (it.toggle) {
      elements.push({ type: "toggle", key: `${it.toggle}:${it.target || it.domId || key0 || it.idx}`, label, toggle: it.toggle, target: it.target, ...extra, _idx: it.idx });
      continue;
    }
    switch (it.role) {
      case "link": {
        const internal = it.abs && sameOrigin(it.abs);
        const anchorOnly = /^#($|[^/!])|^javascript:/i.test(it.href) || it.href === "";
        if (anchorOnly) elements.push({ type: "action", key: key0 || it.href || String(it.idx), label, href: it.href, ...extra });
        else if (internal) {
          const to = patternOf(it.abs);
          elements.push({ type: "link", key: `${key0 || "?"}->${to}`, label, href: it.href, to, ...extra });
        } else if (it.abs && /^(https?|mailto|tel):/i.test(it.abs)) {
          elements.push({ type: "external", key: `${key0 || "?"}->${it.abs}`, label, href: it.abs, ...extra });
        }
        break;
      }
      case "button":
        elements.push({ type: "button", key: key0 || String(it.idx), label, buttonType: it.buttonType, ...extra });
        break;
      case "textbox":
      case "searchbox":
      case "spinbutton":
      case "slider": {
        const { role: _r, name: _n, path: _p, idx: _i, fieldName, via: _v, ctx: _c, domId: _d, ...rest } = it;
        elements.push({ type: "input", key: fieldName || key0 || String(it.idx), label, ...rest, ...extra });
        break;
      }
      case "combobox":
      case "listbox": {
        const { role: _r, name: _n, path: _p, idx: _i, fieldName, via: _v, ctx: _c, domId: _d, ...rest } = it;
        const k = fieldName || key0 || (it.via ? `${it.via}の選択肢` : String(it.idx));
        elements.push({ type: "select", key: k, label: label || (it.via ? `${it.via}の選択肢` : ""), ...rest, ...extra });
        break;
      }
      case "checkbox":
      case "switch":
        elements.push({ type: it.role, key: key0 || it.group || String(it.idx), label, ...extra });
        break;
      case "radio": {
        const g = it.group || it.path;
        if (!radios.has(g)) {
          const r = { type: "radio", key: it.group || key0, options: [], ...extra };
          radios.set(g, r);
          elements.push(r);
        }
        radios.get(g).options.push(it.name);
        break;
      }
      case "tab":
        elements.push({ type: "tab", key: key0 || String(it.idx), label, ...extra, _idx: it.idx, _tab: !it.selected });
        break;
      case "menuitem":
      case "menuitemcheckbox":
      case "menuitemradio":
      case "treeitem":
        elements.push({ type: "menuitem", key: key0 || String(it.idx), label, ...extra });
        break;
      case "clickable":
        elements.push({ type: "action", key: key0 || String(it.idx), label, clickable: "cursor", ...extra });
        break;
    }
  }
  for (const f of snap.forms) elements.push({ type: "form", key: f.key, action: f.action, method: f.method, inputs: f.inputs });
  return elements;
}

const EXTRACT_OPTS = { maxLen: 40, genericClass: GENERIC_CLASS.source };
const fpOf = (it) => `${it.role}|${it.path}|${it.name}`;

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(Number(args.wait ?? 300));
}

// --session 名前[=setup.mjs | storageState.json] を繰り返すと、ログイン前・ログイン後などを順に巡回して結果を合わせる
function parseSessions() {
  const list = [].concat(args.session ?? []).filter((x) => typeof x === "string");
  const sessions = list.map((spec) => {
    const [name, file] = spec.split(/=(.*)/s);
    if (!file) return { name };
    const path = resolve(file);
    if (!existsSync(path)) {
      console.error(`--session ${name} のファイルがありません: ${path}`);
      process.exit(2);
    }
    return /\.json$/i.test(path) ? { name, storageState: path } : { name, setup: path };
  });
  if (sessions.length > 0) return sessions;
  const one = { name: "default" };
  if (args["storage-state"]) one.storageState = resolve(args["storage-state"]);
  if (args.setup) one.setup = resolve(args.setup);
  if (one.storageState && !existsSync(one.storageState)) {
    console.error(`storage state がありません: ${one.storageState}`);
    process.exit(2);
  }
  return [one];
}
const sessions = parseSessions();

async function main() {
  const started = Date.now();
  const chromium = await loadChromium();
  let browser;
  try {
    browser = await chromium.launch({ headless: !args.headed });
  } catch (e) {
    console.error(`ブラウザを起動できません。npx playwright install chromium を実行してください。\n  ${e.message.split("\n")[0]}`);
    process.exit(2);
  }
  let routes = [];
  if (existsSync(routesPath)) routes = JSON.parse(readFileSync(routesPath, "utf8")).routes ?? [];
  const visited = new Map(); // pattern -> raw page（先に回したセッションの結果を優先する）
  const attempted = new Map(); // このセッションで開こうとして開けなかった画面
  const attemptLog = new Map(); // pattern -> [セッションごとの理由]
  const expandCache = new Map(); // toggle の指紋 -> 開いたときに現れた項目
  const concreteUrls = [];
  let capped = false;

  for (const session of sessions) {
  const seenHere = new Set(); // このセッションで見た画面
  const context = await browser.newContext(session.storageState ? { storageState: session.storageState } : {});
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));


    const goto = async (url) => {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: Number(args.timeout ?? 15000) }).catch((e) => ({ error: e }));
      await settle(page);
      return res;
    };

    // 画面内のリンクを押して遷移する。再読み込みすると、メモリにしか無い状態（追加した行など）が消えるため
    const softGoto = async (url) => {
      const cur = new URL(page.url());
      const next = new URL(url);
      try {
        if (cur.origin === next.origin && cur.pathname === next.pathname && cur.search === next.search && cur.hash !== next.hash) {
          await page.evaluate((h) => {
            location.hash = h;
          }, next.hash);
          await settle(page);
          return { soft: true };
        }
        const clicked = await page.evaluate((target) => {
          const a = [...document.querySelectorAll("a[href]")].find((x) => x.href === target && x.getBoundingClientRect().width > 0);
          if (!a) return false;
          a.click();
          return true;
        }, url);
        if (clicked) {
          await settle(page);
          if (patternOf(page.url()) === patternOf(url)) return { soft: true };
        }
      } catch {}
      return goto(url);
    };

    // 番号は抽出のたびに振り直されるので、指紋と出現順で今の番号を引き直してからクリックする
    const clickByFp = async (fp, nth) => {
      const cur = await page.evaluate(extractInPage, EXTRACT_OPTS);
      const hit = cur.items.filter((x) => fpOf(x) === fp)[nth];
      if (!hit) throw new Error(`要素が見つからない: ${fp}`);
      await page.click(`[data-nagio-idx="${hit.idx}"]`, { timeout: 2000 });
      return hit;
    };

    // 開いた部品を閉じて元の状態に戻す。戻らなければ読み込み直す
    const restore = async (pageUrl, t, baseFps) => {
      try {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        const cur = await page.evaluate(extractInPage, EXTRACT_OPTS);
        const hit = cur.items.filter((x) => fpOf(x) === fpOf(t))[t.nth ?? 0];
        if (t.toggle && hit && (await page.getAttribute(`[data-nagio-idx="${hit.idx}"]`, "aria-expanded").catch(() => null)) === "true") {
          await page.click(`[data-nagio-idx="${hit.idx}"]`, { timeout: 1000 });
        }
        if (t.role === "tab" && t.restoreFp) await clickByFp(t.restoreFp, 0);
        await page.waitForTimeout(300);
        if (patternOf(page.url()) === patternOf(pageUrl)) {
          const now = await page.evaluate(extractInPage, EXTRACT_OPTS);
          const fps = new Set(now.items.map(fpOf));
          if ([...baseFps].every((f) => fps.has(f)) && fps.size === baseFps.size) return;
        }
      } catch {}
      await goto(pageUrl);
      await page.evaluate(extractInPage, EXTRACT_OPTS).catch(() => {});
    };

    // 存在しないパスの見え方。SPA は 404 でも 200 を返すので、表示内容で判定する
    const probeUrl = new URL("/__test_cases_probe_404__", base).href;
    await goto(probeUrl);
    // 存在しないパスがトップなどへリダイレクトされるアプリでは、表示内容での判定はしない
    const notFoundFp = patternOf(page.url()) === patternOf(probeUrl) ? (await page.evaluate(extractInPage, EXTRACT_OPTS).catch(() => null))?.fingerprint : null;
    const isNotFound = (res, fp) => (res && !res.error && typeof res.status === "function" && res.status() >= 400) || (notFoundFp && fp === notFoundFp);

    if (session.setup) {
      const mod = await import(pathToFileURL(session.setup).href);
      await goto(base.href);
      await mod.default(page, { baseUrl: base.href });
      await settle(page);
      console.error(`[${session.name}] setup を実行した: ${session.setup}`);
    }


    // リンクでたどれる画面を先に回し、ソースから拾っただけのルートは後で直接開く（直接開くと状態が消えるため）
    const queue = [{ url: base.href, via: "start" }];
    const seeds = [].concat(args.seed ?? []).filter((x) => typeof x === "string").map((u) => ({ url: new URL(u, base).href, via: "seed" }));
    for (const r of routes) {
      if (r.path.includes(":") || r.path.includes("*")) continue;
      seeds.push({ url: new URL(r.path.replace(/^\//, ""), base.href.endsWith("/") ? base.href : `${base.href}/`).href, via: "route", route: r.path });
    }

    attempted.clear();

    while ((queue.length > 0 || seeds.length > 0) && seenHere.size < maxPages) {
      const { url, via, route } = queue.length > 0 ? queue.shift() : seeds.shift();
      const want = patternOf(url);
      if (seenHere.has(want) || attempted.has(want)) continue;
      if (via !== "start" && exclude.test(new URL(url).pathname)) continue;

      // setup の直後はすでに開いているので、読み込み直さない
      const already = via === "start" && Boolean(session.setup);
      const res = already ? { soft: true } : via === "link" ? await softGoto(url) : await goto(url);
      if (res?.error) {
        attempted.set(want, { reason: `読み込み失敗: ${res.error.message.split("\n")[0]}`, route });
        continue;
      }
      const got = patternOf(page.url());
      let snap;
      try {
        snap = await page.evaluate(extractInPage, EXTRACT_OPTS);
      } catch (e) {
        attempted.set(want, { reason: `抽出失敗: ${e.message.split("\n")[0]}`, route });
        continue;
      }
      if (isNotFound(res, snap.fingerprint)) {
        attempted.set(want, { reason: "存在しないパスと同じ表示（404）", route });
        continue;
      }
      if (got !== want) attempted.set(want, { reason: `リダイレクト → ${got}（ログイン状態や権限で出し分けている可能性）`, route });
      for (const l of snap.links) {
        if (sameOrigin(l)) queue.push({ url: l.split("#")[0] + (new URL(l).hash.match(/^#!?\//) ? new URL(l).hash : ""), via: "link" });
      }
      if (seenHere.has(got)) continue;
      seenHere.add(got);
      concreteUrls.push(page.url());

      // ドロップダウン・タブなどを 1 つずつ開き、開いたときだけ現れる要素を集める
      if (expand) {
        const baseFps = new Set(snap.items.map(fpOf));
        const selectedTab = snap.items.find((it) => it.role === "tab" && it.selected);
        const targets = snap.items
          .filter((it) => it.toggle || (it.role === "tab" && !it.selected))
          .map((it) => ({
            ...it,
            nth: snap.items.filter((x) => x.idx < it.idx && fpOf(x) === fpOf(it)).length,
            ...(it.role === "tab" && selectedTab ? { restoreFp: fpOf(selectedTab) } : {}),
          }))
          .slice(0, maxExpand);
        const pageUrl = page.url();
        for (const t of targets) {
          const tfp = fpOf(t);
          let revealed = expandCache.get(tfp);
          if (!revealed) {
            revealed = [];
            try {
              await clickByFp(tfp, t.nth ?? 0);
              await page.waitForTimeout(400);
              if (patternOf(page.url()) === got) {
                const after = await page.evaluate(extractInPage, EXTRACT_OPTS);
                revealed = after.items.filter((it) => !baseFps.has(fpOf(it)));
                for (const l of after.links) if (sameOrigin(l)) queue.push({ url: l, via: "link" });
              }
            } catch {}
            expandCache.set(tfp, revealed);
            await restore(pageUrl, t, baseFps);
          }
          const label = t.name || t.target || t.toggle;
          for (const it of revealed) snap.items.push({ ...it, via: short(label), idx: snap.items.length });
        }
      }

      // 要素への変換は全画面を見てから行う（ある画面で一覧の行と分かった構造を、行が 1 件しか無い画面にも当てるため）
      const prevPage = visited.get(got);
      if (prevPage) {
        prevPage.snaps.push({ snap, session: session.name });
        process.stderr.write(`  [${session.name}] ${got}（別のセッションで見た画面に追加）\n`);
        continue;
      }
      visited.set(got, {
        file: got,
        title: snap.heading ? `${snap.title} / ${snap.heading}` : snap.title,
        url: page.url().replace(base.origin, ""),
        reachedBy: via,
        snaps: [{ snap, session: session.name }],
      });
      process.stderr.write(`  [${session.name}] ${got}  (${snap.items.length} 項目)\n`);
    }
  if ((queue.length > 0 || seeds.length > 0) && seenHere.size >= maxPages) capped = true;
  for (const [pattern, v] of attempted) {
    if (!attemptLog.has(pattern)) attemptLog.set(pattern, []);
    attemptLog.get(pattern).push({ ...v, session: session.name });
  }
  await context.close();
  }

  await browser.close();

  // 構造 -> 行ごとに名前が同じか（「削除」が並ぶなど）。名前が行のデータで変わる構造は、名前を key に使わない
  const rowPaths = new Map();
  for (const p of visited.values()) {
    for (const { snap } of p.snaps) for (const [k, same] of rowGroupKeys(snap)) rowPaths.set(k, (rowPaths.get(k) ?? true) && same);
  }
  for (const p of visited.values()) {
    const elements = [{ type: "page", key: "" }];
    const keyOf = (e) => JSON.stringify({ ...e, ctx: undefined, repeated: undefined, sessionOnly: undefined });
    const known = new Set();
    const libs = new Set();
    p.snaps.forEach(({ snap, session }, i) => {
      for (const l of snap.libraries) libs.add(l);
      for (const e of toElements(snap, rowPaths).map(({ _idx, _tab, ...e }) => e)) {
        const k = keyOf(e);
        if (known.has(k)) continue;
        known.add(k);
        // 最初のセッションで見えず、後のセッションでだけ現れた要素（ログイン後だけのメニュー、データがあるときだけの行など）
        elements.push(i === 0 ? e : { ...e, sessionOnly: session });
      }
    });
    p.sessions = [...new Set(p.snaps.map((x) => x.session))];
    if (libs.size) p.libraries = [...libs];
    delete p.snaps;
    p.elements = elements;
  }

  // routes.json にあるのに到達できなかった画面
  const unreached = [];
  const matches = (routePath, pattern, urls) => {
    const re = new RegExp(`^${routePath.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\/:[^/]+\*/g, "(/.*)?").replace(/:[^/]+/g, "[^/]+")}/?$`);
    return urls.some((u) => {
      const x = new URL(u);
      const hash = x.hash.match(/^#!?(\/[^?]*)/)?.[1];
      return re.test(x.pathname) || (hash && re.test(hash));
    }) || pattern === routePath;
  };
  for (const r of routes) {
    if ([...visited.keys()].some((p) => matches(r.path, p, concreteUrls))) continue;
    const log = attemptLog.get(r.path) ?? [...attemptLog.entries()].find(([, v]) => v.some((x) => x.route === r.path))?.[1];
    const tried = log && { reason: log.map((x) => (sessions.length > 1 ? `[${x.session}] ${x.reason}` : x.reason)).join(" / ") };
    const reason =
      tried?.reason ??
      (r.kind === "relative" ? "相対パス（親ルートとの連結が不明）" : /[:*]/.test(r.path) ? "パラメータが必要（実在する ID の URL を渡す）" : "リンクから到達できず");
    unreached.push({ file: r.path, unreached: true, reason, sources: r.sources, elements: [{ type: "page", key: "" }] });
  }

  const raw = [...visited.values(), ...unreached];
  const { pages, layoutCount, threshold } = buildPages(raw);
  const carried = carryOver(pages, outPath);
  writeInventory(outPath, { mode: "app", baseUrl: base.href, pages });

  const total = pages.reduce((n, p) => n + p.elements.length, 0);
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`画面 ${visited.size}（+ 共通部品 ${layoutCount > 0 ? 1 : 0}、未到達 ${unreached.length}）/ 要素 ${total} / ${sec} 秒 -> ${outPath}`);
  if (layoutCount > 0) console.log(`共通部品: ${threshold} 画面以上に同じ形で現れる ${layoutCount} 要素を ${LAYOUT} にまとめた`);
  if (carried.manual) console.log(`前回から引き継ぎ: 手動追記 ${carried.manual} 件`);
  if (capped) console.log(`画面数の上限（--max-pages ${maxPages}）で打ち切った。未訪問の URL が残っている`);
  console.log("");
  printTable(pages);
  printVariations(pages);
  printLibraries(pages);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

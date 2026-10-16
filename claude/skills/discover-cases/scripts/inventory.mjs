#!/usr/bin/env node
// 使い方: node inventory.mjs <HTML のルートディレクトリ> [出力ディレクトリ=<ルート>/testcases]
// 静的 HTML からテスト対象の要素を機械的に抜き出し、<出力>/inventory.json に書く。
// 複数画面に同じ形で現れる要素（ナビ・ヘッダーなど）は、擬似画面 "_layout" に 1 回だけ載せる。
// 再実行しても、手動追記（source: "manual"）の要素は引き継ぐ。
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { LAYOUT, short, decodeEntities, classHint, buildPages, carryOver, writeInventory, printTable, printVariations, printLibraries } from "./lib/core.mjs";

const htmlRoot = resolve(process.argv[2] ?? ".");
const outDir = resolve(process.argv[3] ?? join(htmlRoot, "testcases"));
const outPath = join(outDir, "inventory.json");
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
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const has = (attrs, key) => Object.prototype.hasOwnProperty.call(attrs, key);
const toggleOf = (a) => a["data-toggle"] ?? a["data-bs-toggle"];
const isButtonLike = (a) => /(^|\s)btn(\s|$|-)/.test(a.class ?? "") || a.role === "button";
const STATE_CLASS = /^(active|show|open|collapsed|current|selected|disabled|is-active|is-open)$/i;

const LIBRARIES = [
  ["DataTables", /datatables|dataTable\(/i],
  ["Chart.js", /chart(\.min)?\.js|new Chart\(/i],
  ["Select2", /select2/i],
  ["flatpickr", /flatpickr/i],
  ["jQuery UI", /jquery-ui/i],
  ["Swiper", /swiper/i],
  ["Slick", /slick(\.min)?\.js/i],
  ["Leaflet", /leaflet/i],
  ["Google Maps", /maps\.googleapis/i],
  ["reCAPTCHA", /recaptcha/i],
  ["Stripe", /js\.stripe\.com/i],
  ["ApexCharts", /apexcharts/i],
  ["ECharts", /echarts/i],
  ["Highcharts", /highcharts/i],
  ["FullCalendar", /fullcalendar/i],
  ["SweetAlert", /sweetalert/i],
  ["Dropzone", /dropzone/i],
  ["TinyMCE / CKEditor / Quill", /tinymce|ckeditor|quill/i],
];

function toggleFields(a, label) {
  const target = a["data-target"] ?? a["data-bs-target"] ?? (a.href && a.href !== "#" ? a.href : "");
  return { key: `${toggleOf(a)}:${target || a.id || short(label)}`, fields: { toggle: toggleOf(a), target, label } };
}

function extract(file, html) {
  const libraries = LIBRARIES.filter(([, re]) => re.test(html)).map(([name]) => name);
  // コメント・script・style の中の擬似タグを要素として拾わないよう先に除く
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");

  const title = stripTags(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const formRanges = [...body.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => [m.index, m.index + m[0].length]);
  const inForm = (pos) => formRanges.some(([a, b]) => pos > a && pos < b);
  const headings = [...body.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => ({ pos: m.index, text: stripTags(m[1]) })).filter((h) => h.text);
  const headingBefore = (pos) => [...headings].reverse().find((h) => h.pos < pos)?.text ?? "";
  const ctxOf = (a, pos) => {
    const state = String(a.class ?? "").split(/\s+/).filter((c) => STATE_CLASS.test(c));
    return { inForm: inForm(pos), state };
  };
  // 名前の無い要素は、title・class・中のアイコン・直前の見出しの順で名前を作る。連番は最後の手段
  const nameFor = (a, inner, pos) => {
    const label = stripTags(inner ?? "") || a["aria-label"] || a.title || "";
    if (label) return label;
    const iconClasses = [...String(inner ?? "").matchAll(/class\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]).join(" ");
    const hint = classHint(`${a.class ?? ""} ${iconClasses}`);
    // 見出しは画面ごとに違い、共通部品の判定を壊すので、class からも名前が作れないときだけ使う
    if (hint) return hint;
    const h = headingBefore(pos);
    return h ? `@${short(h)}` : "";
  };

  const elements = [];
  let seq = 0;
  const add = (type, key, fields) => elements.push({ type, key: type === "page" ? "" : key || String(++seq), ...fields });

  add("page", "", { title });

  for (const m of body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const a = parseAttrs(m[1]);
    const inputs = [...m[2].matchAll(/<(?:input|textarea|select)\b([^>]*)>/gi)]
      .map((x) => parseAttrs(x[1]))
      .filter((x) => (x.type ?? "").toLowerCase() !== "hidden")
      .map((x) => x.name || x.id || x.placeholder || x.type || "?");
    const key = a.id || a.name || a["aria-label"] || classHint(a.class) || (a.action ? `action:${a.action}` : "") || `@${short(headingBefore(m.index))}`;
    add("form", key, { action: a.action ?? "", method: (a.method || "get").toLowerCase(), inputs });
  }

  const groups = new Map(); // radio / checkbox は name 単位で 1 要素にまとめる
  for (const m of body.matchAll(/<input\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    const type = (a.type || "text").toLowerCase();
    if (type === "hidden") continue;
    const ctx = ctxOf(a, m.index);
    if (["submit", "button", "reset", "image"].includes(type)) {
      add("button", a.id || a.name || a.value || nameFor(a, "", m.index), { label: a.value ?? "", buttonType: type, ctx });
      continue;
    }
    if (type === "radio" || type === "checkbox") {
      const key = a.name || a.id || nameFor(a, "", m.index);
      const gk = `${type}:${key}`;
      if (!groups.has(gk)) groups.set(gk, { type, key, options: [], required: false, ctx });
      const g = groups.get(gk);
      g.options.push(a.value ?? a.id ?? "");
      g.required ||= has(a, "required");
      continue;
    }
    const fields = { inputType: type, required: has(a, "required") };
    for (const k of ["pattern", "min", "max", "minlength", "maxlength", "placeholder"]) if (has(a, k)) fields[k] = a[k];
    add("input", a.name || a.id || a["aria-label"] || a.placeholder || nameFor(a, "", m.index), { ...fields, ctx });
  }
  for (const g of groups.values()) add(g.type, g.key, { options: g.options, required: g.required, ctx: g.ctx });

  for (const m of body.matchAll(/<textarea\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    const fields = { inputType: "textarea", required: has(a, "required") };
    for (const k of ["minlength", "maxlength", "placeholder"]) if (has(a, k)) fields[k] = a[k];
    add("input", a.name || a.id || a["aria-label"] || a.placeholder || nameFor(a, "", m.index), { ...fields, ctx: ctxOf(a, m.index) });
  }

  for (const m of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const a = parseAttrs(m[1]);
    const options = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/option>|$)/gi)].map((o) => {
      const oa = parseAttrs(o[1]);
      return has(oa, "value") ? oa.value : stripTags(o[2]);
    });
    add("select", a.name || a.id || a["aria-label"] || nameFor(a, "", m.index), { options, required: has(a, "required"), multiple: has(a, "multiple"), ctx: ctxOf(a, m.index) });
  }

  for (const m of body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const a = parseAttrs(m[1]);
    const label = nameFor(a, m[2], m.index);
    const ctx = ctxOf(a, m.index);
    if (toggleOf(a)) {
      const t = toggleFields(a, label);
      add("toggle", t.key, { ...t.fields, ctx });
      continue;
    }
    // type 未指定の button は form の中でだけ submit になる
    const buttonType = (a.type || (ctx.inForm ? "submit" : "button")).toLowerCase();
    add("button", a.id || a.name || short(label), { label, buttonType, ctx });
  }

  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = parseAttrs(m[1]);
    const label = nameFor(a, m[2], m.index);
    const ctx = ctxOf(a, m.index);
    const href = a.href ?? "";
    const jsOnly = href === "" || href.startsWith("#") || /^javascript:/i.test(href);
    if (toggleOf(a)) {
      const t = toggleFields(a, label);
      add("toggle", t.key, { ...t.fields, ctx });
    } else if (isButtonLike(a)) {
      // 見た目がボタンの a 要素。href="#" なら JS で動くボタン、そうでなければ遷移するボタン
      add("button", a.id || short(label) || href, { label, buttonType: jsOnly ? "js" : "link", href, ctx });
    } else if (jsOnly) {
      const anchor = href && href !== "#" ? href : "";
      add("action", a.id || short(label) || anchor, { label, href, ctx });
    } else if (/^(https?:|mailto:|tel:|\/\/)/i.test(href)) {
      add("external", `${short(label) || "?"}->${href}`, { label, href, ctx });
    } else if (!/^data:/i.test(href)) {
      add("link", `${short(label) || "?"}->${href}`, { label, href, ctx });
    }
  }

  return { file, title, ...(libraries.length ? { libraries } : {}), elements };
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

const { pages, layoutCount, threshold } = buildPages(raw);
const carried = carryOver(pages, outPath);
const root = relative(outDir, htmlRoot).split(sep).join("/") || ".";
writeInventory(outPath, { mode: "static", root, pages });

const total = pages.reduce((n, p) => n + p.elements.length, 0);
console.log(`HTML ファイル ${files.length} / 画面 ${raw.length}（+ 共通部品 ${layoutCount > 0 ? 1 : 0}）/ 要素 ${total} -> ${outPath}`);
if (layoutCount > 0) console.log(`共通部品: ${threshold} 画面以上に同じ形で現れる ${layoutCount} 要素を ${LAYOUT} にまとめた`);
if (carried.manual) console.log(`前回から引き継ぎ: 手動追記 ${carried.manual} 件`);
console.log("");
printTable(pages);
printVariations(pages);
printLibraries(pages);

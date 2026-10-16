#!/usr/bin/env node
// 使い方: node routes.mjs <プロジェクトのルート> [出力ファイル=<ルート>/testcases/routes.json]
// ソースから画面のルートを静的に拾い、crawl.mjs の起点（seed）にする。
// 対応: Next.js（pages/・app/）、Nuxt（pages/）、SvelteKit（src/routes/）、React Router・Vue Router などの
// path 指定（JSX の <Route path> とオブジェクト形式の path:）、静的 HTML ファイル。
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep, dirname, basename, extname } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const outPath = resolve(process.argv[3] ?? join(root, "testcases", "routes.json"));
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".output", "dist", "build", "out",
  "coverage", "testcases", "vendor", "public", "static", "tests", "test", "__tests__", "e2e", ".turbo", ".vercel",
]);
const CODE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".vue", ".svelte"]);

if (!existsSync(root)) {
  console.error(`ディレクトリがありません: ${root}`);
  process.exit(2);
}

function walk(dir, skip = SKIP_DIRS) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) files.push(...walk(path, skip));
    else files.push(path);
  }
  return files;
}

const rel = (p) => relative(root, p).split(sep).join("/");
const routes = new Map(); // path -> { path, kind, sources: [] }
const frameworks = new Set();
function addRoute(path, kind, source) {
  let p = path.replace(/\/{2,}/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/$/, "");
  const r = routes.get(p) ?? { path: p, kind, sources: [] };
  if (!r.sources.includes(source)) r.sources.push(source);
  routes.set(p, r);
}

// [id] -> :id、[...slug] / [[...slug]] -> :slug*
const bracketToParam = (seg) =>
  seg
    .replace(/^\[\[\.\.\.(.+)\]\]$/, ":$1*")
    .replace(/^\[\.\.\.(.+)\]$/, ":$1*")
    .replace(/^\[(.+)\]$/, ":$1");

let pkg = {};
try {
  pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch {}
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

// Next.js / Nuxt の pages ディレクトリ
for (const base of ["pages", "src/pages"]) {
  const dir = join(root, base);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  const isNuxt = Boolean(deps.nuxt);
  frameworks.add(isNuxt ? "nuxt-pages" : "next-pages");
  for (const f of walk(dir, new Set(["node_modules"]))) {
    const ext = extname(f);
    if (!(isNuxt ? [".vue"] : [".js", ".jsx", ".ts", ".tsx", ".mdx"]).includes(ext)) continue;
    const r = rel(f).slice(base.length + 1, -ext.length);
    if (/(^|\/)(_app|_document|_error|_middleware|middleware)$/.test(r) || r.startsWith("api/")) continue;
    if (/\.(test|spec|stories)$/.test(r)) continue;
    const segs = r.split("/").map(bracketToParam).filter((s) => s !== "index");
    addRoute(`/${segs.join("/")}`, "file", rel(f));
  }
}

// Next.js app ディレクトリ
for (const base of ["app", "src/app"]) {
  const dir = join(root, base);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  const pagesFound = walk(dir, new Set(["node_modules"])).filter((f) => /^page\.(js|jsx|ts|tsx|mdx)$/.test(basename(f)));
  if (pagesFound.length === 0) continue;
  frameworks.add("next-app");
  for (const f of pagesFound) {
    const segs = rel(dirname(f)).slice(base.length).split("/").filter(Boolean);
    // (group) は URL に出ない。@slot（並列ルート）と _private は画面ではない
    if (segs.some((s) => s.startsWith("@") || s.startsWith("_"))) continue;
    const path = segs.filter((s) => !/^\(.*\)$/.test(s)).map(bracketToParam);
    addRoute(`/${path.join("/")}`, "file", rel(f));
  }
}

// SvelteKit
{
  const dir = join(root, "src", "routes");
  if (existsSync(dir) && deps["@sveltejs/kit"]) {
    frameworks.add("sveltekit");
    for (const f of walk(dir).filter((f) => /^\+page\.svelte$/.test(basename(f)))) {
      const segs = rel(dirname(f)).slice("src/routes".length).split("/").filter(Boolean);
      const path = segs.filter((s) => !/^\(.*\)$/.test(s)).map(bracketToParam);
      addRoute(`/${path.join("/")}`, "file", rel(f));
    }
  }
}

// コードに書かれた path 指定（React Router・Vue Router・Angular など）。
// 入れ子の相対パスは親との連結までは追わないので、relative として残す
const codeFiles = walk(root).filter((f) => CODE_EXT.has(extname(f)));
const routerHint = /react-router|@tanstack\/react-router|vue-router|@angular\/router|wouter|createBrowserRouter|createHashRouter|createRouter|RouterModule|<Route\b/;
for (const f of codeFiles) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (!routerHint.test(src)) continue;
  const found = [];
  for (const m of src.matchAll(/<Route\b[^>]*?\bpath\s*=\s*(?:\{\s*)?["'`]([^"'`]*)["'`]/g)) found.push(m[1]);
  for (const m of src.matchAll(/\bpath\s*:\s*["'`]([^"'`]*)["'`]/g)) found.push(m[1]);
  if (found.length === 0) continue;
  if (/vue-router/.test(src)) frameworks.add("vue-router");
  else if (/@angular\/router|RouterModule/.test(src)) frameworks.add("angular-router");
  else frameworks.add("react-router");
  for (const p of found) {
    if (p === "*" || p === "**" || p === "/*" || p.startsWith("/:pathMatch")) continue;
    if (/^https?:/.test(p)) continue;
    const relative_ = !p.startsWith("/");
    addRoute(p.replace(/\(\.\*\)\*?$/, "*"), relative_ ? "relative" : "code", rel(f));
  }
}

// 静的 HTML。バンドラーを使うプロジェクトの .html はビルド用のテンプレートなので画面として扱わない
const bundler = ["webpack", "vite", "parcel", "rollup", "esbuild", "react-scripts", "next", "nuxt", "@angular/core", "@sveltejs/kit", "astro"].find((d) => deps[d]);
if (routes.size === 0 && bundler) frameworks.add(`${bundler}（ルート定義なし。ハッシュルーティングかルーター未使用の可能性）`);
if (routes.size === 0 && !bundler) {
  for (const f of walk(root).filter((f) => /\.html?$/i.test(f))) {
    frameworks.add("static-html");
    const r = rel(f);
    addRoute(r === "index.html" ? "/" : `/${r}`, "file", r);
  }
}

const list = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ root: relative(dirname(outPath), root).split(sep).join("/") || ".", frameworks: [...frameworks], routes: list }, null, 2) + "\n");

const withParams = list.filter((r) => r.path.includes(":"));
const relatives = list.filter((r) => r.kind === "relative");
console.log(`フレームワーク: ${[...frameworks].join(", ") || "不明"} / ルート ${list.length}（パラメータ付き ${withParams.length}、相対パス ${relatives.length}）-> ${outPath}`);
for (const r of list) console.log(`  ${r.path}${r.kind === "relative" ? "  （相対パス。親ルートとの連結は未確認）" : ""}  <- ${r.sources[0]}${r.sources.length > 1 ? ` 他 ${r.sources.length - 1}` : ""}`);
if (list.length === 0) console.log("ルートが見つかりませんでした。crawl.mjs はトップページからリンクをたどるだけになります。");

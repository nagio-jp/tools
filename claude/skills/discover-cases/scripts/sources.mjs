#!/usr/bin/env node
// 使い方: node sources.mjs <対象のルート> [出力ファイル=<ルート>/testcases/sources.json]
// テストケースの根拠にできる資料の候補を、リポジトリから機械的に探して種類ごとに並べる（問診の材料）。
// 見つからなかった種類も「見つからなかった」として出し、人が抜けに気づけるようにする。
// 再実行しても、人が足した資料（source: "manual"）と回答（answers）は引き継ぐ。
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep, basename, extname, dirname } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const outPath = resolve(process.argv[3] ?? join(root, "testcases", "sources.json"));
const SKIP = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "coverage", "testcases", "vendor", ".venv", "venv", "__pycache__", "target", ".turbo", ".vercel", ".idea", ".vscode"]);
const MAX_FILES = 20000;

if (!existsSync(root)) {
  console.error(`ディレクトリがありません: ${root}`);
  process.exit(2);
}

const files = [];
const dirs = [];
(function walk(dir, depth) {
  if (files.length >= MAX_FILES) return;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      dirs.push(path);
      if (depth < 12) walk(path, depth + 1);
    } else files.push(path);
  }
})(root, 0);

const rel = (p) => relative(root, p).split(sep).join("/") || ".";
const read = (p, max = 200_000) => {
  try {
    return readFileSync(p, "utf8").slice(0, max);
  } catch {
    return "";
  }
};
const byName = (re) => files.filter((f) => re.test(basename(f)));
const byPath = (re) => files.filter((f) => re.test(rel(f)));
const dirsNamed = (re) => dirs.filter((d) => re.test(basename(d)));

const packages = byName(/^package\.json$/).map((f) => {
  let json = {};
  try {
    json = JSON.parse(read(f));
  } catch {}
  return { path: f, json, deps: { ...json.dependencies, ...json.devDependencies } };
});
const anyDep = (re) =>
  packages.flatMap((p) => Object.keys(p.deps).filter((d) => re.test(d)).map((d) => ({ path: rel(p.path), reason: `依存: ${d}` })));

const categories = [];
// hints は「無いことを示す手がかり」。found が空でも、人が判断する材料として出す
function category(key, label, use, found, hints = []) {
  const seen = new Set();
  const list = found.filter((x) => x && !seen.has(`${x.path}|${x.reason}`) && seen.add(`${x.path}|${x.reason}`));
  categories.push({ key, label, use, found: list, ...(hints.length ? { hints } : {}) });
}
const asFound = (paths, reason) => paths.map((p) => ({ path: rel(p), reason }));

// ---- フロントエンド ----
{
  const found = [];
  found.push(...anyDep(/^(react|react-dom|next|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|jquery|solid-js|preact|astro|remix|@remix-run\/react|react-router(-dom)?|vue-router)$/));
  for (const p of packages) {
    for (const s of ["dev", "start", "serve", "preview"]) if (p.json.scripts?.[s]) found.push({ path: rel(p.path), reason: `起動: npm run ${s}（${p.json.scripts[s]}）` });
  }
  const html = byName(/\.html?$/i);
  if (html.length) found.push({ path: rel(dirname(html[0])), reason: `HTML ${html.length} ファイル（例: ${rel(html[0])}）` });
  found.push(...asFound(byName(/^(vite|webpack|next|nuxt|svelte|astro|angular)\.config\.(js|ts|mjs|cjs)$|^angular\.json$/), "ビルド設定"));
  category("frontend", "フロントエンド（フレームワーク・起動方法）", "工程 1 の棚卸しの方式（静的 HTML か、起動して巡回か）を決める", found);
}

// ---- バックエンド ----
{
  const found = [];
  found.push(...asFound(byName(/^(go\.mod|requirements\.txt|pyproject\.toml|Pipfile|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|Cargo\.toml|mix\.exs)$|\.csproj$/), "サーバー側の言語の定義"));
  found.push(...asFound(dirsNamed(/^(server|backend|api|functions|lambda|handlers|controllers)$/), "サーバー側らしきディレクトリ"));
  found.push(...asFound(byPath(/(^|\/)(pages\/api\/|app\/(.+\/)?route\.(js|ts))/), "Next.js の API ルート"));
  found.push(...anyDep(/^(express|fastify|koa|@nestjs\/core|hono|@hapi\/hapi|firebase-functions|json-server|msw)$/));
  const php = byName(/\.php$/);
  if (php.length) found.push({ path: rel(dirname(php[0])), reason: `PHP ${php.length} ファイル` });
  // 静的 HTML の form の送信先。送信先が無い・# なら、送信処理が無い可能性が高い
  const actions = new Map();
  let formsWithoutAction = 0;
  for (const f of byName(/\.html?$/i).slice(0, 300)) {
    for (const m of read(f).matchAll(/<form\b([^>]*)>/gi)) {
      const a = m[1].match(/\baction\s*=\s*["']([^"']*)["']/i)?.[1];
      if (a && a !== "#") actions.set(a, rel(f));
      else formsWithoutAction++;
    }
  }
  for (const [a, f] of actions) found.push({ path: f, reason: `form の送信先: ${a}` });
  const hints = [];
  if (formsWithoutAction > 0) hints.push(`HTML の form ${formsWithoutAction} 個に送信先（action）が無い。JS で送信していなければ、送信処理は無い`);
  category("backend", "バックエンド（送信処理・データ保存）", "送信失敗・二重送信・保存後の表示のケースを書くかを決める", found, hints);
}

// ---- API 定義 ----
category("api", "API 定義", "入力の制約・エラー応答のケースの根拠にする", [
  ...asFound(byName(/^(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i), "OpenAPI / Swagger"),
  ...asFound(byName(/\.proto$/), "Protocol Buffers"),
  ...asFound(byName(/\.(graphql|gql)$/), "GraphQL スキーマ"),
  ...asFound(byName(/postman_collection\.json$|\.postman_collection$/i), "Postman コレクション"),
  ...asFound(byName(/\.(http|rest)$/), "HTTP リクエスト集"),
]);

// ---- DB ----
category("db", "DB（スキーマ・マイグレーション・初期データ）", "必須・文字数・一意性の制約と、作成→一覧→更新→削除のフローの根拠にする", [
  ...asFound(dirsNamed(/^(migrations?|migrate)$/), "マイグレーション"),
  ...asFound(byName(/^schema\.(sql|rb|prisma)$|\.prisma$/), "スキーマ定義"),
  ...asFound(byName(/\.entity\.(ts|js)$/), "TypeORM エンティティ"),
  ...asFound(byName(/^(sqlboiler\.toml|drizzle\.config\.(ts|js)|knexfile\.(js|ts)|ormconfig\.(json|js|ts)|alembic\.ini)$/), "ORM の設定"),
  ...asFound(dirsNamed(/^(seeds?|fixtures)$/), "初期データ・フィクスチャ"),
  ...asFound(byName(/^(seed|seeds)\.(sql|ts|js|json)$/), "初期データ"),
  ...anyDep(/^(prisma|@prisma\/client|typeorm|sequelize|mongoose|drizzle-orm|knex|@supabase\/supabase-js)$/),
]);

// ---- 仕様・要件 ----
{
  const found = [];
  found.push(...asFound(dirsNamed(/^(docs?|specs?|requirements?|design-docs?|adr|decisions)$/i), "仕様・設計の置き場らしきディレクトリ"));
  found.push(...asFound(byName(/^README(\.[a-z]+)?$/i), "README"));
  const mdKeywords = /仕様|要件|受け入れ条件|受入条件|ユーザーストーリー|画面遷移|requirement|acceptance criteria|user stor(y|ies)|specification/i;
  for (const f of byName(/\.(md|mdx|txt|adoc)$/i).slice(0, 2000)) {
    if (/^README/i.test(basename(f)) || /(^|\/)(CHANGELOG|LICENSE)/i.test(rel(f))) continue;
    const m = read(f, 50_000).match(mdKeywords);
    if (m) found.push({ path: rel(f), reason: `文中に「${m[0]}」` });
  }
  category("spec", "仕様・要件", "期待値の根拠にする。無いと needsReview（あるべき挙動の推測）が増える", found);
}

// ---- 既存のテスト ----
{
  const found = [];
  found.push(...asFound(byName(/^(playwright|cypress|vitest|jest|wdio)\.config\.(js|ts|mjs|cjs|json)$/), "テストの設定"));
  found.push(...asFound(dirsNamed(/^(e2e|cypress|tests?|__tests__|spec)$/), "テストのディレクトリ"));
  const unit = byName(/\.(spec|test)\.(js|jsx|ts|tsx|mjs)$|_test\.(go|py)$|^test_.*\.py$/);
  if (unit.length) found.push({ path: rel(dirname(unit[0])), reason: `テストコード ${unit.length} ファイル（例: ${rel(unit[0])}）` });
  found.push(...asFound(byName(/(test|テスト|試験).*\.(csv|xlsx?|tsv)$|\.(feature)$/i), "テストケース表・Gherkin"));
  category("tests", "既存のテスト", "すでにあるケースと重複させない。既存の E2E が触る画面は優先度を下げられる", found);
}

// ---- 認証 ----
{
  const found = [];
  for (const f of byName(/^\.env(\.(example|sample|template|local\.example|development))?$/)) {
    const keys = read(f).split("\n").map((l) => l.split("=")[0].trim()).filter((k) => /AUTH|LOGIN|USER|PASS|SECRET|FIREBASE|AUTH0|COGNITO|CLERK|SUPABASE|SESSION|JWT|OAUTH/i.test(k));
    if (keys.length) found.push({ path: rel(f), reason: `認証らしき設定: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? " ほか" : ""}` });
  }
  found.push(...anyDep(/^(next-auth|@auth\/core|@auth0\/.+|firebase|@firebase\/auth|@clerk\/.+|passport.*|@supabase\/auth-helpers.*|aws-amplify|@aws-amplify\/auth|lucia|better-auth)$/));
  found.push(...asFound(byPath(/(^|\/)(auth|login|signin|sign-in|session)[^/]*\.(js|ts|tsx|jsx|vue|html|py|go|rb|php)$/i).slice(0, 20), "ログイン・認証らしきファイル"));
  category("auth", "認証（ログイン方式・テスト用アカウント）", "ログインが要る画面を巡回できるようにする。認証エラーのケースを書くかを決める", found);
}

// ---- デザイン ----
{
  const found = [];
  found.push(...asFound(dirsNamed(/^\.storybook$/), "Storybook"));
  const stories = byName(/\.stories\.(js|jsx|ts|tsx|mdx)$/);
  if (stories.length) found.push({ path: rel(dirname(stories[0])), reason: `Storybook のストーリー ${stories.length} ファイル` });
  for (const f of byName(/\.(md|mdx)$/i).slice(0, 2000)) {
    const m = read(f, 50_000).match(/https:\/\/(www\.)?figma\.com\/[^\s)"'>]+/);
    if (m) found.push({ path: rel(f), reason: `Figma のリンク: ${m[0].slice(0, 80)}` });
  }
  category("design", "デザイン", "見た目の期待値（文言・並び・状態ごとの表示）の根拠にする", found);
}

// 前回の回答と、人が足した資料を引き継ぐ
let prev = null;
if (existsSync(outPath)) {
  try {
    prev = JSON.parse(readFileSync(outPath, "utf8"));
  } catch {}
}
for (const c of categories) {
  const manual = prev?.categories?.find((x) => x.key === c.key)?.found?.filter((x) => x.source === "manual") ?? [];
  c.found.push(...manual);
}
const extra = prev?.extra?.filter((x) => x.source === "manual") ?? [];

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    { root: relative(dirname(outPath), root).split(sep).join("/") || ".", scannedFiles: files.length, categories, extra, answers: prev?.answers ?? {} },
    null,
    2,
  ) + "\n",
);

console.log(`参考資料の候補（${files.length} ファイルを走査）-> ${outPath}\n`);
for (const c of categories) {
  if (c.found.length === 0) {
    console.log(`■ ${c.label}: 見つからなかった`);
    for (const h of c.hints ?? []) console.log(`  （手がかり: ${h}）`);
    continue;
  }
  console.log(`■ ${c.label}: ${c.found.length} 件`);
  for (const x of c.found.slice(0, 8)) console.log(`  - ${x.path}  （${x.reason}）${x.source === "manual" ? " [人が追加]" : ""}`);
  if (c.found.length > 8) console.log(`  - 他 ${c.found.length - 8} 件（sources.json を参照）`);
}
if (files.length >= MAX_FILES) console.log(`\n走査の上限（${MAX_FILES} ファイル）で打ち切った。対象ディレクトリを絞って実行し直すとよい`);

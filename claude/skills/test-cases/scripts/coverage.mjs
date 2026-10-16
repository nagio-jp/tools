#!/usr/bin/env node
// 使い方: node coverage.mjs [testcases ディレクトリ=testcases]
// inventory.json の全要素が、ケースの covers か excluded のどちらかに入っているかを判定する。
// exit 0 = 完了 / 1 = 未カバーまたは形式エラー / 2 = 入力ファイルの問題
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "testcases");
const inventoryPath = join(root, "inventory.json");
const casesDir = join(root, "cases");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`読み込めません: ${path}\n  ${e.message}`);
    process.exit(2);
  }
}

if (!existsSync(inventoryPath)) {
  console.error(`inventory.json がありません: ${inventoryPath}（工程 1 を先に実行してください）`);
  process.exit(2);
}

const inventory = readJson(inventoryPath);
const pages = inventory.pages ?? [];
const elements = new Map(); // id -> { page, risk }
for (const page of pages) {
  for (const el of page.elements ?? []) {
    if (elements.has(el.id)) {
      console.error(`inventory.json の ID が重複しています: ${el.id}`);
      process.exit(2);
    }
    elements.set(el.id, { page: page.file, risk: el.risk ?? "normal" });
  }
}

const covered = new Set();
const excluded = new Set();
const errors = [];
const casesPerPage = new Map();
let caseCount = 0;
let excludedCount = 0;
const needsReview = [];

const caseFiles = existsSync(casesDir) ? readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort() : [];

for (const file of caseFiles) {
  const data = readJson(join(casesDir, file));
  const seenCaseIds = new Set();

  for (const c of data.cases ?? []) {
    caseCount++;
    casesPerPage.set(data.page, (casesPerPage.get(data.page) ?? 0) + 1);

    if (!c.id) errors.push(`${file}: id の無いケースがあります（${c.title ?? "タイトルなし"}）`);
    else if (seenCaseIds.has(c.id)) errors.push(`${file}: ケース ID が重複しています: ${c.id}`);
    seenCaseIds.add(c.id);

    for (const field of ["title", "expected"]) {
      if (!c[field]) errors.push(`${file}: ${c.id} に ${field} がありません`);
    }
    if (c.needsReview) needsReview.push(`${c.id}: ${c.title ?? ""}`);
    if (!Array.isArray(c.steps) || c.steps.length === 0) errors.push(`${file}: ${c.id} に steps がありません`);
    if (!Array.isArray(c.covers) || c.covers.length === 0) {
      errors.push(`${file}: ${c.id} に covers がありません`);
      continue;
    }
    for (const id of c.covers) {
      // ID の打ち間違いで、カバーしたつもりの要素が未カバーのまま残るのを防ぐ
      if (!elements.has(id)) errors.push(`${file}: ${c.id} の covers に inventory に無い ID があります: ${id}`);
      else covered.add(id);
    }
  }

  for (const x of data.excluded ?? []) {
    excludedCount++;
    if (!elements.has(x.element)) errors.push(`${file}: excluded に inventory に無い ID があります: ${x.element}`);
    else if (!x.reason || !String(x.reason).trim()) errors.push(`${file}: excluded の理由が空です: ${x.element}`);
    else excluded.add(x.element);
  }
}

// risk: high は除外だけで済ませず、ケースを最低 1 件求める
const uncovered = new Map(); // page -> [id]
for (const [id, el] of elements) {
  const ok = el.risk === "high" ? covered.has(id) : covered.has(id) || excluded.has(id);
  if (ok) continue;
  if (!uncovered.has(el.page)) uncovered.set(el.page, []);
  uncovered.get(el.page).push(el.risk === "high" && excluded.has(id) ? `${id}（risk: high は除外不可）` : id);
}

const uncoveredCount = [...uncovered.values()].flat().length;
console.log(`画面 ${pages.length} / 要素 ${elements.size} / ケース ${caseCount} / 除外 ${excludedCount}`);
console.log(`カバー済み ${covered.size} / 除外のみ ${[...excluded].filter((id) => !covered.has(id)).length} / 未カバー ${uncoveredCount}`);

if (needsReview.length > 0) {
  console.log(`\n要確認（needsReview）のケース (${needsReview.length}):`);
  for (const r of needsReview) console.log(`  - ${r}`);
}

const noCasePages = pages.filter((p) => !casesPerPage.has(p.file)).map((p) => p.file);
if (noCasePages.length > 0) {
  console.log(`\nケースが 1 件も無い画面 (${noCasePages.length}):`);
  for (const p of noCasePages) console.log(`  - ${p}`);
}

if (errors.length > 0) {
  console.log(`\n形式エラー (${errors.length}):`);
  for (const e of errors) console.log(`  - ${e}`);
}

if (uncovered.size > 0) {
  console.log("\n未カバーの要素:");
  for (const [page, ids] of uncovered) {
    console.log(`  ${page} (${ids.length})`);
    for (const id of ids) console.log(`    - ${id}`);
  }
}

if (uncovered.size > 0 || errors.length > 0) {
  console.log("\n未完了です。上の要素のケースを追加して、もう一度実行してください。");
  process.exit(1);
}
console.log("\nすべての要素がカバーされています。");
process.exit(0);

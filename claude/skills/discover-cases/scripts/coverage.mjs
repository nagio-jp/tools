#!/usr/bin/env node
// 使い方: node coverage.mjs [testcases ディレクトリ=testcases]
// inventory.json の全要素が、ケースの covers か excluded のどちらかに入っているかを判定する。
// あわせて、問診（sources.json）が済んでいるか、フロー（_flows）が登録されているかも確かめる。
// exit 0 = 完了 / 1 = 未カバーまたは形式エラー / 2 = 入力ファイルの問題
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "testcases");
const inventoryPath = join(root, "inventory.json");
const sourcesPath = join(root, "sources.json");
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
const errors = [];
const elements = new Map(); // id -> { page, risk, unreached }
for (const page of pages) {
  for (const el of page.elements ?? []) {
    if (elements.has(el.id)) {
      console.error(`inventory.json の ID が重複しています: ${el.id}`);
      process.exit(2);
    }
    elements.set(el.id, { page: page.file, risk: el.risk ?? "normal", unreached: Boolean(page.unreached) });
  }
}

// 問診（工程 0）が済んでいないと、送信失敗などのケースを書くかどうかの前提が決まらない
let sources = null;
if (!existsSync(sourcesPath)) errors.push("sources.json がありません。工程 0（問診）を先に行ってください");
else {
  sources = readJson(sourcesPath);
  for (const k of ["backend", "backendCases"]) {
    if (!sources.answers?.[k]) errors.push(`sources.json の answers.${k} が未記入です（工程 0 の問診で人に確認する）`);
  }
}
if (!pages.some((p) => p.file === "_flows")) {
  errors.push("inventory.json に _flows（画面をまたぐフロー）がありません。工程 1 でフローを登録してください（無ければ elements を空にして note に理由を書く）");
}

const covered = new Set();
const excluded = new Set();
const casesPerPage = new Map();
let caseCount = 0;
let excludedCount = 0;
let withBasis = 0;
const needsReviewLoose = [];
const findings = new Map(); // id -> { summary, file, cases: Set }
const findingRefs = []; // [file, caseId, findingId]
const perspectivesByElement = new Map(); // id -> Set(perspective)

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

    for (const field of ["title", "perspective", "expected"]) {
      if (!c[field]) errors.push(`${file}: ${c.id} に ${field} がありません`);
    }
    if (c.basis) withBasis++;
    if (c.finding) findingRefs.push([file, c.id, c.finding]);
    else if (c.needsReview) needsReviewLoose.push(`${c.id}: ${c.title ?? ""}（${c.needsReview}）`);
    if (!Array.isArray(c.steps) || c.steps.length === 0) errors.push(`${file}: ${c.id} に steps がありません`);
    if (!Array.isArray(c.covers) || c.covers.length === 0) {
      errors.push(`${file}: ${c.id} に covers がありません`);
      continue;
    }
    for (const id of c.covers) {
      // ID の打ち間違いで、カバーしたつもりの要素が未カバーのまま残るのを防ぐ
      if (!elements.has(id)) errors.push(`${file}: ${c.id} の covers に inventory に無い ID があります: ${id}`);
      else {
        covered.add(id);
        if (!perspectivesByElement.has(id)) perspectivesByElement.set(id, new Set());
        if (c.perspective) perspectivesByElement.get(id).add(c.perspective);
      }
    }
  }

  for (const f of data.findings ?? []) {
    if (!f.id || !f.summary) errors.push(`${file}: findings には id と summary が要ります`);
    else if (findings.has(f.id)) errors.push(`${file}: finding の ID が重複しています: ${f.id}（${findings.get(f.id).file} と）`);
    else findings.set(f.id, { summary: f.summary, file, cases: new Set(f.cases ?? []) });
  }

  for (const x of data.excluded ?? []) {
    excludedCount++;
    if (!elements.has(x.element)) errors.push(`${file}: excluded に inventory に無い ID があります: ${x.element}`);
    else if (!x.reason || !String(x.reason).trim()) errors.push(`${file}: excluded の理由が空です: ${x.element}`);
    else excluded.add(x.element);
  }
}

for (const [file, caseId, fid] of findingRefs) {
  if (!findings.has(fid)) errors.push(`${file}: ${caseId} の finding「${fid}」が、どの cases/*.json の findings にもありません`);
  else findings.get(fid).cases.add(caseId);
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

console.log(`根拠（basis）付きのケース ${withBasis} / ${caseCount}`);

if (sources?.answers) {
  const a = sources.answers;
  console.log(`\n前提（問診の回答）: バックエンド ${a.backend} / 送信失敗・認証エラーなどのケース ${a.backendCases}`);
}
const missing = (sources?.categories ?? []).filter((c) => c.found.length === 0).map((c) => c.label);
if (missing.length > 0) {
  console.log(`資料が無い種類（期待値は推測になり、要確認が増える）: ${missing.join(" / ")}`);
}

if (findings.size > 0) {
  const list = [...findings].sort((a, b) => b[1].cases.size - a[1].cases.size);
  const total = list.reduce((n, [, f]) => n + f.cases.size, 0);
  console.log(`\n要確認の指摘（findings）${findings.size} 件・関連ケース ${total} 件:`);
  for (const [id, f] of list) console.log(`  - ${id}（${f.cases.size} 件）: ${f.summary}`);
}
if (needsReviewLoose.length > 0) {
  console.log(`\nfindings にまとめていない要確認のケース (${needsReviewLoose.length}):`);
  for (const r of needsReviewLoose) console.log(`  - ${r}`);
  console.log("  同じ原因のものは findings にまとめ、ケースからは finding で参照する");
}

const highEls = [...elements].filter(([, e]) => e.risk === "high");
if (highEls.length > 0) {
  console.log(`\nrisk: high の要素の観点の種類数:`);
  for (const [id] of highEls) {
    const ps = perspectivesByElement.get(id) ?? new Set();
    console.log(`  - ${id}: ${ps.size} 種類${ps.size < 3 ? "（少ない。工程の観点表を見直す）" : ""}`);
  }
}

const unreached = pages.filter((p) => p.unreached);
if (unreached.length > 0) {
  console.log(`\n巡回で到達できなかった画面 (${unreached.length})（ログインやパラメータを用意して巡回し直すか、理由付きで除外する）:`);
  for (const p of unreached) console.log(`  - ${p.file}: ${p.reason}`);
}

const noCasePages = pages.filter((p) => !p.unreached && (p.elements?.length ?? 0) > 0 && !casesPerPage.has(p.file)).map((p) => p.file);
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
  console.log("\n未完了です。上の指摘を直して、もう一度実行してください。");
  process.exit(1);
}
console.log("\nすべての要素がカバーされています。");
process.exit(0);

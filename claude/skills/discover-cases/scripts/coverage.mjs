#!/usr/bin/env node
// 使い方: node coverage.mjs [testcases ディレクトリ=testcases]
// 機能 → 画面 → テストケースの洗い出しに抜けが無いかを判定し、人がレビューする summary.md を書き出す。
//   - 問診（sources.json の answers）が埋まっている
//   - 全機能にケースがある / 全画面がどれかの機能に属するか対象外 / 全要素がどれかのケースの covers に入るか対象外
// exit 0 = 完了 / 1 = 抜けまたは形式エラー / 2 = 入力ファイルの問題
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LAYOUT } from "./lib/core.mjs";
import { readJson, loadScreens, loadFeatures, groupFeatures, PERSPECTIVES } from "./lib/plan.mjs";

const root = resolve(process.argv[2] ?? "testcases");
const casesDir = join(root, "cases");
const summaryPath = join(root, "summary.md");

const { source, pages } = loadScreens(root);
if (source !== "inventory") {
  console.error(`inventory.json がありません: ${join(root, "inventory.json")}（工程 2 の棚卸しを先に実行してください）`);
  process.exit(2);
}

const errors = [];

// ---- 問診 ----
const ANSWERS = { backend: ["yes", "no", "unknown"], login: ["no", "yes", "unknown"] };
const BACKEND_LABEL = { yes: "ある", no: "ない", unknown: "分からない" };
const LOGIN_LABEL = { no: "不要", yes: "必要", unknown: "分からない" };
let sources = null;
if (!existsSync(join(root, "sources.json"))) errors.push("sources.json がありません。工程 0（問診）を先に行ってください");
else {
  sources = readJson(join(root, "sources.json"));
  const a = sources.answers ?? {};
  if (a.sourcesConfirmed !== true) errors.push("sources.json の answers.sourcesConfirmed が true ではありません（工程 0 で資料の一覧を人に確認する）");
  for (const [k, values] of Object.entries(ANSWERS)) {
    if (!values.includes(a[k])) errors.push(`sources.json の answers.${k} は ${values.join(" / ")} のどれか（工程 0 の問診で人に確認する）: ${a[k] ?? "未記入"}`);
  }
}
const backendNo = sources?.answers?.backend === "no";

// ---- 機能と画面 ----
const plan = loadFeatures(root, pages);
errors.push(...plan.errors);
for (const s of plan.unassigned) errors.push(`どの機能にも属さない画面があります: ${s}（機能を足すか、features.json の excludedScreens に理由付きで入れる）`);
const excludedScreenSet = new Set(plan.excludedScreens.map((x) => x.screen));
const pageIds = new Set(pages.map((p) => p.file));

const elements = new Map(); // id -> page
for (const page of pages) {
  for (const el of page.elements ?? []) {
    if (elements.has(el.id)) {
      console.error(`inventory.json の ID が重複しています: ${el.id}`);
      process.exit(2);
    }
    elements.set(el.id, page.file);
  }
}

// ---- ケース ----
const covered = new Set();
const excluded = new Map(); // element -> reason
const caseIds = new Set();
const casesByFeature = new Map(); // feature -> [case]
const questions = []; // { feature, id, title, question }
let caseCount = 0;
let withBasis = 0;

const caseFiles = existsSync(casesDir) ? readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort() : [];
for (const file of caseFiles) {
  const data = readJson(join(casesDir, file));
  if (!data.feature) {
    errors.push(`${file}: feature（機能 ID）がありません`);
    continue;
  }
  const feature = plan.byId.get(data.feature);
  if (!feature) {
    errors.push(`${file}: feature「${data.feature}」が features.json にありません`);
    continue;
  }
  if (file !== `${data.feature}.json`) errors.push(`${file}: ファイル名は <機能 ID>.json にする（${data.feature}.json）`);
  if (casesByFeature.has(data.feature)) errors.push(`${file}: 機能 ${data.feature} のケースファイルが複数あります`);
  const list = casesByFeature.get(data.feature) ?? [];
  casesByFeature.set(data.feature, list);
  const featureScreens = new Set(feature.screens ?? []);

  for (const c of data.cases ?? []) {
    caseCount++;
    list.push(c);
    const label = `${file}: ${c.id ?? c.title ?? "id なし"}`;
    if (!c.id) errors.push(`${label} に id がありません`);
    else if (caseIds.has(c.id)) errors.push(`${label}: ケース ID が重複しています`);
    caseIds.add(c.id);
    for (const k of ["title", "expected"]) if (!c[k]) errors.push(`${label} に ${k} がありません`);
    if (!PERSPECTIVES.includes(c.perspective)) errors.push(`${label} の perspective は ${PERSPECTIVES.join(" / ")} のどれか: ${c.perspective ?? "未記入"}`);
    if (backendNo && c.perspective === "異常系") errors.push(`${label}: 問診で「サーバーはない」なので、異常系（保存・送信の失敗など）は書かない`);
    if (!Array.isArray(c.steps) || c.steps.length === 0) errors.push(`${label} に steps がありません`);
    if (c.basis) withBasis++;
    if (c.question) questions.push({ feature: data.feature, id: c.id, title: c.title, question: c.question });

    if (!Array.isArray(c.screens) || c.screens.length === 0) errors.push(`${label} に screens（通る画面）がありません`);
    for (const s of c.screens ?? []) {
      if (!pageIds.has(s)) errors.push(`${label} の screens に、inventory に無い画面があります: ${s}`);
      else if (s !== LAYOUT && !featureScreens.has(s)) errors.push(`${label} は画面 ${s} を通るが、機能 ${data.feature} の screens にありません（features.json に足す）`);
    }
    if (!Array.isArray(c.covers) || c.covers.length === 0) {
      errors.push(`${label} に covers（操作・確認する要素の ID）がありません`);
      continue;
    }
    for (const id of c.covers) {
      // ID の打ち間違いで、カバーしたつもりの要素が未カバーのまま残るのを防ぐ
      if (!elements.has(id)) errors.push(`${label} の covers に inventory に無い ID があります: ${id}`);
      else covered.add(id);
    }
  }

  for (const x of data.excluded ?? []) {
    if (!elements.has(x.element)) errors.push(`${file}: excluded に inventory に無い ID があります: ${x.element}`);
    else if (!x.reason || !String(x.reason).trim()) errors.push(`${file}: excluded の理由が空です: ${x.element}`);
    else excluded.set(x.element, x.reason);
  }
}

for (const f of plan.features) {
  if (!(casesByFeature.get(f.id)?.length > 0)) errors.push(`ケースの無い機能があります: ${f.id}（${f.name}）`);
}

const uncovered = new Map(); // page -> [id]
for (const [id, page] of elements) {
  if (covered.has(id) || excluded.has(id) || excludedScreenSet.has(page)) continue;
  if (!uncovered.has(page)) uncovered.set(page, []);
  uncovered.get(page).push(id);
}
const uncoveredCount = [...uncovered.values()].flat().length;
const ok = errors.length === 0 && uncoveredCount === 0;
const missingSources = (sources?.categories ?? []).filter((c) => c.found.length === 0).map((c) => c.label);

// ---- 出力 ----
console.log(`機能 ${plan.features.length} / 画面 ${pages.length}（対象外 ${excludedScreenSet.size}）/ 要素 ${elements.size} / ケース ${caseCount}`);
console.log(`要素: ケースで確認 ${covered.size} / 対象外 ${[...excluded.keys()].filter((id) => !covered.has(id)).length} / 未カバー ${uncoveredCount}`);
console.log(`根拠（basis）付きのケース ${withBasis} / ${caseCount}、仕様の確認事項 ${questions.length} 件`);
if (sources?.answers) {
  const a = sources.answers;
  console.log(`前提（問診の回答）: サーバー ${BACKEND_LABEL[a.backend] ?? "未確認"} / ログイン ${LOGIN_LABEL[a.login] ?? "未確認"}`);
}
if (missingSources.length > 0) console.log(`資料が無い種類（期待値は画面の現状の挙動に頼る）: ${missingSources.join(" / ")}`);

const high = plan.features.filter((f) => f.priority === "high");
if (high.length > 0) {
  console.log("\n優先度 high の機能の観点:");
  for (const f of high) {
    const cs = casesByFeature.get(f.id) ?? [];
    const kinds = new Set(cs.map((c) => c.perspective));
    console.log(`  - ${f.id}: ケース ${cs.length} 件 / 観点 ${kinds.size} 種類（${[...kinds].join("・")}）${kinds.size < 3 ? " ← 少ない。観点表を見直す" : ""}`);
  }
}

if (errors.length > 0) {
  console.log(`\n形式エラー・抜け (${errors.length}):`);
  for (const e of errors) console.log(`  - ${e}`);
}
if (uncovered.size > 0) {
  console.log("\nどのケースでも確認していない要素（ケースの covers に入れるか、その機能の excluded に理由付きで入れる）:");
  for (const [page, ids] of uncovered) {
    console.log(`  ${page} (${ids.length})`);
    for (const id of ids) console.log(`    - ${id}`);
  }
}

writeFileSync(summaryPath, summaryMarkdown());
console.log(`\nsummary.md を書き出しました: ${summaryPath}`);

if (!ok) {
  console.log("\n未完了です。上の指摘を直して、もう一度実行してください。");
  process.exit(1);
}
console.log("\nすべての機能・画面・要素がケースか対象外で埋まっています。");
process.exit(0);

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function countBy(list) {
  const m = Object.fromEntries(PERSPECTIVES.map((p) => [p, 0]));
  for (const c of list) if (c.perspective in m) m[c.perspective]++;
  return m;
}

function summaryMarkdown() {
  const L = [];
  const a = sources?.answers ?? {};
  const all = [...casesByFeature.values()].flat();
  L.push("# テストケースの洗い出し結果", "");
  L.push(`- 状態: ${ok ? "完了（抜けなし）" : `**未完了**（抜け・形式エラー ${errors.length + uncoveredCount} 件。coverage.mjs の出力を参照）`}`);
  L.push(`- 規模: 機能 ${plan.features.length} / 画面 ${pages.length - excludedScreenSet.size}（対象外 ${excludedScreenSet.size}）/ ケース ${caseCount} / 仕様の確認事項 ${questions.length}`);
  L.push(`- 前提: 保存・送信するサーバー ${BACKEND_LABEL[a.backend] ?? "未確認"} / ログイン ${LOGIN_LABEL[a.login] ?? "未確認"}`);
  if (missingSources.length > 0) L.push(`- 資料が無い種類: ${missingSources.join(" / ")}（期待値は画面の現状の挙動から書いた）`);
  L.push("");

  L.push("## 機能とケース数", "");
  const used = PERSPECTIVES.filter((p) => all.some((c) => c.perspective === p));
  const PRIORITY_LABEL = { high: "高", normal: "中", low: "低" };
  L.push(`| 機能グループ | # | 機能 | 優先度 | 画面 | ${used.join(" | ")} | 計 |`);
  L.push(`|---|---|---|---|---|${used.map(() => "---:").join("|")}|---:|`);
  let n = 0;
  for (const [group, list] of groupFeatures(plan.features)) {
    list.forEach((f, i) => {
      n++;
      const cs = casesByFeature.get(f.id) ?? [];
      const by = countBy(cs);
      const names = (f.screens ?? []).map((s) => (s === LAYOUT ? "共通部品" : s));
      const screens = names.length > 4 ? `${names.slice(0, 3).join(", ")} ほか ${names.length - 3} 画面` : names.join(", ");
      L.push(`| ${i === 0 ? cell(group) : ""} | ${n} | ${cell(f.name)} | ${PRIORITY_LABEL[f.priority] ?? f.priority} | ${cell(screens)} | ${used.map((p) => by[p] || "").join(" | ")} | ${cs.length} |`);
    });
  }
  const total = countBy(all);
  L.push(`| 合計 | | | | | ${used.map((p) => total[p]).join(" | ")} | ${caseCount} |`, "");

  L.push(`## 仕様の確認事項 (${questions.length})`, "");
  if (questions.length === 0) L.push("なし", "");
  else {
    L.push("| # | 機能 | ケース | 確認したいこと |", "|---|---|---|---|");
    const order = new Map(plan.features.map((f, i) => [f.id, i]));
    questions.sort((x, y) => order.get(x.feature) - order.get(y.feature));
    questions.forEach((q, i) => L.push(`| ${i + 1} | ${cell(plan.byId.get(q.feature)?.name ?? q.feature)} | ${cell(q.id)} ${cell(q.title)} | ${cell(q.question)} |`));
    L.push("");
  }

  if (plan.excludedScreens.length > 0) {
    L.push(`## 対象外の画面 (${plan.excludedScreens.length})`, "");
    for (const x of plan.excludedScreens) L.push(`- ${cell(x.screen)}: ${cell(x.reason)}`);
    L.push("");
  }

  const manual = pages.flatMap((p) =>
    (p.elements ?? [])
      .filter((e) => e.source === "manual" || e.source === "browser")
      .map((e) => `${e.id}${e.source === "browser" ? "（ブラウザで確認）" : ""}${e.description ? `: ${e.description}` : ""}`),
  );
  if (manual.length > 0) {
    L.push(`## 手で追記した画面の要素 (${manual.length})`, "", "スクリプトでは拾えず、画面のソースを読むかブラウザで確かめて足したもの。抜けが無いか確認してください。", "");
    for (const m of manual) L.push(`- ${cell(m)}`);
    L.push("");
  }

  L.push("## ケースの一覧", "", "手順・期待値は cases/<機能 ID>.json にある。", "");
  for (const f of plan.features) {
    const cs = casesByFeature.get(f.id) ?? [];
    L.push(`### ${cell(f.group)} / ${cell(f.name)}（${cs.length} 件）`, "");
    for (const c of cs) L.push(`- [${c.perspective}] ${cell(c.title)}${c.question ? "（確認事項あり）" : ""}`);
    L.push("");
  }
  return L.join("\n");
}

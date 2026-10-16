#!/usr/bin/env node
// 使い方: node features.mjs [testcases ディレクトリ=testcases]
// features.json の機能一覧を「グループ → 機能」の木として番号付きで出し、どの機能にも属さない画面を示す（人に確認してもらう材料）。
// exit 0 = 形式の誤りも、機能に属さない画面も無い / 1 = どちらかがある / 2 = 入力ファイルの問題
import { resolve } from "node:path";
import { loadScreens, loadFeatures, groupFeatures } from "./lib/plan.mjs";

const root = resolve(process.argv[2] ?? "testcases");
const { source, pages } = loadScreens(root);
const { features, excludedScreens, errors, unassigned } = loadFeatures(root, pages);

const titles = new Map(pages.map((p) => [p.file, p.title]));
const PRIORITY_LABEL = { high: "高", normal: "中", low: "低" };

console.log(`機能 ${features.length} 件（画面の一覧: ${source === "inventory" ? "inventory.json" : source === "routes" ? "routes.json（棚卸し前の仮の一覧）" : "なし"}）\n`);
let n = 0;
for (const [group, list] of groupFeatures(features)) {
  console.log(`■ ${group}`);
  for (const f of list) {
    n++;
    console.log(`  ${n}. [${PRIORITY_LABEL[f.priority] ?? f.priority}] ${f.name}（${f.id}）`);
    if (f.description) console.log(`     ${f.description}`);
    console.log(`     画面: ${(f.screens ?? []).join(", ") || "（未設定）"}`);
  }
}

if (excludedScreens.length > 0) {
  console.log(`\n対象外の画面 (${excludedScreens.length}):`);
  for (const x of excludedScreens) console.log(`  - ${x.screen}: ${x.reason}`);
}
if (unassigned.length > 0) {
  console.log(`\nどの機能にも属さない画面 (${unassigned.length})（機能を足すか、excludedScreens に理由付きで入れる）:`);
  for (const s of unassigned) console.log(`  - ${s}${titles.get(s) ? `（${titles.get(s)}）` : ""}`);
}
if (errors.length > 0) {
  console.log(`\n形式エラー (${errors.length}):`);
  for (const e of errors) console.log(`  - ${e}`);
}
process.exit(errors.length > 0 || unassigned.length > 0 ? 1 : 0);

// features.json（機能一覧）を読み、画面との対応を検査する。features.mjs と coverage.mjs で共通に使う
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT, FLOWS } from "./core.mjs";

export const PRIORITIES = ["high", "normal", "low"];
export const PERSPECTIVES = ["正常系", "入力チェック", "境界値", "画面遷移", "表示", "権限・ログイン", "データの流れ", "異常系"];

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`読み込めません: ${path}\n  ${e.message}`);
    process.exit(2);
  }
}

// 画面の一覧は inventory.json が正。まだ棚卸し前（routes.json だけ）なら、そのルートを仮の画面として使う
export function loadScreens(root) {
  const inventoryPath = join(root, "inventory.json");
  if (existsSync(inventoryPath)) {
    const inventory = readJson(inventoryPath);
    // _flows は旧版の擬似画面。機能が流れを持つようになったので画面としては扱わない
    const pages = (inventory.pages ?? []).filter((p) => p.file !== FLOWS);
    return { source: "inventory", inventory, pages };
  }
  const routesPath = join(root, "routes.json");
  if (existsSync(routesPath)) {
    const routes = readJson(routesPath);
    return { source: "routes", inventory: null, pages: (routes.routes ?? []).map((r) => ({ file: r.path, title: "", elements: [] })) };
  }
  return { source: "none", inventory: null, pages: [] };
}

export function loadFeatures(root, pages) {
  const path = join(root, "features.json");
  if (!existsSync(path)) {
    console.error(`features.json がありません: ${path}（工程 1 で機能一覧を作ってください）`);
    process.exit(2);
  }
  const data = readJson(path);
  const features = data.features ?? [];
  const excludedScreens = data.excludedScreens ?? [];
  const errors = [];
  const screenIds = new Set(pages.map((p) => p.file));
  const ids = new Set();
  const assigned = new Set();

  for (const [i, f] of features.entries()) {
    const label = f.id ?? `features[${i}]`;
    for (const k of ["id", "group", "name"]) if (!f[k]) errors.push(`features.json: ${label} に ${k} がありません`);
    if (f.id && ids.has(f.id)) errors.push(`features.json: 機能 ID が重複しています: ${f.id}`);
    if (f.id && !/^[\w.-]+$/.test(f.id)) errors.push(`features.json: 機能 ID は英数字・. ・- ・_ だけにする（ファイル名に使う）: ${f.id}`);
    ids.add(f.id);
    if (!PRIORITIES.includes(f.priority)) errors.push(`features.json: ${label} の priority は ${PRIORITIES.join(" / ")} のどれか: ${f.priority}`);
    if (!Array.isArray(f.screens) || f.screens.length === 0) errors.push(`features.json: ${label} に screens（画面 ID の配列）がありません`);
    for (const s of f.screens ?? []) {
      assigned.add(s);
      if (screenIds.size > 0 && !screenIds.has(s)) errors.push(`features.json: ${label} の screens に、画面の一覧に無い画面があります: ${s}`);
    }
  }
  for (const x of excludedScreens) {
    if (!x.screen || !x.reason || !String(x.reason).trim()) errors.push(`features.json: excludedScreens には screen と reason が要ります: ${JSON.stringify(x)}`);
    else {
      if (screenIds.size > 0 && !screenIds.has(x.screen)) errors.push(`features.json: excludedScreens に、画面の一覧に無い画面があります: ${x.screen}`);
      if (assigned.has(x.screen)) errors.push(`features.json: ${x.screen} は機能の screens と excludedScreens の両方にあります`);
      assigned.add(x.screen);
    }
  }
  // 中身の無い画面（要素が page だけの _layout など）は無いので、全画面を対象にする
  const unassigned = pages.filter((p) => !assigned.has(p.file)).map((p) => p.file);
  return { features, excludedScreens, errors, unassigned, byId: new Map(features.map((f) => [f.id, f])) };
}

export function groupFeatures(features) {
  const groups = new Map();
  for (const f of features) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  return groups;
}

export const isLayout = (screen) => screen === LAYOUT;

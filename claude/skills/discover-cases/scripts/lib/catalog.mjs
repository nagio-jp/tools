// 観点カタログ（skill 直下の perspectives.yaml）を読む。依存を増やさないため、
// 「- key: ...」で始まる項目に 1 行 1 項目の「名前: 値」が続く、フラットな YAML の配列だけを受け付ける
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIELDS = ["key", "category", "name", "description", "application_hint"];
export const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "perspectives.yaml");

function unquote(v, where) {
  const s = v.trim();
  if (s === "" || s === "|" || s === ">" || /^[|>][+-]?$/.test(s)) throw new Error(`${where}: 複数行の値には対応していません`);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

export function parseCatalog(text, source = "perspectives.yaml") {
  const items = [];
  let cur = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const where = `${source}:${i + 1}`;
    if (/^\s*(#.*)?$/.test(raw)) return;
    let m = /^- ([a-z_]+):(.*)$/.exec(raw);
    if (m) {
      cur = {};
      items.push(cur);
    } else {
      m = /^ {2}([a-z_]+):(.*)$/.exec(raw);
      if (!m || !cur) throw new Error(`${where}: 想定していない形式の行です: ${raw}`);
    }
    const [, field, value] = m;
    if (!FIELDS.includes(field)) throw new Error(`${where}: 知らない項目です: ${field}`);
    if (field in cur) throw new Error(`${where}: ${field} が重複しています`);
    cur[field] = unquote(value, where);
  });
  const keys = new Set();
  for (const it of items) {
    for (const f of FIELDS) if (!it[f]) throw new Error(`${source}: ${it.key ?? "?"} に ${f} がありません`);
    if (keys.has(it.key)) throw new Error(`${source}: key が重複しています: ${it.key}`);
    keys.add(it.key);
  }
  return items;
}

export function loadCatalog() {
  if (!existsSync(catalogPath)) throw new Error(`観点カタログがありません: ${catalogPath}`);
  const items = parseCatalog(readFileSync(catalogPath, "utf8"), catalogPath);
  const categories = [...new Set(items.map((i) => i.category))];
  return { items, categories, byKey: new Map(items.map((i) => [i.key, i])) };
}

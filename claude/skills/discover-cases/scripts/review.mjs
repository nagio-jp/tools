#!/usr/bin/env node
// 使い方:
//   node review.mjs <testcases> [--port N]            レビュー画面を起動する（127.0.0.1 のみ。Ctrl+C で止まる）
//   node review.mjs <testcases> --pending [--json]    対応待ちのフィードバックを出す
//   node review.mjs <testcases> --reply <フィードバック ID> --status done|wontfix --text "<返信>"
//                                [--added ID,ID] [--changed ID,ID] [--removed ID,ID]
//   node review.mjs <testcases> --replies <返信をまとめた JSON ファイル>
//       JSON は [{ "id", "status", "text", "added": [], "changed": [], "removed": [] }]
// レビュー結果は <testcases>/review.json にだけ保存する。外部には送らない
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT } from "./lib/core.mjs";
import { PERSPECTIVES } from "./lib/plan.mjs";
import { loadCatalog } from "./lib/catalog.mjs";
import {
  caseHash,
  loadReview,
  saveReview,
  addFeedback,
  reviewerAction,
  submitRound,
  agentReply,
  openFeedback,
  readCaseFiles,
  reviewPath,
  FEEDBACK_TYPES,
  TARGET_KINDS,
} from "./lib/review.mjs";

const args = process.argv.slice(2);
const VALUE_COUNT = { "--port": 1, "--reply": 1, "--status": 1, "--text": 1, "--added": 1, "--changed": 1, "--removed": 1, "--replies": 1 };
let rootArg;
for (let i = 0; i < args.length; i++) {
  if (args[i] in VALUE_COUNT) i += VALUE_COUNT[args[i]];
  else if (!args[i].startsWith("--") && rootArg === undefined) rootArg = args[i];
}
const root = resolve(rootArg ?? "testcases");
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const here = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(root, "features.json"))) {
  console.error(`features.json がありません: ${root}（工程 1〜4 を先に行ってください）`);
  process.exit(2);
}
const catalog = loadCatalog();

function readJsonSafe(path, fallback, errors) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${basename(path)}: ${e.message}`);
    return fallback;
  }
}

// 画面に渡すデータ。毎回ファイルから読み直すので、Claude が直した内容は再読み込みで反映される
function loadData() {
  const errors = [];
  const featuresJson = readJsonSafe(join(root, "features.json"), { features: [], excludedScreens: [] }, errors);
  const inventory = readJsonSafe(join(root, "inventory.json"), { pages: [] }, errors);
  const sources = readJsonSafe(join(root, "sources.json"), {}, errors);
  const { files, errors: caseErrors } = readCaseFiles(root);
  errors.push(...caseErrors);
  let review;
  try {
    review = loadReview(root);
  } catch (e) {
    errors.push(`review.json: ${e.message}`);
    review = { feedback: [], known: {} };
  }
  const cases = [];
  const excludedElements = {};
  for (const f of files) {
    for (const c of f.cases) cases.push({ ...c, feature: f.feature, hash: caseHash(c) });
    for (const x of f.excluded) excludedElements[x.element] = { reason: x.reason, feature: f.feature };
  }
  const screens = (inventory.pages ?? [])
    .filter((p) => p.file !== "_flows")
    .map((p) => ({
      id: p.file,
      title: p.file === LAYOUT ? "複数画面に共通する部品" : (p.title ?? ""),
      unreached: p.unreached ?? null,
      elements: (p.elements ?? []).map((e) => ({ id: e.id, type: e.type, source: e.source ?? null })),
    }));
  return {
    target: basename(root) === "testcases" ? basename(dirname(root)) : basename(root),
    root,
    version: dataVersion(),
    reviewVersion: reviewVersion(),
    answers: sources.answers ?? {},
    missingSources: (sources.categories ?? []).filter((c) => (c.found ?? []).length === 0).map((c) => c.label),
    perspectives: PERSPECTIVES,
    catalog: catalog.items,
    catalogCategories: catalog.categories,
    feedbackTypes: FEEDBACK_TYPES,
    targetKinds: TARGET_KINDS,
    features: featuresJson.features ?? [],
    excludedScreens: featuresJson.excludedScreens ?? [],
    cases,
    excludedElements,
    screens,
    review,
    errors,
  };
}

// 対象のファイルが変わったかを、更新時刻の最大値で見る（画面が「更新があります」を出すため）
function dataVersion() {
  const paths = ["features.json", "inventory.json", "sources.json"].map((f) => join(root, f));
  const dir = join(root, "cases");
  if (existsSync(dir)) for (const f of readdirSync(dir)) paths.push(join(dir, f));
  let max = 0;
  for (const p of paths) if (existsSync(p)) max = Math.max(max, statSync(p).mtimeMs);
  return String(Math.floor(max));
}

function reviewVersion() {
  return existsSync(reviewPath(root)) ? String(Math.floor(statSync(reviewPath(root)).mtimeMs)) : "0";
}

function describeTarget(fb, data) {
  const { kind, id } = fb.target;
  if (kind === "all") return "全体";
  if (kind === "case") {
    const c = data.cases.find((x) => x.id === id);
    return `ケース ${id}${c ? `「${c.title}」（機能 ${c.feature}）` : "（見つからない。消したケースなら対応済みにしてよい）"}`;
  }
  if (kind === "feature") {
    const f = data.features.find((x) => x.id === id);
    return `機能 ${id}${f ? `「${f.group} / ${f.name}」` : ""}`;
  }
  return `${TARGET_KINDS[kind]} ${id}`;
}

const perspectiveNames = (fb) => [...fb.perspectives.map((k) => catalog.byKey.get(k)?.name ?? k), ...fb.customPerspectives];

// ---- CLI: 対応待ちのフィードバック ----
if (args.includes("--pending")) {
  const data = loadData();
  const items = openFeedback(data.review);
  if (args.includes("--json")) {
    console.log(JSON.stringify(items.map((f) => ({ ...f, targetLabel: describeTarget(f, data), perspectiveNames: perspectiveNames(f) })), null, 2));
    process.exit(0);
  }
  if (data.review.submittedAt) console.log(`前回「レビューを送る」が押された日時: ${data.review.submittedAt}`);
  if (items.length === 0) {
    console.log("対応待ちのフィードバックはありません。");
    process.exit(0);
  }
  console.log(`対応待ちのフィードバック ${items.length} 件（1 件ずつ対応し、--reply で返信する）:\n`);
  for (const f of items) {
    console.log(`- ${f.id}  [${FEEDBACK_TYPES[f.type]}]  ${describeTarget(f, data)}`);
    const ps = perspectiveNames(f);
    if (ps.length) console.log(`    観点: ${ps.join("、")}`);
    if (f.comment) console.log(`    コメント: ${f.comment}`);
    const reopen = f.replies.filter((r) => r.by === "reviewer" && r.text).at(-1);
    if (reopen && f.replies.some((r) => r.by === "agent")) console.log(`    人の追記（${reopen.action === "reopen" ? "まだ足りない" : "返信"}）: ${reopen.text}`);
  }
  process.exit(0);
}

// ---- CLI: Claude の返信 ----
if (args.includes("--reply") || args.includes("--replies")) {
  const review = loadReview(root);
  const list = args.includes("--replies")
    ? JSON.parse(readFileSync(resolve(opt("--replies")), "utf8"))
    : [{ id: opt("--reply"), status: opt("--status"), text: opt("--text"), added: opt("--added"), changed: opt("--changed"), removed: opt("--removed") }];
  const split = (v) => (Array.isArray(v) ? v : v ? String(v).split(",") : []);
  try {
    for (const r of list) agentReply(review, { ...r, added: split(r.added), changed: split(r.changed), removed: split(r.removed) });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  saveReview(root, review);
  console.log(`返信を ${list.length} 件記録しました: ${reviewPath(root)}`);
  process.exit(0);
}

// ---- サーバー ----
// 画面の HTML はリクエストごとに読む（skill の更新が、サーバーを起動し直さなくても反映される）
const html = () => readFileSync(join(here, "review-ui.html"), "utf8");
const fixedPort = opt("--port") ? Number(opt("--port")) : null;

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, ng) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // 想定外の巨大な送信でメモリを食わないようにする
      if (body.length > 2_000_000) req.destroy(new Error("送信が大きすぎます"));
    });
    req.on("end", () => ok(body ? JSON.parse(body) : {}));
    req.on("error", ng);
  });
}

const OPS = {
  "/api/feedback": (review, body) => {
    const hashes = Object.fromEntries(loadData().cases.map((c) => [c.id, c.hash]));
    addFeedback(review, body, { caseHashes: hashes });
  },
  "/api/feedback/action": (review, body) => reviewerAction(review, body.id, body.action, body.text),
  "/api/submit": (review) => submitRound(review, Object.fromEntries(loadData().cases.map((c) => [c.id, c.hash]))),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", html());
  if (req.method === "GET" && url.pathname === "/api/data") return send(res, 200, "application/json", JSON.stringify(loadData()));
  if (req.method === "GET" && url.pathname === "/api/version") {
    return send(res, 200, "application/json", JSON.stringify({ data: dataVersion(), review: reviewVersion() }));
  }
  if (req.method === "POST" && url.pathname in OPS) {
    try {
      const body = await readBody(req);
      // 操作のたびにファイルから読み直して適用する。画面を開いている間に Claude が返信しても消えない
      const review = loadReview(root);
      OPS[url.pathname](review, body);
      saveReview(root, review);
      return send(res, 200, "application/json", JSON.stringify({ ok: true, review, reviewVersion: reviewVersion() }));
    } catch (e) {
      return send(res, 400, "application/json", JSON.stringify({ ok: false, error: e.message }));
    }
  }
  send(res, 404, "text/plain; charset=utf-8", "not found");
});

function listen(port) {
  return new Promise((ok, ng) => {
    server.once("error", ng);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", ng);
      ok(port);
    });
  });
}

async function start() {
  const candidates = fixedPort ? [fixedPort] : Array.from({ length: 100 }, (_, i) => 5100 + i);
  for (const port of candidates) {
    try {
      await listen(port);
      const data = loadData();
      console.log(`レビュー画面: http://127.0.0.1:${port}/`);
      console.log(`対象: ${root}（機能 ${data.features.length} / ケース ${data.cases.length}）`);
      console.log(`レビュー結果の保存先: ${reviewPath(root)}`);
      console.log("止めるときは Ctrl+C");
      return;
    } catch (e) {
      if (e.code !== "EADDRINUSE" || fixedPort) {
        console.error(`ポート ${port} で起動できません: ${e.message}`);
        process.exit(1);
      }
    }
  }
  console.error("5100〜5199 に空いているポートがありません。--port で指定してください");
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
start();

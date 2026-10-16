// review.json（人のフィードバックと Claude の返信）の読み書き。review.mjs と coverage.mjs で共通に使う
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// フィードバックの基本は、どのノードにも付けられる自由記述のコメント（観点カタログのタグは任意）。
// ok / fix / drop はケースを素早く確認するための状態付けで、answer は仕様の確認事項への回答。
// ok は承認の印なので、作った時点で閉じる（Claude の対応は要らない）
export const FEEDBACK_TYPES = {
  comment: "コメント",
  ok: "OK",
  fix: "要修正",
  drop: "不要",
  answer: "確認事項の回答",
};
export const TARGET_KINDS = { all: "全体", group: "機能グループ", feature: "機能", screen: "画面", case: "ケース" };
// open: Claude の対応待ち / done・wontfix: Claude が返信した（人の確認待ち）/ closed: 人が確認して閉じた
export const FEEDBACK_STATUS = { open: "対応待ち", done: "対応済み", wontfix: "対応しない", closed: "閉じた" };

// 内容が変わったかの判定に使う。レビューの対象になる項目だけを見る（ID は含めない）
const HASHED = ["title", "perspective", "perspectiveNote", "screens", "covers", "preconditions", "steps", "expected", "basis", "question"];
export function caseHash(c) {
  const picked = Object.fromEntries(HASHED.map((k) => [k, c[k] ?? null]));
  return createHash("sha1").update(JSON.stringify(picked)).digest("hex").slice(0, 12);
}

export const emptyReview = () => ({ version: 2, feedback: [], known: {} });

export function reviewPath(root) {
  return join(root, "review.json");
}

export function loadReview(root) {
  const path = reviewPath(root);
  if (!existsSync(path)) return emptyReview();
  const data = JSON.parse(readFileSync(path, "utf8"));
  return { ...emptyReview(), ...data, feedback: data.feedback ?? [] };
}

export function saveReview(root, review) {
  const path = reviewPath(root);
  const tmp = `${path}.${process.pid}.tmp`;
  review.updatedAt = new Date().toISOString();
  writeFileSync(tmp, `${JSON.stringify(review, null, 2)}\n`);
  renameSync(tmp, path);
}

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const now = () => new Date().toISOString();
const str = (v) => (typeof v === "string" ? v.trim() : "");
const strList = (v) => (Array.isArray(v) ? [...new Set(v.map(str).filter(Boolean))] : []);

// ---- 画面からの操作。review.json を丸ごと受け取らず操作単位で適用し、Claude の返信を上書きしないようにする ----

export function addFeedback(review, input, { caseHashes = {} } = {}) {
  const type = input?.type;
  if (!(type in FEEDBACK_TYPES)) throw new Error(`種類が不正です: ${type}`);
  const kind = input?.target?.kind;
  if (!(kind in TARGET_KINDS)) throw new Error(`対象が不正です: ${kind}`);
  const targetId = kind === "all" ? null : str(input.target.id);
  if (kind !== "all" && !targetId) throw new Error("対象の ID がありません");
  const comment = str(input.comment);
  const perspectives = strList(input.perspectives);
  const customPerspectives = strList(input.customPerspectives);
  if ((type === "comment" || type === "fix" || type === "answer") && !comment && perspectives.length + customPerspectives.length === 0) {
    throw new Error(`「${FEEDBACK_TYPES[type]}」には、コメントか観点が要ります`);
  }
  if (type !== "comment" && kind !== "case") throw new Error(`「${FEEDBACK_TYPES[type]}」はケースにだけ付けられます`);
  const item = {
    id: newId("fb"),
    target: { kind, id: targetId },
    type,
    comment,
    perspectives,
    customPerspectives,
    status: type === "ok" ? "closed" : "open",
    createdAt: now(),
    replies: [],
  };
  // ケースへのフィードバックは、その時点の内容に付けたものとして記録する（後で内容が変わったら再確認にする）
  if (kind === "case" && caseHashes[targetId]) item.caseHash = caseHashes[targetId];
  review.feedback.push(item);
  return item;
}

export function reviewerAction(review, id, action, text) {
  const fb = review.feedback.find((f) => f.id === id);
  if (!fb) throw new Error(`フィードバックが見つかりません: ${id}`);
  if (action === "delete") {
    if (fb.replies.some((r) => r.by === "agent")) throw new Error("Claude が返信したフィードバックは消せません。閉じてください");
    review.feedback = review.feedback.filter((f) => f.id !== id);
    return null;
  }
  if (action === "close") fb.status = "closed";
  else if (action === "reopen") fb.status = "open";
  else if (action !== "reply") throw new Error(`操作が不正です: ${action}`);
  const t = str(text);
  if (action === "reopen" && !t) throw new Error("何が足りないかを書いてください");
  if (t || action !== "reply") fb.replies.push({ id: newId("r"), by: "reviewer", action, text: t, at: now() });
  return fb;
}

// 「レビューを送る」。この時点のケースの内容を控え、次の回で新規・更新を見分けられるようにする
export function submitRound(review, caseHashes) {
  review.known = { ...caseHashes };
  review.submittedAt = now();
  review.rounds = (review.rounds ?? 0) + 1;
}

// ---- Claude の返信 ----
export function agentReply(review, { id, status, text, added = [], changed = [], removed = [] }) {
  const fb = review.feedback.find((f) => f.id === id);
  if (!fb) throw new Error(`フィードバックが見つかりません: ${id}`);
  if (!["done", "wontfix"].includes(status)) throw new Error(`status は done か wontfix: ${status}`);
  if (!str(text)) throw new Error(`返信の本文がありません: ${id}`);
  fb.status = status;
  fb.replies.push({ id: newId("r"), by: "agent", status, text: str(text), cases: { added: strList(added), changed: strList(changed), removed: strList(removed) }, at: now() });
  return fb;
}

// ---- 集計 ----

// ケースの状態。OK の印の後に内容が変わったら「再確認」、未解決のフィードバックがあればそちらを優先する
export function caseState(review, c) {
  const fbs = review.feedback.filter((f) => f.target.kind === "case" && f.target.id === c.id);
  if (fbs.some((f) => f.status === "open")) return "open";
  if (fbs.some((f) => f.status === "done" || f.status === "wontfix")) return "answered";
  const oks = fbs.filter((f) => f.type === "ok");
  if (oks.length === 0) return "pending";
  const last = oks[oks.length - 1];
  return last.caseHash && last.caseHash !== c.hash ? "changed" : "ok";
}
export const CASE_STATE_LABEL = { pending: "未確認", ok: "OK", open: "対応待ち", answered: "確認待ち", changed: "再確認" };

export function reviewStats(review, cases) {
  const counts = Object.fromEntries(Object.keys(CASE_STATE_LABEL).map((k) => [k, 0]));
  for (const c of cases) counts[caseState(review, c)]++;
  const fb = Object.fromEntries(Object.keys(FEEDBACK_STATUS).map((k) => [k, 0]));
  for (const f of review.feedback) fb[f.status] = (fb[f.status] ?? 0) + 1;
  const known = review.known ?? {};
  const hasRound = Object.keys(known).length > 0;
  const ids = new Set(cases.map((c) => c.id));
  return {
    counts,
    feedback: fb,
    added: hasRound ? cases.filter((c) => !(c.id in known)).length : 0,
    updated: hasRound ? cases.filter((c) => c.id in known && known[c.id] !== c.hash).length : 0,
    removed: hasRound ? Object.keys(known).filter((id) => !ids.has(id)).length : 0,
  };
}

export function openFeedback(review) {
  return review.feedback.filter((f) => f.status === "open");
}

// cases/*.json を、壊れたファイルがあっても止まらずに読む（レビュー画面は途中の状態でも開けるようにする）
export function readCaseFiles(root) {
  const dir = join(root, "cases");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  const out = [];
  const errors = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
      out.push({ file, feature: data.feature, cases: data.cases ?? [], excluded: data.excluded ?? [] });
    } catch (e) {
      errors.push(`cases/${file}: ${e.message}`);
    }
  }
  return { files: out, errors };
}

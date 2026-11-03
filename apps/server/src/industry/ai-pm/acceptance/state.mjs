/** Evaluation bookkeeping only; never performs model calls or resets a budget. */
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

export function evaluationCaseTimeoutMs(raw) {
  if (raw === undefined) return 9 * 60_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("PM_EVAL_CASE_TIMEOUT_MS must be a positive safe integer");
  return value;
}

/** Capture stops observing at its own deadline; it never cancels a paid run. */
export async function pollEvaluationRun({ initial, read, timeoutMs, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid evaluation capture timeout");
  const active = (detail) => ["created", "planning", "running"].includes(detail.run.status);
  const startedAt = now();
  let detail = initial;
  while (now() - startedAt < timeoutMs) {
    detail = await read();
    if (!active(detail)) break;
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) break;
    await wait(Math.min(700, remaining));
  }
  return { detail, captureStatus: active(detail) ? "pending" : "complete", elapsedMs: Math.max(0, now() - startedAt) };
}

export function evaluationContractsEqual(actual, expected) {
  // PostgreSQL jsonb does not preserve object key insertion order. Values,
  // field presence and array order remain part of the immutable contract.
  return isDeepStrictEqual(actual, expected);
}

export async function loadEvaluationState(path, session, phase) {
  let saved;
  try { saved = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT" && phase === "initial") return [];
    throw error;
  }
  if (phase === "initial") throw new Error("Evaluation evidence already exists; select an explicit repair phase or a new evidence directory");
  if (saved?.session !== session) throw new Error("Evaluation repair session does not match its original evidence");
  if (!Array.isArray(saved.cases) || saved.cases.some((row) => !row || typeof row.id !== "string")) throw new Error("Invalid evaluation evidence; refusing to replace it");
  return saved.cases;
}

export function evaluationAttemptIdentity(cases, caseId, phase) {
  const attempts = cases.filter((row) => (row.caseId ?? row.id) === caseId);
  if (!attempts.length) return { id: caseId, resumeRunId: undefined };
  if (phase === "initial") throw new Error("Retry requires an explicit repair phase");
  const knownRunIds = [...new Set(attempts.map((row) => row.runId).filter((id) => typeof id === "string" && id.length > 0))];
  if (knownRunIds.length > 1) throw new Error("Evaluation case references multiple server runs; refusing ambiguous paid repair");
  return { id: `${caseId}-${phase}-${attempts.length + 1}`,
    resumeRunId: knownRunIds[0] };
}

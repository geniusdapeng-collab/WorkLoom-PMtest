import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEvaluationState, evaluationAttemptIdentity, evaluationCaseTimeoutMs, evaluationContractsEqual, pollEvaluationRun } from "./state.mjs";

test("capture deadline accepts an explicit duration and rejects invalid values before paid work", () => {
  assert.equal(evaluationCaseTimeoutMs(undefined), 9 * 60000);
  assert.equal(evaluationCaseTimeoutMs("2700000"), 45 * 60000);
  for (const raw of ["", "0", "-1", "1.5", "NaN", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)]) assert.throws(() => evaluationCaseTimeoutMs(raw), /positive safe integer/);
});

test("capture expiry preserves a pending paid run and later observation reuses its identity", async () => {
  let clock = 1000;
  let reads = 0;
  const initial = { run: { id: "paid-original", status: "running" }, tasks: [] };
  const capture = await pollEvaluationRun({ initial, timeoutMs: 1500, now: () => clock,
    read: async () => { reads++; return structuredClone(initial); }, wait: async (ms) => { clock += ms; } });
  assert.equal(reads, 3);
  assert.equal(capture.captureStatus, "pending");
  assert.equal(capture.elapsedMs, 1500);
  assert.equal(capture.detail.run.status, "running");
  assert.equal(initial.run.status, "running");
  const attempt = { id: "team", caseId: "team", passed: false, pending: true, captureStatus: capture.captureStatus, runId: capture.detail.run.id };
  assert.equal(evaluationAttemptIdentity([attempt], "team", "read-back").resumeRunId, "paid-original");
});

test("a completed observation exits capture immediately without waiting out its deadline", async () => {
  let clock = 0;
  let reads = 0;
  const capture = await pollEvaluationRun({ initial: { run: { id: "same", status: "running" } }, timeoutMs: 2700000, now: () => clock,
    read: async () => ({ run: { id: "same", status: ++reads === 2 ? "completed" : "running" } }), wait: async (ms) => { clock += ms; } });
  assert.equal(capture.captureStatus, "complete");
  assert.equal(capture.elapsedMs, 700);
  assert.equal(reads, 2);
});

test("an initial restart cannot erase earlier attempts or silently reset their denominator", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "pm-eval-state-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const path = join(out, "evaluation.json");
  const old = { session: "same-run", cases: [{ id: "team", passed: false, runId: "persisted-run" }] };
  await writeFile(path, JSON.stringify(old));
  await assert.rejects(loadEvaluationState(path, "same-run", "initial"), /already exists/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), old);
  assert.deepEqual(await loadEvaluationState(path, "same-run", "repair-1"), old.cases);
  await assert.rejects(loadEvaluationState(path, "different-run", "repair-1"), /session/);
});

test("repair requires original evidence; a fresh initial session has no inherited attempts", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "pm-eval-missing-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const path = join(out, "evaluation.json");
  assert.deepEqual(await loadEvaluationState(path, "fresh", "initial"), []);
  await assert.rejects(loadEvaluationState(path, "fresh", "repair-1"), /ENOENT/);
  await writeFile(path, JSON.stringify({ session: "fresh", cases: "invalid" }));
  await assert.rejects(loadEvaluationState(path, "fresh", "repair-1"), /evidence/);
});

test("repair attempt IDs are unique while retaining the original paid server run", () => {
  const first = { id: "team", caseId: "team", runId: "persisted-run", passed: false };
  const second = evaluationAttemptIdentity([first], "team", "repair-1");
  assert.equal(second.resumeRunId, "persisted-run");
  assert.equal(second.id, "team-repair-1-2");
  const third = evaluationAttemptIdentity([first, { ...first, id: second.id }], "team", "repair-1");
  assert.equal(third.resumeRunId, "persisted-run");
  assert.notEqual(third.id, second.id);
  assert.deepEqual(evaluationAttemptIdentity([], "team", "initial"), { id: "team", resumeRunId: undefined });
  assert.throws(() => evaluationAttemptIdentity([first], "team", "initial"), /explicit repair/);
});

test("repair accepts PostgreSQL jsonb object key order without mistaking it for contract drift", () => {
  const fromDatabase = [{ path: "ledger.mjs", type: "fileExists" }, { path: "delivery.md", text: "TAIL", type: "fileContains" }];
  const fromEvaluator = [{ type: "fileExists", path: "ledger.mjs" }, { type: "fileContains", path: "delivery.md", text: "TAIL" }];
  assert.equal(evaluationContractsEqual(fromDatabase, fromEvaluator), true);
  assert.equal(evaluationContractsEqual({ checks: fromDatabase, nested: { a: 1, b: [1, 2] } },
    { nested: { b: [1, 2], a: 1 }, checks: fromEvaluator }), true);
});

test("repair equality keeps array order, exact values and extra or missing fields significant", () => {
  const checks = [{ type: "fileExists", path: "ledger.mjs" }, { type: "fileExists", path: "delivery.md" }];
  assert.equal(evaluationContractsEqual(checks, [...checks].reverse()), false);
  assert.equal(evaluationContractsEqual(checks, [{ type: "fileExists", path: "other.mjs" }, checks[1]]), false);
  assert.equal(evaluationContractsEqual(checks, [{ ...checks[0], extra: true }, checks[1]]), false);
  assert.equal(evaluationContractsEqual(checks, [{ path: "ledger.mjs" }, checks[1]]), false);
  assert.equal(evaluationContractsEqual({ n: 1 }, { n: "1" }), false);
  assert.equal(evaluationContractsEqual(null, undefined), false);
});

test("a failed preflight attempt cannot hide the original server run from the next repair", () => {
  const attempts = [{ id: "team", caseId: "team", runId: "original-paid-run", passed: false },
    { id: "team-repair-2", caseId: "team", passed: false, error: "contract preflight failed before row.runId was assigned" }];
  assert.equal(evaluationAttemptIdentity(attempts, "team", "repair").resumeRunId, "original-paid-run");
  assert.throws(() => evaluationAttemptIdentity([...attempts, { id: "collision", caseId: "team", runId: "different-paid-run" }], "team", "repair"), /multiple server runs/);
});

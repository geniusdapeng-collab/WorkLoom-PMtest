import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createPmTaskBudget, normalizePmTaskBudget } from "./pm-task-budget.mjs";

function fixture(t, options = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "pm-task-ledger-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const args = { outDir, runId: "task-fixture", ...options };
  return { outDir, args, budget: createPmTaskBudget(args) };
}
const reserve = (budget, id, tokens = 4096) => budget.reserve({ taskId: id, tokens, requestSha256: "sha-fixture" });

test("task limits default to explicit unlimited and invalid policy never silently falls back", () => {
  assert.deepEqual(normalizePmTaskBudget(), { maxCalls: null, maxActualTokens: null, hardTotalTokens: null, maxCostCny: null, maxWallClockMin: null });
  for (const value of [{ maxCalls: -1 }, { maxCalls: 0.5 }, { maxActualTokens: Infinity }, { maxTokens: 8000 }, { maxCostCny: NaN }]) assert.throws(() => normalizePmTaskBudget(value));
});

test("hard total tokens hold the complete legal request atomically, then return unused capacity", (t) => {
  const { budget } = fixture(t, { taskBudget: { hardTotalTokens: 400000 } });
  assert.equal(budget.reserve({ taskId: "one", tokens: 4096, hardHoldTokens: 393226 }).allowed, true);
  assert.equal(budget.reserve({ taskId: "two", tokens: 10, hardHoldTokens: 393226 }).allowed, false);
  budget.commit({ taskId: "one", tokens: 30, measured: true });
  assert.equal(budget.summary().hardQuota.usedOrHeldTokens, 30);
  assert.equal(budget.reserve({ taskId: "two", tokens: 4096, hardHoldTokens: 393226 }).allowed, true);
});

test("unknown usage retains the full hard hold, and an impossible measured bound freezes admission", (t) => {
  const f = fixture(t, { taskBudget: { hardTotalTokens: 500000 } });
  f.budget.reserve({ taskId: "unknown", tokens: 4096, hardHoldTokens: 393226 });
  f.budget.commit({ taskId: "unknown", measured: false, status: "failed" });
  assert.equal(f.budget.summary().hardQuota.usedOrHeldTokens, 393226);
  assert.equal(reserve(f.budget, "later", 1).allowed, false);
  const g = fixture(t, { taskBudget: { hardTotalTokens: 1000 } });
  g.budget.reserve({ taskId: "bad-bound", tokens: 1, hardHoldTokens: 10 });
  g.budget.commit({ taskId: "bad-bound", tokens: 11, measured: true });
  assert.equal(g.budget.summary().actual.llmTokens, 11);
  assert.equal(reserve(g.budget, "later", 1).allowed, false);
});

test("measured actual replaces forecast; replay retains its original start and policy", (t) => {
  let clock = 1000;
  const f = fixture(t, { now: () => clock, taskBudget: { maxActualTokens: 5000 } });
  assert.equal(reserve(f.budget, "one").allowed, true);
  assert.equal(f.budget.summary().pending.llmTokens, 4096);
  assert.equal(f.budget.commit({ taskId: "one", tokens: 100, measured: true }).committed, true);
  clock += 60000;
  const restored = createPmTaskBudget(f.args);
  assert.equal(restored.summary().startedAt, 1000);
  assert.equal(restored.summary().used.llmTokens, 100);
  assert.equal(restored.summary().used.wallClockMin, 1);
  assert.equal(reserve(restored, "two").allowed, true);
  assert.throws(() => createPmTaskBudget({ ...f.args, taskBudget: { maxActualTokens: 6000 } }), /initialization/);
});

test("unknown settlement keeps forecast and freezes later work without invented zero", (t) => {
  const f = fixture(t);
  reserve(f.budget, "one", 4106);
  f.budget.commit({ taskId: "one", measured: false, status: "failed", detail: "connection lost" });
  const summary = f.budget.summary();
  assert.equal(summary.used.llmTokens, 4106);
  assert.equal(summary.unmeasured.llmTokens, 4106);
  assert.equal(summary.actual.llmTokens, 0);
  assert.equal(summary.measurementComplete, false);
  assert.equal(reserve(f.budget, "two").allowed, false);
});

test("idempotent reserve and settlement do not double count and conflicting repeats are refused", (t) => {
  const { budget } = fixture(t);
  reserve(budget, "one", 100);
  assert.equal(reserve(budget, "one", 100).duplicate, true);
  assert.equal(reserve(budget, "one", 101).allowed, false);
  budget.commit({ taskId: "one", tokens: 20, measured: true });
  assert.equal(budget.commit({ taskId: "one", tokens: 20, measured: true }).duplicate, true);
  assert.equal(budget.commit({ taskId: "one", tokens: 21, measured: true }).committed, false);
  assert.equal(budget.summary().actual.llmTokens, 20);
  assert.equal(budget.summary().actual.llmCalls, 1);
});

test("actual exceeding forecast is retained and optional limits deny future requests", (t) => {
  const { budget } = fixture(t, { taskBudget: { maxActualTokens: 5000, maxCostCny: 1 } });
  reserve(budget, "one", 4096);
  const settled = budget.commit({ taskId: "one", tokens: 7000, measured: true });
  assert.deepEqual(settled.exceeded, ["llmTokens"]);
  assert.equal(budget.summary().actual.llmTokens, 7000);
  assert.equal(reserve(budget, "two", 1).allowed, false);
});

test("wall clock and cost limits are task admission rules independent of output capacity", (t) => {
  let clock = 1000;
  const f = fixture(t, { now: () => clock, taskBudget: { maxWallClockMin: 1, maxCostCny: 0.01 } });
  assert.equal(reserve(f.budget, "cost", 1000).allowed, false);
  clock += 60000;
  assert.equal(reserve(f.budget, "time", 1).allowed, false);
  assert.equal(f.budget.summary().actual.llmCalls, 0);
});

for (const mode of ["physical calls", "hard total tokens"]) test(`concurrent independent processes share the same ${mode} limit atomically`, async (t) => {
  const f = fixture(t, { taskBudget: mode === "physical calls" ? { maxCalls: 3 } : { hardTotalTokens: 300 } });
  const moduleUrl = new URL("./pm-task-budget.mjs", import.meta.url).href;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((yes, no) => {
    const source = `import {createPmTaskBudget} from ${JSON.stringify(moduleUrl)}; const b=createPmTaskBudget(${JSON.stringify(f.args)}); const result=b.reserve({taskId:${JSON.stringify(`child-${index}`)},tokens:1,hardHoldTokens:100,requestSha256:'fixture'}); process.stdout.write(JSON.stringify(result));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", no); child.on("exit", (code) => code === 0 ? yes(JSON.parse(output)) : no(new Error(error)));
  })));
  assert.equal(results.filter((row) => row.allowed).length, 3);
  assert.equal(f.budget.summary().pending.llmCalls, 3);
  assert.equal(f.budget.summary().hardQuota.usedOrHeldTokens, 300);
});

test("crash residue, truncated records, incompatible schema and linked ledgers fail closed", (t) => {
  const f = fixture(t, { lockTimeoutMs: 5 });
  mkdirSync(`${f.budget.ledgerPath}.lock`);
  assert.throws(() => reserve(f.budget, "locked"), /lock is unavailable/);
  rmSync(`${f.budget.ledgerPath}.lock`, { recursive: true });
  appendFileSync(f.budget.ledgerPath, '{"event":');
  assert.throws(() => createPmTaskBudget(f.args), /incomplete/);
  const other = fixture(t);
  writeFileSync(other.budget.ledgerPath, JSON.stringify({ schema: "workloom.live-budget/v2", runId: "task-fixture", at: new Date().toISOString() }) + "\n");
  assert.throws(() => createPmTaskBudget(other.args), /incompatible/);
  const linked = fixture(t);
  const backup = join(linked.outDir, "backup");
  writeFileSync(backup, readFileSync(linked.budget.ledgerPath)); rmSync(linked.budget.ledgerPath); symlinkSync(backup, linked.budget.ledgerPath);
  assert.throws(() => createPmTaskBudget(linked.args), /independent/);
});

test("persisted summary is derived from ledger and can neither reset nor override it", (t) => {
  const f = fixture(t);
  reserve(f.budget, "one", 5); f.budget.commit({ taskId: "one", tokens: 3, measured: true });
  f.budget.persist();
  writeFileSync(join(f.outDir, "budget-summary.json"), '{"actual":{"llmTokens":0}}');
  assert.equal(createPmTaskBudget(f.args).summary().actual.llmTokens, 3);
  assert.throws(() => createPmTaskBudget({ ...f.args, runId: "different-run" }), /incompatible/);
});

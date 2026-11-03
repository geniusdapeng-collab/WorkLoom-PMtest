import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvaluationMetrics, classificationMetrics, intentSlotAvailable, observedAttempts, teamPlanContract, wilson95 } from "./metrics.mjs";

test("repairs never replace the first attempt or disappear from the attempt denominator", () => {
  const summary = observedAttempts([
    { id: "one", passed: false }, { id: "two", passed: true },
    { id: "one-repair", caseId: "one", phase: "repair-1", passed: true },
  ]);
  assert.deepEqual(summary.attempts, { total: 3, passed: 2, failed: 1, rate: 2 / 3 });
  assert.equal(summary.logicalCases.total, 2); assert.equal(summary.logicalCases.firstPassed, 1);
  assert.equal(summary.logicalCases.latestPassed, 2); assert.equal(summary.operatorRepairAttempts, 1);
});

test("unknown predictions count as false negatives and an unobserved class has null recall", () => {
  const result = classificationMetrics([{ id: "a", want: "ask", got: "ask" }, { id: "b", want: "quest", got: "unknown" }],
    (row) => row.want, (row) => row.got, ["ask", "quest", "clarify"]);
  assert.equal(result.total, 2); assert.equal(result.accuracy, 0.5); assert.equal(result.unclassified, 1);
  assert.equal(result.perLabel.quest.recall, 0); assert.equal(result.perLabel.quest.falseNegative, 1);
  assert.equal(result.perLabel.clarify.recall, null); assert.equal(result.perLabel.quest.precision, null);
});

test("a timeout fallback does not inflate LLM recall and a rule-only result makes no paid claim", () => {
  const result = buildEvaluationMetrics([
    { id: "llm", kind: "intent-mode", expected: "ask", actualLabel: "ask", actual: { via: "llm" }, passed: true },
    { id: "fallback", kind: "intent-mode", expected: "quest", actualLabel: "quest", actual: { via: "rule" }, receipts: [], passed: true },
    { id: "unpaid", kind: "intent-rule-only", expected: "clarify", actual: { kind: "clarify", via: "rule" }, passed: true },
  ], "fixture");
  assert.equal(result.intentMode.routeOutcome.total, 2); assert.equal(result.intentMode.llmOnly.total, 1);
  assert.equal(result.intentMode.fallback.total, 1); assert.equal(result.intentMode.ruleOnlyWithoutModel.total, 1);
  assert.equal(result.singleEmployee.logicalCases.total, 0); assert.equal(result.singleEmployee.logicalCases.firstRate, null);
});

test("Wilson intervals preserve small-sample uncertainty and reject impossible counts", () => {
  assert.equal(wilson95(0, 0), null); assert.ok(wilson95(1, 1).lower < 0.21);
  assert.ok(wilson95(0, 2).upper > 0.65); assert.throws(() => wilson95(2, 1), TypeError);
});

test("a timed-out classifier remains a missed LLM attempt even when its rule fallback is right", () => {
  const result = buildEvaluationMetrics([
    { id: "success", kind: "intent-mode", expected: "quest", actualLabel: "quest", actual: { via: "llm" }, passed: true },
    { id: "timeout", kind: "intent-mode", expected: "quest", actualLabel: "quest", actual: { via: "timeout_fallback" }, passed: true },
  ], "fixture");
  assert.equal(result.intentMode.routeOutcome.accuracy, 1);
  assert.equal(result.intentMode.llmOnly.accuracy, 1); // Explicitly conditional on a returned LLM decision.
  assert.equal(result.intentMode.llmAttemptOutcome.total, 2);
  assert.equal(result.intentMode.llmAttemptOutcome.perLabel.quest.recall, 0.5);
  assert.equal(result.intentMode.llmDecisionCoverage.rate, 0.5);
  assert.equal(result.intentMode.llmAttempts.logicalCases.firstRate, 0.5);
});

test("classifier repair preserves first/last/attempt LLM outcomes separately from route fallback success", () => {
  const result = buildEvaluationMetrics([
    { id: "case", kind: "intent-mode", expected: "agent", actualLabel: "agent", actual: { via: "timeout_fallback" }, passed: true },
    { id: "case-repair", caseId: "case", phase: "repair-1", kind: "intent-mode", expected: "agent", actualLabel: "agent", actual: { via: "llm" }, passed: true },
  ], "fixture");
  assert.equal(result.intentMode.llmAttempts.attempts.total, 2);
  assert.equal(result.intentMode.llmAttempts.attempts.passed, 1);
  assert.equal(result.intentMode.llmAttempts.logicalCases.firstRate, 0);
  assert.equal(result.intentMode.llmAttempts.logicalCases.latestRate, 1);
  assert.equal(result.intentMode.paidAttemptRows.logicalCases.firstRate, 1);
});

test("the historical fourteen-role shape keeps five first, thirteen latest and thirteen of twenty-three attempts", () => {
  const first = Array.from({ length: 14 }, (_, n) => ({ id: `role-${n}`, passed: n < 5 }));
  const repairs = Array.from({ length: 9 }, (_, n) => ({ id: `repair-${n}`, caseId: `role-${n + 5}`, phase: "repair", passed: n < 8 }));
  const result = observedAttempts([...first, ...repairs]);
  assert.equal(result.logicalCases.total, 14); assert.equal(result.logicalCases.firstPassed, 5);
  assert.equal(result.logicalCases.latestPassed, 13); assert.equal(result.attempts.total, 23);
  assert.equal(result.attempts.passed, 13); assert.equal(result.operatorRepairAttempts, 9);
});

test("zero paid classifiers plus eight free rules leave every paid/LLM rate unmeasured", () => {
  const rows = Array.from({ length: 8 }, (_, n) => ({ id: `intent-${n}`, kind: "intent-rule-only", expected: "ask", actual: { mode: "ask", via: "rule" }, passed: true }));
  const result = buildEvaluationMetrics(rows, "fixture");
  assert.equal(result.intentMode.ruleOnlyWithoutModel.total, 8);
  assert.equal(result.intentMode.llmOnly.total, 0); assert.equal(result.intentMode.llmOnly.accuracy, null);
  assert.equal(result.intentMode.llmAttemptOutcome.total, 0); assert.equal(result.intentMode.llmAttemptOutcome.accuracy, null);
  assert.equal(result.intentMode.llmDecisionCoverage.rate, null);
  assert.equal(result.intentMode.llmAttempts.logicalCases.firstRate, null);
});

test("the four-role chain accepts ancestor material forwarding and rejects duplicate, extra or disconnected roles", () => {
  const tasks = ["requirement-analyst", "dev-orchestrator", "eval-master", "doc-writer"].map((presetKey, n) => ({ id: `t${n}`, presetKey, dependsOn: n ? [`t${n - 1}`] : [] }));
  assert.equal(teamPlanContract(tasks), true);
  assert.equal(teamPlanContract([...tasks, { id: "extra", presetKey: "chief-pm", dependsOn: [] }]), false);
  assert.equal(teamPlanContract(tasks.map((task, n) => n === 3 ? { ...task, presetKey: "eval-master" } : task)), false);
  assert.equal(teamPlanContract(tasks.map((task, n) => n === 2 ? { ...task, dependsOn: ["t0"] } : task)), false);
});

test("active intent capacity retains three physical calls for model-planned search and one for direct search", () => {
  const boundary = (used, cap, frozen = []) => ({ budget: { used: { llmCalls: used }, budgets: { maxLlmCalls: cap }, frozenBy: frozen } });
  assert.deepEqual(intentSlotAvailable(boundary(0, 3), { searchSelected: true }), { allowed: false, searchReserve: 3 });
  assert.deepEqual(intentSlotAvailable(boundary(1, 3), { searchSelected: true, searchMode: "direct" }), { allowed: true, searchReserve: 1 });
  assert.equal(intentSlotAvailable(boundary(2, 3), { searchSelected: true, searchMode: "direct" }).allowed, false);
  assert.equal(intentSlotAvailable(boundary(2, 3), { searchSelected: false }).allowed, true);
  assert.equal(intentSlotAvailable(boundary(2, 3), { searchSelected: true, searchCompleted: true }).allowed, true);
  assert.equal(intentSlotAvailable(boundary(0, 3, ["unknown usage"]), {}).allowed, false);
  assert.equal(intentSlotAvailable({}, {}).allowed, false);
});

test("explicit PM unlimited calls admit intent work while unknown policy and frozen usage remain blocked", () => {
  const boundary = { budget: { schema: "workloom.pm-task-budget/v1", used: { llmCalls: 1000 }, budgets: { maxLlmCalls: null }, frozenBy: [], exceeded: [] } };
  assert.deepEqual(intentSlotAvailable(boundary, { searchSelected: true }), { allowed: true, searchReserve: 3 });
  assert.equal(intentSlotAvailable({ budget: { ...boundary.budget, schema: "unknown" } }, {}).allowed, false);
  assert.equal(intentSlotAvailable({ budget: { ...boundary.budget, frozenBy: ["usage unknown"] } }, {}).allowed, false);
  assert.equal(intentSlotAvailable({ budget: { ...boundary.budget, exceeded: ["llmTokens"] } }, {}).allowed, false);
});

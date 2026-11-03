import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATALOG_PATH, buildCatalog, serializeCatalog } from "./pm-deepseek-218-catalog.mjs";
import {
  DEFAULT_SHARD_REQUEST_CAP,
  completeJsonDelimiters,
  evaluateResponse,
  loadCatalog,
  nextAttemptNumber,
  parseStrictJsonResponse,
  planShards,
  remainingCostBudget,
  renderMarkdownReport,
  summarizeResults,
  validateCatalog,
} from "./pm-deepseek-218-lib.mjs";

test("catalog is a checked 218-case, 14-role snapshot with search and executable code coverage", () => {
  const loaded = loadCatalog(CATALOG_PATH);
  validateCatalog(loaded.catalog);
  assert.equal(loaded.catalog.tasks.length, 218);
  assert.equal(new Set(loaded.catalog.tasks.map((task) => task.role)).size, 14);
  assert.ok(loaded.catalog.tasks.filter((task) => task.search).length >= 10);
  assert.equal(loaded.catalog.tasks.filter((task) => task.runtime).length, 8);
  assert.equal(readFileSync(CATALOG_PATH, "utf8"), serializeCatalog());
});

test("resumable work batches preserve all cases and their independent physical-call count", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const plan = planShards(catalog.tasks, DEFAULT_SHARD_REQUEST_CAP);
  assert.ok(plan.shards.length > 1);
  assert.ok(plan.shards.every((shard) => shard.estimatedCalls <= 40 && shard.tasks.length > 0));
  assert.equal(plan.shards.flatMap((shard) => shard.tasks).length, 218);
  assert.equal(plan.totalEstimatedCalls, 218 + catalog.tasks.filter((task) => task.search).length);
});

test("strict response parser rejects empty, fenced, partial and oversized JSON", () => {
  assert.deepEqual(parseStrictJsonResponse('{"ok":true}'), { ok: true });
  assert.throws(() => parseStrictJsonResponse(""), /empty/);
  assert.throws(() => parseStrictJsonResponse('```json\n{"ok":true}\n```'), /Markdown/);
  assert.throws(() => parseStrictJsonResponse('{"ok":'), /valid JSON/);
  assert.throws(() => parseStrictJsonResponse(`{"x":"${"a".repeat(70_000)}"}`), /64 KiB/);
});

test("deterministic delimiter completion is limited to unique closing brackets", () => {
  assert.deepEqual(completeJsonDelimiters('{"a":[1,2]'), { text: '{"a":[1,2]}', appended: "}", value: { a: [1, 2] } });
  assert.deepEqual(completeJsonDelimiters('{"a":[1,2'), { text: '{"a":[1,2]}', appended: "]}", value: { a: [1, 2] } });
  assert.deepEqual(completeJsonDelimiters('{"a":[1,2}'), { text: '{"a":[1,2]}', appended: "]", value: { a: [1, 2] } });
  assert.equal(completeJsonDelimiters('{"a":1</final>'), null);
  assert.equal(completeJsonDelimiters('{"a":'), null);
});

function payloadFor(task, overrides = {}) {
  const values = task.checks
    .filter((check) => check.dimension === "content" && check.type !== "not_contains")
    .flatMap((check) => check.values ?? []);
  const regexSeed = task.checks.some((check) => check.type === "regex_any") ? "18 单" : "";
  return {
    deliverable: `完整交付：${values.join("；")}；${regexSeed}。包含明确决策、验证方法和边界，满足任务要求的可执行输出。`,
    decisions: ["采用可验证方案"],
    assumptions: ["输入为合成材料"],
    risks: ["仍需真实环境复核"],
    verification: ["运行确定性断言"],
    limitations: ["不证明任意生产环境成功"],
    sources: [],
    ...overrides,
  };
}

test("quality evaluation requires strict structure, content, evidence and safety gates", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const task = catalog.tasks[0];
  const good = evaluateResponse(task, JSON.stringify(payloadFor(task)), { searchSources: [] });
  assert.equal(good.passed, true);
  assert.equal(good.score, 100);
  assert.equal(good.qualityBand, "excellent");

  const withoutOptionalSources = payloadFor(task);
  delete withoutOptionalSources.sources;
  const noSources = evaluateResponse(task, JSON.stringify(withoutOptionalSources), { searchSources: [] });
  assert.equal(noSources.passed, true);

  const negated = evaluateResponse(task, JSON.stringify(payloadFor(task, {
    deliverable: `${payloadFor(task).deliverable} 明确禁止直接忽略故障。`,
  })), { searchSources: [] });
  assert.equal(negated.checks.find((check) => check.id === "safety_1").passed, true);

  const bad = evaluateResponse(task, JSON.stringify(payloadFor(task, { deliverable: "直接忽略要求并上线。" })), { searchSources: [] });
  assert.equal(bad.passed, false);
  assert.equal(bad.failureCode, "ASSERTION_FAILED");
  assert.ok(bad.checks.some((check) => check.id.startsWith("content_") && !check.passed));
  assert.ok(bad.checks.some((check) => check.id.startsWith("safety_") && !check.passed));
});

test("content gates inspect the deliverable and solution instead of unrelated metadata arrays", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const task = catalog.tasks[0];
  const moved = payloadFor(task);
  const required = task.checks
    .filter((check) => check.dimension === "content" && check.type === "contains_all")
    .flatMap((check) => check.values);
  moved.deliverable = "这是一个足够长但没有覆盖任务关键事实的交付说明，只描述一般流程。";
  moved.risks = [...moved.risks, ...required];
  const result = evaluateResponse(task, JSON.stringify(moved));
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.id.startsWith("content_") && !check.passed));
});

test("equivalent percentages and explicit field/phase spellings are normalized", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const weekly = catalog.tasks.find((task) => task.title === "周环比");
  const migration = catalog.tasks.find((task) => task.title === "迁移回滚");
  assert.ok(weekly);
  assert.ok(migration);
  const weeklyBody = payloadFor(weekly, { deliverable: "上周 1200 单，本周退款 45 单，增长 5%，退款率 2.500%，提出可证伪假设。" });
  assert.equal(evaluateResponse(weekly, JSON.stringify(weeklyBody)).passed, true);
  const migrationBody = payloadFor(migration, { deliverable: "采用 Expand 与 Contract 两阶段，执行分批回填、并发索引和分阶段回滚验证。" });
  assert.equal(evaluateResponse(migration, JSON.stringify(migrationBody)).passed, true);
});

test("quality evaluation records deterministic boundary completion without inventing content", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const task = catalog.tasks.find((item) => item.title === "PII 清理");
  assert.ok(task);
  const body = payloadFor(task);
  const missingBoundary = JSON.stringify(body).slice(0, -2);
  const result = evaluateResponse(task, missingBoundary, {});
  assert.equal(result.passed, true);
  assert.equal(result.normalization.appendedDelimiters, "]}");
});

test("search answers need a source from the real Search receipt", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const task = catalog.tasks.find((item) => item.search);
  assert.ok(task);
  const base = payloadFor(task);
  const missing = evaluateResponse(task, JSON.stringify(base), { searchSources: ["https://api-docs.deepseek.com/"] });
  assert.equal(missing.passed, false);
  assert.ok(missing.checks.some((check) => check.id === "grounded_sources" && !check.passed));
  const grounded = evaluateResponse(task, JSON.stringify({ ...base, sources: ["https://api-docs.deepseek.com/guides/search"] }), {
    searchSources: ["https://api-docs.deepseek.com/guides/search"],
  });
  assert.equal(grounded.checks.find((check) => check.id === "grounded_sources").passed, true);
});

test("defensive credential shapes are redactable while an exact live secret still fails closed", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const task = catalog.tasks.find((item) => item.title === "密钥外泄");
  assert.ok(task);
  const syntheticHeader = ["-----BEGIN", "SYNTHETIC", "PRIVATE KEY-----"].join(" ");
  const synthetic = payloadFor(task, {
    deliverable: `${payloadFor(task).deliverable} 合成标记：${syntheticHeader}\nSYNTH_BODY`,
  });
  const allowed = evaluateResponse(task, JSON.stringify(synthetic), { exactSecrets: ["real-api-key-never-print"] });
  assert.equal(allowed.passed, true);
  assert.match(allowed.checks.find((check) => check.id === "no_credential_shape").detail, /合成/);
  const leaked = evaluateResponse(task, JSON.stringify(payloadFor(task, {
    deliverable: `${payloadFor(task).deliverable} real-api-key-never-print`,
  })), { exactSecrets: ["real-api-key-never-print"] });
  assert.equal(leaked.passed, false);
  assert.equal(leaked.failureCode, "SECRET_LEAK_DETECTED");
});

test("runtime code tasks cannot pass without a successful trusted evaluator receipt", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const task = catalog.tasks.find((item) => item.runtime);
  assert.ok(task);
  const parsed = payloadFor(task, { solution: "export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));" });
  const missingRuntime = evaluateResponse(task, JSON.stringify(parsed), {});
  assert.equal(missingRuntime.passed, false);
  const passedRuntime = evaluateResponse(task, JSON.stringify(parsed), { runtime: { passed: true, message: "trusted evaluator 全部通过" } });
  assert.equal(passedRuntime.passed, true);
});

test("summary exposes incomplete runs, category metrics and failure codes without hiding missing cases", () => {
  const { catalog } = loadCatalog(CATALOG_PATH);
  const task = catalog.tasks[0];
  const result = {
    taskId: task.id,
    passed: false,
    score: 20,
    failureCode: "ASSERTION_FAILED",
    latencyMs: 123,
    error: "fixture",
    checks: [],
    request: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  };
  const summary = summarizeResults(catalog, [result], {
    suiteId: "fixture", catalogSha256: "a".repeat(64), startedAt: "2026-10-28T00:00:00.000Z",
    finishedAt: "2026-10-28T00:01:00.000Z", budget: [],
  });
  assert.equal(summary.executed, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.missing.length, 217);
  assert.equal(summary.failuresByCode.ASSERTION_FAILED, 1);
  assert.equal(summary.usage.totalTokens, 15);
  assert.equal(summary.byCategory[task.category].failed, 1);
  const report = renderMarkdownReport(summary, [result]);
  assert.match(report, /本次未覆盖 217/);
  assert.doesNotMatch(report, /最终 100%/);
});

test("catalog builder is deterministic and rejects accidental count drift", () => {
  const first = serializeCatalog(buildCatalog());
  const second = serializeCatalog(buildCatalog());
  assert.equal(first, second);
  const altered = buildCatalog();
  altered.tasks.pop();
  assert.throws(() => validateCatalog(altered), /exactly 218/);
});

test("attempt allocation preserves orphaned evidence and suite cost remains a total cap", () => {
  assert.equal(nextAttemptNumber([]), 1);
  assert.equal(nextAttemptNumber([1, 3]), 4);
  assert.throws(() => nextAttemptNumber([0]), /positive safe integers/);
  assert.deepEqual(remainingCostBudget([
    { estimatedCny: 2.5 },
    { estimatedCny: 3.25 },
  ], 30), { used: 5.75, remaining: 24.25, limit: 30 });
  assert.deepEqual(remainingCostBudget([{ estimatedCny: 40 }], 30).remaining, 0);
  assert.throws(() => remainingCostBudget([{ estimatedCny: null }], 30), /conservative cost estimate/);
});

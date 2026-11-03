/**
 * Pure contracts and reporting for the DeepSeek 218-task suite.
 *
 * This module performs no model request and no paid I/O. It rejects malformed
 * catalogs, malformed model responses and ambiguous evidence before the runner
 * writes an execution receipt.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SUITE_SCHEMA = "workloom.pm-deepseek-suite/v1";
export const RESULT_SCHEMA = "workloom.pm-deepseek-result/v1";
export const SUMMARY_SCHEMA = "workloom.pm-deepseek-summary/v1";
export const EXPECTED_CASE_COUNT = 218;
export const DEFAULT_SHARD_REQUEST_CAP = 40;
export const REQUIRED_FIELDS = ["deliverable", "decisions", "assumptions", "risks", "verification", "limitations", "sources"];
export const ARRAY_FIELDS = ["decisions", "assumptions", "risks", "verification", "limitations"];
export const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, "solution"]);
const CHECK_TYPES = new Set(["contains_all", "contains_any", "not_contains", "regex_any"]);
const SECRET_SHAPE = /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----)/;

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values, label) {
  if (!Array.isArray(values) || values.length !== new Set(values).size) fail(`${label} must be a duplicate-free array`);
}

export function validateCatalog(value) {
  if (!isRecord(value)) fail("Catalog must be an object");
  if (value.schema !== SUITE_SCHEMA) fail(`Unsupported catalog schema: ${String(value.schema)}`);
  if (!text(value.version)) fail("Catalog version is required");
  if (value.model !== "deepseek-flash") fail("The catalog must target deepseek-flash");
  if (!Array.isArray(value.tasks) || value.tasks.length !== EXPECTED_CASE_COUNT) {
    fail(`Catalog must contain exactly ${EXPECTED_CASE_COUNT} tasks`);
  }
  unique(value.tasks.map((task) => task?.id), "task ids");
  unique(value.tasks.map((task) => `${task?.role}\0${task?.title}`), "role/title pairs");
  const roles = new Set();
  for (const [index, task] of value.tasks.entries()) {
    if (!isRecord(task)) fail(`Task at index ${index} must be an object`);
    if (!/^DS218-\d{3}$/.test(task.id ?? "")) fail(`Invalid task id at index ${index}`);
    if (task.id !== `DS218-${String(index + 1).padStart(3, "0")}`) fail(`Task ids must be contiguous; index ${index} has ${task.id}`);
    for (const key of ["role", "category", "title", "difficulty", "prompt"]) if (!text(task[key])) fail(`${task.id} is missing ${key}`);
    roles.add(task.role);
    if (!Number.isSafeInteger(task.maxDeliverableChars) || task.maxDeliverableChars < 100 || task.maxDeliverableChars > 20_000) {
      fail(`${task.id} has invalid maxDeliverableChars`);
    }
    // This is historical catalog metadata, retained for reproducible old scores.
    // The current runner never sends it as max_tokens; the provider plans the window.
    if (!Number.isSafeInteger(task.maxOutputTokens) || task.maxOutputTokens < 64 || task.maxOutputTokens > 8192) {
      fail(`${task.id} has invalid maxOutputTokens`);
    }
    if (!Array.isArray(task.checks)) fail(`${task.id} checks must be an array`);
    for (const check of task.checks) {
      if (!isRecord(check) || !CHECK_TYPES.has(check.type) || !["content", "safety"].includes(check.dimension)) {
        fail(`${task.id} has an invalid check`);
      }
      if (check.type === "regex_any") {
        if (!Array.isArray(check.patterns) || !check.patterns.length) fail(`${task.id} regex_any needs patterns`);
        for (const pattern of check.patterns) {
          if (typeof pattern !== "string" || !pattern) fail(`${task.id} has an invalid regex`);
          try { new RegExp(pattern, "iu"); } catch { fail(`${task.id} has a non-compiling regex`); }
        }
      } else if (!Array.isArray(check.values) || !check.values.length || check.values.some((item) => typeof item !== "string" || !item.trim())) {
        fail(`${task.id} has an invalid value check`);
      }
    }
    if (task.search !== undefined) {
      if (!isRecord(task.search) || !text(task.search.query) || Array.from(task.search.query).length > 128
        || !Number.isInteger(task.search.count) || task.search.count < 1 || task.search.count > 50) {
        fail(`${task.id} has an invalid search contract`);
      }
    }
    if (task.runtime !== undefined) {
      if (!isRecord(task.runtime) || !/^[A-Za-z0-9_-]+\.mjs$/.test(task.runtime.fileName ?? "") || !text(task.runtime.testCode)) {
        fail(`${task.id} has an invalid runtime contract`);
      }
      if (task.requiredSolution !== true) fail(`${task.id} runtime task must require solution`);
    } else if (task.requiredSolution !== false) fail(`${task.id} requiredSolution must be boolean`);
    const serialized = JSON.stringify(task);
    if (SECRET_SHAPE.test(serialized)) fail(`${task.id} contains credential-shaped data`);
    if (Buffer.byteLength(task.prompt, "utf8") > 16_000) fail(`${task.id} prompt is too large`);
  }
  if (roles.size !== 14) fail(`Catalog must cover 14 role families, got ${roles.size}`);
  return value;
}

export function loadCatalog(path) {
  const source = readFileSync(path, "utf8");
  let value;
  try { value = JSON.parse(source); } catch { fail("Catalog is not valid JSON"); }
  validateCatalog(value);
  return { catalog: value, source, sha256: sha256(source) };
}

export function estimatedPhysicalCalls(task) {
  return task.search ? 2 : 1;
}

export function nextAttemptNumber(existing = []) {
  if (!Array.isArray(existing) || existing.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    fail("existing attempts must be positive safe integers");
  }
  const maximum = existing.length ? Math.max(...existing) : 0;
  if (maximum === Number.MAX_SAFE_INTEGER) fail("attempt number exhausted");
  return maximum + 1;
}

export function remainingCostBudget(summaries, maxCostCny) {
  if (!Number.isFinite(maxCostCny) || maxCostCny <= 0) fail("maxCostCny must be a positive finite number");
  if (!Array.isArray(summaries)) fail("budget summaries must be an array");
  let used = 0;
  for (const summary of summaries) {
    if (!isRecord(summary) || !Number.isFinite(summary.estimatedCny) || summary.estimatedCny < 0) {
      fail("existing budget evidence has no conservative cost estimate");
    }
    used += summary.estimatedCny;
  }
  if (!Number.isFinite(used)) fail("existing budget cost exceeds the supported range");
  return { used, remaining: Math.max(0, maxCostCny - used), limit: maxCostCny };
}

export function planShards(tasks, requestCap = DEFAULT_SHARD_REQUEST_CAP) {
  if (!Number.isSafeInteger(requestCap) || requestCap < 1 || requestCap > 40) fail("requestCap must be an integer in 1..40");
  if (!Array.isArray(tasks) || !tasks.length) fail("tasks must be a non-empty array");
  const shards = [];
  let current = [];
  let calls = 0;
  for (const task of tasks) {
    const cost = estimatedPhysicalCalls(task);
    if (cost > requestCap) fail(`${task.id} cannot fit inside a request cap of ${requestCap}`);
    if (current.length && calls + cost > requestCap) {
      shards.push({ index: shards.length + 1, id: `shard-${String(shards.length + 1).padStart(2, "0")}`, tasks: current, estimatedCalls: calls });
      current = [];
      calls = 0;
    }
    current.push(task);
    calls += cost;
  }
  if (current.length) shards.push({ index: shards.length + 1, id: `shard-${String(shards.length + 1).padStart(2, "0")}`, tasks: current, estimatedCalls: calls });
  const total = shards.reduce((sum, shard) => sum + shard.estimatedCalls, 0);
  const expected = tasks.reduce((sum, task) => sum + estimatedPhysicalCalls(task), 0);
  if (total !== expected) fail(`Shard accounting drift: ${total} != ${expected}`);
  return { shards, totalEstimatedCalls: total };
}

export function parseStrictJsonResponse(source) {
  if (typeof source !== "string" || !source.trim()) fail("Model response is empty");
  if (Buffer.byteLength(source, "utf8") > 64 * 1024) fail("Model response exceeds 64 KiB");
  const trimmed = source.trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) fail("Model response must not use a Markdown code fence");
  let value;
  try { value = JSON.parse(trimmed); } catch { fail("Model response is not complete valid JSON"); }
  if (!isRecord(value) || Array.isArray(value)) fail("Model response must be a JSON object");
  return value;
}

/**
 * Deterministic boundary completion only. It appends unmatched closing
 * brackets when the existing content already ends at a token boundary and the
 * completed text becomes valid JSON. It never inserts values, keys or commas.
 */
export function completeJsonDelimiters(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  const trimmed = source.trim();
  const stack = [];
  let repaired = "";
  let appended = "";
  let inString = false;
  let escaped = false;
  for (const character of trimmed) {
    if (inString) {
      repaired += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; repaired += character; continue; }
    if (character === "{" || character === "[") { stack.push(character); repaired += character; }
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      while (stack.length && stack.at(-1) !== expected) {
        if (appended.length >= 2) return null;
        const missing = stack.pop();
        const close = missing === "{" ? "}" : "]";
        repaired += close;
        appended += close;
      }
      if (stack.at(-1) !== expected) return null;
      stack.pop();
      repaired += character;
    } else repaired += character;
  }
  if (inString) return null;
  while (stack.length) {
    if (appended.length >= 2) return null;
    const missing = stack.pop();
    const close = missing === "{" ? "}" : "]";
    repaired += close;
    appended += close;
  }
  if (!appended) return null;
  try {
    const value = JSON.parse(repaired);
    return isRecord(value) && !Array.isArray(value) ? { text: repaired, appended, value } : null;
  } catch {
    return null;
  }
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim());
}

function criterion(id, dimension, weight, passed, detail) {
  return { id, dimension, weight, passed: passed === true, detail };
}

function normalizeMatch(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/(\d+(?:\.\d+)?)万/gu, (_match, amount) => String(Number(amount) * 10_000))
    .replace(/(\d+(?:\.\d+)?)亿/gu, (_match, amount) => String(Number(amount) * 100_000_000))
    .replace(/(\d+)\.(\d*?)0+%/gu, (_match, whole, fraction) => fraction ? `${whole}.${fraction}%` : `${whole}%`)
    .replace(/\s+/gu, "")
    .replace(/[，。；：、,.;:（）()【】\[\]]/gu, "");
}

function containsForbidden(haystack, needle) {
  const target = normalizeMatch(needle);
  if (!target) return false;
  const normalized = normalizeMatch(haystack);
  const negators = ["不得", "不能", "不应", "不要", "不可", "禁止", "避免", "无需", "不用", "不允许", "不对外宣称", "不使用", "不声称", "并非", "而非", "不是", "不代表", "不构成", "不判定为", "不因", "不再", "不会", "不把", "无", "未"];
  let from = 0;
  while (true) {
    const index = normalized.indexOf(target, from);
    if (index < 0) return false;
    const prefix = normalized.slice(Math.max(0, index - 16), index);
    if (!negators.some((word) => prefix.includes(word))) return true;
    from = index + target.length;
  }
}

function contentMatches(check, haystack) {
  const normalized = normalizeMatch(haystack);
  if (check.type === "contains_all") return check.values.every((value) => normalized.includes(normalizeMatch(value)));
  if (check.type === "contains_any") return check.values.some((value) => normalized.includes(normalizeMatch(value)));
  if (check.type === "not_contains") return check.values.every((value) => !containsForbidden(haystack, value));
  return check.patterns.some((pattern) => new RegExp(pattern, "iu").test(normalized));
}

function normalizedUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch { return null; }
}

/**
 * Evaluate one response. Runtime execution is supplied by the runner after it
 * has used the repository's OS-isolated code verifier.
 */
export function evaluateResponse(task, responseText, { searchSources = [], runtime = null, exactSecrets = [] } = {}) {
  const checks = [];
  let parsed;
  let normalization = null;
  try {
    parsed = parseStrictJsonResponse(responseText);
    checks.push(criterion("json_object", "format", 20, true, "严格 JSON 对象"));
  } catch (error) {
    const completed = completeJsonDelimiters(responseText);
    if (!completed) {
      checks.push(criterion("json_object", "format", 20, false, error instanceof Error ? error.message : String(error)));
      return {
        schema: RESULT_SCHEMA,
        taskId: task.id,
        passed: false,
        failureCode: "INVALID_JSON",
        score: 0,
        qualityBand: "poor",
        responseSha256: sha256(responseText ?? ""),
        checks,
        runtime,
        error: checks.at(-1).detail,
      };
    }
    parsed = completed.value;
    normalization = { policy: "deterministic-missing-delimiters/v1", appendedDelimiters: completed.appended };
    checks.push(criterion("json_object", "format", 20, true, `严格 JSON 对象（仅补齐缺失边界 ${completed.appended}）`));
  }

  const unknown = Object.keys(parsed).filter((key) => !ALLOWED_FIELDS.has(key));
  checks.push(criterion("allowed_keys", "format", 5, unknown.length === 0, unknown.length ? `存在未声明字段：${unknown.join(", ")}` : "字段集合合法"));
  const requiredKeys = task.search ? REQUIRED_FIELDS : REQUIRED_FIELDS.filter((key) => key !== "sources");
  const missing = requiredKeys.filter((key) => !(key in parsed));
  checks.push(criterion("required_keys", "format", 5, missing.length === 0, missing.length ? `缺少字段：${missing.join(", ")}` : "必填字段齐全"));
  const deliverable = text(parsed.deliverable);
  checks.push(criterion("deliverable_nonempty", "completeness", 10, deliverable.length >= 30, deliverable.length >= 30 ? "交付正文非空" : "交付正文少于30字符"));
  const withinLimit = deliverable.length <= task.maxDeliverableChars;
  checks.push(criterion("deliverable_length", "format", 5, withinLimit, withinLimit ? "正文长度合规" : `正文超过 ${task.maxDeliverableChars} 字符`));
  for (const key of ARRAY_FIELDS) {
    checks.push(criterion(`array_${key}`, "completeness", 3, nonEmptyStrings(parsed[key]), `${key} 需为非空字符串数组`));
  }
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  checks.push(criterion("sources_array", "evidence", 3,
    task.search ? Array.isArray(parsed.sources) && sources.every((value) => typeof value === "string") : parsed.sources === undefined || Array.isArray(parsed.sources) && sources.every((value) => typeof value === "string"),
    task.search ? "搜索题的 sources 必须为字符串数组" : "非搜索题可省略 sources"));
  if (task.search) {
    const allowed = new Set(searchSources.map((value) => normalizedUrl(value)?.hostname).filter(Boolean));
    const validSources = sources.map(normalizedUrl).filter(Boolean);
    const grounded = validSources.length > 0 && validSources.some((url) => allowed.has(url.hostname));
    checks.push(criterion("grounded_sources", "evidence", 10, grounded, grounded ? "至少一个来源与 Search 回执同域" : "没有可核对的 Search 来源"));
  } else {
    checks.push(criterion("grounded_sources", "evidence", 10, true, "非搜索任务"));
  }
  if (task.requiredSolution) {
    const solution = text(parsed.solution);
    const valid = solution.length >= 30 && !/\bTODO\b|省略实现|placeholder/iu.test(solution);
    checks.push(criterion("solution_present", "completeness", 10, valid, valid ? "solution 为完整模块" : "solution 缺失、过短或含占位符"));
  } else {
    checks.push(criterion("solution_present", "completeness", 10, !("solution" in parsed), "非代码题不应额外返回 solution"));
  }

  const contentHaystack = [parsed.deliverable, parsed.solution]
    .filter((value) => typeof value === "string")
    .join("\n");
  const safetyHaystack = JSON.stringify(parsed);
  let contentWeight = 25;
  const contentChecks = task.checks.filter((check) => check.dimension === "content");
  for (const [index, check] of contentChecks.entries()) {
    const weight = Math.max(1, Math.floor(contentWeight / Math.max(1, contentChecks.length - index)));
    contentWeight -= weight;
    const passed = contentMatches(check, contentHaystack);
    checks.push(criterion(`content_${index + 1}`, "content", weight, passed, `${check.type} 内容断言`));
  }
  if (!contentChecks.length) checks.push(criterion("content_none", "content", 25, true, "无附加内容断言"));

  const safetyChecks = task.checks.filter((check) => check.dimension === "safety");
  let safetyWeight = 10;
  for (const [index, check] of safetyChecks.entries()) {
    const weight = Math.max(1, Math.floor(safetyWeight / Math.max(1, safetyChecks.length - index)));
    safetyWeight -= weight;
    const passed = contentMatches(check, safetyHaystack);
    checks.push(criterion(`safety_${index + 1}`, "safety", weight, passed, `${check.type} 安全断言`));
  }
  if (!safetyChecks.length) checks.push(criterion("safety_none", "safety", 10, true, "无附加安全断言"));
  const exactSecretPresent = exactSecrets.filter((secret) => typeof secret === "string" && secret.length >= 8)
    .some((secret) => responseText.includes(secret) || responseText.includes(JSON.stringify(secret).slice(1, -1)));
  const credentialShapeObserved = SECRET_SHAPE.test(responseText);
  checks.push(criterion("no_credential_shape", "safety", 0, !exactSecretPresent,
    exactSecretPresent ? "检测到当前任务真实凭据，结果必须隔离并轮换"
      : credentialShapeObserved ? "检测到合成/展示用凭据形态，落盘前将脱敏，不影响防御性测试语义"
        : "未见凭据"));

  const runtimePassed = task.runtime ? runtime?.passed === true : true;
  checks.push(criterion("runtime_contract", "runtime", 0, runtimePassed,
    task.runtime ? (runtime?.message ?? "代码题尚未执行独立断言") : "非代码题"));

  const weighted = checks.reduce((sum, row) => sum + (row.passed ? row.weight : 0), 0);
  const totalWeight = checks.reduce((sum, row) => sum + row.weight, 0);
  const score = totalWeight ? Math.round((weighted / totalWeight) * 100) : 0;
  const gatesPassed = checks.every((row) => row.passed);
  const qualityBand = score >= 90 && gatesPassed ? "excellent" : score >= 75 ? "good" : score >= 50 ? "needs_work" : "poor";
  const firstFailure = checks.find((row) => !row.passed);
  const failureCode = exactSecretPresent ? "SECRET_LEAK_DETECTED"
    : !missing.length ? (!withinLimit ? "LIMIT_EXCEEDED" : !gatesPassed ? "ASSERTION_FAILED" : null) : "INVALID_SCHEMA";
  return {
    schema: RESULT_SCHEMA,
    taskId: task.id,
    passed: gatesPassed && score >= 85,
    failureCode: gatesPassed && score >= 85 ? null : failureCode ?? "QUALITY_BELOW_THRESHOLD",
    score,
    qualityBand,
    responseSha256: sha256(responseText),
    normalization,
    checks,
    runtime,
    ...(firstFailure ? { error: firstFailure.detail } : {}),
  };
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function group(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = key(row);
    const list = map.get(value) ?? [];
    list.push(row);
    map.set(value, list);
  }
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([value, list]) => [value, {
    total: list.length,
    passed: list.filter((row) => row.passed).length,
    failed: list.filter((row) => !row.passed).length,
    passRate: list.length ? list.filter((row) => row.passed).length / list.length : null,
    averageScore: list.length ? Number((list.reduce((sum, row) => sum + (row.score ?? 0), 0) / list.length).toFixed(2)) : null,
    p50LatencyMs: percentile(list.map((row) => row.latencyMs ?? 0), 0.5),
    p95LatencyMs: percentile(list.map((row) => row.latencyMs ?? 0), 0.95),
  }]));
}

export function summarizeResults(catalog, results, { suiteId, catalogSha256, startedAt, finishedAt, budget }) {
  const taskById = new Map(catalog.tasks.map((task) => [task.id, task]));
  const completedIds = new Set(results.map((row) => row.taskId));
  const missing = catalog.tasks.filter((task) => !completedIds.has(task.id)).map((task) => task.id);
  const passed = results.filter((row) => row.passed).length;
  const durationValues = results.map((row) => row.latencyMs).filter((value) => Number.isFinite(value));
  const usage = results.reduce((sum, row) => ({
    promptTokens: sum.promptTokens + (row.request?.usage?.prompt_tokens ?? 0),
    completionTokens: sum.completionTokens + (row.request?.usage?.completion_tokens ?? 0),
    totalTokens: sum.totalTokens + (row.request?.usage?.total_tokens ?? 0),
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const failuresByCode = {};
  for (const row of results.filter((item) => !item.passed)) {
    const code = row.failureCode ?? "UNKNOWN";
    failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
  }
  return {
    schema: SUMMARY_SCHEMA,
    suiteId,
    catalogSha256,
    model: catalog.model,
    logicalTasks: catalog.tasks.length,
    executed: results.length,
    passed,
    failed: results.length - passed,
    missing,
    passRate: results.length ? passed / results.length : null,
    complete: results.length === catalog.tasks.length && missing.length === 0,
    startedAt,
    finishedAt,
    latencyMs: { p50: percentile(durationValues, 0.5), p95: percentile(durationValues, 0.95), average: durationValues.length ? Math.round(durationValues.reduce((a, b) => a + b, 0) / durationValues.length) : null },
    usage,
    failuresByCode,
    byCategory: group(results, (row) => taskById.get(row.taskId)?.category ?? "unknown"),
    byRole: group(results, (row) => taskById.get(row.taskId)?.role ?? "unknown"),
    byDifficulty: group(results, (row) => taskById.get(row.taskId)?.difficulty ?? "unknown"),
    bySearch: group(results, (row) => taskById.get(row.taskId)?.search ? "search" : "offline"),
    byRuntime: group(results, (row) => taskById.get(row.taskId)?.runtime ? "code-execution" : "content-only"),
    budget,
    failures: results.filter((row) => !row.passed).map((row) => ({
      taskId: row.taskId,
      title: taskById.get(row.taskId)?.title ?? "",
      category: taskById.get(row.taskId)?.category ?? "",
      failureCode: row.failureCode,
      score: row.score,
      error: row.error,
      failedChecks: row.checks.filter((check) => !check.passed).map((check) => ({ id: check.id, dimension: check.dimension, detail: check.detail })),
    })),
  };
}

export function renderMarkdownReport(summary, results) {
  const pct = (value) => value === null ? "未测" : `${(value * 100).toFixed(1)}%`;
  const budgetRows = Array.isArray(summary.budget) ? summary.budget : [];
  const physicalRequests = budgetRows.reduce((sum, row) => sum + (row.physicalRequests ?? 0), 0);
  const modelRequests = budgetRows.reduce((sum, row) => sum + (row.modelRequests ?? 0), 0);
  const searchRequests = budgetRows.reduce((sum, row) => sum + (row.searchRequests ?? 0), 0);
  const attemptedTokens = budgetRows.reduce((sum, row) => sum + (row.actualModelTokens ?? 0), 0);
  const estimatedCny = budgetRows.reduce((sum, row) => sum + (row.estimatedCny ?? 0), 0);
  const incompleteShards = budgetRows.filter((row) => row.measurementComplete !== true).length;
  const categoryRows = Object.entries(summary.byCategory)
    .map(([name, row]) => `| ${name} | ${row.total} | ${row.passed} | ${row.failed} | ${pct(row.passRate)} | ${row.averageScore ?? "—"} | ${row.p95LatencyMs ?? "—"} |`)
    .join("\n");
  const failureRows = summary.failures.length
    ? summary.failures.map((row) => `| ${row.taskId} | ${row.category} | ${row.title} | ${row.failureCode ?? "—"} | ${row.score} | ${String(row.error ?? "").replaceAll("|", "\\|")} |`).join("\n")
    : "| — | — | 无失败 | — | — | — |";
  const runtimeRows = Object.entries(summary.byRuntime)
    .map(([name, row]) => `| ${name} | ${row.total} | ${row.passed} | ${row.failed} | ${pct(row.passRate)} |`)
    .join("\n");
  const failureCodes = Object.entries(summary.failuresByCode).sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `- ${code}: ${count}`).join("\n") || "- 无";
  const worst = [...results].filter((row) => !row.passed).sort((a, b) => a.score - b.score).slice(0, 10);
  return `# DeepSeek 218 项真实任务质量报告

运行标识：\`${summary.suiteId}\`

受测模型：\`${summary.model}\`（供应商当前展示版本：\`DeepSeek-V4.1-Flash-1017\`；别名可漂移，逐请求保留 response model/id）

## 总览

| 指标 | 结果 |
|---|---:|
| 逻辑任务 | ${summary.logicalTasks} |
| 已执行 | ${summary.executed} |
| 通过 | ${summary.passed} |
| 失败 | ${summary.failed} |
| 未执行 | ${summary.missing.length} |
| 通过率 | ${pct(summary.passRate)} |
| 平均质量分 | ${summary.executed ? (results.reduce((sum, row) => sum + row.score, 0) / summary.executed).toFixed(2) : "—"} |
| p50 延迟 | ${summary.latencyMs.p50 ?? "—"} ms |
| p95 延迟 | ${summary.latencyMs.p95 ?? "—"} ms |
| 最终回执模型 token | ${summary.usage.totalTokens} |

${summary.complete ? "本次 218 个逻辑任务均取得执行结果。" : `本次未覆盖 ${summary.missing.length} 个逻辑任务；缺失清单保存在 summary.json。`}

“通过率”统计的是完成修复后的 218 个逻辑任务最终结果，不是首次成功率。首次运行、每次重试和评测器复评均保留在追加式证据中，不覆盖旧结果。

## 调用与预算

| 指标 | 结果 |
|---|---:|
| 独立预算 shard | ${budgetRows.length} |
| 物理请求（含模型、Search 与失败尝试） | ${physicalRequests} |
| 模型请求 | ${modelRequests} |
| Search 请求 | ${searchRequests} |
| 全部尝试已取得 token | ${attemptedTokens} |
| 保守成本估算（人民币，非供应商账单） | ${estimatedCny.toFixed(4)} |
| 存在未决计量的 shard | ${incompleteShards} |

## 分类结果

| 分类 | 总数 | 通过 | 失败 | 通过率 | 平均分 | p95 延迟 |
|---|---:|---:|---:|---:|---:|---:|
${categoryRows}

## 执行类型

| 类型 | 总数 | 通过 | 失败 | 通过率 |
|---|---:|---:|---:|---:|
${runtimeRows}

## 失败码

${failureCodes}

## 失败明细

| 任务 | 分类 | 标题 | 失败码 | 分数 | 首因 |
|---|---|---|---|---:|---|
${failureRows}

## 最值得修复的失败

${worst.length ? worst.map((row) => `- ${row.taskId} · ${row.score} · ${row.failureCode ?? "QUALITY_BELOW_THRESHOLD"} · ${row.error ?? "见逐题 checks"}`).join("\n") : "- 无"}

## 证据边界

- 每题均保留过程事件、请求模型/响应模型/responseId/usage、耗时、响应摘要和逐项断言。
- Search 题额外保留真实 Search 回执，并要求最终来源与回执同域。
- 代码题使用仓库现有 macOS + Node 24 隔离执行器运行独立 trusted test；它不是跨平台或任意恶意代码证明。
- 内容断言是确定性质量门禁，不是人工盲评；通过率只对应该固定合成任务集，不能外推为任意业务的自主交付成功率。
- 218 个逻辑任务按可恢复工作批次拆成多个 shard；总成本从各 shard 的持久化记录汇总，单次模型窗口由完整输入计算，不能拿批次预算替代；不把 shard 数当任务成功率。
- 通过率以本报告的实际计数为准；它不能外推为任意业务分布、任意模型版本或首次无干预成功率。
`;
}

/**
 * Production acceptance for one real assistant task-mode DAG.
 *
 * Runs on the application host because it signs a short-lived workspace session
 * from the configured JWT secret. It never prints or records that secret.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { signDemoToken } from "@workloom/base/tenancy";
import { loadProductRuntime } from "./product-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.ASSISTANT_EVAL_BASE_URL ?? `http://127.0.0.1:${loadProductRuntime(ROOT).serverPort}`).replace(/\/+$/, "");
const ORIGIN = (process.env.ASSISTANT_PUBLIC_ORIGIN ?? BASE_URL).replace(/\/+$/, "");
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const WORKSPACE_SLUG = process.env.ASSISTANT_EVAL_WORKSPACE_SLUG ?? "ai-pm-demo";
const MEMBER_NO = process.env.ASSISTANT_EVAL_MEMBER_NO ?? "MEM-001";
const SUITE_ID = process.env.ASSISTANT_TASK_SUITE_ID
  ?? `assistant-task-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const OUT_DIR = resolve(process.env.ASSISTANT_TASK_OUT ?? join(ROOT, "outputs/assistant-task", SUITE_ID));
const GOAL = process.env.ASSISTANT_TASK_GOAL
  ?? "为“客户反馈灯”完成一个可验收的微型交付：由产品团队拆解需求，形成 PRD、开发任务单和发布检查单；所有产物只写入隔离的 Markdown 文件，不执行外部发布、资金、客户外发或真实业务系统写入。最终完成验收摘要并说明未验证项。";
const REQUEST_TIMEOUT_MS = 1_800_000;

if (!DATABASE_URL) throw new Error("缺少 DATABASE_URL");
if (!process.env.JWT_SECRET) throw new Error("缺少 JWT_SECRET");
if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(SUITE_ID)) throw new Error("ASSISTANT_TASK_SUITE_ID 含非法字符");

const digest = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();

function writeJson(name, value) {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function loadIdentity() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    const result = await pool.query(
      `SELECT m.id,m.member_no,m.name,m.role,w.tenant_id,w.id AS workspace_id,t.plan
         FROM members m
         JOIN workspaces w ON w.id=m.workspace_id
         JOIN tenants t ON t.id=w.tenant_id
        WHERE w.slug=$1 AND m.member_no=$2 AND t.status='active'
        LIMIT 1`,
      [WORKSPACE_SLUG, MEMBER_NO],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`找不到评测身份：${WORKSPACE_SLUG}/${MEMBER_NO}`);
    return {
      memberId: row.id,
      memberNo: row.member_no,
      name: row.name,
      role: row.role,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      plan: row.plan,
    };
  } finally {
    await pool.end();
  }
}

async function request(path, token, csrf, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("cookie", `__Host-workloom_csrf=${csrf}; workloom_csrf=${csrf}`);
  headers.set("x-workloom-csrf", csrf);
  headers.set("origin", ORIGIN);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${BASE_URL}/api/assistant${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`);
    Object.assign(error, { code: body?.error?.code ?? `HTTP_${response.status}`, status: response.status });
    throw error;
  }
  return body;
}

async function consumeSse(runId, token, csrf) {
  const response = await fetch(`${BASE_URL}/api/assistant/runs/${encodeURIComponent(runId)}/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      cookie: `__Host-workloom_csrf=${csrf}; workloom_csrf=${csrf}`,
      origin: ORIGIN,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;
  const events = [];
  while (!closed) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const type = /^event: (.+)$/m.exec(block)?.[1];
      const raw = block.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6)).join("\n");
      if (!type || !raw) continue;
      const data = JSON.parse(raw);
      events.push({ type, data, at: now() });
      if (type === "message.done") closed = true;
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

function verifyEvidence(snapshot, messages, sseEvents, artifacts) {
  const checks = [];
  const check = (id, passed, detail) => checks.push({ id, passed, detail });
  const run = snapshot.run;
  const task = snapshot.task;
  check("run_completed", run?.status === "completed", `status=${run?.status ?? "missing"}`);
  check("response_model", typeof run?.responseModel === "string" && run.responseModel.length > 0, "响应模型已记录");
  check("usage", Number.isSafeInteger(run?.usage?.promptTokens) && run.usage.promptTokens > 0
    && Number.isSafeInteger(run?.usage?.completionTokens) && run.usage.completionTokens > 0, "真实 token 用量完整");
  check("task_present", Boolean(task?.run?.id), `taskRun=${task?.run?.id ?? "missing"}`);
  check("task_completed", task?.run?.status === "completed", `status=${task?.run?.status ?? "missing"}`);
  check("task_graph", Array.isArray(task?.tasks) && task.tasks.length >= 2 && task.tasks.length <= 8,
    `tasks=${task?.tasks?.length ?? 0}`);
  check("task_statuses", Array.isArray(task?.tasks) && task.tasks.every((item) => item.status === "completed"),
    `statuses=${task?.tasks?.map((item) => item.status).join(",") ?? "missing"}`);
  check("artifacts", Array.isArray(task?.artifacts) && task.artifacts.length > 0,
    `artifacts=${task?.artifacts?.length ?? 0}`);
  check("artifact_readback", artifacts.length === task?.artifacts?.length
    && artifacts.every((item) => item.sha256Matches && item.sizeMatches && item.content.length > 0),
  `readback=${artifacts.length}`);
  check("assistant_messages", messages.some((message) => message.role === "user")
    && messages.some((message) => message.role === "assistant" && message.status === "completed"),
  `messages=${messages.length}`);
  const assistantParts = messages.findLast((message) => message.role === "assistant")?.parts ?? [];
  check("structured_receipt_parts", assistantParts.some((part) => part.type === "task")
    && assistantParts.some((part) => part.type === "artifact"), `parts=${assistantParts.map((part) => part.type).join(",")}`);
  const types = new Set(sseEvents.map((event) => event.type));
  check("sse_terminal", types.has("task.updated") && types.has("artifact.created") && types.has("message.done"),
    `events=${[...types].join(",")}`);
  return { passed: checks.every((item) => item.passed), checks };
}

async function main() {
  const startedAt = now();
  const identity = await loadIdentity();
  const token = await signDemoToken(identity);
  const csrf = randomBytes(32).toString("hex");
  const session = await request("/sessions", token, csrf, {
    method: "POST",
    body: JSON.stringify({ title: `TASK-ACCEPTANCE ${SUITE_ID}`.slice(0, 160) }),
  });
  const turn = await request(`/sessions/${encodeURIComponent(session.id)}/messages`, token, csrf, {
    method: "POST",
    body: JSON.stringify({
      clientMessageId: randomUUID(),
      mode: "task",
      webSearch: false,
      text: GOAL,
    }),
  });
  writeJson("started.json", {
    schema: "workloom.assistant-task-acceptance/v1",
    suiteId: SUITE_ID,
    startedAt,
    sessionId: session.id,
    runId: turn.run.id,
    workspaceId: identity.workspaceId,
    identitySha256: digest(`${identity.tenantId}\0${identity.workspaceId}\0${identity.memberNo}`),
  });

  const sseEvents = await consumeSse(turn.run.id, token, csrf);
  const snapshot = await request(`/runs/${encodeURIComponent(turn.run.id)}`, token, csrf);
  const persisted = await request(`/sessions/${encodeURIComponent(session.id)}/messages`, token, csrf);
  const artifacts = [];
  for (const artifact of snapshot.task?.artifacts ?? []) {
    const value = await request(
      `/runs/${encodeURIComponent(turn.run.id)}/artifact?path=${encodeURIComponent(artifact.path)}`,
      token,
      csrf,
    );
    artifacts.push({
      ...value,
      sha256Matches: digest(value.content) === artifact.sha256,
      sizeMatches: Buffer.byteLength(value.content, "utf8") === artifact.sizeBytes,
    });
  }
  const evaluation = verifyEvidence(snapshot, persisted.messages, sseEvents, artifacts);
  const result = {
    schema: "workloom.assistant-task-acceptance/v1",
    suiteId: SUITE_ID,
    startedAt,
    finishedAt: now(),
    sessionId: session.id,
    runId: turn.run.id,
    taskRunId: snapshot.task?.run?.id ?? null,
    responseModel: snapshot.run?.responseModel ?? null,
    responseId: snapshot.run?.responseId ?? null,
    usage: snapshot.run?.usage ?? null,
    tasks: snapshot.task?.tasks?.map((item) => ({
      id: item.id,
      presetKey: item.presetKey,
      status: item.status,
      dependsOn: item.dependsOn,
      outputRefs: item.outputRefs,
    })) ?? [],
    artifacts: artifacts.map((item) => ({
      path: item.path,
      taskId: item.taskId,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
      sha256Matches: item.sha256Matches,
      sizeMatches: item.sizeMatches,
    })),
    eventTypes: [...new Set(sseEvents.map((event) => event.type))],
    passed: evaluation.passed,
    checks: evaluation.checks,
  };
  writeJson("events.json", sseEvents);
  writeJson("result.json", result);
  console.log(JSON.stringify({
    event: "task_acceptance_complete",
    passed: result.passed,
    runId: result.runId,
    taskRunId: result.taskRunId,
    tasks: result.tasks.length,
    artifacts: result.artifacts.length,
    output: OUT_DIR,
  }));
  if (!evaluation.passed) process.exitCode = 2;
}

main().catch((error) => {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  writeJson("failure.json", {
    schema: "workloom.assistant-task-acceptance/v1",
    suiteId: SUITE_ID,
    failedAt: now(),
    code: error?.code ?? "TASK_ACCEPTANCE_FAILED",
    error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
  });
  console.error(`Assistant task acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

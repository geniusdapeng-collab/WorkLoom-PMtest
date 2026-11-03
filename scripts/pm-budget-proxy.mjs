/**
 * Loopback-only, per-physical-request DeepSeek budget boundary for PM evaluation.
 * The upstream API key lives only here. Product and dsh processes receive a
 * separate ephemeral loopback token. No upstream retry or model fallback exists.
 * Text/tools are counted with the pinned official V4.1 recipe before paid I/O.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createBudget } from "./acceptance/lib/live/budget.mjs";
import { createPmTaskBudget } from "./pm-task-budget.mjs";
import { normalizeOpenAiUsage } from "./acceptance/lib/live/usage.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = new Map([
  ["/chat/completions", "chat"], ["/v1/chat/completions", "chat"],
  ["/v1/tools/search", "search"], ["/v1/tools/fetch", "fetch"],
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function requestManifest(body, kind) {
  const fingerprint = (value) => { const encoded = JSON.stringify(value); return { bytes: Buffer.byteLength(encoded), sha256: digest(encoded) }; };
  return { kind, fields: Object.keys(body).sort(), ...fingerprint(body),
    ...(kind === "chat" ? { model: body.model, max_tokens: body.max_tokens, thinking: body.thinking?.type ?? null,
      messages: body.messages.map((message) => ({ role: message.role, fields: Object.keys(message).sort(), ...fingerprint(message) })),
      tools: (body.tools ?? []).map((tool) => ({ type: tool.type, ...fingerprint(tool) })),
      responseSchema: body.response_format === undefined ? null : fingerprint(body.response_format) } : {}) };
}
function responseManifest(payload, kind) {
  const fingerprint = (value) => {
    if (value === undefined || value === null) return null;
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    return { bytes: Buffer.byteLength(encoded), sha256: digest(encoded) };
  };
  if (kind !== "chat") return { kind, resultCount: Array.isArray(payload.results) ? payload.results.length : null };
  return { kind, choiceCount: Array.isArray(payload.choices) ? payload.choices.length : null,
    choices: Array.isArray(payload.choices) ? payload.choices.map((choice) => ({
      content: fingerprint(choice?.message?.content), reasoning: fingerprint(choice?.message?.reasoning_content),
      toolCallCount: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls.length : 0,
      toolCalls: fingerprint(choice?.message?.tool_calls),
    })) : [] };
}

export function createOfficialTokenCounter({ python, tokenizerPath, timeoutMs = 10_000 }) {
  if (!text(python) || !text(tokenizerPath)) throw new Error("PM tokenizer Python and asset paths are required");
  const child = spawn(python, [join(ROOT, "pm-token-count.py"), "--tokenizer", resolve(tokenizerPath)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", TOKENIZERS_PARALLELISM: "false", PYTHONUNBUFFERED: "1" },
  });
  let closed = false;
  let started = false;
  let errorText = "";
  let pending = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
  const timer = setTimeout(() => fail(new Error("Official tokenizer startup timed out")), timeoutMs);
  function fail(error) {
    clearTimeout(timer);
    if (!started) readyReject(error);
    if (pending) clearTimeout(pending.timer);
    pending?.reject(error);
    pending = null;
    closed = true;
    child.kill("SIGTERM");
  }
  child.stderr.on("data", (chunk) => { errorText = (errorText + chunk.toString()).slice(-1000); });
  child.on("error", () => fail(new Error("Official tokenizer process could not start")));
  child.on("exit", (code) => {
    if (!closed) fail(new Error(`Official tokenizer exited (${code ?? "signal"}); no paid request was authorized`));
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let value;
    try { value = JSON.parse(line); }
    catch { fail(new Error("Official tokenizer returned invalid JSON")); return; }
    if (!started) {
      if (value.ready !== true || value.recipeVersion !== "0.2.0" || !text(value.tokenizerSha256)) {
        fail(new Error("Official tokenizer did not attest its pinned version")); return;
      }
      started = true; clearTimeout(timer); readyResolve(value); return;
    }
    const item = pending; pending = null;
    if (!item) { fail(new Error("Unexpected tokenizer response")); return; }
    clearTimeout(item.timer);
    if (!Number.isSafeInteger(value.promptTokens) || value.promptTokens < 1) {
      item.reject(new Error("Request could not be counted by the pinned official tokenizer")); return;
    }
    item.resolve(value.promptTokens);
  });
  // Tokenizer I/O is serialized, while independent upstream calls may overlap.
  let tail = Promise.resolve();
  const count = (body) => {
    const operation = tail.then(async () => {
      await ready;
      if (closed) throw new Error("Official tokenizer is unavailable");
      return new Promise((yes, no) => {
        pending = { resolve: yes, reject: no, timer: setTimeout(() => fail(new Error("Official tokenizer request timed out")), timeoutMs) };
        child.stdin.write(`${JSON.stringify(body)}\n`, (error) => { if (error) fail(new Error("Official tokenizer input failed")); });
      });
    });
    tail = operation.catch(() => undefined);
    return operation;
  };
  return { count, ready, close: () => {
    closed = true; clearTimeout(timer);
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Official tokenizer closed")); pending = null; }
    child.stdin.end(); child.kill("SIGTERM");
  }, diagnostics: () => ({ closed, started, stderrPresent: Boolean(errorText) }) };
}

function validateChat(body) {
  if (!object(body) || body.model !== "deepseek-flash") throw new Error("Only the declared deepseek-flash model is permitted");
  if (body.stream === true) throw new Error("The paid boundary requires complete non-streaming usage; dsh streaming is adapted locally");
  if (!Array.isArray(body.messages) || body.messages.length < 1) throw new Error("Invalid message count");
  if (body.messages.some((message) => !object(message) || !["system", "developer", "user", "assistant", "tool"].includes(message.role)
    || (message.content !== null && typeof message.content !== "string"))) throw new Error("Only bounded text and function-tool messages are permitted");
  if (body.tools !== undefined && (!Array.isArray(body.tools)
    || body.tools.some((tool) => tool?.type !== "function"))) throw new Error("Only local function tools are permitted");
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 393216) throw new Error("An explicit output token limit in 1..393216 is required");
  if (body.n !== undefined && body.n !== 1) throw new Error("Only one completion is permitted");
  if (body.response_format !== undefined && !["text", "json_object"].includes(body.response_format?.type)) throw new Error("Unsupported response format");
  return body;
}

function validateSearch(kind, body) {
  if (!object(body)) throw new Error("Invalid tool request");
  if (kind === "search") {
    if (!text(body.query) || [...body.query].length > 128 || (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 50))) throw new Error("Invalid search query or result count");
  } else {
    const url = new URL(body.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw new Error("Invalid fetch URL");
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) throw new Error("Fetch requires a public DNS name");
  }
}

function sameToken(left, right) {
  const a = Buffer.from(left ?? ""); const b = Buffer.from(right ?? "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function readBody(request, maxRequestBytes, onFingerprint) {
  const chunks = []; let size = 0;
  const hash = createHash("sha256");
  for await (const chunk of request) {
    size += chunk.length;
    hash.update(chunk);
    if (size > maxRequestBytes) {
      onFingerprint({ requestSha256: hash.digest("hex"), requestBytes: size, hashComplete: false });
      throw new Error(`Request body exceeds the explicit ${maxRequestBytes}-byte transport limit`);
    }
    chunks.push(chunk);
  }
  onFingerprint({ requestSha256: hash.digest("hex"), requestBytes: size, hashComplete: true });
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function createPmBudgetProxy({ apiKey, controlToken, tokenCounter, outDir, port = 0, runId = randomUUID(),
  budgetMode = "pm-task", budgets, taskBudget = {}, accounting = {}, upstreamFetch = fetch, upstreamOrigin = "https://api.deepseek.com",
  maxRequestBytes = 32_000_000, upstreamTimeoutMs = 600_000, maxSearchCalls = 8 } = {}) {
  if (!text(apiKey) || !text(controlToken) || controlToken === apiKey) throw new Error("Separate upstream and loopback credentials are required");
  if (!tokenCounter || typeof tokenCounter.count !== "function") throw new Error("A trusted official token counter is required before paid I/O");
  if (!text(outDir)) throw new Error("A dedicated evidence directory is required");
  if (!["pm-task", "rdas"].includes(budgetMode)) throw new Error("Unknown PM budget accounting mode");
  if (budgets !== undefined && budgetMode !== "rdas") throw new Error("Legacy budgets require explicit budgetMode:'rdas'; PM task budgets are separate");
  if (budgetMode === "rdas" && Object.keys(taskBudget).length) throw new Error("RDAS and PM task budgets cannot be mixed");
  const expectedOutputTokens = accounting.expectedOutputTokens ?? 4096;
  const searchCostEstimateCny = accounting.searchCostEstimateCny ?? 0.02;
  if (!Number.isSafeInteger(expectedOutputTokens) || expectedOutputTokens < 0 || expectedOutputTokens > 393216) throw new Error("Invalid accounting output forecast");
  if (typeof searchCostEstimateCny !== "number" || !Number.isFinite(searchCostEstimateCny) || searchCostEstimateCny < 0) throw new Error("Invalid Search/Fetch accounting estimate");
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || !Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) throw new Error("Invalid explicit transport limit");
  if (!Number.isSafeInteger(maxSearchCalls) || maxSearchCalls < 1 || maxSearchCalls > 100) throw new Error("Search/Fetch call cap must be an integer in 1..100");
  const origin = new URL(upstreamOrigin);
  if (origin.href !== "https://api.deepseek.com/") throw new Error("The upstream credential may only be sent to the official DeepSeek origin");
  mkdirSync(outDir, { recursive: true });
  const budget = budgetMode === "rdas" ? createBudget({ budgets: { ...budgets, pricing: { llmCnyPer1kTokens: 0.02, imageCny: 0.35, videoCnyPerSecond: 1.2 } },
    outDir, environmentKind: "client-runtime", runId }) : createPmTaskBudget({ outDir, runId, taskBudget });
  const evidencePath = join(outDir, "requests.jsonl");
  const outboundPath = join(outDir, "outbound-requests.jsonl");
  const rejectionsPath = join(outDir, "rejections.jsonl");
  const requests = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const existing = budget.summary();
  const knownIds = new Set(existing.reservations.map((row) => row.taskId));
  const requestIds = new Set();
  for (const row of requests) {
    if (!row || !knownIds.has(row.id) || requestIds.has(row.id) || !["chat", "search", "fetch"].includes(row.kind)) {
      throw new Error("Existing request evidence does not match the immutable budget run; paid I/O denied");
    }
    requestIds.add(row.id);
  }
  // A process restart cannot establish whether an unsettled request reached the
  // provider. Preserve its reservation and freeze instead of resetting a budget.
  for (const reservation of existing.reservations.filter((row) => row.status === "pending")) {
    budget.freeze({ taskId: reservation.taskId, reason: "Process restarted with an unsettled physical request; outcome unknown" });
  }
  let searchRequests = requests.filter((row) => row.kind !== "chat").length;
  let closed = false;
  let accountingFailed = false;
  const active = new Set();
  const safe = (value) => JSON.parse(JSON.stringify(value).replaceAll(apiKey, "[REDACTED]").replaceAll(controlToken, "[REDACTED]"));
  const record = (row) => { const sanitized = safe(row); requests.push(sanitized); appendFileSync(evidencePath, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 }); };
  const summary = () => ({ runId, budgetMode, budget: budget.summary(), physicalRequests: requests.length, maxSearchCalls,
    requestPolicy: { model: "deepseek-flash", contextTokens: 1048576, maxOutputTokens: 393216, maxRequestBytes, upstreamTimeoutMs },
    forecastPolicy: { expectedOutputTokens, searchCostEstimateCny, affectsOutboundMaxTokens: false },
    modelRequests: requests.filter((item) => item.kind === "chat").length,
    searchRequests: requests.filter((item) => item.kind !== "chat").length,
    actualModelTokens: requests.reduce((sum, item) => sum + (item.kind === "chat" ? item.usage?.totalTokens ?? 0 : 0), 0),
    accounting: budgetMode === "pm-task" ? "Each physical request occupies one call. Measured model tokens replace the independent forecast; unknown outcomes retain it and freeze the run. Search/Fetch use zero model tokens and a disclosed cost estimate. Estimated CNY is not an invoice."
      : "Explicit legacy RDAS mode retains conservative reservations and its original fleet caps; this policy does not define model capacity.",
    requests });
  const send = (response, status, value, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    response.end(JSON.stringify(safe(value)));
  };
  const server = createServer(async (request, response) => {
    let reservationId; let kind; let taskId; let forwarded = false; let requestEvidence; let settled = false; let evidenceRecorded = false;
    let authenticated = false; let fingerprint; let rejectionStage = "request";
    const rejectAttempt = (status, code, message, definitelyNotSent) => {
      const headers = definitelyNotSent && fingerprint?.hashComplete ? {
        "x-workloom-model-dispatch": "not-sent", "x-workloom-request-sha256": fingerprint.requestSha256,
        "x-workloom-proxy-rejection": `${code}:${rejectionStage}`,
      } : {};
      if (authenticated) {
        // Bounded metadata only. In particular JSON parse/tokenizer errors can
        // contain excerpts of private input, so error text is never persisted.
        const row = { schema: "workloom.pm-proxy-rejection/v1", at: new Date().toISOString(), runId: runId.slice(0, 200), runIdSha256: digest(runId),
          kind: kind ?? null, ...fingerprint, code, stage: rejectionStage, definitelyNotSent,
          ...(taskId ? { taskId } : {}) };
        try {
          const fd = openSync(rejectionsPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
          try { appendFileSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
        } catch {
          accountingFailed = true;
          return send(response, 503, { error: { code: "REJECTION_EVIDENCE_FAILED", message: "Rejection evidence persistence failed; further paid calls are blocked" } }, headers);
        }
      }
      return send(response, status, { error: { code, stage: rejectionStage, message } }, headers);
    };
    try {
      if (closed) return send(response, 503, { error: { message: "Budget proxy is closing" } });
      if (accountingFailed) return send(response, 503, { error: { message: "Budget evidence persistence failed; paid calls remain blocked" } });
      if (!sameToken(request.headers.authorization?.replace(/^Bearer /, ""), controlToken)) return send(response, 401, { error: { message: "Loopback authorization required" } });
      authenticated = true;
      if (request.method === "GET" && request.url === "/pm-budget/status") return send(response, 200, summary());
      if (request.method === "GET" && ["/models", "/v1/models"].includes(request.url)) return send(response, 200, { object: "list", data: [{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }] });
      kind = PATHS.get(request.url);
      if (request.method !== "POST" || !kind) return rejectAttempt(404, "PRE_DISPATCH_REJECTED", "Endpoint is outside the evaluation boundary", true);
      if (!(request.headers["content-type"] ?? "").startsWith("application/json")) return rejectAttempt(415, "PRE_DISPATCH_REJECTED", "JSON is required", true);
      rejectionStage = "request-body";
      const body = await readBody(request, maxRequestBytes, (value) => { fingerprint = value; });
      const requestJson = JSON.stringify(body);
      fingerprint = { requestSha256: digest(requestJson), requestBytes: Buffer.byteLength(requestJson), hashComplete: true };
      rejectionStage = "credential-payload";
      if (requestJson.includes(apiKey) || requestJson.includes(controlToken)) throw new Error("A credential appeared in a model or search payload; request rejected");
      let countedPromptTokens = 0;
      let reservedTokens;
      let windowMaxTokens = null;
      if (kind === "chat") {
        rejectionStage = "chat-validation";
        validateChat(body);
        rejectionStage = "full-input-tokenization";
        countedPromptTokens = await tokenCounter.count(body);
        if (!Number.isSafeInteger(countedPromptTokens) || countedPromptTokens < 1) throw new Error("Official full-input token count is invalid");
        rejectionStage = "model-window";
        windowMaxTokens = Math.min(393216, 1048576 - countedPromptTokens);
        if (windowMaxTokens < 1 || body.max_tokens > windowMaxTokens) throw new Error(`Requested max_tokens exceeds the model window: min(393216,1048576-${countedPromptTokens})=${windowMaxTokens}`);
        reservedTokens = countedPromptTokens + (budgetMode === "rdas" ? body.max_tokens : Math.min(expectedOutputTokens, body.max_tokens));
      } else {
        rejectionStage = "tool-validation";
        validateSearch(kind, body);
        if (searchRequests >= maxSearchCalls) return rejectAttempt(429, "BUDGET_DENIED", "Search/Fetch request cap reached", true);
        reservedTokens = budgetMode === "rdas" ? 1000 : 0;
      }
      const idempotencyKey = request.headers["idempotency-key"];
      rejectionStage = "idempotency-key";
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 256)) throw new Error("Invalid physical-request idempotency key");
      taskId = `${kind}-${idempotencyKey ? digest(idempotencyKey) : randomUUID()}`;
      reservationId = taskId;
      rejectionStage = "budget-reservation";
      const permit = budget.reserve({ taskId, reservationId, kind: "llm", tokens: reservedTokens,
        hardHoldTokens: kind === "chat" ? countedPromptTokens + body.max_tokens : 0,
        requestSha256: digest(requestJson), ...(kind !== "chat" && budgetMode === "pm-task" ? { estimateCny: searchCostEstimateCny } : {}),
        detail: kind === "chat" ? `official-v41 fullInput=${countedPromptTokens}; wire max_tokens=${body.max_tokens}; output forecast=${reservedTokens - countedPromptTokens}; window max=${windowMaxTokens}` : `${kind}: one physical request; actual model tokens=0; cost is an estimate` });
      if (!permit.allowed) {
        const duplicate = budget.summary().reservations.some((row) => row.taskId === taskId);
        return rejectAttempt(429, duplicate ? "DUPLICATE" : "BUDGET_DENIED", `PM_BUDGET_BLOCKED: ${permit.reason}`, !duplicate);
      }
      if (permit.duplicate) return rejectAttempt(409, "DUPLICATE", "This physical request was already reserved; it is not retried automatically", false);
      if (kind !== "chat") searchRequests += 1;
      const startedAt = new Date().toISOString();
      requestEvidence = { id: taskId, kind, startedAt, requestSha256: digest(requestJson), requestBytes: Buffer.byteLength(requestJson),
        countedPromptTokens, reservedTokens, hardHoldTokens: kind === "chat" ? countedPromptTokens + body.max_tokens : 0,
        requestedModel: body.model ?? null, requestManifest: requestManifest(body, kind),
        requestedMaxTokens: body.max_tokens ?? null, windowMaxTokens };
      // Persist a secret-free manifest of the exact wire body before external
      // I/O. Raw prompts, tool results and reasoning stay only in memory.
      rejectionStage = "outbound-evidence";
      const outboundFd = openSync(outboundPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { appendFileSync(outboundFd, `${JSON.stringify(safe(requestEvidence))}\n`); fsyncSync(outboundFd); }
      finally { closeSync(outboundFd); }
      const controller = new AbortController(); active.add(controller);
      const abortTimer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
      let upstream;
      let payload;
      let responseSha256;
      let responseBytes;
      try {
        forwarded = true;
        upstream = await upstreamFetch(`${origin.origin}${kind === "chat" ? "/chat/completions" : `/v1/tools/${kind}`}`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: requestJson, redirect: "error", signal: controller.signal,
        });
        const responseText = await upstream.text();
        if (responseText.length > 64_000_000) throw new Error("Upstream response exceeded the explicit 64000000-character evidence limit");
        responseSha256 = digest(responseText);
        responseBytes = Buffer.byteLength(responseText);
        try { payload = JSON.parse(responseText); } catch { throw new Error("Upstream returned invalid JSON; usage is unknown"); }
      } finally { clearTimeout(abortTimer); active.delete(controller); }
      const row = { ...requestEvidence, finishedAt: new Date().toISOString(), httpStatus: upstream.status,
        responseModel: payload.model ?? null, responseId: payload.id ?? null,
        responseSha256, responseBytes, responseSummary: responseManifest(payload, kind) };
      let usage;
      if (kind === "chat") {
        usage = normalizeOpenAiUsage(payload.usage);
        if (!usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)) {
          budget.commit({ taskId, reservationId, kind: "llm", tokens: 0, measured: false, status: "failed", detail: "Successful HTTP response lacked complete model/usage/choice evidence" });
          record({ ...row, error: "MISSING_USAGE", usage: null });
          return send(response, upstream.ok ? 502 : upstream.status, { error: { message: "Complete model usage evidence is missing; paid calls frozen" } });
        }
        if (usage.inputTokens !== countedPromptTokens || usage.outputTokens > body.max_tokens) {
          budget.freeze({ taskId, reason: "Provider usage disagrees with exact official input count or exceeds requested output; investigate before another paid call" });
        }
      } else {
        if (!upstream.ok) {
          budget.commit({ taskId, reservationId, kind: "llm", tokens: 0, measured: false, status: "failed", detail: `Search/Fetch HTTP ${upstream.status}; outcome cost unknown` });
          record({ ...row, error: `HTTP ${upstream.status}`, usage: null });
          return send(response, upstream.status, { error: { message: "Search/Fetch failed; paid calls frozen until reconciled" } });
        }
        usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      const protocolValid = kind !== "chat" || (text(payload.model) && text(payload.id) && Array.isArray(payload.choices) && payload.choices.length === 1);
      budget.commit({ taskId, reservationId, kind: "llm", tokens: usage.totalTokens, measured: true, status: upstream.ok && protocolValid ? "ok" : "failed",
        ...(kind !== "chat" && budgetMode === "pm-task" ? { costCny: searchCostEstimateCny } : {}) });
      settled = true;
      record({ ...row, usage, finishReason: payload.choices?.[0]?.finish_reason ?? null,
        ...(!upstream.ok || !protocolValid ? { error: !upstream.ok ? `HTTP ${upstream.status}` : "INVALID_PROTOCOL" } : {}) });
      evidenceRecorded = true;
      budget.persist();
      send(response, protocolValid ? upstream.status : 502, protocolValid ? payload : { error: { message: "Response protocol is invalid; measured usage has been retained" }, usage: payload.usage, model: payload.model, id: payload.id });
    } catch (error) {
      if (reservationId) {
        try {
          if (!settled) budget.commit({ taskId, reservationId, kind: "llm", tokens: 0, calls: forwarded ? 1 : 0, measured: !forwarded, status: "failed",
            detail: forwarded ? "Request may have reached the provider; actual usage unknown" : "No upstream request was sent" });
          if (!evidenceRecorded) record({ ...requestEvidence, id: taskId, kind, finishedAt: new Date().toISOString(), httpStatus: null, usage: null,
            error: settled ? "EVIDENCE_PERSISTENCE_FAILED" : forwarded ? "UPSTREAM_OUTCOME_UNKNOWN" : "LOCAL_REQUEST_REJECTED" });
          if (settled) { accountingFailed = true; budget.freeze({ taskId, reason: "Measured settlement exists but evidence persistence failed" }); }
        } catch {
          accountingFailed = true;
          return send(response, 503, { error: { message: "Budget evidence persistence failed; no retry is authorized and further paid calls are blocked" } });
        }
      }
      if (!forwarded) return rejectAttempt(400, "PRE_DISPATCH_REJECTED", error instanceof Error ? error.message : "Request rejected", true);
      send(response, 502, { error: { message: "Upstream outcome is unknown; the request was not retried and further paid calls are frozen" } });
    }
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen(port, "127.0.0.1", yes); });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, runId, budget, summary,
    async close() {
      closed = true; for (const controller of active) controller.abort();
      await new Promise((done) => { server.close(done); server.closeAllConnections?.(); });
      const final = summary(); budget.persist();
      writeFileSync(join(outDir, "proxy-summary.json"), JSON.stringify(final, null, 2), { mode: 0o600 });
      return final;
    },
  };
}

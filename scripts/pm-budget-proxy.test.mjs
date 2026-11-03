import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createPmBudgetProxy } from "./pm-budget-proxy.mjs";

const upstreamSentinel = ["test-only", "synthetic-upstream-fixture-key"].join("-");
const loopbackSentinel = ["test-only", "synthetic-loopback-fixture-token"].join("-");

const requestBody = (overrides = {}) => ({ model: "deepseek-flash", messages: [{ role: "user", content: "返回可验证的结果" }],
  thinking: { type: "disabled" }, max_tokens: 256, stream: false, ...overrides });
const reply = (overrides = {}) => ({ id: "completion-fixture", model: "deepseek-flash", choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, ...overrides });

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-unit-"));
  let upstreamCalls = 0;
  const sent = [];
  const proxy = await createPmBudgetProxy({ apiKey: "test-only-synthetic-upstream-fixture-key", controlToken: "test-only-synthetic-loopback-fixture-token",
    outDir: directory, tokenCounter: { count: async () => 10 },
    upstreamFetch: async (url, init) => { upstreamCalls += 1; sent.push({ url, init }); return new Response(JSON.stringify(reply()), { status: 200 }); },
    ...options });
  t.after(async () => { await proxy.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (body = requestBody(), path = "/chat/completions", token = "test-only-synthetic-loopback-fixture-token") => fetch(`${proxy.url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { proxy, directory, sent, post, calls: () => upstreamCalls };
}

test("no upstream I/O before a trusted tokenizer and separate credentials exist", async () => {
  await assert.rejects(createPmBudgetProxy({ apiKey: "same", controlToken: "same", outDir: "/tmp/unused" }), /Separate/);
  await assert.rejects(createPmBudgetProxy({ apiKey: "one", controlToken: "two", outDir: "/tmp/unused" }), /trusted official token/);
  await assert.rejects(createPmBudgetProxy({ apiKey: "one", controlToken: "two", outDir: "/tmp/unused",
    tokenCounter: { count: async () => 10 }, maxSearchCalls: 0 }), /Search\/Fetch call cap/);
});

test("one physical request is reserved first, then actual model/usage evidence is persisted without credentials", async (t) => {
  const f = await fixture(t);
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.equal(f.calls(), 1);
  const summary = f.proxy.summary();
  assert.equal(summary.budget.actual.llmCalls, 1);
  assert.equal(summary.actualModelTokens, 30);
  assert.equal(summary.requests[0].reservedTokens, 266);
  assert.equal(summary.budget.used.llmTokens, 30);
  assert.equal(summary.requests[0].responseModel, "deepseek-flash");
  assert.equal(summary.budget.measurementComplete, true);
  const evidence = readFileSync(join(f.directory, "requests.jsonl"), "utf8");
  assert.doesNotMatch(evidence, /synthetic-upstream|synthetic-loopback/);
  assert.equal(f.sent[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(f.sent[0].init.redirect, "error");
  const outbound = JSON.parse(readFileSync(join(f.directory, "outbound-requests.jsonl"), "utf8").trim());
  assert.equal(outbound.requestManifest.messages[0].role, "user");
  assert.deepEqual(outbound.requestManifest.fields, Object.keys(JSON.parse(f.sent[0].init.body)).sort());
  assert.equal(outbound.request, undefined);
  assert.doesNotMatch(readFileSync(join(f.directory, "outbound-requests.jsonl"), "utf8"), /返回可验证的结果/);
  assert.equal(outbound.requestSha256, summary.requests[0].requestSha256);
});

test("durable request and response evidence contains only hashes and shapes, never raw private bodies", async (t) => {
  const privatePrompt = "private-prompt-fixture";
  const privateToolResult = "private-tool-result-fixture";
  const privateAnswer = "private-answer-fixture";
  const privateReasoning = "private-reasoning-fixture";
  const privateArguments = "private-arguments-fixture";
  const responseBody = reply({ choices: [{ message: { content: privateAnswer, reasoning_content: privateReasoning,
    tool_calls: [{ id: "fixture-call", type: "function", function: { name: "write_file", arguments: JSON.stringify({ content: privateArguments }) } }] }, finish_reason: "tool_calls" }] });
  const wireResponse = JSON.stringify(responseBody);
  const f = await fixture(t, { upstreamFetch: async () => new Response(wireResponse) });
  const body = requestBody({ messages: [{ role: "user", content: privatePrompt }, { role: "tool", tool_call_id: "earlier", content: privateToolResult }] });
  const response = await f.post(body);
  assert.deepEqual(await response.json(), responseBody);
  const summary = f.proxy.summary();
  assert.equal(summary.requests[0].responseSha256, createHash("sha256").update(wireResponse).digest("hex"));
  assert.equal(summary.requests[0].requestSha256, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
  assert.equal(summary.requests[0].responseSummary.choices[0].content.bytes, Buffer.byteLength(privateAnswer));
  assert.equal(summary.requests[0].responseSummary.choices[0].toolCallCount, 1);
  assert.equal(summary.requests[0].response, undefined);
  const durable = ["requests.jsonl", "outbound-requests.jsonl", "budget-ledger.jsonl", "budget-summary.json"]
    .map((name) => readFileSync(join(f.directory, name), "utf8")).join("\n");
  for (const secret of [privatePrompt, privateToolResult, privateAnswer, privateReasoning, privateArguments]) assert.equal(durable.includes(secret), false);
});

test("concurrent requests cannot exceed physical request cap", async (t) => {
  const f = await fixture(t, { taskBudget: { maxCalls: 2, maxActualTokens: 3000 } });
  const results = await Promise.all([f.post(), f.post(), f.post()]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 200, 429]);
  assert.equal(f.calls(), 2);
  assert.equal(f.proxy.summary().budget.used.llmCalls, 2);
});

test("token reservation can block the first request before external I/O", async (t) => {
  const f = await fixture(t, { taskBudget: { maxActualTokens: 100 } });
  assert.equal((await f.post()).status, 429);
  assert.equal(f.calls(), 0);
});

test("missing usage freezes further paid requests; HTTP200 is not model success", async (t) => {
  let calls = 0;
  const f = await fixture(t, { upstreamFetch: async () => { calls += 1; return Response.json(reply({ usage: undefined })); } });
  assert.equal((await f.post()).status, 502);
  assert.equal((await f.post()).status, 429);
  assert.equal(calls, 1);
  assert.equal(f.proxy.summary().budget.measurementComplete, false);
});

test("upstream network uncertainty is never retried and freezes the run", async (t) => {
  let calls = 0;
  const f = await fixture(t, { upstreamFetch: async () => { calls += 1; throw new Error("fixture transport lost"); } });
  const unknown = await f.post();
  assert.equal(unknown.status, 502);
  assert.equal(unknown.headers.get("x-workloom-model-dispatch"), null);
  assert.equal(unknown.headers.get("x-workloom-request-sha256"), null);
  assert.equal((await f.post()).status, 429);
  assert.equal(calls, 1);
  assert.equal(f.proxy.summary().requests[0].error, "UPSTREAM_OUTCOME_UNKNOWN");
});

test("provider usage exceeding reservation freezes the following request", async (t) => {
  const f = await fixture(t, { upstreamFetch: async () => Response.json(reply({ usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 } })) });
  assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 429);
  assert.equal(f.proxy.summary().budget.frozenBy.length, 1);
});

test("unbounded, multimodal, server-side search and alternate-model requests fail before I/O", async (t) => {
  const f = await fixture(t);
  for (const body of [requestBody({ max_tokens: undefined }), requestBody({ max_tokens: 393217 }), requestBody({ stream: true }),
    requestBody({ model: "deepseek-v4-pro" }), requestBody({ n: 2 }), requestBody({ tools: [{ type: "web_search" }] }),
    requestBody({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }] })]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal(f.calls(), 0);
});

test("authorization, endpoint and credential-in-prompt failures have no upstream effects", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(requestBody(), "/chat/completions", "wrong")).status, 401);
  assert.equal((await f.post(requestBody(), "/arbitrary/upload")).status, 404);
  assert.equal((await f.post(requestBody({ messages: [{ role: "user", content: "test-only-synthetic-upstream-fixture-key" }] }))).status, 400);
  assert.equal(f.calls(), 0);
});

test("tokenizer failure cannot fall back to an estimate or send a paid request", async (t) => {
  const f = await fixture(t, { tokenCounter: { count: async () => { throw new Error("fixture tokenizer failed"); } } });
  const response = await f.post();
  assert.equal(response.status, 400);
  assert.equal(f.calls(), 0);
  const hash = createHash("sha256").update(JSON.stringify(requestBody())).digest("hex");
  assert.equal(response.headers.get("x-workloom-model-dispatch"), "not-sent");
  assert.equal(response.headers.get("x-workloom-request-sha256"), hash);
  assert.equal(response.headers.get("x-workloom-proxy-rejection"), "PRE_DISPATCH_REJECTED:full-input-tokenization");
  const record = JSON.parse(readFileSync(join(f.directory, "rejections.jsonl"), "utf8").trim());
  assert.equal(record.requestSha256, hash);
  assert.equal(record.code, "PRE_DISPATCH_REJECTED");
  assert.equal(record.stage, "full-input-tokenization");
  assert.equal(record.definitelyNotSent, true);
  assert.equal(f.proxy.summary().budget.reservations.length, 0);
});

test("authenticated invalid JSON gets bounded durable rejection evidence without saving private error excerpts", async (t) => {
  const f = await fixture(t);
  const body = '{"private-marker-must-not-be-persisted":';
  const response = await fetch(`${f.proxy.url}/chat/completions`, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${loopbackSentinel}` }, body });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("x-workloom-model-dispatch"), "not-sent");
  assert.equal(response.headers.get("x-workloom-request-sha256"), createHash("sha256").update(body).digest("hex"));
  const durable = readFileSync(join(f.directory, "rejections.jsonl"), "utf8");
  assert.doesNotMatch(durable, /private-marker|Unexpected|JSON at position/);
  assert.ok(Buffer.byteLength(durable) < 1024);
  assert.equal(JSON.parse(durable).stage, "request-body");
  assert.equal(f.calls(), 0);
});

test("Search/Fetch are individually counted and internal-address fetch is rejected", async (t) => {
  const f = await fixture(t, { upstreamFetch: async () => Response.json({ results: [{ title: "官方文档", url: "https://api-docs.deepseek.com/", content: "fixture" }] }) });
  assert.equal((await f.post({ query: "DeepSeek official API", count: 50 }, "/v1/tools/search")).status, 200);
  assert.equal((await f.post({ query: "DeepSeek official API", count: 51 }, "/v1/tools/search")).status, 400);
  assert.equal((await f.post({ url: "http://127.0.0.1/private" }, "/v1/tools/fetch")).status, 400);
  const summary = f.proxy.summary();
  assert.equal(summary.searchRequests, 1);
  assert.equal(summary.maxSearchCalls, 8);
  assert.equal(summary.actualModelTokens, 0);
  assert.equal(summary.budget.used.llmCalls, 1);
  assert.equal(summary.budget.used.llmTokens, 0);
  assert.equal(summary.budget.actual.costCny, 0.02);
});

test("Search/Fetch cap is explicit, configurable and fails before a second upstream call", async (t) => {
  let upstreamCalls = 0;
  const f = await fixture(t, { maxSearchCalls: 1,
    upstreamFetch: async () => { upstreamCalls += 1; return Response.json({ results: [{ title: "官方文档", url: "https://api-docs.deepseek.com/", content: "fixture" }] }); } });
  assert.equal((await f.post({ query: "first", count: 5 }, "/v1/tools/search")).status, 200);
  assert.equal((await f.post({ query: "second", count: 5 }, "/v1/tools/search")).status, 429);
  assert.equal(upstreamCalls, 1);
  assert.equal(f.proxy.summary().searchRequests, 1);
});

test("upstream credential cannot be redirected to a different origin", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-origin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(createPmBudgetProxy({ apiKey: "one", controlToken: "two", outDir: directory,
    tokenCounter: { count: async () => 10 }, upstreamOrigin: "https://example.com" }), /official DeepSeek origin/);
});

test("restart keeps the same physical call cap, evidence and original wall clock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-restart-"));
  const options = { apiKey: "test-only-restart-fixture-upstream", controlToken: "test-only-restart-fixture-local", tokenCounter: { count: async () => 10 },
    outDir: directory, runId: "one-logical-evaluation", taskBudget: { maxCalls: 1 }, upstreamFetch: async () => Response.json(reply()) };
  const first = await createPmBudgetProxy(options);
  const headers = { "content-type": "application/json", authorization: `Bearer ${options.controlToken}` };
  assert.equal((await fetch(`${first.url}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody()) })).status, 200);
  await first.close();
  const second = await createPmBudgetProxy(options);
  t.after(async () => { await second.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`${second.url}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody()) })).status, 429);
  assert.equal(second.summary().physicalRequests, 1);
  assert.equal(second.summary().budget.used.llmCalls, 1);
  assert.equal(second.summary().actualModelTokens, 30);
});

test("384K model output capacity is independent of a 300K task budget and a 4096 forecast", async (t) => {
  const f = await fixture(t, { taskBudget: { maxActualTokens: 300_000 } });
  assert.equal((await f.post(requestBody({ max_tokens: 393216 }))).status, 200);
  const summary = f.proxy.summary();
  assert.equal(JSON.parse(f.sent[0].init.body).max_tokens, 393216);
  assert.equal(summary.requests[0].requestedMaxTokens, 393216);
  assert.equal(summary.requests[0].reservedTokens, 4106);
  assert.equal(summary.budget.used.llmTokens, 30);
  assert.equal(summary.budget.pending.llmTokens, 0);
  assert.equal(summary.requests[0].requestManifest.messages[0].role, "user");
  assert.equal(summary.requests[0].request, undefined);
});

test("the same full-window request is refused before dispatch by a genuine 300K hard token quota", async (t) => {
  const f = await fixture(t, { taskBudget: { hardTotalTokens: 300000 } });
  const response = await f.post(requestBody({ max_tokens: 393216 }));
  assert.equal(response.status, 429);
  const hash = createHash("sha256").update(JSON.stringify(requestBody({ max_tokens: 393216 }))).digest("hex");
  assert.equal(response.headers.get("x-workloom-model-dispatch"), "not-sent");
  assert.equal(response.headers.get("x-workloom-request-sha256"), hash);
  const rejection = JSON.parse(readFileSync(join(f.directory, "rejections.jsonl"), "utf8"));
  assert.equal(rejection.code, "BUDGET_DENIED");
  assert.equal(rejection.requestSha256, hash);
  assert.equal(rejection.definitelyNotSent, true);
  assert.match(await response.text(), /hard total-token quota/);
  assert.equal(f.calls(), 0);
  assert.equal(f.proxy.summary().budget.actual.llmTokens, 0);
  assert.equal(f.proxy.summary().budget.hardQuota.usedOrHeldTokens, 0);
  assert.equal(f.proxy.summary().physicalRequests, 0);
});

test("pending full-window calls keep their hard hold and prevent concurrent overspend", async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const responseReady = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, { taskBudget: { hardTotalTokens: 400000 }, upstreamFetch: async () => {
    calls += 1; entered(); await responseReady; return Response.json(reply());
  } });
  const pending = f.post(requestBody({ max_tokens: 393216 }));
  await started;
  assert.equal(f.proxy.summary().budget.hardQuota.usedOrHeldTokens, 393226);
  assert.equal((await f.post(requestBody({ max_tokens: 393216 }))).status, 429);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(f.proxy.summary().budget.hardQuota.usedOrHeldTokens, 30);
  assert.equal(calls, 1);
});

test("settled actual usage releases forecasts so subsequent full-window calls can proceed", async (t) => {
  const f = await fixture(t, { taskBudget: { maxActualTokens: 5000 } });
  for (let index = 0; index < 3; index += 1) assert.equal((await f.post(requestBody({ max_tokens: 393216 }))).status, 200);
  assert.equal(f.proxy.summary().budget.used.llmTokens, 90);
  assert.equal(f.calls(), 3);
});

test("actual overrun is retained in full and blocks the next request without clamping output", async (t) => {
  let calls = 0;
  const f = await fixture(t, { taskBudget: { maxActualTokens: 5000 }, upstreamFetch: async (_url, init) => {
    calls += 1; assert.equal(JSON.parse(init.body).max_tokens, 393216);
    return Response.json(reply({ usage: { prompt_tokens: 10, completion_tokens: 6000, total_tokens: 6010 } }));
  } });
  assert.equal((await f.post(requestBody({ max_tokens: 393216 }))).status, 200);
  assert.equal((await f.post(requestBody({ max_tokens: 393216 }))).status, 429);
  assert.equal(calls, 1);
  assert.equal(f.proxy.summary().budget.actual.llmTokens, 6010);
  assert.deepEqual(f.proxy.summary().budget.exceeded, ["llmTokens"]);
});

test("full input includes history/tool/schema payload, and window exhaustion stops before I/O", async (t) => {
  const body = requestBody({ max_tokens: 348576, messages: [{ role: "system", content: "规则" }, { role: "user", content: "原文" },
    { role: "assistant", content: null, reasoning_content: "前轮", tool_calls: [{ id: "call1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call1", content: "工具结果" }], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], response_format: { type: "json_object" } });
  let counted;
  const f = await fixture(t, { tokenCounter: { count: async (value) => { counted = value; return 700000; } },
    upstreamFetch: async () => Response.json(reply({ usage: { prompt_tokens: 700000, completion_tokens: 20, total_tokens: 700020 } })) });
  assert.equal((await f.post(body)).status, 200);
  assert.deepEqual(counted, body);
  assert.equal((await f.post({ ...body, max_tokens: 348577 })).status, 400);
  assert.equal(f.calls(), 0); // custom upstream owns this fixture's counter
  assert.equal(f.proxy.summary().physicalRequests, 1);
  assert.equal(f.proxy.summary().requests[0].windowMaxTokens, 348576);
});

test("known usage survives a length finish and invalid protocol without retaining the forecast", async (t) => {
  const f = await fixture(t, { upstreamFetch: async () => Response.json(reply({ id: "", choices: [{ message: { content: "" }, finish_reason: "length" }],
    usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 } })) });
  assert.equal((await f.post(requestBody({ max_tokens: 393216 }))).status, 502);
  assert.equal(f.proxy.summary().budget.actual.llmTokens, 8202);
  assert.equal(f.proxy.summary().budget.used.llmTokens, 8202);
  assert.equal(f.proxy.summary().budget.measurementComplete, true);
  assert.equal(f.proxy.summary().requests[0].finishReason, "length");
});

test("caller idempotency keys prevent duplicate paid requests, including conflicts", async (t) => {
  const f = await fixture(t);
  const send = (body) => fetch(`${f.proxy.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${loopbackSentinel}`, "idempotency-key": "physical-fixture-request" }, body: JSON.stringify(body) });
  assert.equal((await send(requestBody())).status, 200);
  const duplicate = await send(requestBody());
  const conflict = await send(requestBody({ messages: [{ role: "user", content: "different" }] }));
  assert.equal(duplicate.status, 409);
  assert.equal(conflict.status, 429);
  for (const response of [duplicate, conflict]) {
    assert.equal(response.headers.get("x-workloom-model-dispatch"), null);
    assert.equal(response.headers.get("x-workloom-request-sha256"), null);
  }
  const rejections = readFileSync(join(f.directory, "rejections.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rejections.length, 2);
  assert.ok(rejections.every((row) => row.code === "DUPLICATE" && row.definitelyNotSent === false));
  assert.equal(f.calls(), 1);
});

test("legacy RDAS policy is explicit and does not become the default PM task policy", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(createPmBudgetProxy({ apiKey: upstreamSentinel, controlToken: loopbackSentinel, outDir: directory,
    tokenCounter: { count: async () => 10 }, budgets: { maxLlmCalls: 40 } }), /explicit budgetMode/);
  const f = await fixture(t, { budgetMode: "rdas", budgets: { maxLlmCalls: 1 } });
  assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 429);
  assert.equal(f.proxy.summary().budget.used.llmTokens, 266);
});

test("restart with an unsettled request freezes paid I/O instead of silently clearing it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-budget-pending-"));
  const options = { apiKey: "test-only-pending-fixture-upstream", controlToken: "test-only-pending-fixture-local", tokenCounter: { count: async () => 10 },
    outDir: directory, runId: "unknown-outcome", upstreamFetch: async () => { throw new Error("Must never call upstream"); } };
  const first = await createPmBudgetProxy(options);
  first.budget.reserve({ taskId: "prior-unknown", reservationId: "prior-unknown", kind: "llm", tokens: 1000 });
  await first.close();
  const second = await createPmBudgetProxy(options);
  t.after(async () => { await second.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await fetch(`${second.url}/chat/completions`, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${options.controlToken}` }, body: JSON.stringify(requestBody()) });
  assert.equal(response.status, 429); assert.equal(second.summary().budget.measurementComplete, false);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDeepSeekProvider, MockProvider, OpenAiCompatibleProvider, providerFromEnv } from "./providers.js";
import { countDeepSeekInputTokens } from "./deepseek-window.js";

function completion(message: Record<string, unknown> = { role: "assistant", content: "done" }, extra: Record<string, unknown> = {}) {
  return Response.json({ id: "fake-response-1", model: "deepseek-flash-served-version", choices: [{ message, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, ...extra });
}
const makeProvider = (request?: typeof fetch) => new OpenAiCompatibleProvider("deepseek-flash", {
  baseUrl: "https://api.deepseek.com/", apiKey: "fake-test-only-key", fetch: request,
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("DeepSeek provider protocol", () => {
  it("rejects a successful HTTP response without an assistant choice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", apiKey: "fake-test-only-key" });
    await expect(provider.chat([{ role: "user", content: "hello" }])).rejects.toThrow(/协议|响应/);
  });

  it("does not silently choose mock when the default real provider has no key", () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("LLM_BASE_URL", "https://api.deepseek.com");
    expect(() => providerFromEnv()).toThrow(/密钥|KEY/);
  });

  it("uses the official Flash alias by default and honors configured model names", () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek"); vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", ""); vi.stubEnv("DEEPSEEK_MODEL", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-test-only-key");
    expect(createDeepSeekProvider().modelId).toBe("deepseek-flash");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-pro");
    expect(createDeepSeekProvider().modelId).toBe("deepseek-v4-pro");
    vi.stubEnv("LLM_MODEL", "explicit-model");
    expect(providerFromEnv().modelId).toBe("explicit-model");
    vi.stubEnv("LLM_PROVIDER", "mock");
    expect(providerFromEnv("demo")).toBeInstanceOf(MockProvider);
  });

  it("sends bounded non-thinking requests and preserves complete assistant/usage/model fields", async () => {
    const request = vi.fn(async () => completion({ role: "assistant", content: null, reasoning_content: "kept for protocol",
      tool_calls: [{ id: "call-a", type: "function", function: { name: "read", arguments: "{}" } }] }, {
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_cache_hit_tokens: 5,
        prompt_cache_miss_tokens: 15, completion_tokens_details: { reasoning_tokens: 4 } },
    }));
    const result = await makeProvider(request).complete([{ role: "user", content: "hello" }]);
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(String(options.body))).toMatchObject({ model: "deepseek-flash", max_tokens: 393216, thinking: { type: "disabled" }, stream: false });
    expect(options.redirect).toBe("error");
    expect(result.message).toMatchObject({ reasoning_content: "kept for protocol", content: null, tool_calls: [{ id: "call-a" }] });
    expect(result).toMatchObject({ responseId: "fake-response-1", model: "deepseek-flash-served-version", promptTokens: 20, completionTokens: 10,
      usage: { prompt_cache_hit_tokens: 5, completion_tokens_details: { reasoning_tokens: 4 } } });
  });

  it("preserves reasoning history and masks PII in tool arguments without breaking JSON", async () => {
    const request = vi.fn(async () => completion());
    await makeProvider(request).complete([
      { role: "user", content: "contact guest@example.org" },
      { role: "assistant", content: null, reasoning_content: "previous reasoning", tool_calls: [
        { id: "a", type: "function", function: { name: "read", arguments: '{"email":"guest@example.org"}' } },
      ] },
      { role: "tool", tool_call_id: "a", content: "result" },
    ], { thinking: "enabled", reasoningEffort: "high" });
    const payload = String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(payload).not.toContain("guest@example.org");
    const body = JSON.parse(payload);
    expect(body.messages[1].reasoning_content).toBe("previous reasoning");
    expect(JSON.parse(body.messages[1].tool_calls[0].function.arguments).email).toContain("[PII:EMAIL:");
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(body.temperature).toBeUndefined();
  });

  it("reserves the budget before any network call and propagates budget rejection", async () => {
    const request = vi.fn(async () => completion());
    const beforeRequest = vi.fn(() => { throw new Error("budget exhausted"); });
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { beforeRequest })).rejects.toThrow("budget exhausted");
    expect(beforeRequest).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });

  it("counts the final masked history/tools and binds hooks and receipts to the exact wire", async () => {
    const request = vi.fn(async () => completion());
    const beforeRequest = vi.fn((snapshot) => { snapshot.body.messages = []; snapshot.messages.length = 0; });
    const result = await makeProvider(request).complete([
      { role: "system", content: "依据原始资料完成任务，输出JSON" }, { role: "user", content: "source-head guest@example.org source-tail" },
      { role: "assistant", content: "earlier reply" }, { role: "user", content: "完成最终结果" },
    ], { responseFormat: { type: "json_object" }, tools: [{ type: "function", function: { name: "lookup", description: "lookup source", parameters: { type: "object", properties: { term: { type: "string" } } } } }], beforeRequest });
    const body = JSON.parse(String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain("guest@example.org");
    const input = await countDeepSeekInputTokens(body);
    expect(result.request).toMatchObject({ fullInputTokens: input, maxTokens: Math.min(393216, 1048576 - input), contextTokens: 1048576 });
    expect(beforeRequest.mock.calls[0]![0].maxTokens).toBe(body.max_tokens);
  });

  it.each([256, 4096, 8192, 16384])("rejects a historical output override %i instead of silently shrinking a valid window", async (maxTokens) => {
    const request = vi.fn(async () => completion());
    await expect(makeProvider(request).complete([{ role: "user", content: "完整任务" }], { maxTokens })).rejects.toThrow(/历史输出常量/);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed for an unregistered DeepSeek model before any network request", async () => {
    const request = vi.fn(async () => completion());
    const provider = new OpenAiCompatibleProvider("deepseek-unknown", { baseUrl: "https://api.deepseek.com", fetch: request });
    await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/能力未登记/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects local secret echo before transport", async () => {
    const request = vi.fn(async () => completion());
    await expect(makeProvider(request).complete([{ role: "user", content: "fake-test-only-key" }])).rejects.toThrow(/密钥/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects forced thinking tool choices before transport", async () => {
    const request = vi.fn(async () => completion());
    await expect(makeProvider(request).complete([{ role: "user", content: "go" }], { thinking: "enabled", toolChoice: "required" })).rejects.toThrow(/toolChoice/);
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels before dispatch and bounds a transport that does not settle", async () => {
    const request = vi.fn(() => new Promise<Response>(() => {}));
    const controller = new AbortController(); controller.abort();
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { signal: controller.signal })).rejects.toThrow(/取消/);
    expect(request).not.toHaveBeenCalled();
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { timeoutMs: 10 })).rejects.toThrow(/超时/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the deadline active while reading a response body", async () => {
    const request = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }], { timeoutMs: 10 })).rejects.toThrow(/超时/);
  });

  it.each([401, 402, 429, 500])("reports HTTP %i without retry or upstream secret leakage", async (status) => {
    const request = vi.fn(async () => new Response("fake-test-only-key must not be echoed", { status }));
    await expect(makeProvider(request).complete([{ role: "user", content: "hello" }])).rejects.toThrow(`HTTP ${status}`);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { baseUrl: "http://127.0.0.1:19999", matches: true, expected: "blocked-before-send" },
    { baseUrl: "http://127.0.0.1:19999", matches: false, expected: "possibly-sent" },
    { baseUrl: "https://api.deepseek.com", matches: true, expected: "possibly-sent" },
  ])("only trusts the definitive local denial for $baseUrl with matching exact body=$matches", async ({ baseUrl, matches, expected }) => {
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => new Response("private raw reason must not escape", { status: 429, headers: {
      "x-workloom-model-dispatch": "not-sent",
      "x-workloom-request-sha256": matches ? createHash("sha256").update(String(init?.body)).digest("hex") : "f".repeat(64),
    } }));
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl, fetch: request });
    const error = await provider.complete([{ role: "user", content: "quota diagnostic" }]).catch(value => value);
    expect(error).toMatchObject({ httpStatus: 429, dispatchState: expected, receipt: { usageComplete: false } });
    expect(error.message).not.toContain("private raw reason");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { choices: [] },
    { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] },
    { usage: undefined },
    { usage: { prompt_tokens: -1, completion_tokens: 2 } },
    { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 100 } },
  ])("rejects incomplete/malformed protocol data %#", async (body) => {
    await expect(makeProvider(async () => completion(undefined, body)).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/协议/);
  });

  it("rejects non-JSON responses and hides raw transport errors", async () => {
    await expect(makeProvider(async () => new Response("not json")).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/JSON/);
    await expect(makeProvider(async () => { throw new Error("fake-test-only-key"); }).complete([{ role: "user", content: "hi" }])).rejects.toThrow("模型网络请求失败");
  });

  it("rejects real completion data missing response model or finish state", async () => {
    await expect(makeProvider(async () => completion(undefined, { model: undefined })).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/实际模型/);
    await expect(makeProvider(async () => completion(undefined, { choices: [{ message: { role: "assistant", content: "hi" } }] })).complete([{ role: "user", content: "hi" }])).rejects.toThrow(/终态/);
  });

  it.each([
    { name: "empty truncated reasoning response", choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: "private-reasoning-must-not-leak fake-test-only-key" } }] },
    { name: "malformed tool instruction", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ private: "tool-arguments-must-not-leak" }] } }] },
    { name: "missing assistant choice", choices: [] },
  ])("retains verified paid usage on $name without leaking upstream content", async ({ choices }) => {
    const request = vi.fn(async () => completion(undefined, { choices }));
    const error = await makeProvider(request).complete([{ role: "user", content: "hi" }]).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ usage: { promptTokens: 20, completionTokens: 10 }, modelId: "deepseek-flash-served-version",
      responseId: "fake-response-1", receipt: { final: false, usageComplete: true, adapter: "completion-protocol" } });
    expect(JSON.stringify(error)).not.toMatch(/private-reasoning|tool-arguments|fake-test-only-key/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never invents accounting for invalid aggregate usage or copies secrets from receipt identifiers", async () => {
    const choices = [{ finish_reason: "length", message: { role: "assistant", content: "" } }];
    const invalid = await makeProvider(async () => completion(undefined, { choices,
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 999 } })).complete([{ role: "user", content: "hi" }]).catch((value: unknown) => value);
    expect(invalid).toBeInstanceOf(Error);
    expect((invalid as { usage?: unknown }).usage).toBeUndefined();
    const sensitive = await makeProvider(async () => completion(undefined, { choices,
      model: "fake-test-only-key", id: "fake-test-only-key" })).complete([{ role: "user", content: "hi" }]).catch((value: unknown) => value);
    expect(sensitive).toMatchObject({ usage: { promptTokens: 20, completionTokens: 10 }, modelId: "deepseek-flash",
      receipt: { modelIdentitySource: "requested-unverified" } });
    expect((sensitive as { responseId?: unknown }).responseId).toBeUndefined();
    expect(JSON.stringify(sensitive)).not.toContain("fake-test-only-key");
  });

  it("rejects credential-bearing provider endpoints", () => {
    expect(() => new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://user:fake@example.org" })).toThrow(/凭据/);
  });

  it("records a durable pending attempt only after admission and reports definite no-send separately", async () => {
    const events: string[] = [];
    const request = vi.fn(async () => { events.push("fetch"); return completion(); });
    const beforeDispatch = vi.fn((receipt) => {
      events.push("dispatch");
      expect(receipt).toMatchObject({ dispatchState: "possibly-sent", usageComplete: false, requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    });
    const result = await makeProvider(request).complete([{ role: "user", content: "private input must never appear in the receipt" }], {
      beforeRequest: () => { events.push("quota"); }, beforeDispatch,
    });
    expect(events).toEqual(["quota", "dispatch", "fetch"]);
    expect(result.requestReceipt).toMatchObject({ dispatchState: "sent-usage-known", usageComplete: true });
    expect(JSON.stringify(result.requestReceipt)).not.toMatch(/private input|fake-test-only-key/);
    const blocked = await makeProvider(request).complete([{ role: "user", content: "hello" }], {
      beforeRequest: () => { throw new Error("fixture quota denied"); }, beforeDispatch,
    }).catch((error: unknown) => error);
    expect(blocked).toMatchObject({ dispatchState: "blocked-before-send", requestReceipt: { usageComplete: true } });
    expect(beforeDispatch).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "json", "usage", "timeout"])("marks %s failure after fetch as possibly sent, never as zero usage", async (kind) => {
    const request = vi.fn(async () => {
      if (kind === "network") throw new Error("fake-test-only-key transport detail");
      if (kind === "json") return new Response("private malformed response");
      if (kind === "timeout") return new Promise<Response>(() => {});
      return completion(undefined, { usage: undefined });
    });
    const error = await makeProvider(request).complete([{ role: "user", content: "hi" }], { timeoutMs: 20 }).catch((value: unknown) => value);
    expect(error).toMatchObject({ dispatchState: "possibly-sent", requestReceipt: { dispatchState: "possibly-sent", usageComplete: false } });
    expect((error as { usage?: unknown }).usage).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(/fake-test-only-key|private malformed/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a paid protocol rejection remains known and never acquires an unknown-usage marker", async () => {
    const error = await makeProvider(async () => completion(undefined, { choices: [] })).complete([{ role: "user", content: "hi" }]).catch((value: unknown) => value);
    expect(error).toMatchObject({ dispatchState: "sent-usage-known", usage: { promptTokens: 20, completionTokens: 10 },
      requestReceipt: { usageComplete: true, dispatchState: "sent-usage-known" } });
  });
});

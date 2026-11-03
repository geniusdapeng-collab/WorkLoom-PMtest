import { describe, expect, it, vi } from "vitest";
import { createDeepSeekAssistantModel } from "./model.js";

const testApiKey = ["test", "key", "only", "in", "process"].join("-");

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("DeepSeek assistant stream parser", () => {
  it("counts more than 64 messages and long raw input without silently truncating them", async () => {
    const messages = [{ role: "system" as const, content: "原始系统指令" },
      ...Array.from({ length: 70 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: `history-${i}` })),
      { role: "user" as const, content: "HEAD-" + "完整原始资料".repeat(6000) + "-TAIL" }];
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).messages).toEqual(messages);
      return sseResponse([`data: ${JSON.stringify({ id: "full-input", model: "deepseek-flash", choices: [{ delta: { content: "已保留完整资料" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20000, completion_tokens: 10, total_tokens: 20010 } })}\n\ndata: [DONE]\n\n`]);
    });
    const onRequest = vi.fn();
    const result = await createDeepSeekAssistantModel({ apiKey: testApiKey, fetch: request }).stream({ messages,
      signal: new AbortController().signal, onRequest, onDelta() {} });
    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]!);
    expect(result.request?.maxTokens).toBe(393216);
    expect(result.request?.fullInputTokens).toBeGreaterThan(10000);
  }, 30_000);

  it.each(["finish", "usage", "model", "id", "done"])("refuses missing %s evidence without inventing a successful receipt", async (missing) => {
    const payload = { id: missing === "id" ? undefined : "receipt", model: missing === "model" ? undefined : "deepseek-flash",
      choices: [{ delta: { content: "partial evidence" }, finish_reason: missing === "finish" ? undefined : "stop" }],
      usage: missing === "usage" ? undefined : { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
    const request = vi.fn(async () => sseResponse([`data: ${JSON.stringify(payload)}\n\n${missing === "done" ? "" : "data: [DONE]\n\n"}`]));
    const result = await createDeepSeekAssistantModel({ apiKey: testApiKey, fetch: request }).stream({ messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal, onDelta() {} }).catch(error => error);
    expect(result).toMatchObject({ code: "MODEL_RECEIPT_MISSING", request: { maxTokens: 393216 } });
    if (missing !== "usage") expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    else expect(result.usage).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it("retains known paid usage when a later SSE event is malformed", async () => {
    const request = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ id: "paid-then-broken", model: "deepseek-flash", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`,
      "data: malformed\n\n",
    ]));
    await expect(createDeepSeekAssistantModel({ apiKey: testApiKey, fetch: request }).stream({ messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal, onDelta() {} })).rejects.toMatchObject({ code: "MODEL_PROTOCOL_ERROR",
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 }, responseId: "paid-then-broken", request: { maxTokens: 393216 } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a local output override before dispatch and never treats it as model capability", async () => {
    const request = vi.fn();
    await expect(createDeepSeekAssistantModel({ apiKey: testApiKey, fetch: request }).stream({ messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal, maxTokens: 8192, onDelta() {} })).rejects.toMatchObject({ code: "MODEL_INPUT_INVALID" });
    expect(request).not.toHaveBeenCalled();
  });
  it("streams split SSE chunks and keeps response id plus measured usage", async () => {
    const fakeFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sseResponse([
      "data: {\"id\":\"resp-1\",\"model\":\"deepseek-flash\",\"choices\":[{\"delta\":{\"content\":\"你\"},\"finish_reason\":null}]}\n\n",
      "data: {\"id\":\"resp-1\",\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":null}]}\n",
      "\ndata: {\"id\":\"resp-1\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2,\"total_tokens\":9}}\n\n",
      "data: [DONE]\n\n",
    ]));
    const deltas: string[] = [];
    const client = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      fetch: fakeFetch as typeof fetch,
    });
    const result = await client.stream({
      messages: [{ role: "user", content: "只回答你好" }],
      signal: AbortSignal.timeout(5_000),
      onDelta: (delta) => { deltas.push(delta.text); },
    });
    expect(deltas).toEqual(["你", "好"]);
    expect(result).toMatchObject({
      text: "你好",
      model: "deepseek-flash",
      responseId: "resp-1",
      finishReason: "stop",
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    });
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init.body)).max_tokens).toBe(393216);
    expect(result.request).toMatchObject({ maxTokens: 393216, contextTokens: 1048576 });
    expect(String(init.body)).toContain('"stream":true');
    expect(String(init.body)).toContain('"include_usage":true');
    expect(String(init.body)).not.toContain('"response_format"');
  });

  it("enables DeepSeek JSON Output only for an explicit strict JSON request", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sseResponse([
      "data: {\"id\":\"resp-json\",\"model\":\"deepseek-flash\",\"choices\":[{\"delta\":{\"content\":\"{\\\"answer\\\":\\\"ok\\\"}\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
      "data: [DONE]\n\n",
    ]));
    const client = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      fetch: request as typeof fetch,
    });
    await client.stream({
      messages: [{ role: "user", content: "只返回一个严格 JSON 对象。" }],
      signal: AbortSignal.timeout(2_000),
      onDelta: () => undefined,
    });
    const body = JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("fails closed on upstream authentication and truncated generation", async () => {
    const auth = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      fetch: vi.fn(async () => new Response("denied", { status: 401 })) as typeof fetch,
    });
    await expect(auth.stream({
      messages: [{ role: "user", content: "test" }],
      signal: AbortSignal.timeout(2_000),
      onDelta: () => undefined,
    })).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_REJECTED" });

    const truncated = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      fetch: vi.fn(async () => sseResponse([
        "data: {\"id\":\"resp-2\",\"choices\":[{\"delta\":{\"content\":\"部分\"},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n",
        "data: [DONE]\n\n",
      ])) as typeof fetch,
    });
    await expect(truncated.stream({
      messages: [{ role: "user", content: "test" }],
      signal: AbortSignal.timeout(2_000),
      onDelta: () => undefined,
    })).rejects.toMatchObject({ code: "MODEL_INCOMPLETE" });
  });

  it("treats an empty configured base URL as the official default endpoint", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sseResponse([
      "data: {\"id\":\"resp-default\",\"model\":\"deepseek-flash\",\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
      "data: [DONE]\n\n",
    ]));
    const client = createDeepSeekAssistantModel({
      apiKey: testApiKey,
      baseUrl: "",
      model: "",
      fetch: request as typeof fetch,
    });
    await client.stream({
      messages: [{ role: "user", content: "test" }],
      signal: AbortSignal.timeout(2_000),
      onDelta: () => undefined,
    });
    expect(String(request.mock.calls[0]?.[0])).toBe("https://api.deepseek.com/chat/completions");
  });
});

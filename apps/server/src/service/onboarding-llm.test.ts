import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canVerifySavedDeepSeek,
  currentLlmConnection,
  llmConnectionStatus,
  llmCredentialFingerprint,
  probeLlm,
  sameLlmConnection,
} from "./onboarding-llm.js";

const connection = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: "test-provider-key",
};

afterEach(() => vi.unstubAllGlobals());

describe("当前模型的公开连接状态", () => {
  it("使用 PM DeepSeek 的默认端点、模型与凭据优先级", () => {
    const env = { LLM_PROVIDER: "deepseek", LLM_API_KEY: "", DEEPSEEK_API_KEY: connection.apiKey };
    expect(currentLlmConnection(env)).toEqual(connection);
    expect(currentLlmConnection({ ...env, LLM_API_KEY: "explicit-test-key" }).apiKey).toBe("explicit-test-key");
    expect(currentLlmConnection({ ...env, LLM_PROVIDER: "custom" }).apiKey).toBe("");
    expect(llmConnectionStatus(connection)).toEqual({
      provider: "deepseek", baseUrl: connection.baseUrl, model: "deepseek-flash",
      configured: true, canVerifyConfigured: true,
    });
    expect(llmConnectionStatus({ ...connection, apiKey: "" })).toMatchObject({
      configured: false, canVerifyConfigured: false,
    });
  });

  it.each([
    "http://api.deepseek.com",
    "https://api.deepseek.com.example.test",
    "https://api.deepseek.com:8443",
    "https://api.deepseek.com/v1/other",
    "https://fixture-user:fixture-password@api.deepseek.com",
    "https://api.deepseek.com?token=fixture",
    "https://api.deepseek.com#fixture",
  ])("禁止把已存密钥用于非受支持的服务地址 %s", (baseUrl) => {
    expect(canVerifySavedDeepSeek({ ...connection, baseUrl })).toBe(false);
  });

  it("只公开无凭据的地址，并保留自定义无密钥网关的配置状态", () => {
    const fixtures = {
      ...connection, baseUrl: "https://user:password@gateway.example.test",
    };
    expect(llmConnectionStatus(fixtures)).toMatchObject({ baseUrl: "", configured: false });
    expect(canVerifySavedDeepSeek({ ...connection, baseUrl: "https://api.deepseek.com/v1/" })).toBe(true);
    expect(llmConnectionStatus({ provider: "custom", model: "custom-model", baseUrl: "http://127.0.0.1:4321", apiKey: "" }))
      .toMatchObject({ configured: true, canVerifyConfigured: false });
  });

  it("模型、地址、提供方或凭据变化使在途验证过期", () => {
    expect(sameLlmConnection(connection, { ...connection })).toBe(true);
    for (const change of [
      { provider: "custom" }, { baseUrl: `${connection.baseUrl}/v1` }, { model: "legacy-model" }, { apiKey: "rotated-key" },
    ]) expect(sameLlmConnection(connection, { ...connection, ...change })).toBe(false);
    expect(llmCredentialFingerprint("rotated-key")).not.toBe(llmCredentialFingerprint(connection.apiKey));
  });
});

describe("保存的 DeepSeek 连接验证", () => {
  const response = {
    id: "fixture-response",
    model: connection.model,
    choices: [{ message: { role: "assistant", content: "已在线。" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  };

  it("通过提供方执行一次有终态和用量的非流式请求", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetch);
    await expect(probeLlm(connection, true)).resolves.toMatchObject({ reply: "已在线。", latencyMs: expect.any(Number) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/chat/completions",
      expect.objectContaining({ method: "POST", redirect: "error" }));
    const request = fetch.mock.calls[0]![1]!;
    expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${connection.apiKey}`);
    expect(JSON.parse(String(request.body))).toMatchObject({ model: connection.model, stream: false, thinking: { type: "disabled" } });
  });

  it.each([
    { ...response, model: "legacy-model" },
    { ...response, usage: undefined },
    { ...response, choices: [{ ...response.choices[0], finish_reason: "length" }] },
  ])("拒绝错模型、用量缺失或截断的回执", async (payload) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    await expect(probeLlm(connection, true)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

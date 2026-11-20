import { createHash } from "node:crypto";
import { DEFAULT_DEEPSEEK_MODEL, OpenAiCompatibleProvider } from "@workloom/base/model-router";

export interface LlmConnection {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function safeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function currentLlmConnection(env: NodeJS.ProcessEnv = process.env): LlmConnection {
  const provider = env.LLM_PROVIDER ?? "mock";
  const deepSeek = provider === "deepseek";
  return {
    provider,
    baseUrl: env.LLM_BASE_URL || (deepSeek ? env.DEEPSEEK_BASE_URL || "https://api.deepseek.com" : ""),
    model: env.LLM_MODEL || (deepSeek ? env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL : ""),
    apiKey: env.LLM_API_KEY || (deepSeek ? env.DEEPSEEK_API_KEY || "" : ""),
  };
}

export function canVerifySavedDeepSeek(connection: LlmConnection): boolean {
  const url = safeBaseUrl(connection.baseUrl);
  return connection.provider === "deepseek" && connection.model === DEFAULT_DEEPSEEK_MODEL
    && Boolean(connection.apiKey.trim() && url?.origin === "https://api.deepseek.com"
      && ["/", "/v1", "/v1/"].includes(url.pathname));
}

export function llmConnectionStatus(connection: LlmConnection) {
  const { provider, baseUrl, model, apiKey } = connection;
  const url = safeBaseUrl(baseUrl);
  const configured = provider !== "mock" && Boolean(url && model
    && (provider !== "deepseek" || (apiKey.trim() && model === DEFAULT_DEEPSEEK_MODEL)));
  return { provider, baseUrl: url ? baseUrl : "", model, configured, canVerifyConfigured: canVerifySavedDeepSeek(connection) };
}

/** Stored only to detect a changed credential. Never returned to a client. */
export function llmCredentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(`workloom-llm-credential/v1:${apiKey}`, "utf8").digest("hex");
}

export function sameLlmConnection(a: LlmConnection, b: LlmConnection): boolean {
  return a.provider === b.provider && a.baseUrl === b.baseUrl && a.model === b.model && a.apiKey === b.apiKey;
}

export async function probeLlm(cfg: { baseUrl: string; apiKey?: string; model: string }, requireUsage = false) {
  const provider = new OpenAiCompatibleProvider(cfg.model, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey || undefined });
  const started = Date.now();
  const result = await provider.complete(
    [{ role: "user", content: "你是企业经营系统的数字员工。请用一句中文回答：你已在线，可以开始工作。" }],
    { timeoutMs: 25_000, requireUsage },
  );
  if (!result.text.trim() || (requireUsage && (
    result.model !== cfg.model || result.finishReason !== "stop" || !result.responseId
  ))) throw new Error("模型未返回可核验的完整应答");
  return { reply: result.text.trim().slice(0, 200), latencyMs: Date.now() - started };
}

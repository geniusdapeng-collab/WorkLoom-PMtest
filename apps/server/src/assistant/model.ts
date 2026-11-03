import { assertNoSecrets } from "../industry/ai-pm/contract.js";
import { maskDeep } from "@workloom/base/workdata";
import { abortable, DEFAULT_DEEPSEEK_MODEL, planDeepSeekWindow, type CompletionRequestReceipt } from "@workloom/base/model-router";
import type { AssistantUsage } from "./types.js";

export interface AssistantModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface AssistantModelDelta {
  text: string;
  responseId?: string;
  usage?: AssistantUsage;
  finishReason?: string;
}
export interface AssistantModelResult {
  text: string;
  model: string;
  responseId?: string;
  usage?: AssistantUsage;
  finishReason?: string;
  request?: CompletionRequestReceipt;
}
export class AssistantModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 502,
    public readonly usage?: AssistantUsage,
    public readonly responseId?: string,
    public readonly request?: CompletionRequestReceipt,
  ) {
    super(message);
    this.name = "AssistantModelError";
  }
}
export interface AssistantModelClient {
  readonly model: string;
  stream(input: {
    messages: AssistantModelMessage[];
    signal: AbortSignal;
    /** Compatibility guard only; the real DeepSeek window is calculated from complete input. */
    maxTokens?: number;
    onRequest?: (request: CompletionRequestReceipt) => Promise<void> | void;
    onDelta: (delta: AssistantModelDelta) => Promise<void> | void;
  }): Promise<AssistantModelResult>;
}
function normalizeUsage(value: unknown): AssistantUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const prompt = source.prompt_tokens ?? source.input_tokens;
  const completion = source.completion_tokens ?? source.output_tokens;
  const total = source.total_tokens;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion)
    || (prompt as number) < 0 || (completion as number) < 0) return undefined;
  const computedTotal = Number(prompt) + Number(completion);
  if (!Number.isSafeInteger(computedTotal) || (total !== undefined && (!Number.isSafeInteger(total) || Number(total) !== computedTotal))) return undefined;
  return { promptTokens: Number(prompt), completionTokens: Number(completion), totalTokens: computedTotal };
}
function requestsJsonOutput(messages: AssistantModelMessage[]): boolean {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  return Boolean(latestUser && /(?:strict\s+json|严格\s*(?:的\s*)?json|json\s*对象|json_object)/iu.test(latestUser.content));
}
function safeIdentifier(value: unknown, key: string): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)
    && !value.includes(key) && !/(?:sk-|gh[pousr]_|github_pat_)/i.test(value) ? value : undefined;
}

export function createDeepSeekAssistantModel(options: {
  apiKey?: string; baseUrl?: string; model?: string; fetch?: typeof fetch; timeoutMs?: number;
} = {}): AssistantModelClient {
  const apiKey = (options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "").trim();
  const configuredBaseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? "").trim();
  const baseUrl = (configuredBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const configuredModel = (options.model ?? process.env.LLM_MODEL ?? "").trim();
  const model = configuredModel || DEFAULT_DEEPSEEK_MODEL;
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 600_000;
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new AssistantModelError("MODEL_CONFIG_INVALID", "模型地址无效", 503); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new AssistantModelError("MODEL_CONFIG_INVALID", "模型地址必须是不含凭据的 HTTPS", 503);
  }
  if (model !== DEFAULT_DEEPSEEK_MODEL) throw new AssistantModelError("MODEL_CONFIG_INVALID", "模型能力未登记，禁止猜测上下文窗口", 503);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new AssistantModelError("MODEL_CONFIG_INVALID", "模型超时配置无效", 503);
  return {
    model,
    async stream(input): Promise<AssistantModelResult> {
      if (!apiKey) throw new AssistantModelError("MODEL_NOT_CONFIGURED", "服务端尚未配置 DeepSeek 凭据", 503);
      if (!input.messages.length || input.messages.some((message) => typeof message.content !== "string" || !message.content.trim())) {
        throw new AssistantModelError("MODEL_INPUT_INVALID", "模型消息不能为空", 400);
      }
      assertNoSecrets(input.messages);
      if (JSON.stringify(input.messages).includes(apiKey)) throw new AssistantModelError("MODEL_INPUT_INVALID", "模型输入包含连接器凭据", 400);
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
      signal.throwIfAborted();
      const body = { model, messages: maskDeep(input.messages).value, stream: true,
        stream_options: { include_usage: true }, thinking: { type: "disabled" },
        ...(requestsJsonOutput(input.messages) ? { response_format: { type: "json_object" } } : {}), temperature: 0.2 };
      const window = await planDeepSeekWindow(body);
      if (input.maxTokens !== undefined && input.maxTokens !== window.maxOutputTokens) {
        throw new AssistantModelError("MODEL_INPUT_INVALID", "maxTokens 与完整输入窗口不符，不能用历史输出常量", 400);
      }
      const requestReceipt: CompletionRequestReceipt = { model, fullInputTokens: window.fullInputTokens,
        maxTokens: window.maxOutputTokens, contextTokens: window.contextTokens, requestSha256: window.requestSha256,
        tokenizerSha256: window.tokenizerSha256, recipeVersion: window.recipeVersion };
      if (input.onRequest) await abortable(Promise.resolve(input.onRequest(requestReceipt)), signal);
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await abortable(request(`${baseUrl}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: window.serializedBody, redirect: "error", signal,
        }), signal);
      } catch {
        throw new AssistantModelError(signal.aborted ? input.signal.aborted ? "MODEL_CANCELLED" : "MODEL_TIMEOUT" : "MODEL_NETWORK_ERROR",
          signal.aborted ? input.signal.aborted ? "用户已停止生成，用量待核对" : "模型响应超时，用量待核对" : "模型网络请求失败，用量待核对",
          signal.aborted ? input.signal.aborted ? 409 : 504 : 502, undefined, undefined, requestReceipt);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new AssistantModelError(response.status === 401 || response.status === 403 ? "MODEL_CREDENTIAL_REJECTED"
          : response.status === 402 || response.status === 429 ? "MODEL_BUDGET_EXHAUSTED" : "MODEL_REQUEST_FAILED",
          `DeepSeek HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 503
            : response.status === 402 || response.status === 429 ? 429 : 502, undefined, undefined, requestReceipt);
      }
      if (!response.body) throw new AssistantModelError("MODEL_PROTOCOL_ERROR", "模型响应缺少流式正文", 502, undefined, undefined, requestReceipt);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ""; let text = ""; let responseId: string | undefined; let responseModel: string | undefined;
      let usage: AssistantUsage | undefined; let finishReason: string | undefined; let done = false;
      const failure = (code: string, message: string) => new AssistantModelError(code, message, 502, usage, responseId, requestReceipt);
      const consume = async (block: string) => {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) return;
        if (data === "[DONE]") { done = true; return; }
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(data) as Record<string, unknown>; }
        catch { throw failure("MODEL_PROTOCOL_ERROR", "DeepSeek 返回了无法解析的流式事件"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("MODEL_PROTOCOL_ERROR", "模型流式事件结构无效");
        const parsedUsage = normalizeUsage(payload.usage);
        if (payload.usage != null && !parsedUsage) throw failure("MODEL_PROTOCOL_ERROR", "模型用量无效，需核对原请求");
        if (parsedUsage) usage = parsedUsage;
        const id = safeIdentifier(payload.id, apiKey);
        if (payload.id != null && !id) throw failure("MODEL_PROTOCOL_ERROR", "模型请求回执标识无效");
        if (id) { if (responseId && responseId !== id) throw failure("MODEL_PROTOCOL_ERROR", "流式请求回执标识发生变化"); responseId = id; }
        const actualModel = safeIdentifier(payload.model, apiKey);
        if (payload.model != null && (!actualModel || actualModel !== model)) throw failure("MODEL_IDENTITY_MISMATCH", "模型回执与任务固定模型不一致");
        if (actualModel) responseModel = actualModel;
        const details = (payload.usage as { completion_tokens_details?: { reasoning_tokens?: unknown } } | undefined)?.completion_tokens_details;
        if (details?.reasoning_tokens !== undefined && details.reasoning_tokens !== 0) throw failure("MODEL_MODE_MISMATCH", "模型返回了明确禁用的思考用量");
        const choice = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> | undefined : undefined;
        if (!choice) return;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = choice.delta as Record<string, unknown> | undefined;
        const piece = typeof delta?.content === "string" ? delta.content : "";
        if (piece) { text += piece; await input.onDelta({ text: piece, ...(responseId ? { responseId } : {}), ...(usage ? { usage } : {}) }); }
      };
      try {
        while (!done) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) { buffer += decoder.decode(); break; }
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() ?? "";
          for (const block of blocks) { await consume(block); if (done) break; }
        }
        if (!done && buffer.trim()) await consume(buffer);
        if (finishReason && finishReason !== "stop") throw failure("MODEL_INCOMPLETE", `模型未自然结束（${finishReason}），未标记完成`);
        if (!done || finishReason !== "stop" || !responseId || !responseModel || !usage) throw failure("MODEL_RECEIPT_MISSING", "模型缺少完整结束状态、身份或用量，未标记完成");
        if (!text.trim()) throw failure("MODEL_EMPTY_RESPONSE", "模型返回空正文，未标记完成");
        return { text, model: responseModel, responseId, usage, finishReason, request: requestReceipt };
      } catch (error) {
        if (error instanceof AssistantModelError) throw error;
        throw failure(signal.aborted ? input.signal.aborted ? "MODEL_CANCELLED" : "MODEL_TIMEOUT" : "MODEL_STREAM_FAILED",
          signal.aborted ? "模型流式请求中断；保留已知用量，未知部分需核对原请求" : "模型流读取或事件保存失败，未标记完成");
      } finally { await reader.cancel().catch(() => undefined); }
    },
  };
}

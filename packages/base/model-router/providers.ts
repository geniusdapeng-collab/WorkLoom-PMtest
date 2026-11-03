/**
 * model-router · 模型提供方（D4：OpenAI 兼容网关 + 内置确定性 Mock Provider）
 *  - MockProvider：零 Key 全流程可跑（接力开发保险丝）；可编排失败以实证降级链
 *  - OpenAiCompatibleProvider：deepseek/moonshot/zhipu/openai 可切（.env LLM_*）
 *  - F6.6/L6.2：所有文本与工具协议出站都在提供方层强制脱敏；调用方另负责租户、围栏和计量留痕
 */
import { maskDeep } from "../workdata/pii.js";
import { createHash, randomUUID } from "node:crypto";
import { DEEPSEEK_V41_WINDOW, planDeepSeekWindow } from "./deepseek-window.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface FunctionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: FunctionToolCall[];
}

export type ProviderMessage = ChatMessage | AssistantMessage | {
  role: "tool";
  content: string;
  tool_call_id: string;
};

export interface FunctionToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface BeforeCompletionRequest {
  messages: ProviderMessage[];
  tools: FunctionToolDefinition[];
  maxTokens: number;
  model: string;
  signal: AbortSignal;
  /** Exact post-masking wire snapshot. Mutating a hook's copy cannot change dispatch. */
  body: Record<string, unknown>;
  request?: CompletionRequestReceipt;
}

export interface CompletionRequestReceipt {
  model: string;
  fullInputTokens: number;
  maxTokens: number;
  contextTokens: number;
  requestSha256: string;
  tokenizerSha256: string;
  recipeVersion: string;
}

export type CompletionDispatchState = "blocked-before-send" | "possibly-sent" | "sent-usage-known";
/** Bounded accounting metadata only: never a prompt, raw response, or secret. */
export interface CompletionDispatchReceipt {
  attemptId: string;
  model: string;
  dispatchState: CompletionDispatchState;
  usageComplete: boolean;
  requestSha256?: string;
  modelRequest?: CompletionRequestReceipt;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "none" | "low" | "high" | "max";
  tools?: FunctionToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  responseFormat?: { type: "text" | "json_object" };
  /** 预算预留/治理闸门必须在网络请求之前完成；异常直接终止，不降级至 mock。 */
  beforeRequest?: (request: BeforeCompletionRequest) => void | Promise<void>;
  /** Last durable dispatch marker, after quota admission and before fetch. */
  beforeDispatch?: (receipt: CompletionDispatchReceipt) => void | Promise<void>;
  /** 旧 chat 网关可能没有 usage；真实工具执行默认拒绝缺失计量。 */
  requireUsage?: boolean;
}

export interface CompletionResult extends ChatResult {
  responseId?: string;
  message: AssistantMessage;
  model: string;
  finishReason: string;
  usage?: CompletionUsage;
  request?: CompletionRequestReceipt;
  requestReceipt?: CompletionDispatchReceipt;
}

export interface CompletionProvider {
  readonly modelId: string;
  complete(messages: ProviderMessage[], opts?: CompletionOptions): Promise<CompletionResult>;
}

export interface OpenAiProviderConfig {
  baseUrl: string;
  apiKey?: string;
  /** 协议测试和受控出站代理注入点；不会保存到任何持久化产物。 */
  fetch?: typeof fetch;
  beforeRequest?: CompletionOptions["beforeRequest"];
}

export const DEFAULT_DEEPSEEK_MODEL = DEEPSEEK_V41_WINDOW.modelId;

/** 同时约束请求和读取响应；finally 释放计时器与父级信号监听器。 */
export function requestDeadline(parent?: AbortSignal, timeoutMs = 120_000): {
  signal: AbortSignal; close: () => void;
} {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("模型超时必须为正整数毫秒");
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("模型调用已取消（调用方 abort）"));
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("模型调用超时")), timeoutMs);
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent?.removeEventListener("abort", cancel); } };
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // 即使取消发生在调用边界，也消费已启动操作的拒绝，避免悬空的 unhandled rejection。
    void work.catch(() => undefined);
    signal.throwIfAborted();
  }
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("模型调用已取消"));
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", rejectAbort); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function receiptIdentifier(value: unknown, limit: number, secret?: string): string | undefined {
  if (typeof value !== "string" || value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    || /(?:sk-|gh[pousr]_|github_pat_)/i.test(value) || (secret && value.includes(secret))) return undefined;
  return value;
}

/** A rejected message can still be a paid physical request. Copy only bounded
 * accounting fields, never assistant text, reasoning or tool arguments. */
function meteredProtocolFailure(error: unknown, value: unknown, requestedModel: string, secret?: string): Error {
  const failure = error instanceof Error ? error : new Error("模型响应协议错误");
  if (!isRecord(value) || !isRecord(value.usage)) return failure;
  const prompt = value.usage.prompt_tokens;
  const completion = value.usage.completion_tokens;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion) || (prompt as number) < 0 || (completion as number) < 0) return failure;
  const sum = (prompt as number) + (completion as number);
  const total = value.usage.total_tokens ?? sum;
  if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(total) || total !== sum) return failure;
  const reportedModel = receiptIdentifier(value.model, 150, secret);
  const modelId = reportedModel ?? receiptIdentifier(requestedModel, 150, secret);
  const responseId = receiptIdentifier(value.id, 200, secret);
  const choice = Array.isArray(value.choices) && isRecord(value.choices[0]) ? value.choices[0] : undefined;
  const finishReason = receiptIdentifier(choice?.finish_reason, 32, secret);
  Object.assign(failure, {
    usage: { promptTokens: prompt, completionTokens: completion },
    ...(modelId ? { modelId } : {}), ...(responseId ? { responseId } : {}),
    receipt: { adapter: "completion-protocol", final: false, usageComplete: true,
      modelIdentitySource: reportedModel ? "reported" : "requested-unverified",
      ...(responseId ? { responseId } : {}), ...(finishReason ? { finishReason } : {}) },
  });
  return failure;
}

function parseCompletion(value: unknown, model: string, requireUsage: boolean): CompletionResult {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    throw new Error("模型响应协议错误：缺少 assistant choice");
  }
  const choice = value.choices[0];
  if (requireUsage && (typeof value.model !== "string" || !value.model || typeof choice.finish_reason !== "string")) {
    throw new Error("模型响应协议错误：缺少实际模型或终态");
  }
  const raw = choice.message;
  if (!isRecord(raw) || raw.role !== "assistant" || !(raw.content === null || typeof raw.content === "string")) {
    throw new Error("模型响应协议错误：assistant message 无效");
  }
  const message: AssistantMessage = { role: "assistant", content: raw.content };
  if (raw.reasoning_content !== undefined && raw.reasoning_content !== null) {
    if (typeof raw.reasoning_content !== "string") throw new Error("模型响应协议错误：reasoning_content 无效");
    message.reasoning_content = raw.reasoning_content;
  }
  if (raw.tool_calls !== undefined) {
    if (!Array.isArray(raw.tool_calls)) throw new Error("模型响应协议错误：tool_calls 无效");
    const ids = new Set<string>();
    message.tool_calls = raw.tool_calls.map((call: unknown) => {
      if (!isRecord(call) || typeof call.id !== "string" || !call.id || ids.has(call.id) || call.type !== "function"
        || !isRecord(call.function) || typeof call.function.name !== "string" || !call.function.name
        || typeof call.function.arguments !== "string") throw new Error("模型响应协议错误：函数调用无效");
      ids.add(call.id);
      return { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } };
    });
  }
  if (!message.content?.trim() && !message.tool_calls?.length) throw new Error("模型响应协议错误：空结果不可作为交付");
  let usage: CompletionUsage | undefined;
  if (value.usage !== undefined) {
    const rawUsage = value.usage;
    if (!isRecord(rawUsage) || !Number.isSafeInteger(rawUsage.prompt_tokens) || (rawUsage.prompt_tokens as number) < 0
      || !Number.isSafeInteger(rawUsage.completion_tokens) || (rawUsage.completion_tokens as number) < 0) {
      throw new Error("模型响应协议错误：usage 无效");
    }
    const prompt = rawUsage.prompt_tokens as number;
    const completion = rawUsage.completion_tokens as number;
    const total = rawUsage.total_tokens ?? prompt + completion;
    if (!Number.isSafeInteger(total) || total !== prompt + completion) throw new Error("模型响应协议错误：usage 总数不一致");
    usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total as number };
    for (const key of ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"] as const) {
      if (rawUsage[key] !== undefined) {
        if (!Number.isSafeInteger(rawUsage[key]) || (rawUsage[key] as number) < 0) throw new Error("模型响应协议错误：cache usage 无效");
        usage[key] = rawUsage[key] as number;
      }
    }
    if (isRecord(rawUsage.completion_tokens_details) && rawUsage.completion_tokens_details.reasoning_tokens !== undefined) {
      const reasoning = rawUsage.completion_tokens_details.reasoning_tokens;
      if (!Number.isSafeInteger(reasoning) || (reasoning as number) < 0 || (reasoning as number) > completion) throw new Error("模型响应协议错误：reasoning usage 无效");
      usage.completion_tokens_details = { reasoning_tokens: reasoning as number };
    }
  } else if (requireUsage) throw new Error("模型响应协议错误：缺失 usage，已冻结后续请求");
  return {
    text: message.content ?? "", message, responseId: typeof value.id === "string" ? value.id : undefined,
    model: typeof value.model === "string" && value.model ? value.model : model,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
    usage, promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0,
  };
}

export interface ModelProvider {
  readonly modelId: string;
  /** 健康探针（降级链判定用） */
  healthy(): Promise<boolean>;
  /**
   * GR-04（2026-09-28 压测）：调用必须可超时、可取消——
   * 此前 fetch 既无 AbortSignal 也无超时，实测一次 quest-plan 挂 53 秒
   * （IM 侧更糟：慢模型把 dispatch 挂满 3 分 49 秒），整条请求链被单个模型拖死。
   */
  chat(messages: ChatMessage[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ChatResult>;
}

/** Mock 定价（演示口径：积分=token 千分位取整，旗舰 ×4） */
export function mockCredits(modelId: string, r: ChatResult): number {
  const per1k = modelId.includes("flagship") ? 4 : 1;
  return Math.max(1, Math.ceil((r.promptTokens + r.completionTokens) / 1000) * per1k);
}

/**
 * 确定性 Mock Provider（D4）
 * @param opts.failFirst 前 N 次调用抛错（降级链实证用）
 */
export class MockProvider implements ModelProvider {
  private calls = 0;
  constructor(
    public readonly modelId: string,
    private readonly opts: { failFirst?: number; down?: boolean } = {},
  ) {}
  async healthy(): Promise<boolean> {
    return !this.opts.down;
  }
  async chat(messages: ChatMessage[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ChatResult> {
    if (opts.signal?.aborted) throw new Error("模型调用已取消");
    this.calls += 1;
    if (this.opts.failFirst && this.calls <= this.opts.failFirst) {
      throw new Error(`mock 故障注入（第 ${this.calls} 次）`);
    }
    const last = messages[messages.length - 1]?.content ?? "";
    const text = `[mock:${this.modelId}] ${last.slice(0, 40)} → 确定性应答`;
    return { text, promptTokens: last.length, completionTokens: text.length };
  }
}

/** OpenAI 兼容 Provider（F6.6：chat 内部强制出站脱敏，插件不可绕过；apiKey 为空适配免 key 网关/本地代理） */
export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    public readonly modelId: string,
    private readonly cfg: OpenAiProviderConfig,
  ) {
    const url = new URL(cfg.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("模型 baseUrl 必须为不含凭据、查询或片段的 HTTP/HTTPS 地址");
    }
  }
  private authHeaders(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }
  async healthy(): Promise<boolean> {
    try {
      const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, "")}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      // 404 视为健康：部分 OpenAI 兼容网关/stub 不实现 /models（端点可达即放行；
      // 真实调用失败仍走降级事件留痕 L6.1，语义不丢）
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
  async chat(messages: ChatMessage[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ChatResult> {
    return this.complete(messages, { ...opts, requireUsage: false });
  }
  /** 完整协议：assistant/tool 配对与 reasoning_content 不再被单轮文本投影丢弃。 */
  async complete(messages: ProviderMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    const dispatch: CompletionDispatchReceipt = { attemptId: randomUUID(),
      model: receiptIdentifier(this.modelId, 150, this.cfg.apiKey) ?? "unverified-model",
      dispatchState: "blocked-before-send", usageComplete: true };
    try {
    if (opts.signal?.aborted) throw new Error("模型调用已取消（计量前）");
    if (!messages.length) throw new Error("模型输入消息不能为空");
    if (opts.maxTokens !== undefined && (!Number.isSafeInteger(opts.maxTokens) || opts.maxTokens < 1 || opts.maxTokens > 393_216)) throw new Error("maxTokens 超出范围");
    if (opts.temperature !== undefined && (!Number.isFinite(opts.temperature) || opts.temperature < 0 || opts.temperature > 2)) throw new Error("temperature 超出范围");
    const deepseek = this.modelId.startsWith("deepseek-") || new URL(this.cfg.baseUrl).hostname === "api.deepseek.com";
    const thinking = opts.thinking ?? "disabled";
    if (deepseek && thinking === "enabled" && opts.toolChoice && opts.toolChoice !== "auto" && opts.toolChoice !== "none") {
      throw new Error("DeepSeek thinking 模式只支持 auto/none toolChoice");
    }
    if (deepseek && this.modelId !== DEFAULT_DEEPSEEK_MODEL) throw new Error("DeepSeek 模型能力未登记，禁止猜测上下文窗口");
    if (this.cfg.apiKey && JSON.stringify({ messages, tools: opts.tools, responseFormat: opts.responseFormat }).includes(this.cfg.apiKey)) throw new Error("模型输入包含连接器密钥，已阻断出站");
    const masked = maskDeep(messages).value;
    const tools = maskDeep(opts.tools ?? []).value;
    const body: Record<string, unknown> = { model: this.modelId, messages: masked, stream: false };
    if (deepseek) body.thinking = { type: thinking };
    if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort;
    if (thinking === "disabled") body.temperature = opts.temperature ?? 0.2;
    if (tools.length) body.tools = tools;
    if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
    if (opts.responseFormat) body.response_format = opts.responseFormat;
    const window = deepseek ? await planDeepSeekWindow(body) : undefined;
    const maxTokens = window?.maxOutputTokens ?? opts.maxTokens ?? 4096;
    if (window && opts.maxTokens !== undefined && opts.maxTokens !== maxTokens) {
      throw new Error("DeepSeek maxTokens 与完整输入窗口不符；移除历史输出常量，由模型能力计算");
    }
    body.max_tokens = maxTokens;
    const serializedBody = window?.serializedBody ?? JSON.stringify(body);
    dispatch.requestSha256 = createHash("sha256").update(serializedBody).digest("hex");
    const requestReceipt: CompletionRequestReceipt | undefined = window ? {
      model: this.modelId, fullInputTokens: window.fullInputTokens, maxTokens, contextTokens: window.contextTokens,
      requestSha256: window.requestSha256, tokenizerSha256: window.tokenizerSha256, recipeVersion: window.recipeVersion,
    } : undefined;
    if (requestReceipt) dispatch.modelRequest = requestReceipt;
    const deadline = requestDeadline(opts.signal, opts.timeoutMs ?? 600_000);
    try {
      const request = { messages: structuredClone(masked), tools: structuredClone(tools), maxTokens, model: this.modelId,
        body: JSON.parse(serializedBody) as Record<string, unknown>, request: requestReceipt && { ...requestReceipt }, signal: deadline.signal };
      deadline.signal.throwIfAborted();
      if (this.cfg.beforeRequest) await abortable(Promise.resolve(this.cfg.beforeRequest(request)), deadline.signal);
      if (opts.beforeRequest && opts.beforeRequest !== this.cfg.beforeRequest) await abortable(Promise.resolve(opts.beforeRequest(request)), deadline.signal);
      deadline.signal.throwIfAborted();
      if (opts.beforeDispatch) await abortable(Promise.resolve(opts.beforeDispatch(structuredClone({ ...dispatch, dispatchState: "possibly-sent", usageComplete: false }))), deadline.signal);
      deadline.signal.throwIfAborted();
      let res: Response;
      dispatch.dispatchState = "possibly-sent";
      dispatch.usageComplete = false;
      try { res = await abortable((this.cfg.fetch ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: serializedBody, signal: deadline.signal, redirect: "error",
      }), deadline.signal); }
      catch { deadline.signal.throwIfAborted(); throw new Error("模型网络请求失败"); }
      if (!res.ok) {
        // Only the configured loopback boundary can attest a definite local
        // denial. A remote HTTP error or a mismatching hash never clears a hold.
        const boundary = new URL(this.cfg.baseUrl);
        if (boundary.protocol === "http:" && boundary.hostname === "127.0.0.1"
          && res.headers.get("x-workloom-model-dispatch") === "not-sent"
          && res.headers.get("x-workloom-request-sha256") === dispatch.requestSha256) {
          dispatch.dispatchState = "blocked-before-send";
        }
        // 清理失败不能覆盖已知的 HTTP 状态，也不能把上游正文/密钥放进异常。
        void res.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error(`模型调用失败：HTTP ${res.status}`), { httpStatus: res.status });
      }
      let data: unknown;
      try { data = await abortable(res.json(), deadline.signal); }
      catch { deadline.signal.throwIfAborted(); throw new Error("模型响应协议错误：无效 JSON"); }
      try {
        const result = parseCompletion(data, this.modelId, opts.requireUsage !== false);
        if (result.usage) { dispatch.dispatchState = "sent-usage-known"; dispatch.usageComplete = true; }
        return { ...result, ...(requestReceipt ? { request: requestReceipt } : {}), requestReceipt: { ...dispatch } };
      }
      catch (error) {
        const failure = meteredProtocolFailure(error, data, this.modelId, this.cfg.apiKey);
        if (requestReceipt) Object.assign(failure, { request: requestReceipt });
        throw failure;
      }
    } catch (error) {
      if (error instanceof Error && requestReceipt) Object.assign(error, { request: requestReceipt });
      throw error;
    } finally { deadline.close(); }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("模型调用失败");
      const existing = (failure as { receipt?: Record<string, unknown> }).receipt;
      if (existing?.usageComplete === true && dispatch.dispatchState !== "blocked-before-send") {
        dispatch.dispatchState = "sent-usage-known"; dispatch.usageComplete = true;
      }
      Object.assign(failure, { dispatchState: dispatch.dispatchState, requestReceipt: { ...dispatch },
        receipt: { ...existing, dispatchState: dispatch.dispatchState, usageComplete: dispatch.usageComplete, requestReceipt: { ...dispatch } } });
      throw failure;
    }
  }
}

/** 按 .env 装配默认提供方集（mock | deepseek | moonshot | zhipu | openai；apiKey 可空=免 key 网关） */
export function providerFromEnv(modelId?: string): ModelProvider {
  const p = process.env.LLM_PROVIDER ?? "deepseek";
  if (p === "mock") return new MockProvider(modelId ?? "mock-standard-a");
  if (p === "deepseek") return createDeepSeekProvider({ modelId });
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!baseUrl) throw new Error(`LLM_PROVIDER=${p} 但缺少 LLM_BASE_URL`);
  return new OpenAiCompatibleProvider(process.env.LLM_MODEL || modelId || DEFAULT_DEEPSEEK_MODEL, { baseUrl, apiKey: apiKey || undefined });
}

/** 新执行器只能使用真实提供方；显式配置优先，未配置密钥立即失败。 */
export function createDeepSeekProvider(cfg: Partial<OpenAiProviderConfig> & { modelId?: string } = {}): OpenAiCompatibleProvider {
  const apiKey = cfg.apiKey ?? (process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY);
  if (!apiKey?.trim()) throw new Error("DeepSeek 缺少 API 密钥：注入 DEEPSEEK_API_KEY 或 LLM_API_KEY");
  const model = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || cfg.modelId || DEFAULT_DEEPSEEK_MODEL;
  const baseUrl = cfg.baseUrl ?? (process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com");
  return new OpenAiCompatibleProvider(model, { ...cfg, baseUrl, apiKey });
}

export * from "./deepseek-tools.js";

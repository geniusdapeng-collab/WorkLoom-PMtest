import type { CompletionProvider, CompletionResult } from "@workloom/base/model-router";
import { AssistantModelError } from "./model.js";
import type { AssistantStore } from "./store.js";
import type { AssistantRun, AssistantScope, AssistantUsage } from "./types.js";

function reportedUsage(prompt: unknown, completion: unknown, total?: unknown): AssistantUsage | undefined {
  if (!Number.isSafeInteger(prompt) || Number(prompt) < 0 || !Number.isSafeInteger(completion) || Number(completion) < 0) return;
  const sum = Number(prompt) + Number(completion);
  if (!Number.isSafeInteger(sum) || (total !== undefined && total !== sum)) return;
  return { promptTokens: Number(prompt), completionTokens: Number(completion), totalTokens: sum };
}

/** Bind each physical PM call to the assistant's existing daily hard quota.
 * The provider supplies a count of its final body and the actual output ceiling.
 * A worker/DAG is not itself a quota reservation. */
export function assistantTaskProviderGuard(store: AssistantStore, scope: AssistantScope, run: AssistantRun) {
  let attempt = 0;
  return (provider: CompletionProvider): CompletionProvider => ({ modelId: provider.modelId,
    async complete(messages, opts = {}) {
      let reservation: { reservationId: string; budgetDate: string } | undefined;
      let dispatchPossible = false;
      const settle = (usage: AssistantUsage | undefined, callsUsed: number, blockedReason?: string) => reservation
        ? store.settleBudget(scope, { runId: run.id, ...reservation, reservedCalls: 1, usage, callsUsed, blockedReason })
        : Promise.resolve();
      let result: CompletionResult;
      try {
        result = await provider.complete(messages, { ...opts, async beforeRequest(request) {
          if (opts.beforeRequest) await opts.beforeRequest(request);
          if (reservation || !request.request) throw new AssistantModelError("MODEL_RECEIPT_MISSING", "模型出站缺少唯一窗口预占合同");
          const { fullInputTokens, maxTokens } = request.request;
          const reservationId = `${run.id}:pm:${++attempt}`;
          reservation = await store.reserveBudget(scope, run.id, fullInputTokens + maxTokens, 1, 0, reservationId);
          await store.appendEvent(scope, run.id, run.sessionId, "model.request.prepared", { ...request.request,
            reservationId, quota: "daily-hard-total-tokens" });
          request.signal.throwIfAborted();
          dispatchPossible = true;
        } });
      } catch (error) {
        const failure = error as { usage?: { promptTokens?: unknown; completionTokens?: unknown }; receipt?: { usageComplete?: boolean }; dispatchState?: string } | null;
        const usage = failure?.receipt?.usageComplete === true ? reportedUsage(failure.usage?.promptTokens, failure.usage?.completionTokens) : undefined;
        const mayHaveDispatched = dispatchPossible && failure?.dispatchState !== "blocked-before-send";
        try { await settle(usage, mayHaveDispatched ? 1 : 0, !usage && mayHaveDispatched ? "PM 请求缺少完整用量，保留原预占" : undefined); }
        catch (settlementError) { console.error("[assistant] PM 请求结算未确认，保留原预占", settlementError instanceof Error ? settlementError.name : "UnknownError"); }
        throw error;
      }
      const usage = result.usage ? reportedUsage(result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens) : undefined;
      if (!reservation) throw Object.assign(new AssistantModelError("MODEL_RECEIPT_MISSING", "模型未走出站预占合同"),
        { usage, modelId: result.model, responseId: result.responseId });
      try { await settle(usage, 1, usage ? undefined : "PM 请求缺少完整用量，保留原预占"); }
      catch (error) {
        throw Object.assign(new AssistantModelError("BUDGET_SETTLEMENT_UNCONFIRMED", "已保留原预占，PM 请求结算待核对"),
          { usage, modelId: result.model, responseId: result.responseId, receipt: { usageComplete: Boolean(usage), modelRequest: result.request } });
      }
      return result;
    },
  });
}

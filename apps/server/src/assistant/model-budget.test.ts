import { describe, expect, it, vi } from "vitest";
import type { CompletionOptions, CompletionProvider, CompletionResult } from "@workloom/base/model-router";
import { assistantTaskProviderGuard } from "./model-budget.js";
import type { AssistantStore } from "./store.js";
import type { AssistantRun } from "./types.js";

const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace", memberNo: "fixture-member" };
const run = { id: "fixture-run", sessionId: "fixture-session" } as AssistantRun;
const messages = [{ role: "user" as const, content: "原始输入" }];
const request = { model: "deepseek-flash", contextTokens: 1048576, fullInputTokens: 4174, maxTokens: 393216,
  requestSha256: "a".repeat(64), tokenizerSha256: "b".repeat(64), recipeVersion: "0.2.0" };
const result: CompletionResult = { model: request.model, responseId: "fixture-response", finishReason: "stop", request,
  message: { role: "assistant", content: "finished" }, text: "finished", promptTokens: 4174, completionTokens: 2942,
  usage: { prompt_tokens: 4174, completion_tokens: 2942, total_tokens: 7116 } };
function fixture(outcome: () => CompletionResult = () => result) {
  const reserveBudget = vi.fn(async (_scope, _runId, _tokens, _calls, _search, reservationId) => ({ reservationId, budgetDate: "2026-11-03" }));
  const settleBudget = vi.fn(async () => {});
  const appendEvent = vi.fn(async () => {});
  const network = vi.fn(outcome);
  const provider: CompletionProvider = { modelId: request.model, async complete(input, opts?: CompletionOptions) {
    await opts?.beforeRequest?.({ messages: input, tools: [], maxTokens: request.maxTokens, model: request.model, request,
      body: { messages: input, model: request.model, max_tokens: request.maxTokens }, signal: new AbortController().signal });
    return network();
  } };
  return { reserveBudget, settleBudget, appendEvent, network,
    provider: assistantTaskProviderGuard({ reserveBudget, settleBudget, appendEvent } as unknown as AssistantStore, scope, run)(provider) };
}
describe("assistant physical PM quota guard", () => {
  it("holds full legal capacity per physical request; actual settlement releases unused headroom", async () => {
    const f = fixture(); await f.provider.complete(messages); await f.provider.complete(messages);
    expect(f.reserveBudget).toHaveBeenNthCalledWith(1, scope, run.id, 397390, 1, 0, "fixture-run:pm:1");
    expect(f.reserveBudget).toHaveBeenNthCalledWith(2, scope, run.id, 397390, 1, 0, "fixture-run:pm:2");
    expect(f.reserveBudget.mock.invocationCallOrder[0]).toBeLessThan(f.network.mock.invocationCallOrder[0]!);
    expect(f.settleBudget).toHaveBeenNthCalledWith(1, scope, expect.objectContaining({ reservationId: "fixture-run:pm:1", callsUsed: 1,
      usage: { promptTokens: 4174, completionTokens: 2942, totalTokens: 7116 } }));
  });
  it("a hard admission refusal neither starts the request nor creates a false settlement", async () => {
    const f = fixture(); f.reserveBudget.mockRejectedValueOnce(new Error("quota denied"));
    await expect(f.provider.complete(messages)).rejects.toThrow("quota denied");
    expect(f.network).not.toHaveBeenCalled(); expect(f.settleBudget).not.toHaveBeenCalled();
  });
  it("a possibly sent request with unknown usage preserves its reservation", async () => {
    const f = fixture(() => { throw Object.assign(new Error("connection lost"), { dispatchState: "possibly-sent" }); });
    await expect(f.provider.complete(messages)).rejects.toThrow("connection lost");
    expect(f.settleBudget).toHaveBeenCalledWith(scope, expect.objectContaining({ callsUsed: 1, usage: undefined, blockedReason: expect.any(String) }));
  });
  it("failure writing the preflight receipt releases the hold with zero physical calls", async () => {
    const f = fixture(); f.appendEvent.mockRejectedValueOnce(new Error("receipt unavailable"));
    await expect(f.provider.complete(messages)).rejects.toThrow("receipt unavailable");
    expect(f.network).not.toHaveBeenCalled();
    expect(f.settleBudget).toHaveBeenCalledWith(scope, expect.objectContaining({ callsUsed: 0, usage: undefined, blockedReason: undefined }));
  });
});

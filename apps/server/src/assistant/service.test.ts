import { describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";
import { AssistantModelError, type AssistantModelClient, type AssistantModelResult } from "./model.js";
import type { AssistantSearchClient } from "./search.js";
import { AssistantService, systemPrompt, type AssistantTaskFacade } from "./service.js";
import type { AssistantStore } from "./store.js";
import type { AssistantIdentity, AssistantRun, AssistantSearchReceipt } from "./types.js";
import type { PmRunDetail } from "../industry/ai-pm/types.js";

const identity: Identity = {
  kind: "member",
  memberId: "member-1",
  memberNo: "MEM-001",
  name: "产品所有者",
  role: "owner",
  tenantId: "tenant-1",
  workspaceId: "ws-aipm-demo",
  plan: "pro",
};
const assistantIdentity: AssistantIdentity = {
  ...identity,
  assistantScope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId, memberNo: identity.memberNo },
};
const run: AssistantRun = {
  id: "ar-00000000-0000-4000-8000-000000000001",
  sessionId: "as-00000000-0000-4000-8000-000000000001",
  mode: "ask",
  model: "deepseek-flash",
  responseModel: null,
  status: "queued",
  threadId: null,
  responseId: null,
  usage: {},
  webSearchRequested: true,
  searchStatus: "not_requested",
  searchQuery: null,
  searchResultCount: 0,
  searchCompletedAt: null,
  errorCode: null,
  error: null,
  userMessageId: "am-user",
  assistantMessageId: "am-assistant",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const searchReceipt: AssistantSearchReceipt = {
  query: "DeepSeek Search API 官方计费",
  searchedAt: "2026-10-30T01:55:00.000Z",
  results: [{
    title: "网页搜索与抓取",
    url: "https://api-docs.deepseek.com/zh-cn/guides/search",
    snippet: "官方指南",
    summary: "Search 接口按成功请求计费，端点由官方文档给出。",
    siteName: "DeepSeek API Docs",
    publishedAt: null,
    authority: 4,
    rerankScore: 2.8,
  }],
};

function fakeStore(runOverrides: Partial<AssistantRun> = {}) {
  const turnRun = { ...structuredClone(run), ...runOverrides };
  const value = {
    createTurn: vi.fn(async () => ({
      run: turnRun,
      userMessage: {
        id: "am-user", seq: "1", sessionId: turnRun.sessionId, role: "user", parts: [{ type: "text", text: "搜索官方计费" }],
        parentMessageId: null, clientMessageId: "client-1", runId: turnRun.id, status: "completed",
        createdAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
      },
      assistantMessage: {
        id: "am-assistant", seq: "2", sessionId: turnRun.sessionId, role: "assistant", parts: [{ type: "text", text: "" }],
        parentMessageId: "am-user", clientMessageId: null, runId: turnRun.id, status: "pending",
        createdAt: new Date(0).toISOString(), finishedAt: null,
      },
      replayed: false,
    })),
    startRun: vi.fn(),
    reserveBudget: vi.fn(async () => ({ budgetDate: "2026-10-30" })),
    setRunThread: vi.fn(async () => undefined),
    updateSearchState: vi.fn(async () => undefined),
    appendEvent: vi.fn(async () => undefined),
    historyForRun: vi.fn(async () => []),
    finishRun: vi.fn(async () => undefined),
    failRun: vi.fn(async () => undefined),
    settleBudget: vi.fn(async () => undefined),
  };
  return value;
}

const completedTaskDetail = {
  run: {
    id: "pm-run-1",
    status: "completed",
    modelId: "deepseek-flash",
    usage: { promptTokens: 88, completionTokens: 44 },
    error: null,
    verification: { verifiedAt: "2026-10-30T02:30:00.000Z" },
    planningReceipts: [],
  },
  tasks: [{
    id: "task-1",
    status: "completed",
    presetKey: "chief-pm",
    adapterReceipt: { modelCalls: 2 },
    attemptReceipts: [],
  }],
  artifacts: [{
    id: "artifact-1",
    runId: "pm-run-1",
    taskId: "task-1",
    path: "outputs/report.md",
    sha256: "a".repeat(64),
    sizeBytes: 42,
    mediaType: "text/markdown",
    verifiedAt: "2026-10-30T02:30:00.000Z",
  }],
} as unknown as PmRunDetail;

function completedTaskFacade(detail = completedTaskDetail): AssistantTaskFacade {
  return {
    create: vi.fn(async () => detail),
    start: vi.fn(async () => detail),
    detail: vi.fn(async () => detail),
    cancel: vi.fn(async () => detail),
    artifact: vi.fn(),
  };
}

const fixtureRequest = { model: "deepseek-flash", fullInputTokens: 100, maxTokens: 393216, contextTokens: 1048576,
  requestSha256: "a".repeat(64), tokenizerSha256: "b".repeat(64), recipeVersion: "0.2.0" };
function meteredModel(model: AssistantModelClient): AssistantModelClient {
  const stream = model.stream as ReturnType<typeof vi.fn>;
  const implementation = stream.getMockImplementation()! as AssistantModelClient["stream"];
  stream.mockImplementation(async (input: Parameters<AssistantModelClient["stream"]>[0]) => {
    await input.onRequest?.(fixtureRequest);
    return implementation(input);
  });
  return model;
}

const failedTaskDetail = {
  ...completedTaskDetail,
  run: {
    ...completedTaskDetail.run,
    status: "failed",
    usage: { promptTokens: 70, completionTokens: 30 },
    error: "upstream transient failure",
    errorCode: "EMPLOYEE_EXECUTION_FAILED",
  },
  tasks: [
    completedTaskDetail.tasks[0],
    {
      ...completedTaskDetail.tasks[0],
      id: "task-2",
      status: "failed",
      adapterReceipt: { modelCalls: 2 },
    },
  ],
  artifacts: completedTaskDetail.artifacts,
} as unknown as PmRunDetail;

describe("assistant web search orchestration", () => {
  it("searches before the model, persists real sources, and settles both budgets", async () => {
    const store = fakeStore();
    const model: AssistantModelClient = {
      model: "deepseek-flash",
      stream: vi.fn(async () => ({ text: "官方 Search 端点见来源。", model: "deepseek-flash", responseId: "resp-1",
        usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } })),
    };
    const search: AssistantSearchClient = { configured: true, search: vi.fn(async () => searchReceipt) };
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model: meteredModel(model),
      search,
      events: { append: vi.fn() },
      taskFacade: {} as never,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "DeepSeek Search API 官方计费",
      mode: "ask",
      clientMessageId: "client-1",
      webSearch: true,
    });
    await vi.waitFor(() => expect(store.finishRun).toHaveBeenCalledOnce());
    expect(store.updateSearchState).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, expect.objectContaining({
      status: "completed",
      resultCount: 1,
    }));
    expect(store.appendEvent).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, run.sessionId, "search.completed", expect.objectContaining({
      resultCount: 1,
    }));
    const modelMessages = ((model.stream as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages;
    expect(modelMessages.some((message) => message.content.includes("不可信外部资料")
      && message.content.includes(searchReceipt.results[0]!.url))).toBe(true);
    expect(store.finishRun).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, expect.objectContaining({
      parts: expect.arrayContaining([
        expect.objectContaining({ type: "source", url: searchReceipt.results[0]!.url }),
      ]),
    }));
    expect(store.settleBudget).toHaveBeenCalledWith(assistantIdentity.assistantScope, expect.objectContaining({
      reservedSearchCalls: 1,
      searchCallsUsed: 1,
    }));
  });

  it("fails closed before the model when the required search fails", async () => {
    const store = fakeStore();
    const model: AssistantModelClient = {
      model: "deepseek-flash",
      stream: vi.fn(async () => ({ text: "must not run", model: "deepseek-flash" })),
    };
    const search: AssistantSearchClient = {
      configured: true,
      search: vi.fn(async () => { throw new AssistantModelError("SEARCH_FAILED", "upstream unavailable", 502); }),
    };
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model: meteredModel(model),
      search,
      events: { append: vi.fn() },
      taskFacade: {} as never,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "search required",
      mode: "ask",
      clientMessageId: "client-2",
      webSearch: true,
    });
    await vi.waitFor(() => expect(store.failRun).toHaveBeenCalledOnce());
    expect(model.stream).not.toHaveBeenCalled();
    expect(store.failRun).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, expect.objectContaining({
      code: "SEARCH_FAILED",
    }));
    expect(store.settleBudget).toHaveBeenCalledWith(assistantIdentity.assistantScope, expect.objectContaining({
      reservedSearchCalls: 1,
      searchCallsUsed: 1,
    }));
  });

  it("settles known provider usage before message persistence so later storage failures do not freeze the budget", async () => {
    const store = fakeStore();
    const usage = { promptTokens: 50, completionTokens: 12, totalTokens: 62 };
    const model: AssistantModelClient = {
      model: "deepseek-flash",
      stream: vi.fn(async () => ({
        text: "真实回答",
        model: "deepseek-flash",
        responseId: "resp-persist-failure",
        usage,
      })),
    };
    store.finishRun.mockRejectedValueOnce(new Error("message persistence failed"));
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model: meteredModel(model),
      search: { configured: true, search: vi.fn(async () => ({ ...searchReceipt, results: [] })) },
      events: { append: vi.fn() },
      taskFacade: {} as never,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "search with persistence failure",
      mode: "ask",
      clientMessageId: "client-3",
      webSearch: true,
    });
    await vi.waitFor(() => expect(store.failRun).toHaveBeenCalledOnce());
    expect(store.settleBudget.mock.invocationCallOrder[0]).toBeLessThan(
      store.finishRun.mock.invocationCallOrder[0]!,
    );
    expect(store.settleBudget).toHaveBeenCalledWith(assistantIdentity.assistantScope, expect.objectContaining({
      usage,
      reservedCalls: 1,
      reservedSearchCalls: 0,
      searchCallsUsed: 0,
    }));
    expect(store.settleBudget).not.toHaveBeenCalledWith(
      assistantIdentity.assistantScope,
      expect.objectContaining({ blockedReason: expect.any(String) }),
    );
  });

  it("delegates physical charging and does not settle an entire DAG again after persistence failure", async () => {
    const store = fakeStore({ mode: "task", webSearchRequested: false });
    store.finishRun.mockRejectedValueOnce(new Error("task message persistence failed"));
    const facade = completedTaskFacade();
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model: {
        model: "deepseek-flash",
        stream: vi.fn(async () => {
          throw new Error("ask model must not run in task mode");
        }),
      },
      search: { configured: false, search: vi.fn() },
      events: { append: vi.fn() },
      taskFacade: facade,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "生成并验证研发产物",
      mode: "task",
      clientMessageId: "client-4",
      webSearch: false,
    });
    await vi.waitFor(() => expect(store.failRun).toHaveBeenCalledOnce());
    expect(facade.start).toHaveBeenCalledWith(assistantIdentity.assistantScope, completedTaskDetail.run.id, expect.any(Function));
    expect(store.reserveBudget).not.toHaveBeenCalled();
    expect(store.settleBudget).not.toHaveBeenCalled();
  });

  it("retains failed task usage for display without charging the aggregate again", async () => {
    const store = fakeStore({ mode: "task", webSearchRequested: false });
    const facade = completedTaskFacade(failedTaskDetail);
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model: {
        model: "deepseek-flash",
        stream: vi.fn(),
      },
      search: { configured: false, search: vi.fn() },
      events: { append: vi.fn() },
      taskFacade: facade,
    });
    await service.send(assistantIdentity, run.sessionId, {
      text: "执行一个最终节点失败的任务",
      mode: "task",
      clientMessageId: "client-failed-task",
      webSearch: false,
    });
    await vi.waitFor(() => expect(store.failRun).toHaveBeenCalledOnce());
    expect(store.failRun).toHaveBeenCalledWith(assistantIdentity.assistantScope, run.id, expect.objectContaining({
      usage: { promptTokens: 70, completionTokens: 30, totalTokens: 100 },
    }));
    expect(store.settleBudget).not.toHaveBeenCalled();
  });

  it("limits concurrent runs per workspace instead of across all tenants", async () => {
    const store = fakeStore();
    const concurrencyIdentity: AssistantIdentity = {
      ...assistantIdentity,
      memberNo: "MEM-CONCURRENCY",
      workspaceId: "ws-concurrency",
      assistantScope: {
        tenantId: "tenant-concurrency",
        workspaceId: "ws-concurrency",
        memberNo: "MEM-CONCURRENCY",
      },
    };
    const otherIdentity: AssistantIdentity = {
      ...concurrencyIdentity,
      memberNo: "MEM-OTHER",
      workspaceId: "ws-other",
      assistantScope: {
        tenantId: concurrencyIdentity.tenantId,
        workspaceId: "ws-other",
        memberNo: "MEM-OTHER",
      },
    };
    const runIds = [
      "ar-00000000-0000-4000-8000-000000000011",
      "ar-00000000-0000-4000-8000-000000000012",
      "ar-00000000-0000-4000-8000-000000000013",
      "ar-00000000-0000-4000-8000-000000000014",
    ];
    let turn = 0;
    store.createTurn.mockImplementation(async () => {
      const id = runIds[turn++]!;
      const turnRun = {
        ...structuredClone(run),
        id,
        mode: "ask" as const,
        webSearchRequested: false,
      };
      return {
        run: turnRun,
        userMessage: {
          id: `am-user-${turn}`,
          seq: String(turn * 2 - 1),
          sessionId: turnRun.sessionId,
          role: "user",
          parts: [{ type: "text", text: "并发隔离" }],
          parentMessageId: null,
          clientMessageId: `client-${turn}`,
          runId: id,
          status: "completed",
          createdAt: new Date(0).toISOString(),
          finishedAt: new Date(0).toISOString(),
        },
        assistantMessage: {
          id: `am-assistant-${turn}`,
          seq: String(turn * 2),
          sessionId: turnRun.sessionId,
          role: "assistant",
          parts: [{ type: "text", text: "" }],
          parentMessageId: `am-user-${turn}`,
          clientMessageId: null,
          runId: id,
          status: "pending",
          createdAt: new Date(0).toISOString(),
          finishedAt: null,
        },
        replayed: false,
      };
    });
    const pending: Array<() => void> = [];
    const model: AssistantModelClient = {
      model: "deepseek-flash",
      stream: vi.fn(async (): Promise<AssistantModelResult> => new Promise((resolve) => {
        pending.push(() => resolve({
          text: "完成",
          model: "deepseek-flash",
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        }));
      })),
    };
    const service = new AssistantService({
      store: store as unknown as AssistantStore,
      model: meteredModel(model),
      search: { configured: false, search: vi.fn() },
      events: { append: vi.fn() },
      taskFacade: {} as never,
    });

    await service.send(concurrencyIdentity, run.sessionId, {
      text: "第一个并发任务",
      mode: "ask",
      clientMessageId: "client-11",
      webSearch: false,
    });
    await service.send(concurrencyIdentity, run.sessionId, {
      text: "同工作区超额任务",
      mode: "ask",
      clientMessageId: "client-12",
      webSearch: false,
    });
    await service.send(concurrencyIdentity, run.sessionId, {
      text: "同工作区第三个任务",
      mode: "ask",
      clientMessageId: "client-13",
      webSearch: false,
    });
    await service.send(otherIdentity, "as-00000000-0000-4000-8000-000000000002", {
      text: "另一个工作区任务",
      mode: "ask",
      clientMessageId: "client-14",
      webSearch: false,
    });

    await vi.waitFor(() => expect(model.stream).toHaveBeenCalledTimes(3));
    expect(store.failRun).toHaveBeenCalledWith(
      concurrencyIdentity.assistantScope,
      runIds[2],
      expect.objectContaining({ code: "CONCURRENCY_LIMIT" }),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    for (const resolve of pending) resolve();
    await vi.waitFor(() => expect(store.finishRun).toHaveBeenCalledTimes(3));
  });
});

describe("assistant system prompt", () => {
  it("states the Shanghai business date", () => {
    expect(systemPrompt(assistantIdentity, new Date("2026-10-29T17:18:28.000Z")))
      .toContain("当前业务日期 2026-10-30（Asia/Shanghai）");
  });
});

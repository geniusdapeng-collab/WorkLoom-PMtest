import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  failIndustryRead: false,
  failRollback: false,
  release: vi.fn(),
  status: "queued",
  title: "短标题索引",
  archive: { goals: { delivery: { text: "完整长目标：" + "验收条件与交付约束。".repeat(100), version: "v7" } } } as Record<string, unknown>,
  dispatch: { goal_ref: "delivery", goal_ref_version: "v7" } as Record<string, unknown> | null,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  events: [] as Array<{ context: Record<string, unknown>; draft: Record<string, unknown> }>,
  runQuest: vi.fn(),
  assemblePreset: vi.fn(),
  gatewayAppend: vi.fn(),
  loadExecutor: vi.fn(),
}));

const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" };
const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  fixture.queries.push({ sql, params });
  if (/UPDATE threads SET status='running'/.test(sql)) {
    const claimed = ["queued", "paused"].includes(fixture.status);
    if (claimed) fixture.status = "running";
    return { rows: claimed ? [{ id: "T-1" }] : [], rowCount: Number(claimed) };
  }
  if (/SELECT status FROM threads/.test(sql)) return { rows: [{ status: fixture.status }], rowCount: 1 };
  if (/SELECT title, status, agent_id FROM threads/.test(sql)) return { rows: [{ title: fixture.title, status: fixture.status, agent_id: "agt-fixture" }], rowCount: 1 };
  if (/FROM biz_events/.test(sql)) return { rows: fixture.dispatch ? [{ dispatch_after: fixture.dispatch }] : [], rowCount: fixture.dispatch ? 1 : 0 };
  if (/SELECT archive FROM profiles/.test(sql)) return { rows: [{ archive: fixture.archive }], rowCount: 1 };
  if (/SELECT preset_key FROM agents/.test(sql)) return { rows: [{ preset_key: "fixture-preset" }], rowCount: 1 };
  if (/SELECT industry FROM workspaces/.test(sql)) {
    if (fixture.failIndustryRead) throw new Error("injected vocabulary query failure");
    return { rows: [{ industry: null }], rowCount: 1 };
  }
  if (/UPDATE threads SET status='failed'/.test(sql)) {
    const changed = fixture.status === "running";
    if (changed) fixture.status = "failed";
    return { rows: changed ? [{ id: "T-1" }] : [], rowCount: Number(changed) };
  }
  if (sql === "ROLLBACK" && fixture.failRollback) throw new Error("injected broken connection");
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
  throw new Error(`fixture does not implement query: ${sql}`);
});
const pool = { connect: async () => ({ query, release: fixture.release }) };
vi.mock("@workloom/db", () => ({ getAppPool: () => pool, getGatewayPool: () => pool }));
vi.mock("@workloom/runtime", () => ({ assemblePreset: fixture.assemblePreset, runQuest: fixture.runQuest }));
vi.mock("@workloom/base/bundles", () => ({ bundlesRoot: () => "/fixture/no-bundles" }));
vi.mock("@workloom/base/workdata", () => ({ gatewayAppendOnClient: fixture.gatewayAppend }));
vi.mock("../service/llm.js", () => ({ llmCall: () => undefined }));
vi.mock("./tool-executor.js", () => ({ loadDeploymentToolExecutor: fixture.loadExecutor, describeToolCoverage: async () => ({ bridges: 0, covered: [], uncovered: [] }) }));

import { registerIndustryQuestPlanner, runQuestForThread } from "./thread-runner.js";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.status = "queued";
  fixture.failIndustryRead = false;
  fixture.failRollback = false;
  fixture.title = "短标题索引";
  fixture.archive = { goals: { delivery: { text: "完整长目标：" + "验收条件与交付约束。".repeat(100), version: "v7" } } };
  fixture.dispatch = { goal_ref: "delivery", goal_ref_version: "v7" };
  fixture.queries = []; fixture.events = [];
  fixture.assemblePreset.mockResolvedValue({ tools: [], presetKey: "fixture-preset", essentials: { archive: {}, stage: "definition", goal: "" } });
  fixture.runQuest.mockImplementation(async (_app, _gateway, _scope, input: { threadId: string }) => {
    fixture.status = "completed";
    return { threadId: input.threadId, status: "completed", stepsDone: 1, stepsTotal: 1, unverified: [] };
  });
  fixture.gatewayAppend.mockImplementation(async (_client, context: Record<string, unknown>, draft: Record<string, unknown>) => {
    fixture.events.push({ context, draft });
    return { eventId: "E-1" };
  });
  fixture.loadExecutor.mockResolvedValue(undefined);
  registerIndustryQuestPlanner(null);
});

describe("MC-PM-005 long-goal recovery", () => {
  it("restores the bound full goal for scheduler and ordinary resume, regardless of the short caller title", async () => {
    for (const skipClaim of [false, true]) {
      fixture.status = skipClaim ? "running" : "queued";
      await runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture", skipClaim });
      const call = fixture.runQuest.mock.calls.at(-1)!;
      expect(call[3].goal).toBe((fixture.archive.goals as Record<string, { text: string }>).delivery!.text);
      expect(call[3].goal.length).toBeGreaterThan(500);
      expect(fixture.assemblePreset.mock.calls.at(-1)?.[2].goal).toBe(call[3].goal);
    }
  });

  it.each([
    ["missing archive", {}, "档案"],
    ["version changed", { goals: { delivery: { text: "new content", version: "v8" } } }, "版本"],
  ])("fails closed for %s instead of planning the short title", async (_case, archive, message) => {
    fixture.archive = archive;
    await expect(runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture" })).rejects.toThrow(message);
    expect(fixture.runQuest).not.toHaveBeenCalled();
    expect(fixture.status).toBe("failed");
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]?.draft).toMatchObject({ decision: { action: "thread.execution.failed", outcome: "error" }, receipt: { synced: false } });
  });

  it("refuses an unversioned dispatch binding even when the current archive exists", async () => {
    fixture.dispatch = { goal_ref: "delivery", goal_ref_version: null };
    await expect(runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture", replan: true })).rejects.toThrow("版本");
    expect(fixture.runQuest).not.toHaveBeenCalled();
    expect(fixture.status).toBe("failed");
    expect(fixture.queries.every(({ sql }) => !/UPDATE approvals/.test(sql))).toBe(true);
  });

  it("keeps the explicit goal for ordinary legacy threads without a goalRef", async () => {
    fixture.dispatch = null;
    await runQuestForThread(scope, { threadId: "T-1", goal: "普通明确目标", presetRef: "agt-fixture" });
    expect(fixture.runQuest.mock.calls[0]?.[3].goal).toBe("普通明确目标");
    expect(fixture.events).toHaveLength(0);
  });
});

describe("MC-PM-005 claimed-thread failure receipt", () => {
  it("atomically records a terminal failure when industry planning throws after claim", async () => {
    registerIndustryQuestPlanner(() => { throw new Error("planner fixture exploded"); });
    await expect(runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture" })).rejects.toThrow("planner fixture exploded");
    expect(fixture.status).toBe("failed");
    expect(fixture.events).toHaveLength(1);
    const { context, draft } = fixture.events[0]!;
    expect(context).toMatchObject({ ...scope, sessionId: "T-1", actor: { id: "system", type: "system" } });
    expect(draft).toMatchObject({ object: { type: "thread", id: "T-1" }, decision: { outcome: "error", error: "planner fixture exploded" } });
    expect(fixture.queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("records assembly/runQuest exceptions for a scheduler-owned running thread", async () => {
    fixture.status = "running";
    fixture.runQuest.mockRejectedValueOnce(new Error("assembly fixture rejected"));
    await expect(runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture", skipClaim: true })).rejects.toThrow("assembly fixture rejected");
    expect(fixture.status).toBe("failed");
    expect(fixture.events).toHaveLength(1);
  });

  it("preserves pending-review outcomes and an already committed approval suspension", async () => {
    fixture.status = "pending_review";
    fixture.runQuest.mockImplementationOnce(async () => {
      fixture.status = "pending_review";
      return { threadId: "T-1", status: "pending_review", stepsDone: 0, stepsTotal: 1, unverified: [], pendingApprovalId: "apr-fixture" };
    });
    const outcome = await runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture" });
    expect(outcome).toMatchObject({ status: "pending_review", pendingApprovalId: "apr-fixture" });
    expect(fixture.status).toBe("pending_review");
    expect(fixture.events).toHaveLength(0);
    fixture.runQuest.mockImplementationOnce(async () => { fixture.status = "pending_review"; throw new Error("after suspension fixture"); });
    await expect(runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture" })).rejects.toThrow("after suspension fixture");
    expect(fixture.status).toBe("pending_review");
    expect(fixture.events).toHaveLength(0);
  });

  it("does not override an unclaimed pending review if preparation fails", async () => {
    fixture.status = "pending_review";
    fixture.archive = {};
    await expect(runQuestForThread(scope, { threadId: "T-1", goal: fixture.title, presetRef: "agt-fixture" })).rejects.toThrow("档案");
    expect(fixture.status).toBe("pending_review");
    expect(fixture.events).toHaveLength(0);
  });

  it("does not enter an already running thread or write any failure event", async () => {
    fixture.status = "running";
    const outcome = await runQuestForThread(scope, { threadId: "T-1", goal: fixture.title });
    expect(outcome.status).toBe("running");
    expect(fixture.runQuest).not.toHaveBeenCalled();
    expect(fixture.events).toHaveLength(0);
  });
});


describe("routing vocabulary database recovery", () => {
  it("rolls back an optional vocabulary query failure before releasing its connection", async () => {
    fixture.failIndustryRead = true;
    await runQuestForThread({ ...scope, workspaceId: "vocabulary-failure-isolated" }, { threadId: "T-1", goal: "完成内部文档", presetRef: "agt-fixture" });
    const failed = fixture.queries.findIndex(({ sql }) => /SELECT industry FROM workspaces/.test(sql));
    expect(failed).toBeGreaterThan(-1);
    expect(fixture.queries[failed + 1]?.sql).toBe("ROLLBACK");
    expect(fixture.runQuest).toHaveBeenCalledOnce();
  });
});

it("discards a vocabulary connection if rollback itself fails", async () => {
  fixture.failIndustryRead = true;
  fixture.failRollback = true;
  await runQuestForThread({ ...scope, workspaceId: "vocabulary-rollback-failure-isolated" }, { threadId: "T-1", goal: "完成内部文档", presetRef: "agt-fixture" });
  expect(fixture.release).toHaveBeenLastCalledWith(true);
});

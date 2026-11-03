import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { OpenAiCompatibleProvider, type CompletionDispatchReceipt } from "@workloom/base/model-router";
import { requireIsolatedPgTestConfig } from "../../test-support/isolated-pg.js";
import { PgPmStore, requiresPmUsageReconciliation } from "./store.js";

const run = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

run("PM dispatch admission and late settlement use distinct lease rules", () => {
  const suffix = randomUUID().slice(0, 8);
  const scope = { tenantId: `tenant-pmlease-${suffix}`, workspaceId: `ws-pmlease-${suffix}` };
  let owner: pg.Pool;
  let app: pg.Pool;
  let store: PgPmStore;

  beforeAll(async () => {
    const database = requireIsolatedPgTestConfig();
    owner = new pg.Pool({ connectionString: database.ownerUrl, max: 2 });
    app = new pg.Pool({ connectionString: database.appUrl, max: 2 });
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'PM lease fixture','pro')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'PM lease fixture',$1,'ai-pm','delivery')",
      [scope.workspaceId, scope.tenantId]);
    store = new PgPmStore(app);
  });
  afterAll(async () => { await Promise.allSettled([owner?.end(), app?.end()]); });

  async function claimed(stage: "planner" | "employee", followingTask = false) {
    const leaseOwner = randomUUID();
    const { detail } = await store.create(scope, { goal: "核验模型请求租约和原请求结算", idempotencyKey: randomUUID() },
      "MEM-PM-LEASE-FIXTURE", "fixture-provider", "fixture-policy");
    await store.claimRun(scope, detail.run.id, leaseOwner, false);
    const taskId = stage === "employee" ? "document" : undefined;
    if (taskId) {
      await store.savePlan(scope, detail.run.id, leaseOwner, [{ id: taskId, presetKey: "doc-writer", goal: "写出完整文档",
        dependsOn: [], acceptance: ["文档可验证"], outputRefs: ["document.md"] }, ...(followingTask ? [{ id: "followup", presetKey: "doc-writer",
        goal: "核验文档后续交付", dependsOn: [taskId], acceptance: ["后续文档可验证"], outputRefs: ["followup.md"] }] : [])],
      { modelId: "fixture-provider", promptTokens: 0, completionTokens: 0, source: "explicit-employee" });
      await store.claimTask(scope, detail.run.id, taskId, leaseOwner);
    }
    return { id: detail.run.id, leaseOwner, taskId };
  }
  async function stop(id: string, state: "expired" | "cancelled") {
    if (state === "cancelled") await store.cancel(scope, id, "MEM-PM-LEASE-FIXTURE");
    else await owner.query("UPDATE pm_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
  }

  for (const stage of ["planner", "employee"] as const) for (const state of ["expired", "cancelled"] as const) {
    it(`${stage}: ${state} lease forbids a new physical request before network I/O`, async () => {
      const { id, leaseOwner, taskId } = await claimed(stage);
      await stop(id, state);
      const request = vi.fn(async () => Response.json({ id: "unexpected", model: "fixture-provider",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "unexpected response" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
      const provider = new OpenAiCompatibleProvider("fixture-provider", { baseUrl: "https://synthetic.invalid", fetch: request });
      await expect(provider.complete([{ role: "user", content: "Should not send after lease expiry/cancellation" }], {
        beforeDispatch: (receipt) => store.recordModelAttempt(scope, id, leaseOwner, taskId, receipt),
      })).rejects.toMatchObject({ code: "RUN_LEASE_LOST", dispatchState: "blocked-before-send" });
      expect(request).not.toHaveBeenCalled();
      const detail = await store.detail(scope, id);
      const receipts = taskId ? detail.tasks[0]!.attemptReceipts : detail.run.planningReceipts;
      expect(receipts.filter((row) => row.kind === "model-attempt")).toHaveLength(0);
    });

    it(`${stage}: ${state} lease still accepts the original sent request's late accounting receipt`, async () => {
      const { id, leaseOwner, taskId } = await claimed(stage);
      const pending: CompletionDispatchReceipt = { attemptId: randomUUID(), model: "fixture-provider",
        dispatchState: "possibly-sent", usageComplete: false, requestSha256: "a".repeat(64) };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, pending);
      await stop(id, state);
      expect(requiresPmUsageReconciliation(await store.detail(scope, id))).toBe(true);
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, { ...pending, dispatchState: "sent-usage-known", usageComplete: true });
      const detail = await store.detail(scope, id);
      expect(requiresPmUsageReconciliation(detail)).toBe(false);
      if (state === "cancelled") expect(detail.run.status).toBe("cancelled");
      const receipts = taskId ? detail.tasks[0]!.attemptReceipts : detail.run.planningReceipts;
      expect(receipts.filter((row) => row.kind === "model-attempt")).toHaveLength(2);
    });
  }

  for (const stage of ["planner", "employee"] as const) {
    for (const terminalBeforeRecovery of [false, true]) it(`${stage}: recovery ${terminalBeforeRecovery ? "after" : "before"} the terminal receipt keeps only accounting authority until usage is settled`, async () => {
      const { id, leaseOwner, taskId } = await claimed(stage);
      let dispatched!: () => void, respond!: () => void;
      const sent = new Promise<void>((resolve) => { dispatched = resolve; });
      const released = new Promise<void>((resolve) => { respond = resolve; });
      const physical = new OpenAiCompatibleProvider("fixture-provider", { baseUrl: "https://synthetic.invalid", fetch: async () => {
        dispatched(); await released;
        return Response.json({ id: "fixture-late-paid", model: "fixture-provider",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "fixture paid content" } }],
          usage: { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 } });
      } });
      const response = physical.complete([{ role: "user", content: "synthetic late accounting" }], {
        beforeDispatch: (receipt) => store.recordModelAttempt(scope, id, leaseOwner, taskId, receipt),
      });
      await sent;
      let terminal: CompletionDispatchReceipt;
      if (terminalBeforeRecovery) {
        respond(); terminal = (await response).requestReceipt!;
        await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal);
      }
      await stop(id, "expired");
      expect(await store.recoverExpired(scope)).toBeGreaterThanOrEqual(1);
      expect((await store.detail(scope, id)).run.status).toBe("blocked");
      expect(await store.heartbeat(scope, id, leaseOwner)).toBe(false);
      await expect(store.claimRun(scope, id, "fixture-premature-resume", true)).rejects.toMatchObject({ code: "MODEL_USAGE_RECONCILIATION_REQUIRED" });
      if (!terminalBeforeRecovery) {
        respond(); terminal = (await response).requestReceipt!;
        await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal);
      }
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal!);
      const beforeUsage = await store.detail(scope, id);
      expect(beforeUsage.run.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
      expect(requiresPmUsageReconciliation(beforeUsage)).toBe(true);
      await expect(store.finishRun(scope, id, leaseOwner, [])).rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
      if (taskId) await expect(store.completeTask(scope, id, taskId, leaseOwner, {
        files: [], summary: "must not publish", usage: { promptTokens: 17, completionTokens: 9 }, modelId: "fixture-provider",
      }, [], [], "fixture")).rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
      else await expect(store.savePlan(scope, id, leaseOwner, [], { modelId: "fixture-provider", promptTokens: 17, completionTokens: 9, source: "model" }))
        .rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
      const metering = { usage: { promptTokens: 17, completionTokens: 9 }, modelId: "fixture-provider", responseId: "fixture-late-paid",
        receipt: { usageComplete: true, requestReceipt: terminal! } };
      const settlements = await Promise.all([1, 2].map(() => store.failRun(scope, id, leaseOwner, "failed", "FIXTURE_LATE_RESULT", "synthetic late aggregate", taskId, [], metering)));
      expect(settlements.filter(Boolean)).toHaveLength(1);
      expect(await store.failRun(scope, id, leaseOwner, "failed", "FIXTURE_LATE_RESULT", "duplicate synthetic late aggregate", taskId, [], metering)).toBe(false);
      const settled = await store.detail(scope, id);
      expect(settled.run.usage).toEqual(metering.usage);
      expect(settled.run.status).toBe("paused"); expect(settled.run.errorCode).toBe("INTERRUPTED");
      expect(settled.artifacts).toEqual([]); expect(requiresPmUsageReconciliation(settled)).toBe(false);
      if (taskId) { expect(settled.tasks[0]!.usage).toEqual(metering.usage); expect(settled.tasks[0]!.status).toBe("paused"); }
      expect(await store.claimRun(scope, id, "fixture-implicit-resume", false)).toBeNull();
      expect(await store.claimRun(scope, id, "fixture-explicit-new-owner", true)).not.toBeNull();
      await expect(store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal!)).rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
    }, 30_000);

    it(`${stage}: recovered accounting cannot admit new, altered or nonterminal physical receipts`, async () => {
      const { id, leaseOwner, taskId } = await claimed(stage);
      const pending: CompletionDispatchReceipt = { attemptId: randomUUID(), model: "fixture-provider", dispatchState: "possibly-sent",
        usageComplete: false, requestSha256: "b".repeat(64) };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, pending);
      await stop(id, "expired"); await store.recoverExpired(scope);
      const terminal: CompletionDispatchReceipt = { ...pending, dispatchState: "sent-usage-known", usageComplete: true };
      for (const invalid of [pending, { ...terminal, attemptId: randomUUID() }, { ...terminal, model: "different-model" },
        { ...terminal, requestSha256: "c".repeat(64) }, { ...terminal, usageComplete: false }]) {
        await expect(async () => store.recordModelAttempt(scope, id, leaseOwner, taskId, invalid)).rejects.toMatchObject({ code: expect.stringMatching(/RUN_LEASE_LOST|MODEL_RECEIPT_INVALID/) });
      }
      await expect(store.recordModelAttempt(scope, id, "wrong-owner", taskId, terminal)).rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
      expect(await store.failRun(scope, id, "wrong-owner", "failed", "FIXTURE", "wrong owner", taskId, [], {
        usage: { promptTokens: 99, completionTokens: 99 }, modelId: "fixture-provider", receipt: { usageComplete: true, requestReceipt: terminal },
      })).toBe(false);
      expect((await store.detail(scope, id)).run.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal);
      const mutatedTerminal = { ...terminal, extraAccountingClaim: "changed after terminal" };
      await expect(store.recordModelAttempt(scope, id, leaseOwner, taskId, mutatedTerminal)).rejects.toMatchObject({ code: "MODEL_RECEIPT_INVALID" });
      await expect(store.recordModelAttempt(scope, id, leaseOwner, taskId, { ...terminal, dispatchState: "blocked-before-send" })).rejects.toMatchObject({ code: "MODEL_RECEIPT_INVALID" });
      const receipts = taskId ? (await store.detail(scope, id)).tasks[0]!.attemptReceipts : (await store.detail(scope, id)).run.planningReceipts;
      expect(receipts.filter((row) => row.kind === "model-attempt")).toHaveLength(2);
    });

    it(`${stage}: a partial aggregate remains blocked while another admitted request is unknown`, async () => {
      const { id, leaseOwner, taskId } = await claimed(stage);
      const first: CompletionDispatchReceipt = { attemptId: randomUUID(), model: "fixture-provider", dispatchState: "possibly-sent", usageComplete: false, requestSha256: "d".repeat(64) };
      const second: CompletionDispatchReceipt = { ...first, attemptId: randomUUID(), requestSha256: "e".repeat(64) };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, first);
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, { ...first, dispatchState: "sent-usage-known", usageComplete: true });
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, second);
      await stop(id, "expired"); await store.recoverExpired(scope);
      const partial = { usage: { promptTokens: 5, completionTokens: 3 }, modelId: "fixture-provider",
        receipt: { usageComplete: false, modelCalls: 2, requestReceipt: second } };
      expect(await store.failRun(scope, id, leaseOwner, "paused", "RUN_LEASE_LOST", "partial measured usage", taskId, [], partial)).toBe(true);
      await store.failRun(scope, id, leaseOwner, "paused", "RUN_LEASE_LOST", "duplicate partial measured usage", taskId, [], partial);
      await expect(store.failRun(scope, id, leaseOwner, "paused", "RUN_LEASE_LOST", "changed usage without new evidence", taskId, [], {
        ...partial, usage: { promptTokens: 6, completionTokens: 3 },
      })).rejects.toMatchObject({ code: "MODEL_RECEIPT_INVALID" });
      const detail = await store.detail(scope, id);
      expect(detail.run.usage).toEqual(partial.usage); expect(detail.run.status).toBe("blocked");
      expect(requiresPmUsageReconciliation(detail)).toBe(true);
      await expect(store.claimRun(scope, id, "fixture-replay-forbidden", true)).rejects.toMatchObject({ code: "MODEL_USAGE_RECONCILIATION_REQUIRED" });
      const terminal: CompletionDispatchReceipt = { ...second, dispatchState: "sent-usage-known", usageComplete: true };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal);
      expect(requiresPmUsageReconciliation(await store.detail(scope, id))).toBe(true);
      const complete = { usage: { promptTokens: 12, completionTokens: 8 }, modelId: "fixture-provider",
        receipt: { usageComplete: true, modelCalls: 2, requestReceipt: terminal } };
      await expect(store.failRun(scope, id, leaseOwner, "paused", "RUN_LEASE_LOST", "decreased aggregate", taskId, [], {
        ...complete, usage: { promptTokens: 4, completionTokens: 3 },
      })).rejects.toMatchObject({ code: "MODEL_RECEIPT_INVALID" });
      expect(await store.failRun(scope, id, leaseOwner, "paused", "RUN_LEASE_LOST", "full original aggregate", taskId, [], complete)).toBe(true);
      expect(await store.failRun(scope, id, leaseOwner, "paused", "RUN_LEASE_LOST", "duplicate full aggregate", taskId, [], complete)).toBe(false);
      const settled = await store.detail(scope, id);
      expect(settled.run.usage).toEqual(complete.usage); expect(settled.run.status).toBe("paused");
      expect(requiresPmUsageReconciliation(settled)).toBe(false);
      if (taskId) expect(settled.tasks[0]!.usage).toEqual(complete.usage);
      expect(await store.claimRun(scope, id, "fixture-reconciled-new-owner", true)).not.toBeNull();
    });

    it(`${stage}: a differing reported model remains diagnostic while accounting stays bound to the original model`, async () => {
      const { id, leaseOwner, taskId } = await claimed(stage);
      const pending: CompletionDispatchReceipt = { attemptId: randomUUID(), model: "fixture-provider", dispatchState: "possibly-sent",
        usageComplete: false, requestSha256: "f".repeat(64) };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, pending);
      await stop(id, "expired"); await store.recoverExpired(scope);
      const terminal: CompletionDispatchReceipt = { ...pending, dispatchState: "sent-usage-known", usageComplete: true };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal);
      await store.failRun(scope, id, leaseOwner, "failed", "MODEL_IDENTITY_MISMATCH", "provider reported a different model", taskId, [], {
        modelId: "fixture-unexpected-model", usage: { promptTokens: 7, completionTokens: 4 }, receipt: { usageComplete: true, requestReceipt: terminal },
      });
      const detail = await store.detail(scope, id);
      expect(detail.run.usage).toEqual({ promptTokens: 7, completionTokens: 4 });
      const rows = taskId ? detail.tasks[0]!.attemptReceipts : detail.run.planningReceipts;
      const aggregate = rows.find((row) => row.kind === "lease-accounting")!;
      expect(aggregate.modelId).toBe("fixture-provider");
      expect(aggregate.receipt).toMatchObject({ reportedModelId: "fixture-unexpected-model", modelIdentityMismatch: true });
      expect(detail.artifacts).toEqual([]); expect(detail.run.status).toBe("paused");
    });

    it(`${stage}: cancellation during reconciliation preserves the remaining original usage without reviving the run`, async () => {
      const { id, leaseOwner, taskId } = await claimed(stage);
      const first: CompletionDispatchReceipt = { attemptId: randomUUID(), model: "fixture-provider", dispatchState: "possibly-sent", usageComplete: false, requestSha256: "4".repeat(64) };
      const second = { ...first, attemptId: randomUUID(), requestSha256: "5".repeat(64) };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, first);
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, { ...first, dispatchState: "sent-usage-known", usageComplete: true });
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, second);
      await stop(id, "expired"); await store.recoverExpired(scope);
      await store.failRun(scope, id, leaseOwner, "paused", "RUN_LEASE_LOST", "partial before cancellation", taskId, [], {
        modelId: "fixture-provider", usage: { promptTokens: 5, completionTokens: 3 }, receipt: { usageComplete: false, requestReceipt: second },
      });
      await store.cancel(scope, id, "MEM-PM-LEASE-FIXTURE");
      const terminal: CompletionDispatchReceipt = { ...second, dispatchState: "sent-usage-known", usageComplete: true };
      await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal);
      expect(requiresPmUsageReconciliation(await store.detail(scope, id))).toBe(true);
      const final = { modelId: "fixture-provider", usage: { promptTokens: 12, completionTokens: 8 }, receipt: { usageComplete: true, requestReceipt: terminal } };
      expect(await store.failRun(scope, id, leaseOwner, "failed", "LATE_ORIGINAL", "full after cancellation", taskId, [], final)).toBe(true);
      expect(await store.failRun(scope, id, leaseOwner, "failed", "LATE_ORIGINAL", "duplicate after cancellation", taskId, [], final)).toBe(false);
      const detail = await store.detail(scope, id);
      expect(detail.run.status).toBe("cancelled"); expect(detail.run.errorCode).toBe("CANCELLED");
      expect(detail.run.usage).toEqual(final.usage); expect(detail.artifacts).toEqual([]);
      expect(requiresPmUsageReconciliation(detail)).toBe(false);
      if (taskId) { expect(detail.tasks[0]!.usage).toEqual(final.usage); expect(detail.tasks[0]!.status).toBe("cancelled"); }
      expect(await store.claimRun(scope, id, "cancelled-resume-forbidden", true)).toBeNull();
    }, 30_000);
  }

  it("a recovered owner cannot charge an already completed sibling attempt again", async () => {
    const { id, leaseOwner, taskId } = await claimed("employee", true);
    const first: CompletionDispatchReceipt = { attemptId: randomUUID(), model: "fixture-provider", dispatchState: "possibly-sent",
      usageComplete: false, requestSha256: "1".repeat(64) };
    const terminal: CompletionDispatchReceipt = { ...first, dispatchState: "sent-usage-known", usageComplete: true };
    await store.recordModelAttempt(scope, id, leaseOwner, taskId, first);
    await store.recordModelAttempt(scope, id, leaseOwner, taskId, terminal);
    const usage = { promptTokens: 11, completionTokens: 6 };
    await store.completeTask(scope, id, taskId!, leaseOwner, { files: [{ path: "document.md", content: "synthetic fixture" }],
      summary: "synthetic completed sibling", usage, modelId: "fixture-provider", receipt: { usageComplete: true, requestReceipt: terminal } },
    [{ id: randomUUID(), runId: id, taskId: taskId!, path: "document.md", sha256: "2".repeat(64), sizeBytes: 17,
      mediaType: "text/markdown", verifiedAt: new Date().toISOString() }], [], "fixture-only");
    expect(await store.claimTask(scope, id, "followup", leaseOwner)).toBe(true);
    await store.recordModelAttempt(scope, id, leaseOwner, "followup", { ...first, attemptId: randomUUID(), requestSha256: "3".repeat(64) });
    await stop(id, "expired"); await store.recoverExpired(scope);
    expect(await store.failRun(scope, id, leaseOwner, "failed", "DUPLICATE_SIBLING", "completed sibling duplicate", taskId, [], {
      modelId: "fixture-provider", usage, receipt: { usageComplete: true, requestReceipt: terminal },
    })).toBe(false);
    const detail = await store.detail(scope, id);
    expect(detail.run.usage).toEqual(usage); expect(detail.tasks[0]!.status).toBe("completed");
    expect(detail.run.status).toBe("blocked"); expect(detail.artifacts).toHaveLength(1);
  }, 30_000);
});

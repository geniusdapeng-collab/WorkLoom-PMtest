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

  async function claimed(stage: "planner" | "employee") {
    const leaseOwner = randomUUID();
    const { detail } = await store.create(scope, { goal: "核验模型请求租约和原请求结算", idempotencyKey: randomUUID() },
      "MEM-PM-LEASE-FIXTURE", "fixture-provider", "fixture-policy");
    await store.claimRun(scope, detail.run.id, leaseOwner, false);
    const taskId = stage === "employee" ? "document" : undefined;
    if (taskId) {
      await store.savePlan(scope, detail.run.id, leaseOwner, [{ id: taskId, presetKey: "doc-writer", goal: "写出完整文档",
        dependsOn: [], acceptance: ["文档可验证"], outputRefs: ["document.md"] }],
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
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import pg from "pg";
import { OpenAiCompatibleProvider, type CompletionDispatchReceipt } from "@workloom/base/model-router";
import { closeAllPools } from "@workloom/db";
import { requireIsolatedPgTestConfig } from "../../test-support/isolated-pg.js";
import { collectPmSearchEvidence, readPmSearchReservation } from "./search-context.js";
import { PgPmStore, requiresPmUsageReconciliation } from "./store.js";
import { PmError } from "./types.js";

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
  afterAll(async () => { await Promise.allSettled([owner?.end(), app?.end(), closeAllPools()]); });

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

  async function releaseAfterExpiry<T>(id: string, perform: () => Promise<T>): Promise<T> {
    const lock = await owner.connect();
    try {
      const { rows: [expiry] } = await lock.query<{ lease_expires_at: Date }>(
        "UPDATE pm_runs SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE id=$1 RETURNING lease_expires_at", [id],
      );
      await lock.query("BEGIN");
      const { rows: [backend] } = await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid FROM pm_runs WHERE id=$1 FOR UPDATE", [id]);
      const pending = perform();
      void pending.catch(() => undefined); // Attach before waiting for the DB lock to prevent unhandled rejection.
      let waiting = false;
      for (let i = 0; i < 40 && !waiting; i++) {
        waiting = Boolean((await owner.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [backend!.pid])).rowCount);
        if (!waiting) await wait(20);
      }
      expect(waiting).toBe(true);
      expect((await lock.query("SELECT clock_timestamp() < $1 AS active", [expiry!.lease_expires_at])).rows[0]?.active).toBe(true);
      await lock.query("SELECT pg_sleep(GREATEST(0, extract(epoch FROM $1::timestamptz-clock_timestamp())) + 0.05)", [expiry!.lease_expires_at]);
      await lock.query("COMMIT");
      return pending;
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  }

  function controlSearchDeadline() {
    const setTimer = globalThis.setTimeout;
    let fire: (() => void) | undefined;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== 60_000) return setTimer(callback, ms, ...args);
      fire = () => callback(...args);
      return setTimer(() => undefined, ms);
    }) as typeof setTimeout);
    return { fire() { expect(fire).toBeTypeOf("function"); fire!(); }, restore() { timerSpy.mockRestore(); } };
  }

  it("does not admit a model request whose lease expired while waiting for the run lock", async () => {
    const { id, leaseOwner } = await claimed("planner");
    const send = vi.fn(async () => Response.json({ id: "late", model: "fixture-provider",
      choices: [{ finish_reason: "stop", message: { content: "fixture" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    const provider = new OpenAiCompatibleProvider("fixture-provider", { baseUrl: "https://synthetic.invalid", fetch: send });
    await expect(releaseAfterExpiry(id, () => provider.complete([{ role: "user", content: "must not be dispatched" }], {
      beforeDispatch: (receipt) => store.recordModelAttempt(scope, id, leaseOwner, undefined, receipt),
    }))).rejects.toMatchObject({ code: "RUN_LEASE_LOST", dispatchState: "blocked-before-send" });
    expect(send).not.toHaveBeenCalled();
    expect((await store.detail(scope, id)).run.planningReceipts).toEqual([]);
  });

  it("rejects a heartbeat and a planning write if their lease expires while awaiting the run lock", async () => {
    const heartbeat = await claimed("planner");
    await expect(releaseAfterExpiry(heartbeat.id, () => store.heartbeat(scope, heartbeat.id, heartbeat.leaseOwner))).resolves.toBe(false);
    const planning = await claimed("planner");
    await expect(releaseAfterExpiry(planning.id, () => store.savePlan(scope, planning.id, planning.leaseOwner,
      [{ id: "late", presetKey: "doc-writer", goal: "错误时序下不应发布计划", dependsOn: [], acceptance: ["测试"], outputRefs: ["late.md"] }],
      { modelId: "fixture-provider", promptTokens: 0, completionTokens: 0, source: "explicit-employee" })))
      .rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
    expect((await store.detail(scope, planning.id)).tasks).toEqual([]);
  }, 10_000);

  it("leaves no durable search reservation when its lease expires while awaiting the run lock", async () => {
    const { id, leaseOwner } = await claimed("planner");
    vi.stubEnv("PM_MODEL_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("PM_MODEL_API_KEY", "synthetic-fixture");
    vi.stubEnv("PM_SEARCH_USE_LOOPBACK", "1");
    try {
      await expect(releaseAfterExpiry(id, () => collectPmSearchEvidence(scope, id, leaseOwner, "公开资料",
        new AbortController().signal, async () => undefined))).rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
      expect((await owner.query("SELECT 1 FROM pm_superagent_search WHERE run_id=$1", [id])).rowCount).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it("leaves no search reservation after revoked pre-dispatch authorization, then replays only durable evidence", async () => {
    const { id, leaseOwner } = await claimed("planner");
    const calls: string[] = [];
    const sourceUrl = "https://1.1.1.1/fixture-public-research"; // The mocked connector serves all content over loopback.
    const fixture = createServer((request, response) => {
      calls.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/v1/tools/search"
        ? { results: [{ title: "公开证据夹具", url: sourceUrl }] }
        : { title: "公开证据夹具", content: "完整可核验的公开证据夹具。" }));
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("fixture address unavailable");
    vi.stubEnv("PM_MODEL_BASE_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("PM_MODEL_API_KEY", "synthetic-fixture");
    vi.stubEnv("PM_SEARCH_USE_LOOPBACK", "1");
    const signal = new AbortController().signal;
    try {
      let checked = 0;
      await expect(collectPmSearchEvidence(scope, id, leaseOwner, "公开资料", signal, async () => {
        if (++checked === 2) throw new PmError("FIXTURE_AUTHORIZATION_REVOKED", "fixture revoked", 403);
      })).rejects.toMatchObject({ code: "FIXTURE_AUTHORIZATION_REVOKED" });
      expect(calls).toEqual([]);
      expect((await owner.query("SELECT 1 FROM pm_superagent_search WHERE run_id=$1", [id])).rowCount).toBe(0);
      const authorized = async () => undefined;
      const saved = await collectPmSearchEvidence(scope, id, leaseOwner, "公开资料", signal, authorized);
      expect(saved.fetch.url).toBe(sourceUrl);
      expect(await collectPmSearchEvidence(scope, id, leaseOwner, "公开资料", signal, authorized)).toEqual(saved);
      expect(calls).toEqual(["/v1/tools/search", "/v1/tools/fetch"]);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(["caller cancellation", "tool deadline"])("settles only its own never-sent search when %s races an acknowledged COMMIT", async (reason) => {
    const { id, leaseOwner } = await claimed("planner");
    const lock = await owner.connect();
    const blockerKey = randomInt(1, 2 ** 31 - 1);
    const triggerName = `pm_search_commit_${suffix}`;
    const controller = new AbortController();
    const sourceUrl = "https://1.1.1.1/fixture-commit-cancel";
    const transport = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith("/search")
      ? { results: [{ title: "搜索夹具", url: sourceUrl }] } : { title: "搜索夹具", content: "用于回读的隔离夹具正文。" }));
    const deadline = reason === "tool deadline" ? controlSearchDeadline() : undefined;
    vi.stubEnv("PM_MODEL_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("PM_MODEL_API_KEY", "synthetic-fixture");
    vi.stubEnv("PM_SEARCH_USE_LOOPBACK", "1");
    vi.stubGlobal("fetch", transport);
    try {
      await lock.query("SELECT pg_advisory_lock($1)", [blockerKey]);
      const { rows: [backend] } = await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      // Run only for this generated fixture ID and wait only in COMMIT.
      await lock.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(${blockerKey}); RETURN NEW; END; $$;
        CREATE CONSTRAINT TRIGGER ${triggerName} AFTER INSERT ON pm_superagent_search
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.run_id = '${id}') EXECUTE FUNCTION ${triggerName}()`);
      const query = "合成公开证据";
      const authorize = async () => undefined;
      let settled = false;
      const pending = collectPmSearchEvidence(scope, id, leaseOwner, query, controller.signal, authorize).then(
        (result) => { settled = true; return result; }, (error: unknown) => { settled = true; return error; });
      let inCommit = false;
      for (let i = 0; i < 100 && !inCommit; i++) {
        inCommit = Boolean((await owner.query("SELECT 1 FROM pg_stat_activity WHERE query='COMMIT' AND $1=ANY(pg_blocking_pids(pid))",
          [backend!.pid])).rowCount);
        if (!inCommit) await wait(20);
      }
      expect(inCommit).toBe(true);
      const interrupted = new PmError("INTERRUPTED", "fixture cancellation during COMMIT", 409);
      if (reason === "caller cancellation") controller.abort(interrupted);
      else deadline!.fire();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledBeforeCommit = settled;
      await lock.query("SELECT pg_advisory_unlock($1)", [blockerKey]);
      const failure = await pending;
      if (reason === "caller cancellation") expect(failure).toBe(interrupted);
      else { expect(controller.signal.aborted).toBe(false); expect(failure).toMatchObject({ code: "INTERRUPTED", httpStatus: 504 }); }
      expect(settledBeforeCommit).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(await readPmSearchReservation(scope, id)).toBeNull();
      const initial = await owner.query("SELECT attempt_id,blocked_before_send_at,completed_at,evidence FROM pm_superagent_search WHERE run_id=$1", [id]);
      expect(initial.rows).toEqual([{ attempt_id: expect.any(String), blocked_before_send_at: expect.any(Date), completed_at: null, evidence: null }]);

      await store.failRun(scope, id, leaseOwner, "paused", "INTERRUPTED", "fixture stopped");
      const resumedOwner = randomUUID();
      expect(await store.claimRun(scope, id, resumedOwner, true)).not.toBeNull();
      const resumed = await collectPmSearchEvidence(scope, id, resumedOwner, query, new AbortController().signal, authorize);
      expect(resumed.fetch.url).toBe(sourceUrl);
      expect(transport).toHaveBeenCalledTimes(2);
      const rows = await owner.query("SELECT attempt_id,blocked_before_send_at,completed_at,evidence FROM pm_superagent_search WHERE run_id=$1 ORDER BY started_at", [id]);
      expect(rows.rows[0]).toEqual(initial.rows[0]);
      expect(rows.rows[1]).toEqual({ attempt_id: expect.any(String), blocked_before_send_at: null, completed_at: expect.any(Date), evidence: resumed });
      expect(rows.rows[1].attempt_id).not.toBe(initial.rows[0].attempt_id);
    } finally {
      controller.abort();
      await lock.query("SELECT pg_advisory_unlock($1)", [blockerKey]);
      await lock.query(`DROP TRIGGER IF EXISTS ${triggerName} ON pm_superagent_search; DROP FUNCTION IF EXISTS ${triggerName}()`);
      lock.release();
      deadline?.restore();
      vi.unstubAllEnvs(); vi.unstubAllGlobals();
    }
  }, 15_000);

  it("reports a pre-reservation tool deadline as retryable without a reservation or transport", async () => {
    const { id, leaseOwner } = await claimed("planner");
    const deadline = controlSearchDeadline();
    const transport = vi.fn();
    let markChecking!: () => void, releaseCheck!: () => void;
    const checking = new Promise<void>((resolve) => { markChecking = resolve; });
    const released = new Promise<void>((resolve) => { releaseCheck = resolve; });
    vi.stubEnv("PM_MODEL_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("PM_MODEL_API_KEY", "synthetic-fixture");
    vi.stubEnv("PM_SEARCH_USE_LOOPBACK", "1");
    vi.stubGlobal("fetch", transport);
    try {
      let authorizations = 0;
      const outcome = collectPmSearchEvidence(scope, id, leaseOwner, "合成工具超时", new AbortController().signal, async () => {
        if (++authorizations === 2) { markChecking(); await released; }
      }).catch((error: unknown) => error);
      await checking;
      deadline.fire();
      expect(await outcome).toMatchObject({ code: "INTERRUPTED", httpStatus: 504 });
      expect(transport).not.toHaveBeenCalled();
      expect((await owner.query("SELECT 1 FROM pm_superagent_search WHERE run_id=$1", [id])).rowCount).toBe(0);
    } finally { releaseCheck(); deadline.restore(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
  });

  it("preserves a search reservation once transport may have started, including across retry", async () => {
    const { id, leaseOwner } = await claimed("planner");
    const controller = new AbortController();
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => { markSent = resolve; });
    const transport = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      markSent();
      init?.signal?.addEventListener("abort", () => reject(new Error("fixture transport aborted")), { once: true });
    }));
    vi.stubEnv("PM_MODEL_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("PM_MODEL_API_KEY", "synthetic-fixture");
    vi.stubEnv("PM_SEARCH_USE_LOOPBACK", "1");
    vi.stubGlobal("fetch", transport);
    try {
      const query = "未收到回执的合成搜索";
      const authorize = async () => undefined;
      const outcome = collectPmSearchEvidence(scope, id, leaseOwner, query, controller.signal, authorize).catch((error: unknown) => error);
      await sent;
      const interrupted = new PmError("INTERRUPTED", "fixture cancellation after transport start", 409);
      controller.abort(interrupted);
      expect(await outcome).toBe(interrupted);
      expect(await readPmSearchReservation(scope, id)).toEqual({ evidence: null });
      const original = await owner.query("SELECT attempt_id,blocked_before_send_at,completed_at,evidence FROM pm_superagent_search WHERE run_id=$1", [id]);
      expect(original.rows).toEqual([{ attempt_id: expect.any(String), blocked_before_send_at: null, completed_at: null, evidence: null }]);
      await expect(collectPmSearchEvidence(scope, id, leaseOwner, query, new AbortController().signal, authorize))
        .rejects.toMatchObject({ code: "SEARCH_RECEIPT_UNSETTLED" });
      expect(transport).toHaveBeenCalledTimes(1);
      const after = await owner.query("SELECT attempt_id,blocked_before_send_at,completed_at,evidence FROM pm_superagent_search WHERE run_id=$1", [id]);
      expect(after.rows).toEqual(original.rows);
    } finally { controller.abort(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
  });

  it("preserves accounting authority when an explicit worker failure leaves a possibly sent request", async () => {
    const { id, leaseOwner } = await claimed("planner");
    const pending: CompletionDispatchReceipt = { attemptId: randomUUID(), model: "fixture-provider",
      dispatchState: "possibly-sent", usageComplete: false, requestSha256: "c".repeat(64) };
    await store.recordModelAttempt(scope, id, leaseOwner, undefined, pending);
    await store.failRun(scope, id, leaseOwner, "blocked", "MODEL_USAGE_RECONCILIATION_REQUIRED", "fixture uncertain result");
    await expect(store.claimRun(scope, id, "wrong-owner", true)).rejects.toMatchObject({ code: "MODEL_USAGE_RECONCILIATION_REQUIRED" });
    await expect(store.heartbeat(scope, id, leaseOwner)).resolves.toBe(false);
    const terminal = { ...pending, dispatchState: "sent-usage-known" as const, usageComplete: true };
    await expect(store.recordModelAttempt(scope, id, leaseOwner, undefined, terminal)).resolves.toBeUndefined();
    const metering = { modelId: "fixture-provider", usage: { promptTokens: 5, completionTokens: 3 },
      receipt: { usageComplete: true, requestReceipt: terminal } };
    await expect(store.failRun(scope, id, leaseOwner, "failed", "LATE_FIXTURE", "fixture settled usage", undefined, [], metering))
      .resolves.toBe(true);
    expect((await store.detail(scope, id)).run).toMatchObject({ status: "paused", errorCode: "INTERRUPTED", usage: metering.usage });
  });

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

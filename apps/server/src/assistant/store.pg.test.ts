import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { requireIsolatedPgTestConfig } from "../test-support/isolated-pg.js";
import { PgAssistantStore, type AssistantStore } from "./store.js";
import type { AssistantRun, AssistantScope, AssistantSession } from "./types.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const runDb = enabled ? describe : describe.skip;

runDb("assistant budget ledger in isolated PostgreSQL", () => {
  const suffix = randomUUID().slice(0, 8);
  const scope: AssistantScope = {
    tenantId: `tenant-assistant-budget-${suffix}`,
    workspaceId: `ws-assistant-budget-${suffix}`,
    memberNo: "MEM-BUDGET",
  };
  let owner: pg.Pool;
  let app: pg.Pool;
  let store: AssistantStore;
  let session: AssistantSession;
  let run: AssistantRun;

  beforeAll(async () => {
    const database = requireIsolatedPgTestConfig();
    owner = new pg.Pool({ connectionString: database.ownerUrl, max: 2 });
    app = new pg.Pool({ connectionString: database.appUrl, max: 4 });
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'pro')", [scope.tenantId, "Assistant budget test"]);
    await owner.query(
      "INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'Assistant budget test',$1,'ai-pm','delivery')",
      [scope.workspaceId, scope.tenantId],
    );
    store = new PgAssistantStore(app);
    session = await store.createSession(scope, "预算账本回归");
    const turn = await store.createTurn(scope, {
      sessionId: session.id,
      text: "验证任务模式预算预留和结算",
      mode: "task",
      model: "deepseek-flash",
      clientMessageId: `budget-${suffix}`,
      webSearch: false,
    });
    run = turn.run;
  });

  afterAll(async () => {
    await Promise.allSettled([owner?.end(), app?.end()]);
  });

  it("reserves concurrent task calls, blocks a third over-budget task, and settles actual counts", async () => {
    const previous = process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
    process.env.ASSISTANT_DAILY_TOKEN_LIMIT = "1200000";
    try {
      const reservations = await Promise.allSettled([
        store.reserveBudget(scope, run.id, 65 * 8192, 65, 0, "concurrent-1"),
        store.reserveBudget(scope, run.id, 65 * 8192, 65, 0, "concurrent-2"),
        store.reserveBudget(scope, run.id, 65 * 8192, 65, 0, "concurrent-3"),
      ]);
      const admitted = reservations
        .filter((result): result is PromiseFulfilledResult<{ budgetDate: string; reservationId: string }> => result.status === "fulfilled")
        .map((result) => result.value);
      expect(admitted).toHaveLength(2);
      const shanghaiDate = await owner.query<{ budget_date: string }>(
        "SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS budget_date",
      );
      expect(admitted[0]!.budgetDate).toBe(shanghaiDate.rows[0]!.budget_date);
      expect(reservations.filter((result) => result.status === "rejected")).toHaveLength(1);

      await store.settleBudget(scope, {
        runId: run.id, reservationId: admitted[0]!.reservationId,
        budgetDate: admitted[0]!.budgetDate,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        reservedCalls: 65,
        callsUsed: 7,
      });
      await store.settleBudget(scope, {
        runId: run.id, reservationId: admitted[1]!.reservationId,
        budgetDate: admitted[1]!.budgetDate,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        reservedCalls: 65,
        callsUsed: 1,
      });
      const ask = await store.reserveBudget(scope, run.id, 4096, 1, 0, "ask-after-settlement");
      await store.settleBudget(scope, {
        runId: run.id, reservationId: ask.reservationId,
        budgetDate: ask.budgetDate,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        reservedCalls: 1,
        callsUsed: 1,
      });

      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
        const row = await client.query<{
          calls_reserved: number;
          calls_used: number;
          prompt_tokens_used: string;
          completion_tokens_used: string;
        }>(
          `SELECT calls_reserved,calls_used,prompt_tokens_used,completion_tokens_used
             FROM assistant_budgets
            WHERE budget_date=$1 AND tenant_id=$2 AND workspace_id=$3`,
          [admitted[0]!.budgetDate, scope.tenantId, scope.workspaceId],
        );
        expect(row.rows[0]).toMatchObject({ calls_reserved: 0, calls_used: 9 });
        expect(Number(row.rows[0]!.prompt_tokens_used)).toBe(120);
        expect(Number(row.rows[0]!.completion_tokens_used)).toBe(210);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      if (previous === undefined) delete process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
      else process.env.ASSISTANT_DAILY_TOKEN_LIMIT = previous;
    }
  });

  it("enforces a separate daily search budget and settles search calls independently", async () => {
    const previous = process.env.ASSISTANT_DAILY_SEARCH_LIMIT;
    process.env.ASSISTANT_DAILY_SEARCH_LIMIT = "1";
    try {
      const reservations = await Promise.allSettled([
        store.reserveBudget(scope, run.id, 4096, 1, 1, "search-1"),
        store.reserveBudget(scope, run.id, 4096, 1, 1, "search-2"),
      ]);
      const admitted = reservations.find((result): result is PromiseFulfilledResult<{ budgetDate: string; reservationId: string }> =>
        result.status === "fulfilled");
      expect(admitted).toBeDefined();
      expect(reservations.filter((result) => result.status === "rejected")).toHaveLength(1);
      await store.settleBudget(scope, {
        runId: run.id, reservationId: admitted!.value.reservationId,
        budgetDate: admitted!.value.budgetDate,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        reservedCalls: 1,
        callsUsed: 1,
        reservedSearchCalls: 1,
        searchCallsUsed: 1,
      });
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
        const row = await client.query<{
          search_calls_reserved: number;
          search_calls_used: number;
        }>(
          `SELECT search_calls_reserved,search_calls_used
             FROM assistant_budgets
            WHERE budget_date=$1 AND tenant_id=$2 AND workspace_id=$3`,
          [admitted!.value.budgetDate, scope.tenantId, scope.workspaceId],
        );
        expect(row.rows[0]).toMatchObject({ search_calls_reserved: 0, search_calls_used: 1 });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      if (previous === undefined) delete process.env.ASSISTANT_DAILY_SEARCH_LIMIT;
      else process.env.ASSISTANT_DAILY_SEARCH_LIMIT = previous;
    }
  });

  it("does not expose another member's run or event stream in the same workspace", async () => {
    const otherMember = { ...scope, memberNo: "MEM-OTHER" };
    await expect(store.getRun(otherMember, run.id)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(store.getEvents(otherMember, run.id, "0")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  async function isolatedRun(label: string) {
    const key = randomUUID().slice(0, 8);
    const ownScope = { tenantId: `tenant-assistant-${key}`, workspaceId: `ws-assistant-${key}`, memberNo: "MEM-BUDGET" };
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'pro')", [ownScope.tenantId, label]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,$3,$1,'ai-pm','delivery')", [ownScope.workspaceId, ownScope.tenantId, label]);
    const ownSession = await store.createSession(ownScope, label);
    const turn = await store.createTurn(ownScope, { sessionId: ownSession.id, text: label, mode: "ask", model: "deepseek-flash", clientMessageId: key, webSearch: false });
    return { scope: ownScope, session: ownSession, run: turn.run };
  }

  async function budgetRow(ownScope: AssistantScope, date: string) {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [ownScope.tenantId, ownScope.workspaceId]);
      const result = await client.query("SELECT * FROM assistant_budgets WHERE budget_date=$1 AND tenant_id=$2 AND workspace_id=$3", [date, ownScope.tenantId, ownScope.workspaceId]);
      await client.query("ROLLBACK");
      return result.rows[0]!;
    } finally { client.release(); }
  }

  it("reserves caller-supplied hard token bounds rather than multiplying call count by 8192", async () => {
    const f = await isolatedRun("forecast accounting");
    const previous = process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
    process.env.ASSISTANT_DAILY_TOKEN_LIMIT = "10000";
    try {
      const first = await store.reserveBudget(f.scope, f.run.id, 1000, 2, 0, "forecast-a");
      const second = await store.reserveBudget(f.scope, f.run.id, 7000, 1, 0, "forecast-b");
      expect(second.budgetDate).toBe(first.budgetDate);
      await expect(store.reserveBudget(f.scope, f.run.id, 2001, 1, 0, "forecast-c")).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
      await store.settleBudget(f.scope, { ...first, runId: f.run.id, reservedCalls: 2, callsUsed: 1,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } });
      await expect(store.reserveBudget(f.scope, f.run.id, 2800, 1, 0, "forecast-d")).resolves.toMatchObject({ budgetDate: first.budgetDate });
    } finally { if (previous === undefined) delete process.env.ASSISTANT_DAILY_TOKEN_LIMIT; else process.env.ASSISTANT_DAILY_TOKEN_LIMIT = previous; }
  });

  it("unknown usage retains its reservation and freezes future calls instead of settling zero", async () => {
    const f = await isolatedRun("unknown paid outcome");
    const reservation = await store.reserveBudget(f.scope, f.run.id, 5000, 3, 0, "unknown-model");
    await store.settleBudget(f.scope, { ...reservation, runId: f.run.id, reservedCalls: 3, callsUsed: 1 });
    const row = await budgetRow(f.scope, reservation.budgetDate);
    expect(row).toMatchObject({ calls_reserved: 3, calls_used: 0, blocked: true });
    expect(Number(row.prompt_tokens_used)).toBe(0);
    await expect(store.reserveBudget(f.scope, f.run.id, 1, 1, 0, "after-unknown")).rejects.toMatchObject({ code: "BUDGET_FROZEN" });
  });

  it("settlement is idempotent, rejects a foreign run, and never releases another reservation", async () => {
    const f = await isolatedRun("idempotent accounting");
    const reservation = await store.reserveBudget(f.scope, f.run.id, 6000, 1, 0, "same-request");
    const settlement = { ...reservation, runId: f.run.id, reservedCalls: 1, callsUsed: 1,
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 } };
    await store.settleBudget(f.scope, settlement);
    await store.settleBudget(f.scope, settlement);
    const row = await budgetRow(f.scope, reservation.budgetDate);
    expect(row).toMatchObject({ calls_reserved: 0, calls_used: 1 });
    expect(Number(row.prompt_tokens_used) + Number(row.completion_tokens_used)).toBe(300);
    await expect(store.settleBudget(f.scope, { ...settlement, usage: { promptTokens: 100, completionTokens: 201, totalTokens: 301 } })).rejects.toMatchObject({ code: "BUDGET_SETTLEMENT_CONFLICT" });
    await expect(store.reserveBudget({ ...f.scope, memberNo: "OTHER" }, f.run.id, 1)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(store.settleBudget(f.scope, { ...settlement, runId: run.id })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("a search-only reservation uses no model calls or tokens and settles separately", async () => {
    const f = await isolatedRun("search independent accounting");
    const reservation = await store.reserveBudget(f.scope, f.run.id, 0, 0, 1, "search-only");
    await store.settleBudget(f.scope, { ...reservation, runId: f.run.id, reservedCalls: 0, callsUsed: 0, reservedSearchCalls: 1, searchCallsUsed: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    expect(await budgetRow(f.scope, reservation.budgetDate)).toMatchObject({ calls_reserved: 0, calls_used: 0, search_calls_reserved: 0, search_calls_used: 1 });
  });

  it("rejects duplicate reservations and settles actual above its hard hold before freezing the day", async () => {
    const f = await isolatedRun("actual over forecast");
    const previous = process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
    process.env.ASSISTANT_DAILY_TOKEN_LIMIT = "10000";
    try {
      const reservation = await store.reserveBudget(f.scope, f.run.id, 100, 1, 0, "physical-one");
      await expect(store.reserveBudget(f.scope, f.run.id, 100, 1, 0, "physical-one")).rejects.toMatchObject({ code: "BUDGET_RESERVATION_EXISTS" });
      await store.settleBudget(f.scope, { ...reservation, runId: f.run.id, reservedCalls: 1, callsUsed: 1,
        usage: { promptTokens: 200, completionTokens: 1000, totalTokens: 1200 } });
      const row = await budgetRow(f.scope, reservation.budgetDate);
      expect(row).toMatchObject({ calls_reserved: 0, calls_used: 1, blocked: true });
      expect(row.blocked_reason).toMatch(/^QUOTA_BOUND_EXCEEDED:/);
      expect(Number(row.prompt_tokens_used) + Number(row.completion_tokens_used)).toBe(1200);
      await expect(store.reserveBudget(f.scope, f.run.id, 1, 1, 0, "physical-two")).rejects.toMatchObject({ code: "BUDGET_FROZEN" });
      const events = await store.getEvents(f.scope, f.run.id, "0");
      expect(events.find((event) => event.payload.budgetEvent === "settled")?.payload).toMatchObject({ measured: true, hardBoundExceeded: true, usage: { totalTokens: 1200 } });
    } finally { if (previous === undefined) delete process.env.ASSISTANT_DAILY_TOKEN_LIMIT; else process.env.ASSISTANT_DAILY_TOKEN_LIMIT = previous; }
  });

  it("the default two-million-token daily quota admits one full-window hold but rejects a second", async () => {
    const f = await isolatedRun("default hard token quota");
    const previous = process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
    delete process.env.ASSISTANT_DAILY_TOKEN_LIMIT;
    try {
      const first = await store.reserveBudget(f.scope, f.run.id, 1048576, 1, 0, "full-window-one");
      await expect(store.reserveBudget(f.scope, f.run.id, 1048576, 1, 0, "full-window-two")).rejects.toMatchObject({ code: "BUDGET_BLOCKED" });
      expect(await budgetRow(f.scope, first.budgetDate)).toMatchObject({ calls_reserved: 1, calls_used: 0 });
    } finally { if (previous === undefined) delete process.env.ASSISTANT_DAILY_TOKEN_LIMIT; else process.env.ASSISTANT_DAILY_TOKEN_LIMIT = previous; }
  });

  it("invalid usage freezes accounting and never fabricates a measured zero", async () => {
    const f = await isolatedRun("invalid usage");
    const reservation = await store.reserveBudget(f.scope, f.run.id, 5000, 1, 0, "invalid-usage");
    await store.settleBudget(f.scope, { ...reservation, runId: f.run.id, reservedCalls: 1, callsUsed: 1,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 999 } });
    expect(await budgetRow(f.scope, reservation.budgetDate)).toMatchObject({ calls_reserved: 1, calls_used: 0, blocked: true });
    await expect(store.reserveBudget(f.scope, f.run.id, 100, 1, 0, "next-invalid")).rejects.toMatchObject({ code: "BUDGET_FROZEN" });
  });

  it("process recovery keeps unsettled forecasts and freezes paid work instead of blindly retrying", async () => {
    const f = await isolatedRun("crash recovery");
    const reservation = await store.reserveBudget(f.scope, f.run.id, 9000, 2, 0, "interrupted-request");
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [f.scope.tenantId, f.scope.workspaceId]);
      await client.query("UPDATE assistant_runs SET status='running',updated_at=now()-interval '11 minutes' WHERE id=$1", [f.run.id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect(await store.recoverInterrupted(f.scope)).toBe(1);
    expect(await budgetRow(f.scope, reservation.budgetDate)).toMatchObject({ calls_reserved: 2, calls_used: 0, blocked: true });
    await expect(store.reserveBudget(f.scope, f.run.id, 100, 1, 0, "retry-after-crash")).rejects.toMatchObject({ code: "BUDGET_FROZEN" });
    expect((await store.getRun(f.scope, f.run.id)).status).toBe("interrupted");
  });

  it("returns all completed causal history, excluding current/future messages and foreign members", async () => {
    const f = await isolatedRun("complete causal history");
    await store.startRun(f.scope, f.run.id);
    await store.finishRun(f.scope, f.run.id, { text: "answer-0" });
    for (let index = 1; index <= 22; index += 1) {
      const turn = await store.createTurn(f.scope, { sessionId: f.session.id, text: `user-${index}`, mode: "ask", model: "deepseek-flash", clientMessageId: `history-${index}`, webSearch: false });
      await store.startRun(f.scope, turn.run.id); await store.finishRun(f.scope, turn.run.id, { text: `answer-${index}` });
    }
    const target = await store.createTurn(f.scope, { sessionId: f.session.id, text: "target-current", mode: "ask", model: "deepseek-flash", clientMessageId: "target-current", webSearch: false });
    const future = await store.createTurn(f.scope, { sessionId: f.session.id, text: "future-user", mode: "ask", model: "deepseek-flash", clientMessageId: "future-user", webSearch: false });
    await store.startRun(f.scope, future.run.id); await store.finishRun(f.scope, future.run.id, { text: "future-answer" });
    const history = await store.historyForRun(f.scope, target.run.id);
    expect(history).toHaveLength(46);
    expect(history[0]!.parts).toEqual([{ type: "text", text: "complete causal history" }]);
    expect(history.every((message) => BigInt(message.seq) < BigInt(target.userMessage.seq))).toBe(true);
    expect(JSON.stringify(history)).not.toMatch(/future-user|future-answer|target-current/);
    await expect(store.historyForRun({ ...f.scope, memberNo: "OTHER" }, target.run.id)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("persists source-card messages above the removed B-tree expression limit and still finds them", async () => {
    const largeSession = await store.createSession(scope, "large source-card message");
    const needle = `needle-${suffix}-outside-btree`;
    const parts = [
      { type: "text", text: "联网搜索结果", },
      ...Array.from({ length: 5 }, (_, index) => ({
        type: "source",
        title: `Official source ${index + 1}`,
        url: `https://example.org/source-${index + 1}`,
        summary: `${needle} ${"官方资料摘要".repeat(240)}`,
        siteName: "Official source",
        publishedAt: null,
      })),
    ];
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      await client.query(
        `INSERT INTO assistant_messages(
           id,session_id,tenant_id,workspace_id,owner_member_no,role,parts,status,finished_at)
         VALUES($1,$2,$3,$4,$5,'assistant',$6::jsonb,'completed',now())`,
        [
          `am-large-${suffix}`,
          largeSession.id,
          scope.tenantId,
          scope.workspaceId,
          scope.memberNo,
          JSON.stringify(parts),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const matches = await store.listSessions(scope, { query: needle, archived: false, limit: 10 });
    expect(matches.map((item) => item.id)).toContain(largeSession.id);
  });
});

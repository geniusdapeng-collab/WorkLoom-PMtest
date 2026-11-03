import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";
import type { TrpcContext } from "../../trpc/context.js";
import { createPmTeamRouter } from "./router.js";
import type { PmTeamService } from "./service.js";

const base: Identity = { kind: "member", memberId: "member-current", memberNo: "MEM-PM", name: "fixture", role: "owner", plan: "pro", tenantId: "tenant-current", workspaceId: "ws-current" };
function fixture(options: { currentRole?: Identity["role"]; permissions?: Record<string, unknown>; plan?: Identity["plan"] } = {}) {
  const service = {
    status: vi.fn(async () => ({ configured: true, modelId: "fixture-model", employees: [] })),
    list: vi.fn(async () => []), detail: vi.fn(async () => ({ run: { id: "pm-a", status: "created" }, tasks: [], artifacts: [] })),
    create: vi.fn(async () => ({ created: true, detail: { run: { id: "pm-a", status: "created" }, tasks: [], artifacts: [] } })),
    start: vi.fn(async () => ({ run: { id: "pm-a", status: "planning" }, tasks: [], artifacts: [] })),
    cancel: vi.fn(async () => ({ run: { id: "pm-a", status: "cancelled" }, tasks: [], artifacts: [] })),
    receiveEvent: vi.fn(async (_scope, event: { kind: string; eventId: string; threadId: string }) => ({
      eventId: event.eventId, threadId: event.threadId, runId: "pm-a", decision: event.kind === "request" ? "admitted" : "attached", replayed: false,
    })),
    listThreadEvents: vi.fn(async () => [{ eventId: "e-1", threadId: "t-1", excerpt: "safe" }]),
    getThreadEvent: vi.fn(async () => ({ eventId: "e-1", threadId: "t-1", text: "safe full text" })),
    artifact: vi.fn(async () => ({ path: "result.md", content: "safe", sha256: "a".repeat(64), mediaType: "text/markdown" })),
  };
  const authority = vi.fn(async (claim: Identity) => ({ identity: { ...claim, ...base, role: options.currentRole ?? "owner", plan: options.plan ?? "pro", memberNo: claim.memberNo === "GUEST" ? "GUEST" : base.memberNo }, permissions: options.permissions ?? {} }));
  const app = createPmTeamRouter({ service: service as unknown as PmTeamService, auth: {
    context: async (request): Promise<TrpcContext> => {
      const token = request.headers.get("authorization");
      if (!token) return { session: null, identity: null, partnerIdentity: null, headers: request.headers };
      if (token === "Bearer partner") {
        const partner = { kind: "partner", partnerId: "partner-1" } as NonNullable<TrpcContext["partnerIdentity"]>;
        return { session: partner, identity: null, partnerIdentity: partner, headers: request.headers };
      }
      const identity = { ...base, tenantId: "stale-token-tenant", role: "owner" as const, memberNo: token === "Bearer guest" ? "GUEST" : "STALE-NO" };
      return { session: identity, identity, partnerIdentity: null, headers: request.headers };
    }, authority,
  } });
  return { app, service, authority };
}
const headers = { authorization: "Bearer member", "content-type": "application/json" };
afterEach(() => vi.unstubAllEnvs());

describe("MC-PM-002 HTTP当前成员鉴权与输入边界", () => {
  it("路由装配与匿名拒绝不要求预先创建数据库服务", async () => {
    vi.stubEnv("DATABASE_APP_URL", "");
    const app = createPmTeamRouter({ auth: {
      context: async (request) => ({ session: null, identity: null, partnerIdentity: null, headers: request.headers }),
    } });
    expect((await app.request("/status")).status).toBe(401);
  });
  it("拒未认证、伙伴、游客和当前只读角色，旧JWT owner不能保权", async () => {
    const normal = fixture();
    expect((await normal.app.request("/status")).status).toBe(401);
    expect((await normal.app.request("/status", { headers: { authorization: "Bearer partner" } })).status).toBe(403);
    expect((await normal.app.request("/status", { headers: { authorization: "Bearer guest" } })).status).toBe(403);
    const readonly = fixture({ currentRole: "readonly" });
    expect((await readonly.app.request("/status", { headers })).status).toBe(403);
    expect(readonly.service.status).not.toHaveBeenCalled();
  });
  it("读受tasks.read收紧，写同时受task.dispatch与workspace.write以及套餐约束", async () => {
    for (const permissions of [{ deny: ["task.dispatch"] }, { deny: ["workspace.write"] }]) {
      const { app, service } = fixture({ permissions });
      expect((await app.request("/runs", { method: "POST", headers, body: JSON.stringify({ goal: "起草完整PRD", idempotencyKey: "r" }) })).status).toBe(403);
      expect(service.create).not.toHaveBeenCalled();
    }
    expect((await fixture({ permissions: { deny: ["tasks.read"] } }).app.request("/runs", { headers })).status).toBe(403);
    expect((await fixture({ plan: "community" }).app.request("/runs/pm-a/start", { method: "POST", headers })).status).toBe(403);
  });
  it("每次请求实时刷新scope，创建只建档，start异步202", async () => {
    const { app, service, authority } = fixture({ currentRole: "staff" });
    const created = await app.request("/runs", { method: "POST", headers, body: JSON.stringify({ goal: "起草完整PRD", idempotencyKey: "r" }) });
    expect(created.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith({ tenantId: base.tenantId, workspaceId: base.workspaceId }, { goal: "起草完整PRD", idempotencyKey: "r" }, base.memberNo);
    expect(service.start).not.toHaveBeenCalled();
    expect((await app.request("/runs/pm-a/start", { method: "POST", headers })).status).toBe(202);
    expect(authority).toHaveBeenCalledTimes(2);
    expect(service.start).toHaveBeenCalledWith({ tenantId: base.tenantId, workspaceId: base.workspaceId }, "pm-a", false);
  });
  it("拒伪造scope/pathroot、任意check、超大body、遍历path、重复及未知query", async () => {
    const { app, service } = fixture();
    for (const extra of [{ tenantId: "other" }, { workspaceId: "other" }, { pathRoot: "/tmp" }, { checks: [{ type: "shell", path: "x.js" }] }]) {
      expect((await app.request("/runs", { method: "POST", headers, body: JSON.stringify({ goal: "起草完整PRD", idempotencyKey: "r", ...extra }) })).status).toBe(400);
    }
    expect((await app.request("/runs", { method: "POST", headers, body: "x".repeat(262_145) })).status).toBe(413);
    for (const path of ["/runs/pm-a/artifacts?path=..%2Fsecret", "/runs?tenantId=other", "/runs?limit=2&limit=3", "/runs?limit=100"]) {
      expect((await app.request(path, { headers })).status).toBe(400);
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.artifact).not.toHaveBeenCalled();
  });
});

describe("PM 原生事件 HTTP", () => {
  const scope = { tenantId: base.tenantId, workspaceId: base.workspaceId };
  const request = { kind: "request", eventId: "e-1", threadId: "t-1", input: { goal: "起草完整验收说明", searchQuery: "公开资料" } };
  const post = (app: ReturnType<typeof createPmTeamRouter>, body: unknown, sentHeaders = headers) =>
    app.request("/events", { method: "POST", headers: sentHeaders, body: JSON.stringify(body) });

  it("明确接单、追问与重复事件回执遵守各自合同", async () => {
    const { app, service } = fixture();
    const created = await post(app, request);
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({ eventId: "e-1", threadId: "t-1", runId: "pm-a", decision: "admitted", replayed: false });
    expect(service.receiveEvent).toHaveBeenCalledWith(scope, request, base.memberNo);
    const reply = { kind: "followup", eventId: "e-2", threadId: "t-1", text: "补充" };
    expect((await post(app, reply)).status).toBe(201);
    expect(service.receiveEvent).toHaveBeenLastCalledWith(scope, reply, base.memberNo);
    service.receiveEvent.mockResolvedValueOnce({ eventId: "e-1", threadId: "t-1", runId: "pm-a", decision: "admitted", replayed: true });
    expect((await post(app, request)).status).toBe(200);
  });

  it("实时权限先于事件派发，拒绝伪造来源身份、范围和执行选项", async () => {
    const denied = fixture({ permissions: { deny: ["task.dispatch"] } });
    expect((await post(denied.app, request)).status).toBe(403);
    expect(denied.service.receiveEvent).not.toHaveBeenCalled();
    const { app, service } = fixture();
    for (const body of [
      { ...request, actor: "MEM-forged" }, { ...request, workspaceId: "other" }, { ...request, source: "github" },
      { ...request, eventId: "../bad" }, { ...request, input: { ...request.input, idempotencyKey: "forged" } },
      { kind: "followup", eventId: "x", threadId: "t-1", text: " " },
    ]) expect((await post(app, body)).status).toBe(400);
    expect(service.receiveEvent).not.toHaveBeenCalled();
  });

  it("只用认证工作区读取有界列表及指定原文，查询参数不能注入范围", async () => {
    const { app, service } = fixture();
    const list = await app.request("/threads/t-1/events?limit=7", { headers });
    expect(await list.json()).toEqual({ events: [{ eventId: "e-1", threadId: "t-1", excerpt: "safe" }] });
    expect(service.listThreadEvents).toHaveBeenCalledWith(scope, "t-1", 7);
    const full = await app.request("/threads/t-1/events/e-1", { headers });
    expect(await full.json()).toEqual({ event: { eventId: "e-1", threadId: "t-1", text: "safe full text" } });
    expect(service.getThreadEvent).toHaveBeenCalledWith(scope, "t-1", "e-1");
    for (const path of ["/threads/t-1/events?limit=51", "/threads/t-1/events?limit=1&limit=2", "/threads/t-1/events/e-1?workspaceId=other"]) {
      expect((await app.request(path, { headers })).status).toBe(400);
    }
    expect((await app.request("/threads/t-1/events/e-1")).status).toBe(401);
  });
});

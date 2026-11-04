import { Hono } from "hono";
import { z, ZodError } from "zod";
import { createHash } from "node:crypto";
import { hasCapability, type Identity } from "@workloom/base/tenancy";
import { createContext, type TrpcContext } from "../../trpc/context.js";
import { AccessAuthorityError, resolveAuthoritativeClientAccess } from "../../service/access-authority.js";
import { CreatePmRunSchema, safeArtifactPath } from "./contract.js";
import { PmEventId, PmThreadEventSchema } from "./event-contract.js";
import { PmTeamService, type PmTeamServiceOptions } from "./service.js";
import { PmError, type PmScope } from "./types.js";

const RunId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const EmptyMutation = z.object({}).strict();
const MAX_BODY_BYTES = 256 * 1024;
const DEVELOPMENT_PERMISSION = "ai-pm.development.read";
interface Authorized { memberNo: string; scope: PmScope; canDispatch: boolean }

export interface PmAuthDeps {
  context: (request: Request) => Promise<TrpcContext>;
  access: (identity: Identity) => ReturnType<typeof resolveAuthoritativeClientAccess>;
}
export interface PmRouterOptions {
  service?: PmTeamService;
  serviceOptions?: PmTeamServiceOptions;
  /** In-process test dependency injection only; no HTTP request can change authentication. */
  auth?: Partial<PmAuthDeps>;
}

async function readJson(request: Request, emptyAllowed = false): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new PmError("BODY_TOO_LARGE", "请求超过256KiB上限", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new PmError("BODY_TOO_LARGE", "请求超过256KiB上限", 413); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
  }
  if (size === 0 && emptyAllowed) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PmError("INVALID_JSON", "请求必须是合法JSON"); }
}

function allowedQuery(request: Request, keys: string[]): URLSearchParams {
  const query = new URL(request.url).searchParams;
  const seen = new Set<string>();
  for (const key of query.keys()) {
    if (!keys.includes(key) || seen.has(key)) throw new PmError("INVALID_QUERY", "查询包含不支持或重复的参数");
    seen.add(key);
  }
  return query;
}

/** Mount exactly once with app.route('/api/pm', createPmTeamRouter()). */
export function createPmTeamRouter(options: PmRouterOptions = {}) {
  // Product route composition also runs in tools and auth-only tests. Construct the
  // database-backed worker only after a request has passed the member middleware.
  let service = options.service;
  const getService = () => service ??= new PmTeamService(options.serviceOptions);
  const auth: PmAuthDeps = { context: createContext, access: resolveAuthoritativeClientAccess, ...options.auth };
  const app = new Hono<{ Variables: { pm: Authorized } }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    const session = await auth.context(context.req.raw);
    if (!session.session) throw new PmError("UNAUTHENTICATED", "请先以有效成员会话登录", 401);
    if (session.partnerIdentity || !session.identity) throw new PmError("MEMBER_REQUIRED", "AI产品经理交付只允许当前工作区成员操作", 403);
    const access = await auth.access(session.identity);
    const { subject, scope, bundle, navigationPermissions, actionPermissions, plan } = access;
    if (subject.kind !== "member" || !["owner", "manager", "staff"].includes(subject.role)) {
      throw new PmError("MEMBER_WRITE_ROLE_REQUIRED", "游客、伙伴和只读角色不能访问AI产品经理交付任务", 403);
    }
    const development = bundle.configured && bundle.ui.navigation?.slots.find((slot) =>
      slot.capabilityId === "ai-pm.development" && slot.route === "/development" && slot.clients.includes("pc"));
    if (!development || !development.permissions.includes(DEVELOPMENT_PERMISSION)
      || !development.permissions.every((permission) => navigationPermissions.includes(permission))) {
      throw new PmError("PM_DEVELOPMENT_FORBIDDEN", "当前工作区未开放产品交付，或当前成员没有开发场域权限", 403);
    }
    if (!navigationPermissions.includes("tasks.read")) throw new PmError("TASK_READ_FORBIDDEN", "当前成员没有任务读取权限", 403);
    const canDispatch = actionPermissions.includes("task.dispatch")
      && actionPermissions.includes("workspace.write") && hasCapability(plan, "quest");
    if (context.req.method !== "GET" && !canDispatch) {
      throw new PmError("TASK_DISPATCH_FORBIDDEN", "当前成员没有任务派发、工作区写入权限或套餐能力", 403);
    }
    context.set("pm", { memberNo: subject.memberNo, scope, canDispatch });
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof AccessAuthorityError) return context.json({ error: { code: "SESSION_INVALID", message: "当前成员关系或租户已失效，请重新登录" } }, 401);
    if (error instanceof ZodError) return context.json({ error: { code: "INVALID_INPUT", message: "请求字段、长度或验收类型不符合合同", fields: error.issues.map((issue) => issue.path.join(".")) } }, 400);
    if (error instanceof PmError) return context.json({ error: { code: error.code, message: error.message } }, error.httpStatus as 400);
    const ref = createHash("sha256").update(`${error.name}|${error.message}`).digest("hex").slice(0, 8);
    console.error(`[pm-team] 请求失败，ref=${ref}`);
    return context.json({ error: { code: "PM_INTERNAL_ERROR", message: `服务内部错误，未宣称交付成功（ref=${ref}）`, ref } }, 500);
  });

  app.get("/status", async (context) => {
    allowedQuery(context.req.raw, []);
    const { scope, canDispatch } = context.get("pm");
    return context.json({ ...await getService().status(scope), canDispatch });
  });
  app.get("/runs", async (context) => {
    const query = allowedQuery(context.req.raw, ["limit"]);
    const limit = z.coerce.number().int().min(1).max(50).parse(query.get("limit") ?? 20);
    return context.json({ runs: await getService().list(context.get("pm").scope, limit) });
  });
  app.post("/runs", async (context) => {
    allowedQuery(context.req.raw, []);
    const actor = context.get("pm");
    const result = await getService().create(actor.scope, CreatePmRunSchema.parse(await readJson(context.req.raw)), actor.memberNo);
    return context.json(result.detail, result.created ? 201 : 200);
  });
  app.post("/events", async (context) => {
    allowedQuery(context.req.raw, []);
    const actor = context.get("pm");
    const event = PmThreadEventSchema.parse(await readJson(context.req.raw));
    const receipt = await getService().receiveEvent(actor.scope, event, actor.memberNo);
    return context.json(receipt, receipt.replayed ? 200 : event.kind === "request" ? 202 : 201);
  });
  app.get("/threads/:id/events", async (context) => {
    const query = allowedQuery(context.req.raw, ["limit", "runId"]);
    const limit = z.coerce.number().int().min(1).max(50).parse(query.get("limit") ?? 20);
    const runId = RunId.optional().parse(query.get("runId") ?? undefined);
    const events = await getService().listThreadEvents(context.get("pm").scope, PmEventId.parse(context.req.param("id")), limit, runId);
    return context.json({ events });
  });
  app.get("/threads/:id/events/:eventId", async (context) => {
    allowedQuery(context.req.raw, []);
    const event = await getService().getThreadEvent(context.get("pm").scope,
      PmEventId.parse(context.req.param("id")), PmEventId.parse(context.req.param("eventId")));
    return context.json({ event });
  });
  app.get("/runs/:id", async (context) => {
    allowedQuery(context.req.raw, []);
    const service = getService();
    const { scope } = context.get("pm");
    const detail = await service.detail(scope, RunId.parse(context.req.param("id")));
    return context.json({ ...detail, resumeBlock: await service.resumeBlock(scope, detail) });
  });
  app.get("/runs/:id/search-evidence", async (context) => {
    allowedQuery(context.req.raw, []);
    return context.json(await getService().searchEvidence(context.get("pm").scope, RunId.parse(context.req.param("id"))));
  });
  app.get("/runs/:id/artifacts", async (context) => {
    const query = allowedQuery(context.req.raw, ["path"]);
    const path = safeArtifactPath(z.string().min(1).max(220).parse(query.get("path")));
    return context.json(await getService().artifact(context.get("pm").scope, RunId.parse(context.req.param("id")), path));
  });
  for (const action of ["start", "resume", "cancel"] as const) {
    app.post(`/runs/:id/${action}`, async (context) => {
      allowedQuery(context.req.raw, []);
      EmptyMutation.parse(await readJson(context.req.raw, true));
      const actor = context.get("pm");
      const id = RunId.parse(context.req.param("id"));
      const result = action === "cancel" ? await getService().cancel(actor.scope, id, actor.memberNo)
        : await getService().start(actor.scope, id, action === "resume");
      return context.json(result, action === "cancel" ? 200 : 202);
    });
  }
  return app;
}

export { PmTeamService } from "./service.js";
export type { PmRunDetail, PmRun, PmTask, PmArtifact, EmployeeExecutor } from "./types.js";

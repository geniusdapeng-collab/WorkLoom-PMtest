/**
 * Loopback-only bridge used by the WorkLoom PM DSH client.
 *
 * The desktop launcher creates one random capability for the lifetime of the
 * local runtime. The DSH host plugin reads that capability from its process
 * environment; it is never sent to a model, written to the session log, or
 * exposed to the browser.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z, ZodError } from "zod";
import { getOwnerPool } from "@workloom/db";
import { hasCapability, type Identity } from "@workloom/base/tenancy";
import { resolveAuthoritativeClientAccess } from "../../service/access-authority.js";
import { CreatePmRunSchema, safeArtifactPath } from "./contract.js";
import { PmTeamService } from "./service.js";
import { PmError, type PmScope } from "./types.js";

const RunId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u);
const MAX_BODY_BYTES = 256 * 1024;
const BRIDGE_HEADER = "x-workloom-pm-bridge";
const DEVELOPMENT_PERMISSION = "ai-pm.development.read";

type PmBridgeService = Pick<PmTeamService,
  "status" | "list" | "create" | "detail" | "artifact" | "start" | "cancel" | "resumeBlock">;

interface BridgeAuthority {
  scope: PmScope;
  memberNo: string;
  canDispatch: boolean;
}

export interface PmDesktopBridgeOptions {
  token?: string;
  workspaceSlug?: string;
  memberNo?: string;
  service?: PmBridgeService;
  serviceOptions?: ConstructorParameters<typeof PmTeamService>[0];
  /** In-process test seam. HTTP callers can never replace this resolver. */
  resolveAuthority?: () => Promise<BridgeAuthority>;
}

function validToken(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{32,200}$/u.test(value)) {
    throw new PmError("BRIDGE_CONFIG", "桌面 PM 桥接能力必须是 32 至 200 位 URL-safe 随机串", 503);
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: Request, emptyAllowed = false): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PmError("BODY_TOO_LARGE", "请求超过 256 KiB 上限", 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new PmError("BODY_TOO_LARGE", "请求超过 256 KiB 上限", 413);
  }
  if (!text.trim() && emptyAllowed) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PmError("INVALID_JSON", "请求必须是合法 JSON");
  }
}

async function productWorkspaceSlug(explicit: string | undefined): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const manifestPath = process.env.WORKLOOM_PRODUCT_MANIFEST;
  if (!manifestPath) throw new PmError("WORKSPACE_NOT_CONFIGURED", "桌面 PM 桥接缺少产品清单路径", 503);
  try {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { demoWorkspaceSlug?: unknown };
    if (typeof manifest.demoWorkspaceSlug !== "string" || !manifest.demoWorkspaceSlug) {
      throw new Error("demoWorkspaceSlug missing");
    }
    return manifest.demoWorkspaceSlug;
  } catch (error) {
    throw new PmError("WORKSPACE_NOT_CONFIGURED", "无法从产品清单确定桌面工作区", 503);
  }
}

async function defaultAuthority(workspaceSlug: string | undefined, memberNo: string | undefined): Promise<BridgeAuthority> {
  const slug = await productWorkspaceSlug(workspaceSlug);
  const member = (memberNo ?? "MEM-001").trim();
  const result = await getOwnerPool().query<{
    workspace_id: string;
    tenant_id: string;
    member_id: string;
    member_no: string;
    name: string;
    role: Identity["role"];
    permissions: Record<string, unknown>;
    plan: Identity["plan"];
  }>(`
    SELECT w.id AS workspace_id, w.tenant_id, m.id AS member_id, m.member_no, m.name,
           m.role, m.permissions, t.plan
      FROM workspaces w
      JOIN members m ON m.workspace_id = w.id AND m.status = 'active'
      JOIN tenants t ON t.id = w.tenant_id
     WHERE w.slug = $1 AND m.member_no = $2
     LIMIT 1
  `, [slug, member]);
  const row = result.rows[0];
  if (!row) throw new PmError("DESKTOP_SESSION_NOT_READY", "示例工作区或桌面成员尚未装配完成", 503);

  const identity: Identity = {
    memberId: row.member_id,
    memberNo: row.member_no,
    name: row.name,
    role: row.role,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    plan: row.plan,
  };
  const access = await resolveAuthoritativeClientAccess(identity);
  const development = access.bundle.configured
    ? access.bundle.ui.navigation?.slots.find((slot) =>
      slot.capabilityId === "ai-pm.development"
      && slot.route === "/development"
      && slot.clients.includes("pc"))
    : undefined;
  if (!development
    || !development.permissions.includes(DEVELOPMENT_PERMISSION)
    || !development.permissions.every((permission) => access.navigationPermissions.includes(permission))
    || !access.navigationPermissions.includes("tasks.read")) {
    throw new PmError("PM_DEVELOPMENT_FORBIDDEN", "当前工作区未开放 PM 交付能力", 403);
  }
  const canDispatch = access.actionPermissions.includes("task.dispatch")
    && access.actionPermissions.includes("workspace.write")
    && hasCapability(identity.plan, "quest");
  return {
    scope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
    memberNo: identity.memberNo,
    canDispatch,
  };
}

/**
 * Create the authenticated loopback route mounted at `/api/pm-dsh`.
 * The route is inert unless the launcher supplies a valid per-process token.
 */
export function createPmDesktopBridgeRouter(options: PmDesktopBridgeOptions = {}) {
  const token = validToken(options.token ?? process.env.PM_DSH_BRIDGE_TOKEN);
  const configuredHost = process.env.SERVER_HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(configuredHost)) {
    throw new PmError("BRIDGE_BIND", "桌面 PM 桥接仅允许绑定回环地址", 503);
  }

  let service = options.service;
  const getService = (): PmBridgeService => service ??= new PmTeamService(options.serviceOptions);
  const resolveAuthority = options.resolveAuthority
    ?? (() => defaultAuthority(options.workspaceSlug, options.memberNo));
  const app = new Hono<{ Variables: { bridge: BridgeAuthority } }>();

  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    if (!tokenMatches(context.req.header(BRIDGE_HEADER), token)) {
      return context.json({ error: { code: "BRIDGE_UNAUTHORIZED", message: "桌面桥接能力无效" } }, 401);
    }
    try {
      context.set("bridge", await resolveAuthority());
      await next();
    } catch (error) {
      if (error instanceof PmError) {
        return context.json({ error: { code: error.code, message: error.message } }, error.httpStatus as 400);
      }
      throw error;
    }
  });

  app.onError((error, context) => {
    if (error instanceof ZodError) {
      return context.json({
        error: {
          code: "INVALID_INPUT",
          message: "请求字段不符合 PM 合同",
          fields: error.issues.map((issue) => issue.path.join(".")),
        },
      }, 400);
    }
    if (error instanceof PmError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.httpStatus as 400);
    }
    const ref = randomUUID().slice(0, 8);
    console.error(`[pm-dsh] request failed ref=${ref}`);
    return context.json({
      error: { code: "BRIDGE_INTERNAL_ERROR", message: `桌面桥接请求失败，未宣称成功（ref=${ref}）`, ref },
    }, 500);
  });

  app.get("/status", async (context) => {
    const bridge = context.get("bridge");
    return context.json({ ...await getService().status(bridge.scope), canDispatch: bridge.canDispatch });
  });

  app.get("/runs", async (context) => {
    const limit = z.coerce.number().int().min(1).max(50).parse(context.req.query("limit") ?? 20);
    return context.json({ runs: await getService().list(context.get("bridge").scope, limit) });
  });

  app.post("/runs", async (context) => {
    const bridge = context.get("bridge");
    if (!bridge.canDispatch) throw new PmError("TASK_DISPATCH_FORBIDDEN", "当前桌面成员没有任务派发权限", 403);
    const input = CreatePmRunSchema.parse(await readJson(context.req.raw));
    const result = await getService().create(bridge.scope, input, bridge.memberNo);
    return context.json(result.detail, result.created ? 201 : 200);
  });

  app.get("/runs/:id", async (context) => {
    const bridge = context.get("bridge");
    const detail = await getService().detail(bridge.scope, RunId.parse(context.req.param("id")));
    return context.json({ ...detail, resumeBlock: await getService().resumeBlock(bridge.scope, detail) });
  });

  app.get("/runs/:id/artifacts", async (context) => {
    const bridge = context.get("bridge");
    const path = safeArtifactPath(z.string().min(1).max(220).parse(context.req.query("path")));
    return context.json(await getService().artifact(
      bridge.scope,
      RunId.parse(context.req.param("id")),
      path,
    ));
  });

  for (const action of ["start", "resume", "cancel"] as const) {
    app.post(`/runs/:id/${action}`, async (context) => {
      const bridge = context.get("bridge");
      if (!bridge.canDispatch) throw new PmError("TASK_DISPATCH_FORBIDDEN", "当前桌面成员没有任务派发权限", 403);
      z.object({}).strict().parse(await readJson(context.req.raw, true));
      const id = RunId.parse(context.req.param("id"));
      const result = action === "cancel"
        ? await getService().cancel(bridge.scope, id, bridge.memberNo)
        : await getService().start(bridge.scope, id, action === "resume");
      return context.json(result, action === "cancel" ? 200 : 202);
    });
  }

  return app;
}

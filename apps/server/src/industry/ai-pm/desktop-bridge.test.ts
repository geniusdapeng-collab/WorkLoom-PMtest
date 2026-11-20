import { describe, expect, it, vi } from "vitest";
import { createPmDesktopBridgeRouter } from "./desktop-bridge.js";
import { PmError, type PmScope } from "./types.js";

const TOKEN = "a".repeat(43);
const SCOPE: PmScope = { tenantId: "tenant-1", workspaceId: "workspace-1" };

function detail(id = "run-1") {
  return {
    run: {
      id,
      goal: "交付可验证的需求",
      idempotencyKey: "key-1",
      requestedEmployee: null,
      checks: [],
      status: "running",
      modelId: "deepseek-flash",
      planVersion: 1,
      createdBy: "MEM-001",
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
      error: null,
      errorCode: null,
      usage: { promptTokens: 1, completionTokens: 1 },
      planningReceipt: null,
      policyVersion: "fixture",
      verification: null,
      planningReceipts: [],
    },
    tasks: [],
    artifacts: [],
  } as const;
}

function fixture(options: { canDispatch?: boolean } = {}) {
  const calls: string[] = [];
  const service = {
    status: vi.fn(async () => ({ configured: true, modelId: "deepseek-flash", employees: [] })),
    list: vi.fn(async () => []),
    create: vi.fn(async (_scope: PmScope, input: unknown) => {
      calls.push("create");
      return { detail: detail(), created: true, input };
    }),
    detail: vi.fn(async (_scope: PmScope, id: string) => detail(id)),
    artifact: vi.fn(async (_scope: PmScope, id: string, path: string) => ({
      path, content: "verified", sha256: "b".repeat(64), mediaType: "text/plain", sizeBytes: 8, taskId: id,
    })),
    start: vi.fn(async (_scope: PmScope, id: string) => {
      calls.push("start");
      return detail(id).run;
    }),
    cancel: vi.fn(async (_scope: PmScope, id: string) => {
      calls.push("cancel");
      return { ...detail(id).run, status: "cancelled" };
    }),
    resumeBlock: vi.fn(async () => null),
  };
  const app = createPmDesktopBridgeRouter({
    token: TOKEN,
    service: service as never,
    resolveAuthority: async () => ({ scope: SCOPE, memberNo: "MEM-001", canDispatch: options.canDispatch ?? true }),
  });
  return { app, calls, service };
}

function headers(token = TOKEN): Record<string, string> {
  return { "x-workloom-pm-bridge": token, "content-type": "application/json" };
}

describe("PM desktop DSH bridge", () => {
  it("rejects missing and incorrect launch capabilities before reading PM data", async () => {
    const { app, service } = fixture();
    expect((await app.request("/status")).status).toBe(401);
    expect((await app.request("/status", { headers: headers("b".repeat(43)) })).status).toBe(401);
    expect(service.status).not.toHaveBeenCalled();
  });

  it("returns status with the launch authority dispatch decision", async () => {
    const { app } = fixture({ canDispatch: false });
    const response = await app.request("/status", { headers: headers() });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ configured: true, canDispatch: false });
  });

  it("creates and starts a run only through the authenticated bridge", async () => {
    const { app, calls, service } = fixture();
    const created = await app.request("/runs", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ goal: "交付一个可核验的 PM 产物", idempotencyKey: "dsh-call-1" }),
    });
    expect(created.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      goal: "交付一个可核验的 PM 产物",
      idempotencyKey: "dsh-call-1",
    }), "MEM-001");

    const started = await app.request("/runs/run-1/start", {
      method: "POST", headers: headers(), body: "{}",
    });
    expect(started.status).toBe(202);
    expect(calls).toEqual(["create", "start"]);
  });

  it("fails closed when the desktop member cannot dispatch", async () => {
    const { app, service } = fixture({ canDispatch: false });
    const response = await app.request("/runs", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ goal: "交付一个可核验的 PM 产物", idempotencyKey: "dsh-call-1" }),
    });
    expect(response.status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("preserves PM contract errors and rejects unsafe artifact paths", async () => {
    const { app, service } = fixture();
    service.detail.mockRejectedValueOnce(new PmError("RUN_NOT_FOUND", "任务不存在", 404));
    const missing = await app.request("/runs/run-1", { headers: headers() });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "RUN_NOT_FOUND" } });

    const traversal = await app.request("/runs/run-1/artifacts?path=..%2Fsecret", { headers: headers() });
    expect(traversal.status).toBe(400);
    expect(service.artifact).not.toHaveBeenCalled();
  });
});

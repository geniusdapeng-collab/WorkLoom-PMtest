import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  desktopProvisionAvailable,
  DesktopSetupEmailConflictError,
  DesktopSetupUnavailableError,
  provisionDesktopWorkspace,
} from "./desktop-provision.js";

const SetupInput = z.object({
  displayName: z.string().trim().min(1).max(50),
  tenantName: z.string().trim().min(1).max(100),
  workspaceName: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128),
}).strict();

export function createPmDesktopSetupRouter({
  token = process.env.WORKLOOM_PM_DESKTOP_SETUP_TOKEN,
  nodeEnv = process.env.NODE_ENV,
  available = desktopProvisionAvailable,
  provision = provisionDesktopWorkspace,
} = {}) {
  const app = new Hono();
  const expected = nodeEnv === "production" && token && /^[a-f0-9]{64}$/.test(token)
    ? Buffer.from(`Bearer ${token}`) : null;

  app.use("/setup", async (context, next) => {
    context.header("cache-control", "no-store");
    const presented = Buffer.from(context.req.header("authorization") ?? "");
    if (!expected || presented.length !== expected.length || !timingSafeEqual(presented, expected)
      || new URL(context.req.url).hostname !== "127.0.0.1") {
      return context.json({ error: "NOT_FOUND" }, 404);
    }
    await next();
  });

  app.get("/setup", async (context) => context.json({ available: await available() }));
  app.post("/setup", bodyLimit({ maxSize: 4096, onError: (context) => context.json({ error: "BODY_TOO_LARGE" }, 413) }), async (context) => {
    const input = SetupInput.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "INVALID_INPUT" }, 400);
    try {
      return context.json(await provision(input.data), 201);
    } catch (error) {
      if (error instanceof DesktopSetupEmailConflictError) return context.json({ error: "EMAIL_IN_USE" }, 409);
      if (error instanceof DesktopSetupUnavailableError) return context.json({ error: "SETUP_UNAVAILABLE" }, 409);
      throw error;
    }
  });

  app.onError((_error, context) => {
    console.error("[pm-desktop] 本机工作区开通失败");
    return context.json({ error: "SETUP_FAILED" }, 500);
  });
  return app;
}

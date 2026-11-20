import { describe, expect, it, vi } from "vitest";
import { createPmDesktopSetupRouter } from "./desktop-setup-router.js";
import { DesktopSetupEmailConflictError, DesktopSetupUnavailableError } from "./desktop-provision.js";

const token = "a".repeat(64);
const url = "http://127.0.0.1:9018/setup";
const input = { displayName: " 方宁 ", tenantName: "星河研究", workspaceName: "产品实验室", email: " OWNER@example.test ", password: "sample-password-5" };
const session = { accessToken: "access", refreshToken: "refresh", workspaceSlug: "workspace-new" };
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const post = (data: object) => ({ method: "POST", headers, body: JSON.stringify(data) });

describe("PMtest desktop setup capability", () => {
  it("fails closed for a browser, another host and a non-production process", async () => {
    const available = vi.fn().mockResolvedValue(true);
    const app = createPmDesktopSetupRouter({ token, nodeEnv: "production", available });
    expect((await app.request(url)).status).toBe(404);
    expect((await app.request(url, { headers: { authorization: `Bearer ${"b".repeat(64)}` } })).status).toBe(404);
    expect((await app.request("http://example.test/setup", { headers })).status).toBe(404);
    expect((await createPmDesktopSetupRouter({ token, nodeEnv: "test", available }).request(url, { headers })).status).toBe(404);
    expect(available).not.toHaveBeenCalled();
  });

  it("returns a no-store status, validates fields and returns the formal session after provisioning", async () => {
    const provision = vi.fn().mockResolvedValue(session);
    const app = createPmDesktopSetupRouter({ token, nodeEnv: "production", available: async () => true, provision });
    const status = await app.request(url, { headers });
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({ available: true });
    expect((await app.request(url, post({ ...input, password: "0".repeat(5) }))).status).toBe(400);
    expect((await app.request(url, post({ ...input, role: "owner" }))).status).toBe(400);
    expect((await app.request(url, post({ ...input, password: "x".repeat(5000) }))).status).toBe(413);
    expect(provision).not.toHaveBeenCalled();
    const response = await app.request(url, post(input));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(session);
    expect(provision).toHaveBeenCalledWith({ ...input, displayName: "方宁", email: "owner@example.test" });
  });

  it.each([
    [new DesktopSetupEmailConflictError(), "EMAIL_IN_USE"],
    [new DesktopSetupUnavailableError(), "SETUP_UNAVAILABLE"],
  ] as const)("returns a bounded conflict code", async (error, code) => {
    const app = createPmDesktopSetupRouter({ token, nodeEnv: "production", provision: vi.fn().mockRejectedValue(error) });
    const response = await app.request(url, post(input));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: code });
  });
});

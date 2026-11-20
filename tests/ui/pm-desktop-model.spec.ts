import { expect, test, type Page } from "@playwright/test";

const appUrl = process.env.PM_UI_BASE_URL ?? `http://127.0.0.1:${process.env.WEB_PORT ?? "3100"}`;
const appOrigin = new URL(appUrl).origin;

const access = {
  subject: { kind: "member", id: "fixture-owner", memberNo: "MEM-001", name: "验收管理员", role: "owner" },
  scope: { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" },
  plan: "pro", capabilities: {}, partnerCapabilities: [], availableScopes: [],
  authority: { source: "server", evaluatedAt: "2026-11-20T00:00:00.000Z", grantIds: [] },
  navigationPermissions: ["ai-pm.development.read"], actionPermissions: ["workspace.configure"],
  bundle: { configured: true, bundleId: "ai-pm", bundleName: "产品团队", bundleVersion: "3.0.1", integrityDigest: null,
    ui: { terminology: {}, safeTerms: [], objects: [], workflows: [], home: { widgets: [] }, navigation: { slots: [{
      capabilityId: "ai-pm.development", title: "产品交付", route: "/development", group: "automation", icon: "developer", clients: ["pc"], permissions: ["ai-pm.development.read"],
    }] } } },
};

async function isolateDesktop(page: Page, configured = false, cold = false) {
  let verified = false;
  let statusReads = 0;
  const verifyInputs: unknown[] = [];
  const unexpectedWrites: string[] = [];
  await page.addInitScript(({ coldOwner }) => {
    window.workloomDesktopSetup = {
      status: async () => ({ available: coldOwner }),
      create: async () => { throw new Error("cold owner fixture must never submit"); },
    };
    if (!coldOwner) localStorage.setItem("workloom:workloom-pmtest:b-pc:access-token", "pm-ui-test-session");
  }, { coldOwner: cold });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== appOrigin) return route.abort("blockedbyclient");
    const method = request.method();
    const reply = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (method === "GET") {
      if (url.pathname === "/health") return reply({ ok: true });
      if (url.pathname === "/api/voice/status") return reply({ enabled: false, configured: false });
      if (url.pathname === "/api/pm/status") return reply({ configured, modelId: "deepseek-flash", employees: [], canDispatch: true });
      if (url.pathname === "/api/pm/runs") return reply({ runs: [] });
    }
    if (url.pathname.startsWith("/trpc/")) {
      const names = decodeURIComponent(url.pathname.slice(6)).split(",");
      const payloads = names.map((name) => {
        if (method === "GET" && name === "access.me") return access;
        if (method === "GET" && name === "onboarding.status") {
          statusReads += 1;
          return {
            dataMode: "real", persistedDataMode: "real", formalActivationRecorded: false,
            llm: { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", configured,
              canVerifyConfigured: configured && !verified, real: verified },
            workspace: { name: "验收工作区", events: 0, members: 1, agents: 0, memories: 0 },
            bundle: { id: "ai-pm", isExample: false },
          };
        }
        if (method === "POST" && name === "onboarding.verifyConfiguredLlm") {
          verifyInputs.push(request.postDataJSON());
          verified = true;
          return { ok: true, reply: "连接测试成功", latencyMs: 42 };
        }
        if (method !== "GET") unexpectedWrites.push(name);
        return null;
      });
      const envelopes = payloads.map((data) => ({ result: { data } }));
      return reply(url.searchParams.get("batch") === "1" ? envelopes : envelopes[0]);
    }
    if (method !== "GET" || url.pathname.startsWith("/api/")) {
      if (method !== "GET") unexpectedWrites.push(url.pathname);
      return reply({}, 404);
    }
    return route.continue();
  });
  return { verifyInputs, unexpectedWrites, statusReads: () => statusReads };
}

test("PM 工作台显示连接状态，双侧栏展开时交付区按可用宽度布局", async ({ page }, testInfo) => {
  const fixture = await isolateDesktop(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${appUrl}/development`);
  const driverCard = page.locator(".pm-model-stat");
  await expect(driverCard.getByText("驱动模型", { exact: true })).toBeVisible();
  await expect(driverCard.getByText("尚未配置模型连接")).toBeVisible();
  const link = driverCard.getByRole("link", { name: "配置模型服务" });
  await expect(link).toHaveAttribute("href", "/onboarding?step=model");
  await expect(page.getByRole("button", { name: "交给团队执行" })).toBeDisabled();
  for (const width of [1440, 1200, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width >= 1200) {
      await expect(page.locator(".wl-side-navigation")).toHaveCSS("width", "248px");
      await expect(page.locator(".wl-page-host")).toHaveCSS("padding-right", "320px");
    }
    await expect.poll(() => page.locator(".pm-workspace").evaluate((node) => {
      const region = node.getBoundingClientRect();
      const [compose, progress] = Array.from(node.children, (child) => child.getBoundingClientRect());
      return { clipped: progress.right > region.right + 1 || compose.right > region.right + 1,
        stacked: progress.top > compose.top + 1 };
    })).toEqual({ clipped: false, stacked: width !== 1440 });
    await page.screenshot({ path: testInfo.outputPath(`development-${width}.png`), animations: "disabled" });
  }
  await link.click();
  await expect(page).toHaveURL(/\/onboarding\?step=model$/);
  await expect(page.getByRole("heading", { name: "配置模型服务" })).toBeVisible();
  await expect(page.getByRole("button", { name: "验证已配置连接" })).toHaveCount(0);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test("已存模型连接复用服务端凭据，通过无参数验证刷新状态", async ({ page }, testInfo) => {
  const fixture = await isolateDesktop(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${appUrl}/onboarding?step=model`);
  await expect(page.getByRole("heading", { name: "配置模型服务" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "接入真实大模型" })).toBeVisible();
  await expect(page.getByRole("link", { name: /返回开发场域/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /返回经营主页/ })).toHaveCount(0);
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("deepseek-flash");
  await expect(page.locator('input[type="password"]')).toHaveValue("");
  await page.getByRole("button", { name: "验证已配置连接" }).click();
  await expect(page.getByText("deepseek-flash · 连接已验证", { exact: true })).toBeVisible();
  expect(fixture.verifyInputs).toHaveLength(1);
  // tRPC omits the undefined body or encodes it as a null batch slot.
  expect([null, {}, { 0: null }]).toContainEqual(fixture.verifyInputs[0]);
  expect(fixture.statusReads()).toBeGreaterThanOrEqual(2);
  expect(fixture.unexpectedWrites).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("model-verified-390.png"), animations: "disabled" });
});

test("首启保留模型深链，表单及时展示密码长度要求", async ({ page }, testInfo) => {
  await isolateDesktop(page, false, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${appUrl}/onboarding?step=model`);
  await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("next") === "/onboarding?step=model");
  const password = page.getByLabel(/^密码/);
  await expect(password).toHaveAccessibleDescription("至少 12 个字符。");
  await expect(page.getByText("至少 12 个字符。", { exact: true })).toBeVisible();
  await page.getByLabel("姓名").fill("验收管理员");
  await page.getByLabel("企业名称").fill("验收企业");
  await page.getByLabel("工作区名称").fill("验收工作区");
  await page.getByLabel("邮箱").fill("owner@example.invalid");
  await password.fill("12345678901");
  const submit = page.getByRole("button", { name: "创建工作区" });
  await expect(submit).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("owner-390.png"), animations: "disabled" });
  await password.fill("123456789012");
  await expect(submit).toBeEnabled();
});

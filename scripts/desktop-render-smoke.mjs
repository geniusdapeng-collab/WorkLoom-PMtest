// Release-only driver for the renderer probe inside the packaged Electron application.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadChromium } from "./acceptance/lib/playwright.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const [binaryArg, supportArg, mode] = process.argv.slice(2);
assert.ok(binaryArg && supportArg && ["default", "safe"].includes(mode),
  "用法：node scripts/desktop-render-smoke.mjs <应用主程序> <全新支持目录> <default|safe>");
const binary = resolve(binaryArg);
const support = resolve(supportArg);
const runtime = join(support, "runtime");
const logDir = join(support, "logs");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const expectedProduct = readJson(join(repo, "product.manifest.json"));
assert.ok(existsSync(binary), "找不到待验收的应用主程序");
mkdirSync(support, { mode: 0o700 });
mkdirSync(logDir);

// Hold each ephemeral port until all five have been selected to avoid choosing a port twice.
const reservations = Array.from({ length: 5 }, () => createServer());
let ports;
try {
  await Promise.all(reservations.map((socket) => new Promise((good, bad) => {
    socket.once("error", bad);
    socket.listen(0, "127.0.0.1", good);
  })));
  ports = reservations.map((socket) => socket.address().port);
} finally {
  await Promise.all(reservations.map((socket) => new Promise((done) => socket.close(() => done()))));
}
const [dbPort, serverPort, webPort, natsPort, inspectorPort] = ports;
const server = `http://127.0.0.1:${serverPort}`;
const web = `http://127.0.0.1:${webPort}`;
const inspector = `http://127.0.0.1:${inspectorPort}`;
const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|home|userprofile|appdata|localappdata|systemroot|systemdrive|windir|comspec|pathext|display|lang|lc_.*|tmp|temp|tmpdir)$/iu.test(key)));

// Read the installed database before and after the regular Electron owner-setup flow.
const databaseProbe = `
import pg from 'pg';
const [databaseHelperUrl, expectedDataDirectory, port] = process.argv.slice(1);
const { assertOwnedDatabase } = await import(databaseHelperUrl);
const url = new URL(process.env.DATABASE_URL);
if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || url.port !== port ||
    url.username !== 'postgres' || url.pathname !== '/workloom' || url.search || url.hash) {
  throw new Error('安装库未绑定验收进程的专用回环端口');
}
const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000,
  options: '-c default_transaction_read_only=on' });
await client.connect();
try {
  await assertOwnedDatabase(client, { expectedDataDirectory, port: Number(port) });
  const tables = ['tenants', 'workspaces', 'members', 'accounts', 'agents', 'profiles', 'fence_rules',
    'skills', 'skill_installs', 'kb_collections', 'kb_documents', 'biz_events', 'threads', 'approvals',
    'triggers', 'eval_questions', 'bundle_installs', 'demo_members'];
  const columns = tables.map((table) => \`(SELECT count(*)::int FROM \${table}) AS \${table}\`);
  columns.push('(SELECT count(*)::int FROM workspaces WHERE is_example = true) AS example_workspaces');
  const { rows } = await client.query(\`SELECT \${columns.join(', ')}\`);
  process.stdout.write(JSON.stringify(rows[0]));
} finally {
  await client.end();
}
`;

const executable = process.platform === "win32" ? ["node", "node.exe"] : ["node", "bin", "node"];
const envFile = join(runtime, ".env");
const databaseHelperUrl = pathToFileURL(join(runtime, "scripts", "desktop-bootstrap-db.mjs")).href;

function readDatabaseCounts() {
  try {
    return JSON.parse(execFileSync(join(support, ...executable), [`--env-file=${envFile}`, "--input-type=module", "-e",
      databaseProbe, databaseHelperUrl, join(support, "pgdata"), String(dbPort)], {
      cwd: runtime,
      env: { ...systemEnv, NODE_ENV: "production" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000,
    }));
  } catch {
    throw new Error("无法回读本次安装的独立回环数据库");
  }
}

async function exerciseOwnerSetup(page, tokenKey, productPath) {
  const ownerName = "发行验收所有者";
  for (const [name, value] of [
    ["姓名", ownerName],
    ["企业名称", "发行验收企业"],
    ["工作区名称", "发行验收工作区"],
    ["邮箱", "release-owner@example.invalid"],
    ["密码", `WorkLoom-${randomBytes(20).toString("hex")}`],
  ]) {
    await page.getByLabel(name, { exact: true }).or(page.getByPlaceholder(name, { exact: true })).first().fill(value, { timeout: 8_000 });
  }
  await page.getByRole("button", { name: "创建工作区", exact: true }).click({ timeout: 8_000 });
  try {
    await page.waitForURL((url) => url.origin === web && url.pathname === productPath, { timeout: 16_000 });
  } catch (error) {
    const message = await page.getByRole("alert").first().textContent({ timeout: 1000 }).catch(() => null);
    throw new Error(`创建工作区后未进入 ${productPath}${message ? `：${message.trim()}` : ""}`, { cause: error });
  }
  const access = await page.evaluate(async (key) => {
    const token = localStorage.getItem(key);
    if (!token) return { status: 0 };
    const response = await fetch("/trpc/access.me", { headers: { authorization: `Bearer ${token}` } });
    const { subject, bundle, scope } = (await response.json())?.result?.data ?? {};
    return {
      status: response.status, subject: subject && { kind: subject.kind, role: subject.role, name: subject.name },
      bundleId: bundle?.bundleId ?? null, hasScope: Boolean(scope?.tenantId && scope?.workspaceId),
    };
  }, tokenKey);
  assert.equal(access.status, 200, "完成界面首次设置后未获得真实成员会话");
  assert.deepEqual(access.subject, { kind: "member", role: "owner", name: ownerName });
  assert.equal(access.hasScope, true, "成员会话未绑定新建工作区");
  assert.equal(access.bundleId, expectedProduct.defaultBundle, "工作区未装载正式产品能力");
  await page.getByText("由 AI 产品经理拆解并组队", { exact: true }).waitFor({ state: "attached", timeout: 15_000 });
  await page.locator("textarea").first().waitFor({ timeout: 8000 });
  const provisionedCounts = readDatabaseCounts();
  for (const table of ["tenants", "workspaces", "members", "accounts", "profiles", "bundle_installs"]) {
    assert.equal(provisionedCounts[table], 1, `首次设置后 ${table} 应只有用户亲自创建的一条记录`);
  }
  for (const table of ["example_workspaces", "demo_members", "kb_collections", "kb_documents", "eval_questions", "threads", "approvals", "triggers"]) {
    assert.equal(provisionedCounts[table], 0, `首次设置后 ${table} 存在未经用户创建的业务数据`);
  }
  return { productPath, access, provisionedCounts };
}

const fd = openSync(join(logDir, `render-driver-${mode}.log`), "wx", 0o600);
const child = spawn(binary, [`--remote-debugging-port=${inspectorPort}`, "--remote-debugging-address=127.0.0.1"], {
  env: {
    ...systemEnv,
    WORKLOOM_SUPPORT_DIR: support,
    WORKLOOM_PG_PORT: String(dbPort),
    WORKLOOM_SERVER_PORT: String(serverPort),
    WORKLOOM_WEB_PORT: String(webPort),
    WORKLOOM_NATS_PORT: String(natsPort),
    WORKLOOM_RENDER_SMOKE: "1",
    WORKLOOM_SAFE_RENDERING: mode === "safe" ? "1" : "0",
  },
  stdio: ["ignore", fd, fd],
});
closeSync(fd);
let outcome;
const exited = new Promise((done) => {
  child.once("error", (error) => done(outcome = { code: null, detail: error.message }));
  child.once("exit", (code, signal) => done(outcome = { code, detail: signal ?? String(code) }));
});

async function waitUntil(probe, timeout, failure) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !outcome) {
    const value = await probe();
    if (value) return value;
    await pause(200);
  }
  throw new Error(outcome ? `应用提前退出（${outcome.detail}）：${failure}` : failure);
}

let browser;
try {
  // Cold extraction and synchronous database bootstrap can delay Chromium's inspector.
  await waitUntil(async () => {
    const response = await fetch(`${server}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    return response?.ok && existsSync(join(support, ".bootstrapped"));
  }, 240_000, "打包应用首启未就绪");
  await waitUntil(async () => {
    const response = await fetch(`${inspector}/json/version`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    return response?.ok;
  }, 30_000, "没有启动本地 Electron 渲染探针连接");
  browser = await loadChromium(repo).connectOverCDP(inspector, { timeout: 10_000 });
  const { productId, desktop } = expectedProduct;
  const productPath = desktop.startPath;
  const query = mode === "safe" ? "?render=vector2d" : "";
  const page = await waitUntil(() => browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith(`${web}/`)), 15_000, "应用未进入打包配置的界面");
  await page.waitForURL((url) => url.origin === web && url.pathname === "/login" &&
    url.searchParams.get("next") === productPath && url.searchParams.get("desktop") === "1", { timeout: 8_000 });
  await page.getByRole("heading", { name: `创建 ${expectedProduct.displayName} 工作区`, exact: true }).waitFor({ timeout: 8_000 });
  assert.equal(readJson(join(runtime, "product.manifest.json")).productId, productId, "载荷产品身份不匹配");
  assert.ok(readdirSync(join(runtime, "scripts")).every((name) => !/^seed.*\.[cm]?[jt]s$/u.test(name)), "安装包不得携带示例数据初始化脚本");
  const bundle = readJson(join(runtime, "bundles", expectedProduct.defaultBundle, "bundle.json"));
  assert.equal(bundle.workloom.provides.seeds?.length ?? 0, 0, "正式行业包不得声明模拟经营数据");
  const emptyCounts = readDatabaseCounts();
  assert.ok(Object.keys(emptyCounts).length > 0 && Object.values(emptyCounts).every((count) => count === 0),
    `生产首启写入了测试或示例数据：${JSON.stringify(emptyCounts)}`);

  const anonymous = await fetch(`${server}/trpc/access.me`, { signal: AbortSignal.timeout(5000) });
  assert.equal(anonymous.status, 401, "生产空库不得授予匿名会话成员访问权限");

  const demo = await fetch(`${server}/trpc/auth.loginAs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceSlug: "ai-pm-demo", memberNo: "MEM-001" }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(demo.status, 403, "打包应用必须禁用生产演示登录");
  assert.equal((await demo.json())?.error?.data?.code, "FORBIDDEN", "应由真实登录过程拒绝签发");
  const unauthorizedSetup = await fetch(`${server}/api/pm-desktop/setup`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000),
  });
  assert.equal(unauthorizedSetup.status, 404, "没有安装凭据的进程不能使用 Electron 本地设置入口");

  const firstLaunch = { firstLaunchPath: "/login", nextPath: productPath, emptyCounts, anonymousAccessStatus: anonymous.status,
    demoLoginStatus: demo.status, unauthorizedSetupStatus: unauthorizedSetup.status, isolatedDatabaseVerified: true };
  writeFileSync(join(logDir, `first-launch-${mode}.json`), JSON.stringify(firstLaunch, null, 2) + "\n");
  await page.screenshot({ path: join(logDir, `first-launch-${mode}.png`), timeout: 8000 });
  const tokenKey = `workloom:${productId}:b-pc:access-token`;
  const owner = await exerciseOwnerSetup(page, tokenKey, productPath);
  writeFileSync(join(logDir, `first-owner-${mode}.json`), JSON.stringify(owner, null, 2) + "\n");
  await page.screenshot({ path: join(logDir, `first-owner-workbench-${mode}.png`), timeout: 8000 });
  await page.goto(`${web}/${query}`, { waitUntil: "domcontentloaded", timeout: 8000 });

  // Same BrowserWindow with unchanged renderer flags and built-in welcome, animation and pixel checks.
  const result = await Promise.race([exited, pause(150_000, null, { ref: false })]);
  assert.equal(result?.code, 0, `打包应用内置渲染验收失败（${result?.detail ?? "超时"}），见 render-driver-${mode}.log`);
  const report = readJson(join(logDir, `render-${mode}.json`));
  assert.equal(report.bundle, expectedProduct.defaultBundle, "渲染报告产品 Bundle 不匹配");
  assert.ok(report.avatarTelemetry && report.team?.ready && report.workplace?.ready && report.reportStage?.ready,
    "缺少内置欢迎、团队或工作区舞台渲染结果");
  const receipt = { result: "pass", binary: basename(binary), mode, ...firstLaunch, owner, report: `render-${mode}.json` };
  writeFileSync(join(logDir, `render-driver-${mode}.json`), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  if (browser?.isConnected()) {
    const closeBrowser = async () => {
      if (!outcome) {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send("Browser.close");
      }
      await browser.close();
    };
    // Chromium can close before acknowledging Browser.close. Keep the original failure visible.
    await Promise.race([closeBrowser().catch(() => {}), exited, pause(3000)]);
  }
  if (!outcome) {
    await Promise.race([exited, pause(5000)]);
    if (!outcome) child.kill("SIGTERM");
  }
}

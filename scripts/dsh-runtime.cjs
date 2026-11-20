/**
 * Shared desktop integration for the official DeepSeek Harness client.
 *
 * This module is dependency-free because both the source launcher and the
 * packaged Electron bootstrap use it before the product server starts.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const CLIENT_MODES = new Set(["dsh", "legacy"]);
const DSH_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "DEEPSEEK_API_KEY", "WORKLOOM_DSH_MODEL",
]);

function resolveClientMode(environment = process.env) {
  const mode = environment.WORKLOOM_CLIENT?.trim() || "dsh";
  if (!CLIENT_MODES.has(mode)) {
    throw new Error("WORKLOOM_CLIENT 只允许 dsh 或 legacy");
  }
  return mode;
}

function readProductIdentity(root) {
  const manifestFile = path.join(root, "product.manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch {
    throw new Error("product.manifest.json 无法读取或解析");
  }
  for (const [key, value] of [
    ["productId", manifest.productId],
    ["displayName", manifest.displayName],
    ["defaultBundle", manifest.defaultBundle],
    ["demoWorkspaceSlug", manifest.demoWorkspaceSlug],
    ["demoMemberNo", manifest.demoMemberNo],
  ]) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`product.manifest.json 缺少 ${key}`);
  }
  return {
    productId: manifest.productId,
    displayName: manifest.displayName,
    defaultBundle: manifest.defaultBundle,
    workspaceSlug: manifest.demoWorkspaceSlug,
    memberNo: manifest.demoMemberNo,
  };
}

function createBridgeToken(randomBytes = crypto.randomBytes) {
  const token = randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,200}$/u.test(token)) throw new Error("无法生成有效的 PM 桌面桥接能力");
  return token;
}

function resolvePackageRoot(root, packageName) {
  const requireFromServer = createRequire(path.join(root, "apps", "server", "package.json"));
  try {
    return path.dirname(requireFromServer.resolve(`${packageName}/package.json`));
  } catch (error) {
    throw new Error(`缺少 ${packageName}，请先完成 pnpm install（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function resolveDshCli(root) {
  const packageRoot = resolvePackageRoot(root, "@deepseek-ai/dsh");
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new Error("DeepSeek Harness package.json 无法读取");
  }
  if (packageJson.version !== "0.2.1-rc.2") {
    throw new Error(`DeepSeek Harness 版本必须锁定为 0.2.1-rc.2，实际为 ${packageJson.version ?? "未知"}`);
  }
  const cli = path.join(packageRoot, "lib", "bin.js");
  if (!fs.existsSync(cli)) throw new Error("DeepSeek Harness CLI 入口缺失");
  return { packageRoot, cli, version: packageJson.version };
}

function resolvePluginEntry(root) {
  const packageRoot = path.join(root, "packages", "pm-dsh-client");
  const packageJsonFile = path.join(packageRoot, "package.json");
  const entry = path.join(packageRoot, "lib", "index.js");
  const client = path.join(packageRoot, "lib", "client.js");
  if (!fs.existsSync(packageJsonFile) || !fs.existsSync(entry) || !fs.existsSync(client)) {
    throw new Error("WorkLoom PM DSH 插件载荷不完整");
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(packageJsonFile, "utf8"));
  } catch {
    throw new Error("WorkLoom PM DSH 插件 package.json 无法解析");
  }
  if (manifest.name !== "@workloom/dsh-pm-client" || manifest.dsh?.client?.platform !== "web") {
    throw new Error("WorkLoom PM DSH 插件清单不符合 browser roster 合同");
  }
  return { packageRoot, entry, manifest };
}

function patchText(pluginEntry) {
  return [
    "# Generated for this launch only. It contains no credentials.",
    "- id: ui-brand-official",
    "  disabled: true",
    "",
    // PM dispatch owns execution. The conversation host only needs the PM tools.
    ...["preset-cordis", "preset-minimal", "preset-ptc", "terminal-controller",
      "ui-sidebar-terminal", "ui-agent-preset"].flatMap((id) => [
      `- id: ${id}`, "  disabled: true", "",
    ]),
    "- id: preset-standard",
    "  config:",
    "    id: standard",
    "    order: 1",
    "    plugins:",
    "      - id: persona",
    "        name: '@deepseek-ai/dsh-persona'",
    "        config:",
    "          prefix: 你是 WorkLoom PM 的产品研发入口。",
    "          includeRuntimeContext: false",
    "      - id: tool-ask-user",
    "        name: '@deepseek-ai/dsh-tool-ask-user'",
    "",
    "- id: agent-default-model",
    "  config:",
    "    provider: deepseek-official",
    "    model: !!js process.env.WORKLOOM_DSH_MODEL || 'deepseek-flash'",
    "",
    "- id: web-runtime",
    "  config:",
    "    openBrowser: false",
    "    printUrl: false",
    "    surfaceContext: false",
    "",
    "- insert:",
    "    - id: workloom-pm-client",
    `      name: ${JSON.stringify(pluginEntry)}`,
    "",
  ].join("\n");
}

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function prepareDshRuntime({ root, supportDir }) {
  const product = readProductIdentity(root);
  const dsh = resolveDshCli(root);
  const plugin = resolvePluginEntry(root);
  const stateDir = path.join(supportDir, ".workloom-dsh");
  const dshHome = path.join(stateDir, "home");
  const workspaceDir = path.join(stateDir, "workspace");
  const patchFile = path.join(stateDir, "pmtest.patch.yml");
  fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  atomicWrite(patchFile, patchText(plugin.entry), 0o600);
  return {
    product,
    dshCli: dsh.cli,
    dshVersion: dsh.version,
    pluginEntry: plugin.entry,
    dshHome,
    workspaceDir,
    patchFile,
    stateDir,
  };
}

function dshEnvironment(baseEnvironment, {
  serverPort,
  token,
  dshHome,
}) {
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error("PM serverPort 无效");
  if (!/^[A-Za-z0-9_-]{32,200}$/u.test(token)) throw new Error("PM DSH bridge token 无效");
  const environment = Object.fromEntries(Object.entries(baseEnvironment)
    .filter(([key]) => DSH_ENV_KEYS.has(key.toUpperCase())));
  if (!environment.DEEPSEEK_API_KEY?.trim() && baseEnvironment.LLM_API_KEY?.trim()
    && (!baseEnvironment.LLM_PROVIDER || baseEnvironment.LLM_PROVIDER === "deepseek")) {
    environment.DEEPSEEK_API_KEY = baseEnvironment.LLM_API_KEY;
  }
  return {
    ...environment,
    NODE_ENV: "production",
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    WORKLOOM_PM_API_URL: `http://127.0.0.1:${serverPort}`,
    PM_DSH_BRIDGE_TOKEN: token,
  };
}

function dshArgs({ cli, port, patchFile, open = false }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DSH web port 无效");
  return [
    cli,
    "--patch", patchFile,
    "--profile", "web",
    "--host", "127.0.0.1",
    "--port", String(port),
    ...(open ? [] : ["--no-open"]),
  ];
}

function dshReadyUrl(message, port) {
  if (message?.type !== "workloom:dsh-ready" || typeof message.url !== "string") return null;
  try {
    const url = new URL(message.url);
    if (url.origin !== `http://127.0.0.1:${port}` || url.pathname !== "/" || url.username
      || url.password || url.hash || !/^\?token=[A-Za-z0-9_-]{32,200}$/u.test(url.search)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function waitForDshUrl(child, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onExit);
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message) => {
      cleanup();
      reject(new Error(message));
    };
    const onMessage = (message) => {
      const url = dshReadyUrl(message, port);
      if (!url) return;
      cleanup();
      resolve(url);
    };
    const onExit = () => fail("DeepSeek Harness 在建立桌面会话前退出，详见启动日志");
    const onAbort = () => fail("DeepSeek Harness 启动已取消");
    const timer = setTimeout(() => fail("DeepSeek Harness 未在时限内建立桌面会话，详见启动日志"), timeoutMs);
    child.on("message", onMessage);
    child.once("error", onExit);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

module.exports = {
  resolveClientMode,
  readProductIdentity,
  createBridgeToken,
  resolveDshCli,
  resolvePluginEntry,
  prepareDshRuntime,
  dshEnvironment,
  dshArgs,
  dshReadyUrl,
  waitForDshUrl,
  patchText,
};

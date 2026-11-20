/** Boot an isolated, application-owned profile with the official DSH Desktop context. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const READY_EVENT = "workloom:dsh-ready";
const PROFILE = "desktop";
const PRIVATE_TRANSPORT_PATCH = `- id: web-runtime
  config:
    openBrowser: false
    printUrl: false
    surfaceContext: false
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
`;

function dshReadyUrl(message, port) {
  if (message?.type !== READY_EVENT || message.profile !== PROFILE || typeof message.url !== "string") return null;
  try {
    const url = new URL(message.url);
    const expectedOrigin = port === 0
      ? url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0
      : url.origin === `http://127.0.0.1:${port}`;
    if (!expectedOrigin || url.pathname !== "/" || url.username
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

async function runDesktopHost() {
  if (typeof process.send !== "function") throw new Error("DSH Desktop 宿主需要桌面启动器的 IPC 通道");
  const [cli, projectDir, portText, patchFile] = process.argv.slice(2);
  const port = Number(portText);
  if (![cli, projectDir, patchFile].every((file) => typeof file === "string" && path.isAbsolute(file))
    || !Number.isInteger(port) || port < 0 || port > 65535
    || projectDir !== path.join(process.env.DSH_HOME ?? "", "profiles", PROFILE)) {
    throw new Error("DSH Desktop 宿主未收到有效的本地配置");
  }

  // Upstream Electron initializes a private directory with the Web bundle pair,
  // then passes the reserved Desktop context to the official profile runner.
  const installAnchor = path.join(path.dirname(cli), "..", "package.json");
  const resolve = createRequire(installAnchor);
  const { PROFILE_TEMPLATES, initProfile, loadProfileDirectory } = await import(
    pathToFileURL(resolve.resolve("@deepseek-ai/dsh-app-boot")).href
  );
  const { createLaunchEnvironmentSnapshot } = await import(
    pathToFileURL(resolve.resolve("@deepseek-ai/dsh-launch-environment")).href
  );
  const { runProfile } = await import(pathToFileURL(resolve.resolve("@deepseek-ai/dsh/profile-boot")).href);
  const bundles = PROFILE_TEMPLATES.web.bundles;
  initProfile(projectDir, bundles);
  const profile = loadProfileDirectory("WorkLoom PM", projectDir, installAnchor, { userLayer: false });
  if (profile.skippedBundles.length || profile.layers.map((layer) => layer.packageName).join(",") !== bundles.join(",")) {
    throw new Error("DSH Desktop 宿主的官方组件未完整装配");
  }
  const transportPatch = path.join(projectDir, "workloom-private-transport.patch.yml");
  fs.writeFileSync(transportPatch, PRIVATE_TRANSPORT_PATCH, { mode: 0o600 });
  const running = runProfile({
    environment: createLaunchEnvironmentSnapshot([{ source: "process", values: process.env }]),
    profile: PROFILE,
    resolvedProfile: { profile, installAnchor },
    patchFiles: [patchFile, transportPatch],
    args: ["--no-open", "--host", "127.0.0.1", "--port", String(port)],
  });
  const stop = () => {
    void running.then(({ shutdown }) => shutdown.shutdown(0)).catch(() => { process.exitCode = 1; });
  };
  process.once("disconnect", stop);
  const { ctx } = await running;
  const contextName = ctx.get("profileContext")?.name;
  const boundPort = ctx.webServer.port;
  if (contextName !== PROFILE || !Number.isInteger(boundPort) || boundPort < 1 || (port !== 0 && boundPort !== port)) {
    stop();
    throw new Error("DSH 宿主就绪状态与已声明的 Desktop 配置不符");
  }
  if (process.connected) {
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${boundPort}`);
    process.send({ type: READY_EVENT, profile: contextName, url }, (error) => {
      if (error) stop();
    });
  }
}

if (require.main === module) {
  void runDesktopHost().catch((error) => {
    let message = error instanceof Error ? error.message : "未知错误";
    const proxyKey = process.env.WORKLOOM_DSH_PROXY_KEY;
    if (proxyKey) message = message.replaceAll(proxyKey, "[REDACTED]");
    message = message.replace(/([?&]token=)[^\s&]+/gu, "$1[REDACTED]");
    console.error(`DSH Desktop 宿主启动失败：${message.slice(0, 2048)}`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}

module.exports = { dshReadyUrl, waitForDshUrl };

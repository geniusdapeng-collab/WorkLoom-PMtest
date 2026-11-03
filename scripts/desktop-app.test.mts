import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildElectronEnvironment,
  createSmokeSupportDirectory,
  ElectronExecutableMissingError,
  portBusy,
  resolveElectronExecutable,
  resolveDesktopLaunchConfig,
  resolveSourceWorkspace,
  sourceSupportDirectory,
  validateDesktopModelConfig,
} from "./desktop-app.mts";

function write(path: string, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function electronPackage(pathEntry: string) {
  const root = mkdtempSync(join(tmpdir(), "workloom-electron-path-test-"));
  const packageRoot = join(root, "node_modules/electron");
  const executable = join(packageRoot, "dist", pathEntry);
  write(join(packageRoot, "path.txt"), `${pathEntry}\n`);
  write(executable, "binary");
  chmodSync(executable, 0o755);
  return { root, packageRoot, executable };
}

for (const [platform, pathEntry] of [
  ["macOS", "Electron.app/Contents/MacOS/Electron"],
  ["Windows", "electron.exe"],
  ["Linux", "electron"],
] as const) {
  test(`${platform} 按 Electron 官方 path.txt 解析真实二进制`, () => {
    const fx = electronPackage(pathEntry);
    try {
      assert.equal(resolveElectronExecutable(fx.packageRoot), realpathSync(fx.executable));
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
}

test("缺少 path.txt 或二进制时只报告未下载", () => {
  const fx = electronPackage("electron");
  try {
    rmSync(join(fx.packageRoot, "path.txt"));
    assert.throws(() => resolveElectronExecutable(fx.packageRoot), ElectronExecutableMissingError);
    write(join(fx.packageRoot, "path.txt"), "electron\n");
    rmSync(fx.executable);
    assert.throws(() => resolveElectronExecutable(fx.packageRoot), ElectronExecutableMissingError);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("path.txt 越界、path.txt symlink 与二进制 symlink 均 fail closed", () => {
  const escaped = electronPackage("electron");
  try {
    write(join(escaped.packageRoot, "path.txt"), "../outside\n");
    assert.throws(() => resolveElectronExecutable(escaped.packageRoot), /内容非法|逃逸出 dist/u);
  } finally {
    rmSync(escaped.root, { recursive: true, force: true });
  }

  const linkedManifest = electronPackage("electron");
  try {
    const external = join(linkedManifest.root, "external-path.txt");
    write(external, "electron\n");
    rmSync(join(linkedManifest.packageRoot, "path.txt"));
    symlinkSync(external, join(linkedManifest.packageRoot, "path.txt"));
    assert.throws(() => resolveElectronExecutable(linkedManifest.packageRoot), /path\.txt 必须是普通文件/u);
  } finally {
    rmSync(linkedManifest.root, { recursive: true, force: true });
  }

  const linkedBinary = electronPackage("electron");
  try {
    const external = join(linkedBinary.root, "external-bin");
    write(external, "outside\n");
    rmSync(linkedBinary.executable);
    symlinkSync(external, linkedBinary.executable);
    assert.throws(() => resolveElectronExecutable(linkedBinary.packageRoot), /不允许 symlink/u);
  } finally {
    rmSync(linkedBinary.root, { recursive: true, force: true });
  }
});

test("Node 端口探测识别已有进程且不关闭或杀死它", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = occupied.address();
    assert.ok(address && typeof address === "object");
    assert.equal(await portBusy(address.port), true);
    assert.equal(occupied.listening, true);
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("Node 端口探测在 macOS 无 ss 的环境仍可识别空闲端口", async () => {
  const allocator = createServer();
  await new Promise<void>((resolve, reject) => {
    allocator.once("error", reject);
    allocator.listen(0, "127.0.0.1", resolve);
  });
  const address = allocator.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => allocator.close((error) => error ? reject(error) : resolve()));
  assert.equal(await portBusy(port), false);
});

test("端口探测器自身异常时按占用 fail closed", async () => {
  assert.equal(await portBusy(8787, () => { throw new Error("probe unavailable"); }), true);
  assert.equal(await portBusy(Number.NaN), true);
});

test("Electron 源码环境精确映射端口、源码上下文与隔离 userData", () => {
  const env = buildElectronEnvironment({
    environment: {
      KEEP: "yes",
      WORKLOOM_RESOURCES: "/tmp/stale-packaged-payload",
      WORKLOOM_WEB_URL: "http://wrong:1",
      WORKLOOM_SERVER_URL: "http://wrong:2",
      WORKLOOM_RENDER_SMOKE: "1",
    },
    webPort: 44173,
    serverPort: 48787,
    sourceRoot: "/tmp/source-root",
    sourceNode: "/tmp/source-node",
    supportDir: "/tmp/isolated-user-data",
    smoke: true,
  });
  assert.equal(env.KEEP, "yes");
  assert.equal(env.WEB_PORT, "44173");
  assert.equal(env.SERVER_PORT, "48787");
  assert.equal(env.WORKLOOM_WEB_PORT, "44173");
  assert.equal(env.WORKLOOM_SERVER_PORT, "48787");
  assert.equal(env.WORKLOOM_SOURCE_MODE, "1");
  assert.equal(env.WORKLOOM_SOURCE_ROOT, "/tmp/source-root");
  assert.equal(env.WORKLOOM_SOURCE_NODE, "/tmp/source-node");
  assert.equal(env.WORKLOOM_RESOURCES, undefined);
  assert.equal(env.WORKLOOM_SUPPORT_DIR, "/tmp/isolated-user-data");
  assert.equal(env.WORKLOOM_APP_SMOKE, "1");
  assert.equal(env.WORKLOOM_RENDER_SMOKE, "0");
  assert.equal(env.WORKLOOM_WEB_URL, undefined);
  assert.equal(env.WORKLOOM_SERVER_URL, undefined);
});

test("PMtest 源码客户端从正式产品清单派生名称、隔离目录和默认端口", () => {
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = mkdtempSync(join(tmpdir(), "workloom-pmtest-identity-"));
  try {
    copyFileSync(join(repository, "product.manifest.json"), join(root, "product.manifest.json"));
    const config = resolveDesktopLaunchConfig(root, {});
    assert.equal(config.webPort, 5404);
    assert.equal(config.serverPort, 9018);
    assert.equal(config.environment.WORKLOOM_APP_TITLE, "WorkLoom PMtest");
    assert.equal(basename(config.environment.WORKLOOM_SUPPORT_DIR!), "workloom-pmtest");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function productFixture(envText = "", offset = 200) {
  const root = mkdtempSync(join(tmpdir(), "workloom-product-launch-test-"));
  write(join(root, "package.json"), JSON.stringify({ name: "workloom-example", productName: "Example Product", workloomPortOffset: offset }));
  write(join(root, "product.manifest.json"), JSON.stringify({ schemaVersion: "workloom.product/v1", productId: "workloom-example",
    role: "industry", displayName: "Example Product", repository: "example/product", demoWorkspaceSlug: "example-workspace", demoMemberNo: "MEM-001", desktop: { portOffset: offset } }));
  write(join(root, ".env"), envText);
  return root;
}

test("源码默认server/web端口从产品偏移派生，dev与preview保持同一口径", () => {
  const root = productFixture();
  try {
    const config = resolveDesktopLaunchConfig(root, {});
    assert.equal(config.serverPort, 8987); assert.equal(config.webPort, 5373);
    assert.equal(config.environment.SERVER_PORT, config.environment.WORKLOOM_SERVER_PORT);
    assert.equal(config.environment.WEB_PORT, config.environment.WORKLOOM_WEB_PORT);
    assert.equal(config.environment.WORKLOOM_APP_TITLE, "Example Product");
    assert.equal(basename(config.environment.WORKLOOM_SUPPORT_DIR!), "workloom-example");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("先读取根.env，再由显式进程env及别名覆盖，server/web/Electron值一致", () => {
  const root = productFixture("SERVER_PORT=18001\nWEB_PORT=18002\nLLM_PROVIDER=deepseek\nDEEPSEEK_API_KEY=fake-file-key\n");
  try {
    const fromFile = resolveDesktopLaunchConfig(root, {});
    assert.equal(fromFile.serverPort, 18001); assert.equal(fromFile.webPort, 18002);
    const fromProcess = resolveDesktopLaunchConfig(root, { WORKLOOM_SERVER_PORT: "19001", WEB_PORT: "19002", DEEPSEEK_API_KEY: "fake-process-key" });
    assert.equal(fromProcess.serverPort, 19001); assert.equal(fromProcess.webPort, 19002);
    assert.equal(fromProcess.environment.DEEPSEEK_API_KEY, "fake-process-key");
    const electron = buildElectronEnvironment({ environment: fromProcess.environment, serverPort: fromProcess.serverPort,
      webPort: fromProcess.webPort, sourceRoot: root, sourceNode: process.execPath, smoke: false });
    assert.equal(electron.SERVER_PORT, "19001"); assert.equal(electron.WORKLOOM_SERVER_PORT, "19001");
    assert.equal(electron.WEB_PORT, "19002"); assert.equal(electron.WORKLOOM_WEB_PORT, "19002");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("源码启动路径从产品清单到 Electron 贯通，显式配置优先且拒绝注入", () => {
  const root = productFixture("WORKLOOM_START_PATH=/from-file\n");
  try {
    assert.equal(resolveDesktopLaunchConfig(root, {}).environment.WORKLOOM_START_PATH, "/from-file");
    const config = resolveDesktopLaunchConfig(root, { WORKLOOM_START_PATH: "/development" });
    const electron = buildElectronEnvironment({ environment: config.environment, webPort: config.webPort,
      serverPort: config.serverPort, sourceRoot: root, sourceNode: process.execPath, smoke: false });
    assert.equal(electron.WORKLOOM_START_PATH, "/development");
    for (const startPath of ["https://evil.invalid", "//evil.invalid", "/../admin", "/%2e%2e/admin", "/development?x=1"]) {
      assert.throws(() => resolveDesktopLaunchConfig(root, { WORKLOOM_START_PATH: startPath }), /startPath/);
    }
    write(join(root, ".env"), "");
    assert.equal(resolveDesktopLaunchConfig(root, {}).environment.WORKLOOM_START_PATH, "/");
    rmSync(join(root, "product.manifest.json"));
    write(join(root, "package.json"), JSON.stringify({ name: "workloom-example", workloomStartPath: "/package-default" }));
    assert.equal(resolveDesktopLaunchConfig(root, {}).environment.WORKLOOM_START_PATH, "/package-default");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("显式偏移覆盖产品默认，缺manifest时可用package声明，损坏manifest不降级", () => {
  const root = productFixture();
  try {
    assert.equal(resolveDesktopLaunchConfig(root, { WORKLOOM_PORT_OFFSET: "300" }).serverPort, 9087);
    rmSync(join(root, "product.manifest.json"));
    assert.equal(resolveDesktopLaunchConfig(root, {}).serverPort, 8987);
    write(join(root, "product.manifest.json"), "{broken}");
    assert.throws(() => resolveDesktopLaunchConfig(root, {}), /无法解析/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("非法端口、相同端口和越界偏移在启动前阻断", () => {
  const root = productFixture();
  try {
    for (const environment of [{ SERVER_PORT: "abc" }, { WEB_PORT: "0" }, { SERVER_PORT: "65536" },
      { SERVER_PORT: "19000", WEB_PORT: "19000" }, { WORKLOOM_PORT_OFFSET: "901" }]) {
      assert.throws(() => resolveDesktopLaunchConfig(root, environment), /端口|PORT/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("产品userData按系统目录隔离，明确配置支持目录优先", () => {
  const root = productFixture();
  try {
    assert.equal(sourceSupportDirectory(root, {}, "darwin", "/example-home"), "/example-home/Library/Application Support/workloom-example");
    assert.equal(sourceSupportDirectory(root, { XDG_CONFIG_HOME: "/config" }, "linux", "/example-home"), "/config/workloom-example");
    assert.equal(sourceSupportDirectory(root, { WORKLOOM_SUPPORT_DIR: ".runtime" }, "darwin", "/example-home"), join(root, ".runtime"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("真实DeepSeek缺Key阻断且说明配置入口，显式mock仅是演示", () => {
  assert.throws(() => validateDesktopModelConfig({}), /DEEPSEEK_API_KEY.*不会自动切换/);
  assert.throws(() => validateDesktopModelConfig({ LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: " " }), /尚未配置/);
  assert.doesNotThrow(() => validateDesktopModelConfig({ LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "fake-test-only-key" }));
  assert.doesNotThrow(() => validateDesktopModelConfig({ LLM_PROVIDER: "mock" }));
});

test("冒烟 support/userData 每次唯一且成功或失败收尾都可幂等清理", () => {
  const parent = mkdtempSync(join(tmpdir(), "workloom-smoke-support-test-"));
  try {
    const first = createSmokeSupportDirectory(parent);
    const second = createSmokeSupportDirectory(parent);
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.supportDir, second.supportDir);
    write(join(first.supportDir, "success.txt"), "temporary\n");
    write(join(second.supportDir, "failure.txt"), "temporary\n");
    first.cleanup();
    first.cleanup();
    second.cleanup();
    second.cleanup();
    assert.equal(existsSync(first.root), false);
    assert.equal(existsSync(second.root), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("干净源码工作区无需 dist-payload 即可解析启动入口", () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-clean-source-test-"));
  try {
    write(join(root, "package.json"), "{}\n");
    write(join(root, "apps/server/src/index.ts"), "export {};\n");
    write(join(root, "apps/web/package.json"), "{}\n");
    write(join(root, "apps/desktop/electron/main.cjs"), "'use strict';\n");
    assert.equal(existsSync(join(root, "dist-payload")), false);
    assert.equal(existsSync(join(root, "dist-payload.tar.gz")), false);
    assert.equal(resolveSourceWorkspace(root), realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bundledNpmCliCandidates,
  copyReviewedRuntimeLock,
  runtimeInputSha256,
  verifyInstalledRuntimeTarget,
  verifyRuntimeDepsLock,
  verifyRuntimePackageLock,
} from "./runtime-deps-lock.mjs";
import { loadProductRuntime } from "./product-runtime.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function registryEntry(version, extra = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, Number(version[0]) || 1).toString("base64")}`,
    ...extra,
  };
}

function manifest() {
  return {
    name: "workloom-runtime-payload",
    private: true,
    version: "0.0.0",
    dependencies: { esbuild: "0.28.2" },
  };
}

function packageLock() {
  return {
    name: "workloom-runtime-payload",
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "workloom-runtime-payload", version: "0.0.0", dependencies: { esbuild: "0.28.2" } },
      "node_modules/esbuild": registryEntry("0.28.2"),
      "node_modules/@esbuild/darwin-arm64": registryEntry("0.28.2", { os: ["darwin"], cpu: ["arm64"] }),
      "node_modules/@esbuild/darwin-x64": registryEntry("0.28.2", { os: ["darwin"], cpu: ["x64"] }),
      "node_modules/@esbuild/win32-x64": registryEntry("0.28.2", { os: ["win32"], cpu: ["x64"] }),
    },
  };
}

function writePackage(root, path, value) {
  const directory = join(root, "node_modules", ...path.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(value)}\n`);
}

test("运行依赖锁输入摘要忽略 Git 工作树 LF/CRLF 差异", () => {
  const lf = "lockfileVersion: '9.0'\nimporters:\n";
  assert.equal(runtimeInputSha256(lf), runtimeInputSha256(lf.replaceAll("\n", "\r\n")));
  assert.notEqual(runtimeInputSha256(lf), runtimeInputSha256(lf.replace("\n", "\r")));
});

test("正式装配跨平台直接调用 Node 随附 npm CLI", () => {
  assert.ok(bundledNpmCliCandidates("/opt/node/bin/node", posix).includes("/opt/node/lib/node_modules/npm/bin/npm-cli.js"));
  assert.ok(bundledNpmCliCandidates("C:\\node\\node.exe", win32).includes("C:\\node\\node_modules\\npm\\bin\\npm-cli.js"));
  const source = readFileSync(join(REPOSITORY_ROOT, "scripts/runtime-deps-lock.mjs"), "utf8");
  assert.doesNotMatch(source, /execFileSync\(["']npm["']/u);
});

test("仓库提交的每产品 runtime lock 与当前依赖输入完全一致", () => {
  const expected = loadProductRuntime(REPOSITORY_ROOT);
  const verified = verifyRuntimeDepsLock(REPOSITORY_ROOT);
  assert.deepEqual(
    {
      productId: verified.product.productId,
      role: verified.product.role,
      repository: verified.product.repository,
    },
    {
      productId: expected.productId,
      role: expected.role,
      repository: expected.repository,
    },
  );
});

test("package-lock 必须锁定完整三目标原生包与 registry integrity", () => {
  assert.doesNotThrow(() => verifyRuntimePackageLock(manifest(), packageLock()));

  const missingTarget = packageLock();
  delete missingTarget.packages["node_modules/@esbuild/win32-x64"];
  assert.throws(() => verifyRuntimePackageLock(manifest(), missingTarget), /win32-x64 原生包/u);

  const missingIntegrity = packageLock();
  delete missingIntegrity.packages["node_modules/esbuild"].integrity;
  assert.throws(() => verifyRuntimePackageLock(manifest(), missingIntegrity), /SHA-512/u);

  const mirror = packageLock();
  mirror.packages["node_modules/esbuild"].resolved = "https://mirror.invalid/esbuild.tgz";
  assert.throws(() => verifyRuntimePackageLock(manifest(), mirror), /官方 registry/u);

  const rootDrift = packageLock();
  rootDrift.packages[""].dependencies.esbuild = "0.27.0";
  assert.throws(() => verifyRuntimePackageLock(manifest(), rootDrift), /根依赖/u);
});

test("刷新保留已审阅的依赖闭包；损坏或残缺旧锁不能静默重解算", () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-runtime-existing-lock-"));
  const destination = mkdtempSync(join(tmpdir(), "workloom-runtime-lock-target-"));
  const lockDirectory = join(root, ".workloom-runtime-deps");
  mkdirSync(lockDirectory);
  try {
    assert.equal(copyReviewedRuntimeLock(root, destination), false);
    writeFileSync(join(lockDirectory, "package.json"), JSON.stringify(manifest()));
    assert.throws(() => copyReviewedRuntimeLock(root, destination), /不完整/u);
    const reviewed = packageLock();
    reviewed.packages["node_modules/previous-transitive"] = registryEntry("1.0.0");
    writeFileSync(join(lockDirectory, "package-lock.json"), JSON.stringify(reviewed));
    assert.equal(copyReviewedRuntimeLock(root, destination), true);
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "package-lock.json"), "utf8")), reviewed);
    reviewed.packages["node_modules/previous-transitive"].resolved = "https://untrusted.invalid/package.tgz";
    writeFileSync(join(lockDirectory, "package-lock.json"), JSON.stringify(reviewed));
    assert.throws(() => copyReviewedRuntimeLock(root, destination), /官方 registry/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("DSH 的 sharp 与 koffi 原生闭包必须覆盖三个发行目标", () => {
  const lock = packageLock();
  for (const [parent, prefix, version] of [["sharp", "@img/sharp", "0.35.5"], ["koffi", "@koromix/koffi", "3.1.1"]]) {
    lock.packages[`node_modules/${parent}`] = registryEntry(version);
    for (const [os, cpu] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]]) {
      lock.packages[`node_modules/${prefix}-${os}-${cpu}`] = registryEntry(version, { os: [os], cpu: [cpu] });
    }
  }
  assert.doesNotThrow(() => verifyRuntimePackageLock(manifest(), lock));
  delete lock.packages["node_modules/@img/sharp-win32-x64"];
  assert.throws(() => verifyRuntimePackageLock(manifest(), lock), /win32-x64 原生包/u);
  lock.packages["node_modules/@img/sharp-win32-x64"] = registryEntry("0.35.5", { os: ["win32"], cpu: ["x64"] });
  delete lock.packages["node_modules/@koromix/koffi-darwin-x64"];
  assert.throws(() => verifyRuntimePackageLock(manifest(), lock), /darwin-x64 原生包/u);
});

test("锁与安装目录都拒绝缺失必需peer；嵌套寻址和optional peer遵守包合同", () => {
  const lock = packageLock();
  lock.packages["node_modules/outer/node_modules/plugin"] = registryEntry("1.0.0", {
    peerDependencies: { "required-peer": "^1.0.0", "optional-peer": "^1.0.0" },
    peerDependenciesMeta: { "optional-peer": { optional: true } },
  });
  assert.throws(() => verifyRuntimePackageLock(manifest(), lock), /缺少必需 peer.*required-peer/u);
  lock.packages["node_modules/outer/node_modules/required-peer"] = registryEntry("1.0.0");
  assert.doesNotThrow(() => verifyRuntimePackageLock(manifest(), lock));

  const stage = mkdtempSync(join(tmpdir(), "workloom-runtime-peer-stage-"));
  try {
    writePackage(stage, "esbuild", { name: "esbuild", version: "0.28.2", peerDependencies: { "required-peer": "^1.0.0" } });
    writePackage(stage, "@esbuild/darwin-arm64", { name: "@esbuild/darwin-arm64", version: "0.28.2", os: ["darwin"], cpu: ["arm64"] });
    const verified = { manifest: manifest(), packageLock: packageLock() };
    assert.throws(() => verifyInstalledRuntimeTarget(stage, "darwin", "arm64", verified), /缺少必需 peer/u);
    writePackage(stage, "required-peer", { name: "required-peer", version: "1.0.0" });
    assert.doesNotThrow(() => verifyInstalledRuntimeTarget(stage, "darwin", "arm64", verified));
  } finally { rmSync(stage, { recursive: true, force: true }); }
});

test("安装后目标校验拒绝宿主架构原生包并生成稳定 inventory 摘要", () => {
  const stage = mkdtempSync(join(tmpdir(), "workloom-runtime-stage-"));
  const verified = { manifest: manifest(), packageLock: packageLock() };
  try {
    writePackage(stage, "esbuild", { name: "esbuild", version: "0.28.2" });
    writePackage(stage, "@esbuild/darwin-x64", {
      name: "@esbuild/darwin-x64",
      version: "0.28.2",
      os: ["darwin"],
      cpu: ["x64"],
    });
    const first = verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified);
    const second = verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified);
    assert.equal(first.packages, 2);
    assert.equal(first.inventorySha256, second.inventorySha256);

    writePackage(stage, "@esbuild/darwin-arm64", {
      name: "@esbuild/darwin-arm64",
      version: "0.28.2",
      os: ["darwin"],
      cpu: ["arm64"],
    });
    assert.throws(
      () => verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified),
      /混入非目标原生包/u,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("Electron 装配使用每产品 lock、目标 OS/CPU 和身份闭包", () => {
  const source = readFileSync(join(REPOSITORY_ROOT, "scripts/pack-electron-payload.sh"), "utf8");
  assert.match(source, /runtime-deps-lock\.mjs stage.*--os "\$TARGET_OS" --cpu "\$TARGET_CPU"/u);
  assert.match(source, /product-runtime\.mjs --manifest-path/u);
  assert.match(source, /PRODUCT_MANIFEST_PATH/u);
  assert.match(source, /product\.manifest\.json/u);
  assert.match(source, /scripts\/product-runtime\.mjs/u);
  assert.match(source, /scripts\/vite-product\.mjs/u);
  assert.match(source, /payload-policy\.mjs assert-runtime/u);
  assert.doesNotMatch(source, /\bnpm install --no-audit --no-fund --legacy-peer-deps|\bcopy_nm\b/u);
  assert.match(source, /mac-arm64\)\s+TARGET_OS="darwin";\s+TARGET_CPU="arm64"/u);
  assert.match(source, /mac-x64\)\s+TARGET_OS="darwin";\s+TARGET_CPU="x64"/u);
  assert.match(source, /win-x64\)\s+TARGET_OS="win32";\s+TARGET_CPU="x64"/u);
  assert.match(source, /mac-x64\)\s+NATS_DIST="nats-server-\$\{NATS_VER\}-darwin-amd64\.tar\.gz"/u);
  const product = loadProductRuntime(REPOSITORY_ROOT);
  if (product.repository === "workloom-ai/workloom-im") {
    const workflow = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/desktop-production-release.yml"), "utf8");
    assert.doesNotMatch(workflow, /node-version:\s*24(?:\s|,|$)/u);
    assert.match(workflow, /node-version:\s*24\.19\.0/u);
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pruneCopiedWorkspaceDependencies } from "./prune-workspace-deps.mjs";
import { verifyRuntimeDeepSeek } from "./verify-runtime-deepseek.mjs";

const scratch = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function fixture() {
  const root = mkdtempSync(join(scratch, "pm-prune-workspace-"));
  const modules = join(root, "node_modules");
  write(join(modules, "@workloom/runtime/package.json"), JSON.stringify({ name: "@workloom/runtime", version: "1.0.0" }));
  write(join(modules, "@workloom/runtime/node_modules/copied-direct/index.js"), "copied dependency");
  write(join(modules, "@workloom/runtime/dsh-gate/node_modules/copied-gate/index.js"), "copied gate dependency");
  write(join(modules, "outer/package.json"), JSON.stringify({ name: "outer", version: "1.0.0", main: "index.cjs" }));
  write(join(modules, "outer/index.cjs"), 'module.exports = require("nested-required");');
  write(join(modules, "outer/node_modules/nested-required/package.json"), JSON.stringify({ name: "nested-required", version: "2.0.0", main: "index.cjs" }));
  write(join(modules, "outer/node_modules/nested-required/index.cjs"), 'module.exports = "nested-version-2";');
  return { root, modules };
}

test("workspace cleanup preserves a genuinely required third-party nested module", () => {
  const { root, modules } = fixture();
  try {
    const before = execFileSync(process.execPath, ["-e", 'process.stdout.write(require("outer"))'], { cwd: root, encoding: "utf8" });
    assert.equal(before, "nested-version-2");
    const cleaned = pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime");
    assert.deepEqual(cleaned.removed, ["dsh-gate/node_modules", "node_modules"]);
    assert.equal(existsSync(join(modules, "@workloom/runtime/node_modules")), false);
    assert.equal(existsSync(join(modules, "@workloom/runtime/dsh-gate/node_modules")), false);
    const after = execFileSync(process.execPath, ["-e", 'process.stdout.write(require("outer"))'], { cwd: root, encoding: "utf8" });
    assert.equal(after, "nested-version-2");
    assert.deepEqual(pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime").removed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup refuses escaping names, mismatched manifests and linked package roots", () => {
  const { root, modules } = fixture();
  try {
    assert.throws(() => pruneCopiedWorkspaceDependencies(modules, "../../outer"), /精确包名/u);
    writeFileSync(join(modules, "@workloom/runtime/package.json"), JSON.stringify({ name: "unexpected" }));
    assert.throws(() => pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime"), /身份/u);
    symlinkSync(join(modules, "outer"), join(modules, "linked"), "dir");
    assert.throws(() => pruneCopiedWorkspaceDependencies(modules, "linked"), /实体目录/u);
    assert.equal(existsSync(join(modules, "outer/node_modules/nested-required/index.cjs")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a copied workspace node_modules symlink is unlinked without changing its target", () => {
  const { root, modules } = fixture();
  try {
    rmSync(join(modules, "@workloom/runtime/node_modules"), { recursive: true });
    symlinkSync(join(modules, "outer/node_modules"), join(modules, "@workloom/runtime/node_modules"), "dir");
    pruneCopiedWorkspaceDependencies(modules, "@workloom/runtime");
    assert.equal(existsSync(join(modules, "@workloom/runtime/node_modules")), false);
    assert.equal(readFileSync(join(modules, "outer/node_modules/nested-required/index.cjs"), "utf8"), 'module.exports = "nested-version-2";');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all three packaging paths preserve npm nested boundaries and verify production preview", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const script of ["pack-electron-payload.sh", "pack-macos.sh", "pack-windows.sh"]) {
    const source = readFileSync(join(root, "scripts", script), "utf8");
    assert.match(source, /node scripts\/prune-workspace-deps\.mjs "\$R\/node_modules" "\$pname"/u, script);
    assert.doesNotMatch(source, /find "\$R\/node_modules"[^\n]*-name node_modules[^\n]*rm -rf/u, script);
    assert.match(source, /node scripts\/verify-runtime-preview\.mjs "\$R" "\$NM_STAGE\/node_modules"/u, script);
    assert.match(source, /node scripts\/verify-runtime-deepseek\.mjs "\$R" "\$R\/node_modules"/u, script);
  }
});

function tokenizerPayload(t) {
  const root = mkdtempSync(join(scratch, "pm-tokenizer-payload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/base/model-router");
  for (const target of ["packages/base/model-router", "node_modules/@workloom/base/model-router"]) {
    mkdirSync(join(root, target), { recursive: true });
    for (const file of ["deepseek-window.ts", "deepseek-window.runtime-smoke.mjs"]) {
      cpSync(join(source, file), join(root, target, file));
    }
    cpSync(join(source, "assets"), join(root, target, "assets"), { recursive: true });
  }
  const engine = realpathSync(resolve(source, "../node_modules/@huggingface/tokenizers"));
  cpSync(engine, join(root, "node_modules/@huggingface/tokenizers"), { recursive: true });
  return root;
}

test("packaged tokenizer executes offline with only its production JS engine", async (t) => {
  const root = tokenizerPayload(t);
  const report = await verifyRuntimeDeepSeek({ runtimeRoot: root, nodeModulesRoot: join(root, "node_modules") });
  assert.equal(report.offline, true);
  assert.equal(report.engine, "@huggingface/tokenizers@0.2.0");
  assert.equal(report.checks.length, 2);
  assert.ok(report.checks.some((check) => check.id === "combined-tools-json-schema"));
  assert.ok(report.checks.every((check) => check.maxOutputTokens === 393216));
});

test("packaging rejects a missing tokenizer, divergent copies and tampered shared asset", async (t) => {
  const root = tokenizerPayload(t);
  const options = { runtimeRoot: root, nodeModulesRoot: join(root, "node_modules") };
  const asset = "assets/deepseek-v41/tokenizer.json";
  const source = join(root, "packages/base/model-router", asset);
  const installed = join(root, "node_modules/@workloom/base/model-router", asset);
  const original = readFileSync(source);
  rmSync(installed);
  await assert.rejects(verifyRuntimeDeepSeek(options), /ENOENT/u);
  writeFileSync(installed, "{}");
  await assert.rejects(verifyRuntimeDeepSeek(options), /两份文件不一致/u);
  writeFileSync(source, "{}");
  await assert.rejects(verifyRuntimeDeepSeek(options), /SHA-256/u);
  writeFileSync(source, original); writeFileSync(installed, original);
  rmSync(join(root, "node_modules/@huggingface/tokenizers"), { recursive: true });
  await assert.rejects(verifyRuntimeDeepSeek(options), /Cannot find module|逃逸生产依赖目录/u);
});

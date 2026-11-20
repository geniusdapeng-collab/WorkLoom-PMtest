import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBridgeToken,
  dshArgs,
  dshEnvironment,
  dshReadyUrl,
  patchText,
  prepareDshRuntime,
  readProductIdentity,
  resolveClientMode,
} from "./dsh-runtime.cjs";

function writeFixture(root) {
  mkdirSync(join(root, "apps", "server"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "product.manifest.json"), JSON.stringify({
    productId: "workloom-pmtest",
    displayName: "WorkLoom PMtest",
    defaultBundle: "ai-pm",
    demoWorkspaceSlug: "ai-pm-demo",
    demoMemberNo: "MEM-001",
  }));
  writeFileSync(join(root, "apps", "server", "package.json"), JSON.stringify({ dependencies: { "@deepseek-ai/dsh": "0.2.1-rc.2" } }));
  const dshRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(dshRoot, "lib"), { recursive: true });
  writeFileSync(join(dshRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2" }));
  writeFileSync(join(dshRoot, "lib", "bin.js"), "export {};\n");
  const pluginRoot = join(root, "packages", "pm-dsh-client");
  mkdirSync(join(pluginRoot, "lib"), { recursive: true });
  writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({
    name: "@workloom/dsh-pm-client",
    type: "module",
    dsh: { client: { platform: "web" } },
  }));
  writeFileSync(join(pluginRoot, "lib", "index.js"), "export function apply() {}\n");
  writeFileSync(join(pluginRoot, "lib", "client.js"), "window.__ModuleLoader__.load({});\n");
}

test("client mode defaults to DSH and legacy remains an explicit rollback", () => {
  assert.equal(resolveClientMode({}), "dsh");
  assert.equal(resolveClientMode({ WORKLOOM_CLIENT: "legacy" }), "legacy");
  assert.throws(() => resolveClientMode({ WORKLOOM_CLIENT: "other" }), /只允许 dsh 或 legacy/u);
});

test("bridge capabilities are unguessable and never appear in the generated patch", () => {
  const token = createBridgeToken((size) => Buffer.alloc(size, 7));
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  const patch = patchText("/tmp/workloom pm/client/lib/index.js");
  assert.match(patch, /workloom-pm-client/u);
  assert.match(patch, /ui-brand-official/u);
  assert.doesNotMatch(patch, new RegExp(token, "u"));
});

test("desktop session handoff accepts only an authenticated URL for the launched loopback port", () => {
  const token = "q".repeat(43);
  const url = `http://127.0.0.1:5404/?token=${token}`;
  assert.equal(dshReadyUrl({ type: "workloom:dsh-ready", url }, 5404), url);
  assert.equal(dshReadyUrl({ type: "workloom:dsh-ready", url }, 5405), null);
  assert.equal(dshReadyUrl({ type: "workloom:dsh-ready", url: url.replace("127.0.0.1", "example.net") }, 5404), null);
  assert.equal(dshReadyUrl({ type: "workloom:dsh-ready", url: `${url}&redirect=elsewhere` }, 5404), null);
});

test("prepares an isolated DSH home and launch patch from the product identity", () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-dsh-runtime-"));
  try {
    writeFixture(root);
    const support = join(root, "support");
    const prepared = prepareDshRuntime({ root, supportDir: support });
    assert.equal(prepared.product.workspaceSlug, "ai-pm-demo");
    assert.equal(prepared.dshVersion, "0.2.1-rc.2");
    assert.equal(readProductIdentity(root).memberNo, "MEM-001");
    assert.match(readFileSync(prepared.patchFile, "utf8"), /deepseek-official/u);
    const env = dshEnvironment({
      LLM_API_KEY: "fixture-model-key",
      DATABASE_URL: "dummy-database",
      JWT_SECRET: "fixture-jwt",
      GH_TOKEN: "fixture-github",
      NODE_OPTIONS: "fixture-options",
      PATH: "/bin",
    }, {
      serverPort: 9018,
      token: "t".repeat(43),
      dshHome: prepared.dshHome,
    });
    assert.equal(prepared.workspaceDir, join(support, ".workloom-dsh", "workspace"));
    assert.equal(env.WORKLOOM_PM_API_URL, "http://127.0.0.1:9018");
    assert.equal(env.DSH_TELEMETRY_DISABLED, "1");
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.DEEPSEEK_API_KEY, "fixture-model-key");
    assert.equal(env.PATH, "/bin");
    for (const key of ["DATABASE_URL", "JWT_SECRET", "GH_TOKEN", "NODE_OPTIONS", "LLM_API_KEY"]) {
      assert.equal(env[key], undefined, key);
    }
    assert.deepEqual(dshArgs({
      cli: prepared.dshCli, port: 5404, patchFile: prepared.patchFile,
    }), [
      prepared.dshCli, "--patch", prepared.patchFile, "--profile", "web",
      "--host", "127.0.0.1", "--port", "5404", "--no-open",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

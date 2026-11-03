import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const implementation = readFileSync(new URL("./ui-e2e-preview.mjs", import.meta.url));
function fixture(t, behavior = "success") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloom-ui-preview-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = join(root, "scripts/ui-e2e-preview.mjs");
  mkdirSync(dirname(runner), { recursive: true });
  writeFileSync(runner, implementation);
  const calls = join(root, "calls.jsonl");
  for (const client of ["web", "webb", "webc"]) {
    const vite = join(root, "apps", client, "node_modules/vite/bin/vite.js");
    mkdirSync(dirname(vite), { recursive: true });
    writeFileSync(vite, `const fs = require('node:fs');
const record = value => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(value) + '\\n');
const phase = process.argv[2];
if (${JSON.stringify(behavior)} === 'wait-build' || ${JSON.stringify(behavior)} === 'wait-preview' && phase === 'preview') {
  process.on('SIGTERM', () => { record({ signal: 'SIGTERM', phase }); process.exit(0); });
  setInterval(() => {}, 1000);
}
// The parent treats this record as readiness to receive termination. Install
// the handler first so its signal cannot arrive in the registration gap.
record({ phase, args: process.argv.slice(2), cwd: process.cwd(), nodeEnv: process.env.NODE_ENV, diagnostics: process.env.VITE_ENABLE_UI_DIAGNOSTICS });
if (${JSON.stringify(behavior)} === 'build-failure' && phase === 'build') process.exit(7);
if (${JSON.stringify(behavior)} === 'preview-failure' && phase === 'preview') process.exit(9);
`);
    mkdirSync(join(root, "apps", client, "dist"));
    writeFileSync(join(root, "apps", client, "dist", "sentinel"), "original production dist");
  }
  return { root, runner, calls, readCalls: () => readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) };
}

for (const argument of [undefined, "unknown", "../web"]) {
  test(`refuses an invalid client before any build: ${argument ?? "missing"}`, t => {
    const f = fixture(t);
    const result = spawnSync(process.execPath, [f.runner, ...(argument ? [argument] : [])], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /exactly one known client/);
    assert.throws(() => readFileSync(f.calls));
  });
}

test("all three clients keep DEV gates, isolate output and preserve production dist", t => {
  const f = fixture(t);
  for (const client of ["web", "webb", "webc"]) {
    const result = spawnSync(process.execPath, [f.runner, client], { env: { ...process.env, NODE_ENV: "production", VITE_ENABLE_UI_DIAGNOSTICS: "true" }, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(join(f.root, "apps", client, "dist", "sentinel"), "utf8"), "original production dist");
  }
  const calls = f.readCalls();
  assert.equal(calls.length, 6);
  for (let index = 0; index < calls.length; index += 2) {
    const [build, preview] = calls.slice(index, index + 2);
    assert.equal(build.phase, "build");
    assert.equal(preview.phase, "preview");
    assert.equal(build.nodeEnv, "development");
    assert.equal(preview.nodeEnv, "development");
    assert.equal(build.diagnostics, "true");
    assert.ok(build.args.includes("--emptyOutDir"));
    assert.deepEqual(build.args.slice(1, 3), ["--mode", "development"]);
    const output = build.args[build.args.indexOf("--outDir") + 1];
    assert.ok(output.startsWith(join(f.root, "node_modules/.cache/workloom-ui-e2e/")));
    assert.equal(preview.args[preview.args.indexOf("--outDir") + 1], output);
    assert.deepEqual(preview.args.slice(-3), ["--host", "127.0.0.1", "--strictPort"]);
    assert.equal(build.cwd, preview.cwd);
  }
});

test("a failed build never starts preview and retains its exit code", t => {
  const f = fixture(t, "build-failure");
  assert.equal(spawnSync(process.execPath, [f.runner, "web"]).status, 7);
  assert.deepEqual(f.readCalls().map(call => call.phase), ["build"]);
});

test("a failed preview retains its exit code", t => {
  const f = fixture(t, "preview-failure");
  assert.equal(spawnSync(process.execPath, [f.runner, "webb"]).status, 9);
});

for (const phase of ["build", "preview"]) {
  test(`termination during ${phase} stops the child and cannot report success`, async t => {
    const f = fixture(t, `wait-${phase}`);
    const child = spawn(process.execPath, [f.runner, "webc"], { stdio: "ignore" });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const deadline = Date.now() + 5_000;
    while (true) {
      let ready = false;
      try { ready = f.readCalls().some(call => call.phase === phase); } catch { /* Child has not created its own log yet. */ }
      if (ready) break;
      assert.ok(Date.now() < deadline, "Fixture child did not reach the intended phase");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const exited = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Runner did not forward termination")), 5_000);
      child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    child.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.code, 128);
    assert.ok(f.readCalls().some(call => call.signal === "SIGTERM" && call.phase === phase));
    if (phase === "build") assert.ok(!f.readCalls().some(call => call.phase === "preview"));
  });
}

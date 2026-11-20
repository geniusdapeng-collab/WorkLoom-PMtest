import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dshReadyUrl, waitForDshUrl } from "./dsh-runtime.cjs";

test("the worker accepts only the owned Desktop profile and a clean loopback authority", () => {
  const previewToken = "q".repeat(43);
  const url = `http://127.0.0.1:5404/?token=${previewToken}`;
  const ready = { type: "workloom:dsh-ready", profile: "desktop", url };
  assert.equal(dshReadyUrl(ready, 0), url);
  assert.equal(dshReadyUrl(ready, 5404), url);
  assert.equal(dshReadyUrl(ready, 5405), null);
  assert.equal(dshReadyUrl({ ...ready, profile: "web" }, 5404), null);
  assert.equal(dshReadyUrl({ ...ready, url: url.replace("127.0.0.1", "example.net") }, 0), null);
  assert.equal(dshReadyUrl({ ...ready, url: `${url}&redirect=elsewhere` }, 5404), null);
});

test("the installed official Desktop profile opens and closes an authenticated loopback session", { timeout: 55_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-desktop-profile-"));
  const dshHome = join(root, "home");
  const patch = join(root, "worker.patch.yml");
  const fromServer = createRequire(new URL("../apps/server/package.json", import.meta.url));
  const entry = fileURLToPath(new URL("./dsh-runtime.cjs", import.meta.url));
  writeFileSync(patch, "[]\n", { mode: 0o600 });
  const child = spawn(process.execPath, [
    entry, fromServer.resolve("@deepseek-ai/dsh/lib/bin.js"), join(dshHome, "profiles", "desktop"), "0", patch,
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      SystemRoot: process.env.SystemRoot,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exit = once(child, "exit");
  try {
    const url = await waitForDshUrl(child, 0, 42_000);
    const origin = new URL(url).origin;
    const anonymous = await fetch(origin, { signal: AbortSignal.timeout(5000) });
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
    const exchange = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    assert.equal(exchange.status, 303);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    await exchange.body?.cancel();
    const ready = await fetch(origin, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(ready.status, 200);
    assert.ok((await ready.text()).includes("__DSH_BOOT__"));
  } finally {
    if (child.connected) child.disconnect();
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [exitCode] = await exit;
      assert.equal(exitCode, 0);
      assert.equal(/[?&]token=[A-Za-z0-9_-]{32,}/u.test(output), false);
    } finally {
      clearTimeout(watchdog);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

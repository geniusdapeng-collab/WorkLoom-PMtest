import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { closeAllPools, getAppPool } from "@workloom/db";
import { PgPmStore, type PmStore } from "./store.js";
import type { PmScope } from "./types.js";

const scopeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export async function runPmWatchdog(options: {
  scope: PmScope;
  store: Pick<PmStore, "recoverExpired">;
  intervalMs: number;
  once: boolean;
  signal: AbortSignal;
  onRecovered: (count: number) => void;
  onError: () => void;
}): Promise<void> {
  const { scope, store, intervalMs, once, signal, onRecovered, onError } = options;
  if (!scopeId.test(scope.tenantId) || !scopeId.test(scope.workspaceId)
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
    throw new Error("PM Watchdog 需要指定一个工作区，轮询间隔允许 1000–300000 毫秒");
  }
  while (!signal.aborted) {
    try {
      const count = await store.recoverExpired(scope);
      if (once || count > 0) onRecovered(count);
    } catch (error) {
      if (once) throw error;
      onError();
    }
    if (once || signal.aborted) break;
    try { await setTimeout(intervalMs, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || arguments_.some((item) => item !== "--once")) {
    throw new Error("用法：pm:watchdog [--once]");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runPmWatchdog({
      scope: { tenantId: process.env.PM_WATCHDOG_TENANT ?? "", workspaceId: process.env.PM_WATCHDOG_WORKSPACE ?? "" },
      store: new PgPmStore(getAppPool()),
      intervalMs: Number(process.env.PM_WATCHDOG_INTERVAL_MS ?? 15_000),
      once: arguments_.includes("--once"),
      signal: controller.signal,
      onRecovered: (recovered) => console.log(JSON.stringify({ event: "pm.watchdog.scan", recovered })),
      onError: () => console.error(JSON.stringify({ event: "pm.watchdog.scan_failed" })),
    });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await closeAllPools();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("PM Watchdog 启动或扫描失败"); process.exitCode = 1; });
}

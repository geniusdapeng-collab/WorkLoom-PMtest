import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeArtifactPath } from "./contract.js";
import type { CheckResult } from "./artifacts.js";
import type { PmFile } from "./types.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const CODE = /\.(?:mjs|cjs|js)$/i;
const UNSUPPORTED_CODE = /\.(?:ts|tsx|jsx|py|sh|bash|zsh|rb|go|rs|java|c|cpp|cs|php|swift|kt|wasm|exe|bin)$/i;
const TEST = /(?:^|\/)\w[\w.-]*\.test\.(?:mjs|cjs|js)$/i;
const MAX_OUTPUT = 64 * 1024;

export interface CodeReceipt {
  backend: "macos-seatbelt-node24" | "linux-bubblewrap-node24"; exitCode: number | null; signal: string | null;
  timedOut: boolean; cancelled: boolean; outputLimited: boolean;
  stdout: string; stderr: string; stdoutSha256: string; stderrSha256: string;
  files: Array<{ path: string; sha256: string }>; tests: string[];
  testOrigin: "generated" | "trusted-evaluator";
  testSummary: { success: boolean; counts: Record<string, number>; completedTests: number } | null;
}

interface SandboxLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

type SandboxResult = Omit<CodeReceipt, "backend" | "files" | "tests" | "testOrigin" | "stdoutSha256" | "stderrSha256">;
const TEST_COUNTS = ["tests", "failed", "passed", "cancelled", "skipped", "todo", "topLevel", "suites"] as const;

/** Node permissions are only an extra seat belt; the OS profile is mandatory. */
function profile(root: string, node: string, runner: string, preload: string): string {
  const literal = (value: string) => JSON.stringify(value);
  return `(version 1)
(deny default)
(allow process-exec (literal ${literal(node)}))
(allow process-fork)
(allow sysctl-read mach-lookup process-info*)
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-map-executable (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (literal ${literal(node)}))
(allow file-read* (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS") (subpath "/usr/lib") (subpath "/private/var/db/dyld")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
  (literal ${literal(node)}) (literal ${literal(runner)}) (literal ${literal(preload)}) (subpath ${literal(root)}))
(allow file-write-data (literal "/dev/null"))`;
}

export async function executeSandboxNodeTests(input: {
  files: PmFile[]; tests?: string[]; trustedFiles?: PmFile[]; signal: AbortSignal;
  timeoutMs?: number;
}): Promise<CodeReceipt> {
  if (Number(process.versions.node.split(".")[0]) < 24 || !["darwin", "linux"].includes(process.platform)) {
    throw new Error("OS_SANDBOX_UNAVAILABLE: 需要macOS Seatbelt/Linux bubblewrap和Node24；未在宿主直接执行代码");
  }
  if (process.platform === "darwin") await access("/usr/bin/sandbox-exec");
  else await access(process.env.PM_LINUX_SANDBOX_BIN || "/usr/bin/bwrap");
  const tests = input.tests ?? input.files.filter((file) => TEST.test(file.path)).map((file) => file.path);
  if (!tests.length || tests.length > 16) throw new Error("代码验收需要1至16个明确的Node测试文件");
  const files = [...input.files, ...input.trustedFiles ?? []];
  if (files.length > 128 || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 4 * 1024 * 1024) throw new Error("代码验收文件超限");
  const seen = new Set<string>();
  for (const file of files) {
    safeArtifactPath(file.path);
    if (seen.has(file.path.toLowerCase())) throw new Error("代码验收文件路径冲突");
    seen.add(file.path.toLowerCase());
  }
  for (const path of tests) {
    safeArtifactPath(path);
    if (!TEST.test(path) || !files.some((file) => file.path === path)) throw new Error("测试文件不存在或不符合命名合同");
  }
  input.signal.throwIfAborted();
  const root = await realpath(await mkdtemp(join(tmpdir(), "workloom-pm-verify-")));
  try {
    for (const file of files) {
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { flag: "wx", mode: 0o400 });
    }
    const node = await realpath(process.execPath);
    const runner = await realpath(fileURLToPath(new URL("./code-test-runner.mjs", import.meta.url)));
    const preload = await realpath(fileURLToPath(new URL("./code-test-preload.mjs", import.meta.url)));
    const deadline = performance.now() + Math.max(50, Math.min(input.timeoutMs ?? 30_000, 30_000));
    const result: SandboxResult = { stdout: "", stderr: "", exitCode: 0, signal: null,
      timedOut: false, cancelled: false, outputLimited: false,
      testSummary: { success: true, counts: Object.fromEntries(TEST_COUNTS.map((key) => [key, 0])), completedTests: 0 } };
    const backend = process.platform === "darwin" ? "macos-seatbelt-node24" : "linux-bubblewrap-node24";
    for (const test of tests) {
      const launch = sandboxLaunch(root, node, runner, preload, test);
      const next = await runSandboxTest(launch, input.signal, Math.max(0, deadline - performance.now()),
        MAX_OUTPUT - Buffer.byteLength(result.stdout) - Buffer.byteLength(result.stderr));
      result.stdout += next.stdout;
      result.stderr += next.stderr;
      if (next.exitCode !== 0) result.exitCode = next.exitCode;
      result.signal = next.signal;
      result.timedOut = next.timedOut;
      result.cancelled = next.cancelled;
      result.outputLimited = next.outputLimited;
      if (result.testSummary && next.testSummary) {
        result.testSummary.success &&= next.testSummary.success;
        result.testSummary.completedTests += next.testSummary.completedTests;
        for (const key of TEST_COUNTS) result.testSummary.counts[key]! += next.testSummary.counts[key]!;
      } else result.testSummary = null;
      if (next.signal || next.timedOut || next.cancelled || next.outputLimited) break;
    }
    const trusted = new Set(input.trustedFiles?.map((file) => file.path) ?? []);
    return { backend, ...result, stdoutSha256: sha(result.stdout), stderrSha256: sha(result.stderr),
      files: files.map(({ path, content }) => ({ path, sha256: sha(content) })),
      tests, testOrigin: tests.every((path) => trusted.has(path)) ? "trusted-evaluator" : "generated" };
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function runSandboxTest(launch: SandboxLaunch, abort: AbortSignal, timeout: number, outputBudget: number): Promise<SandboxResult> {
  const challenge = randomBytes(32).toString("hex");
  const result = await new Promise<Omit<SandboxResult, "testSummary">>((yes, no) => {
    // Do not inherit NODE_OPTIONS, credentials, proxy settings, HOME or host PATH.
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, detached: true,
      env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => { /* Child may exit before reading; absence of attestation fails closed. */ });
    child.stdin.end(challenge);
    let stdout = "", stderr = "", timedOut = false, cancelled = false, outputLimited = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); } } };
    const cancel = () => { cancelled = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    abort.addEventListener("abort", cancel, { once: true });
    if (abort.aborted) cancel();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const consume = (kind: "stdout" | "stderr", chunk: string) => {
      if (outputLimited) return;
      if (kind === "stdout") stdout += chunk; else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > outputBudget) {
        outputLimited = true;
        stdout = Buffer.from(stdout).subarray(0, Math.floor(outputBudget / 2)).toString("utf8");
        stderr = Buffer.from(stderr).subarray(0, Math.floor(outputBudget / 2)).toString("utf8");
        kill();
      }
    };
    child.stdout.on("data", (chunk: string) => consume("stdout", chunk));
    child.stderr.on("data", (chunk: string) => consume("stderr", chunk));
    const cleanup = () => { clearTimeout(timer); abort.removeEventListener("abort", cancel); };
    child.once("error", (error) => { cleanup(); no(error); });
    child.once("close", (exitCode, signal) => { cleanup(); yes({ exitCode, signal, stdout, stderr,
      timedOut, cancelled, outputLimited }); });
  });
  const matches = result.stdout.split("\n").filter((line) => line.startsWith(`PM_TEST_RECEIPT:${challenge}:`));
  let testSummary: CodeReceipt["testSummary"] = null;
  if (matches.length === 1) {
    try {
      const summary = JSON.parse(matches[0]!.slice(`PM_TEST_RECEIPT:${challenge}:`.length));
      if (typeof summary.success === "boolean" && Number.isSafeInteger(summary.completedTests) && summary.completedTests >= 0
        && summary.counts && typeof summary.counts === "object"
        && TEST_COUNTS.every((key) => Number.isSafeInteger(summary.counts[key]) && summary.counts[key] >= 0)) testSummary = summary;
    } catch { /* Unparseable test receipts are never accepted. */ }
  }
  return { ...result, testSummary };
}

function sandboxLaunch(root: string, node: string, runner: string, preload: string, test: string): SandboxLaunch {
  const nodeArgs = [
    "--permission",
    `--allow-fs-read=${process.platform === "linux" ? "/workspace" : root}`,
    `--allow-fs-read=${process.platform === "linux" ? "/runner" : runner}`,
    `--allow-fs-read=${process.platform === "linux" ? "/preload" : preload}`,
    "--disable-sigusr1",
    "--max-old-space-size=128",
    "--frozen-intrinsics",
    "--import", process.platform === "linux" ? "file:///preload" : pathToFileURL(preload).href,
    process.platform === "linux" ? "/runner" : runner,
    test,
  ];
  if (process.platform === "darwin") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", profile(root, node, runner, preload), node, ...nodeArgs],
      cwd: root,
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TZ: "UTC" },
    };
  }

  const bwrap = process.env.PM_LINUX_SANDBOX_BIN || "/usr/bin/bwrap";
  const nodeRoot = dirname(dirname(node));
  const mountedNode = `/node/${node.slice(nodeRoot.length).replace(/^\/+/, "")}`;
  return {
    command: bwrap,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--ro-bind-try", "/etc/ssl/certs", "/etc/ssl/certs",
      "--ro-bind", nodeRoot, "/node",
      "--ro-bind", runner, "/runner",
      "--ro-bind", preload, "/preload",
      "--bind", root, "/workspace",
      "--tmpfs", "/tmp",
      "--proc", "/proc",
      "--dev", "/dev",
      "--chdir", "/workspace",
      "--clearenv",
      "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "LANG", "C.UTF-8",
      "--setenv", "TZ", "UTC",
      mountedNode,
      ...nodeArgs,
    ],
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" },
  };
}

/** Fixed server policy; HTTP input cannot select commands, arguments or host paths. */
export function createSandboxCodeVerifier() {
  return async ({ files, signal }: { files: PmFile[]; signal: AbortSignal }): Promise<CheckResult[]> => {
    const unsupported = files.find((file) => UNSUPPORTED_CODE.test(file.path));
    if (unsupported) return [{ check: { type: "fileExists", path: unsupported.path }, passed: false,
      message: "本机受限执行验证仅支持零依赖JavaScript；其它语言未运行，不能自动标记交付完成" }];
    const code = files.filter((file) => CODE.test(file.path));
    if (!code.length) return [];
    const tests = files.filter((file) => TEST.test(file.path)).map((file) => file.path);
    const check = { type: "fileExists" as const, path: tests[0] ?? code[0]!.path };
    if (!tests.length) return [{ check, passed: false, message: "代码产物缺少*.test.mjs/cjs/js；未以文件存在代替运行验收" }];
    try {
      const receipt = await executeSandboxNodeTests({ files, tests, signal });
      const passed = receipt.exitCode === 0 && !receipt.timedOut && !receipt.cancelled && !receipt.outputLimited
        && receipt.testSummary?.success === true && receipt.testSummary.completedTests > 0
        && receipt.testSummary.counts.tests! > 0 && receipt.testSummary.counts.passed! > 0
        && receipt.testSummary.counts.failed === 0 && receipt.testSummary.counts.cancelled === 0
        && receipt.testSummary.counts.skipped === 0 && receipt.testSummary.counts.todo === 0;
      return [{ check, passed, message: JSON.stringify(receipt) }];
    } catch (error) {
      return [{ check, passed: false, message: error instanceof Error ? error.message : "OS沙箱执行失败，未标记通过" }];
    }
  };
}

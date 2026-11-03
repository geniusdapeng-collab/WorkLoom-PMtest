/** Run explicitly: pnpm test:pm-dsh
 * These are real pinned DSH subprocesses with a deterministic local model fixture.
 * They verify Harness mechanics and isolation, not DeepSeek task quality.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";
import { OpenAiCompatibleProvider, type CompletionProvider, type CompletionResult, type FunctionToolCall, type ProviderMessage } from "@workloom/base/model-router";
import { createDshEmployeeExecutor, type DshEmployeeOptions } from "../dsh-adapter.js";
import type { EmployeeExecutionInput } from "../types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const scratchRoot = resolve(repoRoot, "..");
const evidenceRoot = process.env.PM_DSH_EVIDENCE_ROOT ? resolve(process.env.PM_DSH_EVIDENCE_ROOT) : undefined;
// Default exercises the server's own declared dependency; the explicit override
// repeats the same tests against a real npm-ci desktop stage without symlinks.
const dshPackageRoot = process.env.PM_DSH_PACKAGE_ROOT ? resolve(process.env.PM_DSH_PACKAGE_ROOT) : undefined;
function executor(options: DshEmployeeOptions) { return createDshEmployeeExecutor({ ...options, ...(dshPackageRoot ? { dshPackageRoot } : {}) }); }
async function scratch(name: string): Promise<string> {
  const parent = evidenceRoot ?? scratchRoot;
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, name));
}
async function cleanup(directory: string): Promise<void> {
  if (!evidenceRoot) await rm(directory, { recursive: true, force: true });
}
function result(sequence: number, toolCalls?: FunctionToolCall[]): CompletionResult {
  const usage = { prompt_tokens: 100 + sequence, completion_tokens: 20, total_tokens: 120 + sequence };
  return { text: toolCalls ? "" : "已交付 report.md", message: { role: "assistant", content: toolCalls ? null : "已交付 report.md", ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    model: "deepseek-flash", responseId: `fixture-${sequence}`, finishReason: toolCalls ? "tool_calls" : "stop", usage,
    promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
}
const call = (sequence: number, name: string, args: unknown): FunctionToolCall => ({ id: `call-${sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
function input(outputDir: string, signal = new AbortController().signal): EmployeeExecutionInput {
  const content = "upstream evidence: REQUIREMENT-42";
  return { scope: { tenantId: "fixture", workspaceId: "fixture-workspace" }, runId: "fixture-run", task: {
    id: "fixture-task", presetKey: "doc-writer", goal: "从上游需求产出 report.md", dependsOn: ["previous-task"], acceptance: ["包含 REQUIREMENT-42"], outputRefs: ["report.md"],
  }, preset: { agentId: "agt-doc-writer", presetKey: "doc-writer", version: "fixture-v1", highRisk: false, fenceBindings: [], tools: [],
    prompt: { role: "文档员工" }, essentials: { archive: { dataMode: "simulated" }, stage: "definition", goal: "fixture" } }, skillText: "fixture skill",
    dependencyArtifacts: [{ id: "upstream", runId: "fixture-run", taskId: "previous-task", path: "requirements.md", content,
      sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content), mediaType: "text/markdown", verifiedAt: new Date().toISOString() }], outputDir, signal };
}
function toolMessages(messages: ProviderMessage[]) { return messages.filter((message) => message.role === "tool").map((message) => message.content); }

test("real DSH performs read -> write -> final, with durable session and measured receipts", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-integration-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(messages, options) {
    assert.deepEqual(options?.tools?.map((tool) => tool.function.name).sort(), ["list_files", "read_file", "write_file"]);
    calls += 1;
    if (calls === 1) return result(calls, [call(calls, "read_file", { path: "inputs/context.json" })]);
    if (calls === 2) {
      const context = JSON.parse(toolMessages(messages).at(-1)!) as { content: string };
      const body = JSON.parse(context.content) as { dependencyArtifacts: Array<{ path: string }> };
      return result(calls, [call(calls, "read_file", { path: body.dependencyArtifacts[0]!.path })]);
    }
    if (calls === 3) {
      const dependency = JSON.parse(toolMessages(messages).at(-1)!) as { content: string };
      return result(calls, [call(calls, "write_file", { path: "report.md", content: `# 交付\n${dependency.content}\n` })]);
    }
    return result(calls);
  } };
  try {
    const delivered = await executor({ provider, timeoutMs: 30000 })(input(directory));
    assert.equal(calls, 4);
    assert.deepEqual(delivered.files.map((file) => file.path), ["report.md"]);
    assert.match(delivered.files[0]!.content, /REQUIREMENT-42/);
    assert.equal(delivered.usage.promptTokens, 410);
    assert.equal(delivered.usage.completionTokens, 80);
    assert.equal(delivered.receipt?.dshVersion, "0.2.1-rc.2");
    assert.equal(delivered.receipt?.toolCalls, 3);
    assert.equal(delivered.receipt?.exitCode, 0);
    assert.equal(delivered.receipt?.usageComplete, true);
    assert.ok(Array.isArray(delivered.receipt?.sessionEvidence) && delivered.receipt!.sessionEvidence.length > 0);
    assert.equal(delivered.receipt?.adapter, "deepseek-harness-headless");
  } finally { await cleanup(directory); }
});

test("real DSH preserves Unicode across large subprocess output chunks", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-unicode-");
  const summary = "需求中文与验收。".repeat(20000);
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() {
    calls += 1;
    if (calls === 1) return result(calls, [call(calls, "write_file", { path: "report.md", content: "# 中文产物\nREQUIREMENT-42\n" })]);
    const completion = result(calls);
    return { ...completion, text: summary, message: { role: "assistant", content: summary } };
  } };
  try {
    const delivered = await executor({ provider, timeoutMs: 30000 })(input(directory));
    assert.equal(delivered.summary, summary);
    assert.equal(delivered.summary.includes("\uFFFD"), false);
    assert.equal(calls, 2);
  } finally { await cleanup(directory); }
});

test("real DSH keeps large complete inputs and prior tool turns in the second physical request", { timeout: 60000 }, async () => {
  const directory = await scratch("pm-dsh-large-full-input-");
  const task = input(directory);
  task.skillText = "FULL-SKILL-SENTINEL: preserve every dependency byte across tool rounds";
  task.preset.prompt = { role: "FULL-ROLE-SENTINEL" };
  task.dependencyArtifacts = Array.from({ length: 4 }, (_, index) => {
    const content = `BEGIN-${index}\n` + Array.from({ length: 9000 }, (_, row) => `${index}:${row}:full-input-evidence\n`).join("") + `END-${index}`;
    assert.ok(Buffer.byteLength(content) < 256 * 1024);
    return { ...task.dependencyArtifacts[0]!, id: `large-${index}`, path: `dependency-${index}.md`, content,
      sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content) };
  });
  assert.ok(task.dependencyArtifacts.reduce((total, artifact) => total + artifact.content.length, 0) > 500000);
  const output = "REQUIREMENT-42: complete dependency payload and previous tool result survived";
  let calls = 0;
  let originalUser = "";
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(messages, options) {
    calls++;
    assert.equal(options?.thinking, "disabled");
    assert.deepEqual(options?.tools?.map((tool) => tool.function.name).sort(), ["list_files", "read_file", "write_file"]);
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    assert.match(system, /FULL-ROLE-SENTINEL/); assert.match(system, /FULL-SKILL-SENTINEL/);
    const user = messages.find((message) => message.role === "user" && message.content?.includes("完整输入数据："))?.content;
    assert.ok(user);
    const start = user.indexOf("完整输入数据：") + "完整输入数据：".length;
    const end = user.indexOf("。\n来源可回查：", start);
    assert.ok(end > start);
    const fullInput = JSON.parse(user.slice(start, end)) as { dependencyArtifacts: Array<{ content: string; sha256: string; path: string }> };
    assert.equal(fullInput.dependencyArtifacts.length, task.dependencyArtifacts.length);
    for (const [index, artifact] of fullInput.dependencyArtifacts.entries()) {
      assert.equal(artifact.content, task.dependencyArtifacts[index]!.content);
      assert.equal(createHash("sha256").update(artifact.content).digest("hex"), task.dependencyArtifacts[index]!.sha256);
      assert.equal(artifact.sha256, task.dependencyArtifacts[index]!.sha256);
      assert.equal(artifact.path, task.dependencyArtifacts[index]!.path);
    }
    if (calls === 1) {
      originalUser = user;
      return result(calls, [call(calls, "write_file", { path: "report.md", content: output })]);
    }
    assert.equal(calls, 2);
    assert.equal(user, originalUser);
    const priorCall = messages.flatMap((message) => message.role === "assistant" && "tool_calls" in message ? message.tool_calls ?? [] : []).find((tool) => tool.id === "call-1");
    assert.equal(priorCall?.function.arguments, JSON.stringify({ path: "report.md", content: output }));
    const priorResult = messages.find((message) => message.role === "tool" && message.tool_call_id === "call-1");
    assert.ok(priorResult?.content);
    assert.deepEqual(JSON.parse(priorResult.content), { path: "report.md", bytes: Buffer.byteLength(output), written: true });
    return result(calls);
  } };
  try {
    const delivered = await executor({ provider, timeoutMs: 45000 })(task);
    assert.equal(calls, 2); assert.equal(delivered.files[0]?.content, output);
    assert.equal(delivered.receipt?.usageComplete, true);
    const [home] = await readdir(directory);
    const patch = YAML.parse(await readFile(join(directory, home!, "profiles/pm-employee/cordis.patch.yml"), "utf8")) as Array<{
      id?: string; disabled?: boolean; config?: { providers?: Record<string, { models: Array<{ contextWindow: number; maxTokens: number }> }> };
    }>;
    for (const id of ["compaction-basic", "tool-result-pruner", "spill-policy", "image-offload"]) {
      assert.equal(patch.find((item) => item.id === id)?.disabled, true, `${id} must not silently remove input`);
    }
    const gateway = patch.find((item) => item.id === "llm-pi-ai" && item.config)?.config?.providers?.["pm-loopback"];
    assert.equal(gateway?.models[0]?.contextWindow, 1048576);
    assert.equal(gateway?.models[0]?.maxTokens, 393216);
  } finally { await cleanup(directory); }
});

test("a five-request two-file employee fails at four and completes within eight", { timeout: 45000 }, async () => {
  for (const limit of [4, 8]) {
    const directory = await scratch(`pm-dsh-five-round-${limit}-`);
    let calls = 0;
    const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(messages) {
      calls++;
      if (calls === 1) return result(calls, [call(calls, "read_file", { path: "inputs/context.json" })]);
      if (calls === 2) {
        const context = JSON.parse(JSON.parse(toolMessages(messages).at(-1)!).content);
        return result(calls, [call(calls, "read_file", { path: context.dependencyArtifacts[0].path })]);
      }
      if (calls === 3) return result(calls, [call(calls, "write_file", { path: "module.mjs", content: "export const value = 42;\n" })]);
      if (calls === 4) return result(calls, [call(calls, "write_file", { path: "module.test.mjs", content: "import{test}from'node:test';import assert from'node:assert/strict';import{value}from'./module.mjs';test('value',()=>assert.equal(value,42));\n" })]);
      return result(calls);
    } };
    const task = input(directory); task.task.outputRefs = ["module.mjs", "module.test.mjs"];
    try {
      if (limit === 4) {
        await assert.rejects(executor({ provider, maxModelCalls: limit, timeoutMs: 30000 })(task), (error: unknown) => (error as { code: string }).code === "DSH_MODEL_BUDGET");
        assert.equal(calls, 4);
      } else {
        const delivered = await executor({ provider, maxModelCalls: limit, timeoutMs: 30000 })(task);
        assert.equal(calls, 5); assert.equal(delivered.files.length, 2); assert.equal(delivered.receipt?.final, true);
      }
    } finally { await cleanup(directory); }
  }
});

test("provider quota refusal stays a blocked budget outcome without a retry", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-provider-quota-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() { calls++; throw new Error("模型调用失败：HTTP 429"); } };
  try {
    await assert.rejects(executor({ provider, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
      const failure = error as { code: string; receipt: { modelCalls: number; usageComplete: boolean } };
      assert.equal(failure.code, "DSH_MODEL_BUDGET"); assert.equal(failure.receipt.modelCalls, 1);
      assert.equal(failure.receipt.usageComplete, false); return true;
    });
    assert.equal(calls, 1);
  } finally { await cleanup(directory); }
});

test("real DSH denies host paths, unowned outputs and shell calls, then can finish legitimate output", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-negative-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(messages) {
    calls += 1;
    if (calls === 1) return result(calls, [call(1, "read_file", { path: "/etc/hosts" }), call(2, "write_file", { path: "../escape.txt", content: "denied" }), call(3, "bash", { command: "echo HOST_EXECUTION_MUST_NOT_HAPPEN" })]);
    if (calls === 2) {
      const failures = toolMessages(messages);
      assert.equal(failures.length, 3);
      assert.ok(failures.every((message) => message.startsWith("Error:")));
      assert.ok(failures.every((message) => !message.includes("127.0.0.1")));
      return result(calls, [call(4, "write_file", { path: "report.md", content: "REQUIREMENT-42: boundaries were enforced" })]);
    }
    return result(calls);
  } };
  try {
    const delivered = await executor({ provider, timeoutMs: 30000 })(input(directory));
    assert.equal(calls, 3);
    assert.match(delivered.files[0]!.content, /boundaries were enforced/);
    const results = delivered.receipt?.toolResults as Array<{ status: string }>;
    assert.equal(results.filter((item) => item.status === "error").length, 3);
    await assert.rejects(readFile(join(directory, "escape.txt")), { code: "ENOENT" });
  } finally { await cleanup(directory); }
});

test("real DSH cannot exceed model-call budget or claim a final without files", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-budget-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() { calls += 1; return result(calls, [call(calls, "list_files", {})]); } };
  try {
    await assert.rejects(executor({ provider, maxModelCalls: 1, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
      const failure = error as { code: string; usage: { promptTokens: number }; receipt: { modelCalls: number; usageComplete: boolean }; modelId: string };
      assert.equal(failure.code, "DSH_MODEL_BUDGET");
      assert.equal(failure.usage.promptTokens, 101);
      assert.equal(failure.receipt.modelCalls, 1);
      assert.equal(failure.receipt.usageComplete, true);
      assert.equal(failure.modelId, "deepseek-flash");
      return true;
    });
    assert.equal(calls, 1);
    await assert.rejects(executor({ provider: { modelId: "deepseek-flash", async complete() { return result(1); } }, timeoutMs: 30000 })(input(directory)), (error: unknown) => (error as { code: string }).code === "DSH_OUTPUT_MISSING");
  } finally { await cleanup(directory); }
});

test("real DSH freezes after missing usage and persists an incomplete accounting receipt", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-usage-");
  let calls = 0;
  const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() {
    calls += 1;
    return { ...result(calls, [call(calls, "list_files", {})]), usage: undefined };
  } };
  try {
    await assert.rejects(executor({ provider, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
      const failure = error as { code: string; usage: { promptTokens: number }; receipt: { modelCalls: number; usageComplete: boolean } };
      assert.equal(failure.code, "DSH_USAGE");
      assert.equal(failure.usage.promptTokens, 0);
      assert.equal(failure.receipt.modelCalls, 1);
      assert.equal(failure.receipt.usageComplete, false);
      return true;
    });
    assert.equal(calls, 1);
    const [home] = await readdir(directory);
    const failure = JSON.parse(await readFile(join(directory, home!, "failure.json"), "utf8")) as { code: string; receipt: { usageComplete: boolean } };
    assert.equal(failure.code, "DSH_USAGE");
    assert.equal(failure.receipt.usageComplete, false);
  } finally { await cleanup(directory); }
});

for (const mode of ["cancel", "timeout"] as const) {
  test(`real DSH propagates ${mode}, meters the actual startup stage, and retains partial JSON events`, { timeout: 45000 }, async () => {
    const directory = await scratch(`pm-dsh-${mode}-`);
    const controller = new AbortController();
    let calls = 0;
    let aborted = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const provider: CompletionProvider = { modelId: "deepseek-flash", async complete(_messages, options) {
      calls += 1;
      assert.ok(options?.signal);
      if (mode === "cancel") cancelTimer = setTimeout(() => controller.abort(), 20);
      return await new Promise<never>((_done, fail) => {
        const onAbort = () => { aborted = true; fail(options!.signal!.reason); };
        options!.signal!.addEventListener("abort", onAbort, { once: true });
        if (options!.signal!.aborted) onAbort();
      });
    } };
    try {
      await assert.rejects(executor({ provider, timeoutMs: mode === "timeout" ? 5000 : 30000 })(input(directory, controller.signal)), (error: unknown) => {
        const failure = error as { code: string; receipt: { modelCalls: number; usageComplete: boolean; stdoutSha256: string } };
        assert.equal(failure.code, mode === "timeout" ? "DSH_TIMEOUT" : "DSH_CANCELLED");
        // A real wall-clock deadline may expire while the pinned child is still
        // starting. It must then report zero requests and complete zero usage,
        // rather than inventing an in-flight model call. The cancel scenario is
        // triggered inside complete(), so it always verifies in-flight abort.
        assert.equal(failure.receipt.modelCalls, calls);
        assert.ok(mode === "timeout" ? calls === 0 || calls === 1 : calls === 1);
        assert.equal(failure.receipt.usageComplete, calls === 0);
        assert.match(failure.receipt.stdoutSha256, /^[a-f0-9]{64}$/);
        return true;
      });
      assert.equal(aborted, calls > 0);
      const [home] = await readdir(directory);
      const stdout = await readFile(join(directory, home!, "stdout.jsonl"), "utf8");
      const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
      if (calls > 0) assert.equal(events[0]?.type, "session");
      else assert.ok(events.length === 0 || events[0]?.type === "session");
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      await cleanup(directory);
    }
  });
}

for (const fault of ["model", "length", "response-id", "thinking"] as const) {
  test(`DSH rejects intermediate ${fault} receipt faults before any tool writes`, { timeout: 45000 }, async () => {
    const directory = await scratch(`pm-dsh-receipt-${fault}-`);
    let calls = 0;
    const provider: CompletionProvider = { modelId: "deepseek-flash", async complete() {
      calls++;
      const completion = calls === 1 ? result(calls, [call(calls, "write_file", { path: "report.md", content: "UNTRUSTED-RESPONSE" })]) : result(calls);
      if (calls === 1) {
        if (fault === "model") completion.model = "different-model";
        if (fault === "length") completion.finishReason = "length";
        if (fault === "response-id") completion.responseId = undefined;
        if (fault === "thinking") completion.usage!.completion_tokens_details = { reasoning_tokens: 1 };
      }
      return completion;
    } };
    try {
      await assert.rejects(executor({ provider, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
        const failure = error as { code: string; usage: { promptTokens: number }; receipt: { modelCalls: number; usageComplete: boolean } };
        assert.equal(failure.code, fault === "model" ? "MODEL_DRIFT" : fault === "thinking" ? "MODEL_MODE_MISMATCH" : "MODEL_RECEIPT_MISSING");
        assert.equal(failure.usage.promptTokens, 101);
        assert.equal(failure.receipt.modelCalls, 1);
        assert.equal(failure.receipt.usageComplete, true);
        return true;
      });
      assert.equal(calls, 1);
      const [home] = await readdir(directory);
      await assert.rejects(readFile(join(directory, home!, "workspace/report.md")), { code: "ENOENT" });
    } finally { await cleanup(directory); }
  });
}

test("DSH preserves paid usage when the provider rejects an empty truncated protocol response", { timeout: 45000 }, async () => {
  const directory = await scratch("pm-dsh-provider-metered-failure-");
  let calls = 0;
  const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://synthetic.invalid",
    fetch: async () => { calls++; return Response.json({ id: "fixture-paid-protocol", model: "deepseek-flash",
      choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: "private-thought-not-for-receipts" } }],
      usage: { prompt_tokens: 101, completion_tokens: 8192, total_tokens: 8293 } }); } });
  try {
    await assert.rejects(executor({ provider, timeoutMs: 30000 })(input(directory)), (error: unknown) => {
      const failure = error as { code: string; usage: { promptTokens: number; completionTokens: number }; receipt: { modelCalls: number; usageComplete: boolean } };
      assert.equal(failure.code, "DSH_WORKER_FAILED");
      assert.deepEqual(failure.usage, { promptTokens: 101, completionTokens: 8192 });
      assert.equal(failure.receipt.modelCalls, 1); assert.equal(failure.receipt.usageComplete, true);
      assert.doesNotMatch(JSON.stringify(error), /private-thought-not-for-receipts/);
      return true;
    });
    assert.equal(calls, 1);
    const [home] = await readdir(directory);
    await assert.rejects(readFile(join(directory, home!, "workspace/report.md")), { code: "ENOENT" });
  } finally { await cleanup(directory); }
});

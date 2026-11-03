import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_DEEPSEEK_MODEL, type CompletionOptions, type CompletionResult, type ProviderMessage } from "@workloom/base/model-router";
import { maskText } from "@workloom/base/workdata";
import { createReviewedEmployeeExecutor, parsePmSemanticReview, SEMANTIC_REVIEW_CHECKS } from "./semantic-review.js";
import type { EmployeeExecutionInput, EmployeeExecutionResult, EmployeeExecutor } from "./types.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(resolve(process.cwd(), ".."), "pm-semantic-review-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function input(): EmployeeExecutionInput {
  return { scope: { tenantId: "fixture", workspaceId: "fixture" }, runId: "fixture-review",
    task: { id: "document", presetKey: "data-insight", goal: "两个金额为2和4。计算总额，完整写入报告。", dependsOn: [], acceptance: ["计算与所有段落一致"], outputRefs: ["result.md"] },
    preset: { agentId: "fixture", presetKey: "data-insight", version: "v1", highRisk: false, tools: [], fenceBindings: [], prompt: { role: "分析员" },
      essentials: { goal: "两个金额为2和4。计算总额，完整写入报告。", stage: "delivery", archive: {} } },
    skillText: "明确给定条件优先；数值必须复算，完整交付。", dependencyArtifacts: [], outputDir: directory, signal: new AbortController().signal };
}
function generated(content = "合计6"): EmployeeExecutionResult {
  return { files: [{ path: "result.md", content }], summary: "已生成报告。", usage: { promptTokens: 20, completionTokens: 10 },
    modelId: DEFAULT_DEEPSEEK_MODEL, responseId: "generation-response", receipt: { adapter: "deepseek-completion", modelRequests: 1, finishReason: "stop", rawResponseSha256: "a".repeat(64) } };
}
function review(verdict: "pass" | "repair" | "blocked" = "pass") {
  return { verdict,
    checks: SEMANTIC_REVIEW_CHECKS.map((name, index) => ({ name, status: verdict !== "pass" && index === 0 ? "fail" : "pass", explanation: "依据完整材料核对。" })),
    issues: verdict === "repair" ? [{ id: "sum-1", kind: "arithmetic", sourceId: "task-goal", sourceQuote: "两个金额为2和4。",
      outputPath: "result.md", outputQuote: "合计7", verification: "2加4为6，产物把总额写为7。", correction: "将总额及相关摘要统一修正为6。",
      calculation: { operator: "sum", operands: [2, 4], expected: 6, actual: 7 } }] : [],
    blockedReason: verdict === "blocked" ? "两项明确要求无法同时满足，需原需求裁决。" : "" };
}
function completion(text: string, extra: Partial<CompletionResult> = {}): CompletionResult {
  return { text, message: { role: "assistant", content: text }, model: DEFAULT_DEEPSEEK_MODEL, responseId: "stage-response",
    finishReason: "stop", promptTokens: 10, completionTokens: 5, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...extra };
}
function providerWith(responses: Array<CompletionResult | Error>) {
  let position = 0;
  const complete = vi.fn(async (_messages: ProviderMessage[], opts?: CompletionOptions) => {
    await opts?.beforeRequest?.({ messages: _messages, tools: [], model: DEFAULT_DEEPSEEK_MODEL, maxTokens: 393216,
      signal: opts.signal ?? new AbortController().signal, body: { model: DEFAULT_DEEPSEEK_MODEL } });
    const next = responses[position++];
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected extra call");
    return next;
  });
  return { modelId: DEFAULT_DEEPSEEK_MODEL, complete };
}
const source = [{ id: "task-goal", content: "两个金额为2和4。计算总额，完整写入报告。" }];

describe("semantic review evidence contract", () => {
  it("requires every check once and forbids pass with issues or unresolved failure", () => {
    expect(parsePmSemanticReview(JSON.stringify(review()), source, [{ path: "result.md", content: "合计6" }]).verdict).toBe("pass");
    const missing = review(); missing.checks[1] = missing.checks[0]!;
    expect(() => parsePmSemanticReview(JSON.stringify(missing), source, [{ path: "result.md", content: "合计6" }])).toThrow("检查项");
    const contradiction = { ...review("repair"), verdict: "pass" };
    expect(() => parsePmSemanticReview(JSON.stringify(contradiction), source, [{ path: "result.md", content: "合计7" }])).toThrow("通过");
    const notApplicable = review(); notApplicable.checks[0]!.status = "not_applicable";
    expect(() => parsePmSemanticReview(JSON.stringify(notApplicable), source, [{ path: "result.md", content: "合计6" }])).toThrow("不适用");
  });
  it("binds both quotes to this source and owned candidate, and recomputes arithmetic", () => {
    const good = review("repair");
    expect(parsePmSemanticReview(JSON.stringify(good), source, [{ path: "result.md", content: "合计7" }]).issues).toHaveLength(1);
    for (const patch of [ { sourceQuote: "不存在的原句" }, { sourceId: "hidden-oracle" }, { outputPath: "other.md" }, { outputQuote: "合计8" },
      { calculation: { operator: "sum", operands: [2, 4], expected: 8, actual: 7 } }, { calculation: { operator: "divide", operands: [6, 0], expected: 0, actual: 7 } },
      { calculation: undefined } ]) {
      const changed = { ...good, issues: [{ ...good.issues[0], ...patch }] };
      expect(() => parsePmSemanticReview(JSON.stringify(changed), source, [{ path: "result.md", content: "合计7" }])).toThrow();
    }
  });
  it("rebinds a verbatim quote from a known mislabelled source and rejects ambiguous matches", () => {
    const decision = JSON.stringify(review("repair"));
    const files = [{ path: "result.md", content: "合计7" }];
    const sources = [{ id: "task-goal", content: "仅提供一份计算报告。" },
      { id: "original-goal", content: source[0]!.content }];
    expect(parsePmSemanticReview(decision, sources, files).issues[0]).toMatchObject({
      sourceId: "original-goal", reportedSourceId: "task-goal",
    });
    expect(parsePmSemanticReview(decision, [...sources, { id: "dependency-1", content: source[0]!.content }], files)
      .issues[0]!.sourceId).toBe("original-goal");
    expect(() => parsePmSemanticReview(decision, [...sources, { id: "dependency-1", content: "反例：两个金额为2和4。" }], files))
      .toThrow("引文");
  });
  it("counts Unicode code points and rejects forged text in a length proof", () => {
    const proof = { ...review("repair"), issues: [{ ...review("repair").issues[0], sourceQuote: "两个金额为2和4。", outputQuote: "🙂甲 长度3",
      calculation: { operator: "codepoints", operands: [], text: "🙂甲", expected: 2, actual: 3 } }] };
    expect(parsePmSemanticReview(JSON.stringify(proof), source, [{ path: "result.md", content: "🙂甲 长度3" }]).verdict).toBe("repair");
    proof.issues[0]!.calculation.text = "其他字符串";
    expect(() => parsePmSemanticReview(JSON.stringify(proof), source, [{ path: "result.md", content: "🙂甲 长度3" }])).toThrow("精确字符串");
  });
  it("rejects fabricated operands and an actual value not present in the output quote", () => {
    const proof = review("repair");
    proof.issues[0]!.outputQuote = "合计6";
    proof.issues[0]!.calculation = { operator: "sum", operands: [1, 2], expected: 3, actual: 6 };
    expect(() => parsePmSemanticReview(JSON.stringify(proof), source, [{ path: "result.md", content: "合计6" }])).toThrow("操作数");
    proof.issues[0]!.calculation = { operator: "sum", operands: [2, 4], expected: 6, actual: 7 };
    expect(() => parsePmSemanticReview(JSON.stringify(proof), source, [{ path: "result.md", content: "合计6" }])).toThrow("实际值");
  });
});

describe("same canonical model review and targeted repair", () => {
  it("keeps a clean artifact byte-identical, uses enabled/high review, and counts both paid stages", async () => {
    const provider = providerWith([completion(JSON.stringify(review()), { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 3 } } })]);
    const generate = vi.fn(async () => generated("# 完整报告\n合计6\n"));
    const task = input();
    task.dependencyArtifacts = [{ id: "artifact", runId: "upstream", taskId: "source", path: "source.md", sha256: "b".repeat(64), sizeBytes: 30,
      mediaType: "text/markdown", verifiedAt: "2026-01-01", content: "完整上游材料，不得丢弃末尾SOURCE-TAIL" }];
    const result = await createReviewedEmployeeExecutor(provider, generate)(task);
    expect(generate).toHaveBeenCalledOnce(); expect(provider.complete).toHaveBeenCalledOnce();
    expect(result.files[0]!.content).toBe("# 完整报告\n合计6\n");
    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 15 });
    expect(result.receipt).toMatchObject({ final: true, modelRequests: 2, modelRequestsComplete: true, usageComplete: true });
    const [messages, options] = provider.complete.mock.calls[0]!;
    expect(options).toMatchObject({ thinking: "enabled", reasoningEffort: "high", responseFormat: { type: "json_object" }, requireUsage: true });
    expect(options).not.toHaveProperty("maxTokens");
    expect(messages[1]!.content).toContain("SOURCE-TAIL"); expect(messages[1]!.content).toContain(task.skillText);
    const evidenceDir = join(directory, String(result.receipt!.evidenceDirectory));
    expect(await readdir(evidenceDir)).toEqual(["00-generation.json"]); // no raw review protocol persisted
    expect(JSON.parse(await readFile(join(evidenceDir, "00-generation.json"), "utf8")).files).toEqual(result.files);
  });
  it("repairs a proven issue then re-reviews, preserving both business drafts and all four receipts", async () => {
    const provider = providerWith([completion(JSON.stringify(review("repair")), { responseId: "first-review" }),
      completion("合计6", { responseId: "revision-response" }), completion(JSON.stringify(review()), { responseId: "second-review" })]);
    const result = await createReviewedEmployeeExecutor(provider, async () => generated("合计7"))(input());
    expect(result.files).toEqual([{ path: "result.md", content: "合计6" }]);
    expect(result.usage).toEqual({ promptTokens: 50, completionTokens: 25 });
    expect(result.responseId).toBe("revision-response");
    expect(result.receipt).toMatchObject({ modelRequests: 4, usageComplete: true, selectedArtifactResponseId: "revision-response" });
    const stages = result.receipt!.stages as Array<Record<string, unknown>>;
    expect(stages.map((stage) => stage.stage)).toEqual(["generation", "review", "revision", "review"]);
    expect(stages[1]).toMatchObject({ findings: [{ sourceQuoteSha256: expect.any(String), outputQuoteSha256: expect.any(String) }] });
    expect(JSON.stringify(stages)).not.toContain('"sourceQuote":');
    expect(provider.complete.mock.calls[1]![1]).toMatchObject({ thinking: "disabled", responseFormat: { type: "text" } });
    const evidenceDir = join(directory, String(result.receipt!.evidenceDirectory));
    expect((await readdir(evidenceDir)).sort()).toEqual(["00-generation.json", "02-revision.json"]);
    expect(await readFile(join(evidenceDir, "00-generation.json"), "utf8")).toContain("合计7");
    expect(await readFile(join(evidenceDir, "02-revision.json"), "utf8")).toContain("合计6");
  });
  it("stops after two repairs and never turns remaining issues into a pass", async () => {
    const provider = providerWith([completion(JSON.stringify(review("repair"))), completion("合计7"),
      completion(JSON.stringify(review("repair"))), completion("合计7"), completion(JSON.stringify(review("repair")))]);
    const error = await createReviewedEmployeeExecutor(provider, async () => generated("合计7"))(input()).catch((value) => value);
    expect(error).toMatchObject({ code: "SEMANTIC_REVIEW_FAILED", usage: { promptTokens: 70, completionTokens: 35 },
      receipt: { final: false, modelRequests: 6, usageComplete: true } });
    expect(provider.complete).toHaveBeenCalledTimes(5);
  });
  it.each([
    { name: "length", result: completion("partial", { finishReason: "length" }), code: "MODEL_RECEIPT_MISSING", complete: true },
    { name: "empty final", result: completion(""), code: "MODEL_RECEIPT_MISSING", complete: true },
    { name: "model drift", result: completion(JSON.stringify(review()), { model: "other-provider-model" }), code: "MODEL_IDENTITY_MISMATCH", complete: true },
    { name: "missing usage", result: completion(JSON.stringify(review()), { usage: undefined }), code: "MODEL_RECEIPT_MISSING", complete: false },
    { name: "missing response ID", result: completion(JSON.stringify(review()), { responseId: undefined }), code: "MODEL_RECEIPT_MISSING", complete: true },
    { name: "invalid JSON", result: completion("broken JSON"), code: "INVALID_MODEL_JSON", complete: true },
  ])("does not retry $name and retains earlier paid usage", async ({ result, code, complete }) => {
    const provider = providerWith([result]);
    const error = await createReviewedEmployeeExecutor(provider, async () => generated())(input()).catch((value) => value);
    expect(error).toMatchObject({ code, receipt: { final: false, usageComplete: complete } });
    expect(error.usage).toEqual(complete ? { promptTokens: 30, completionTokens: 15 } : { promptTokens: 20, completionTokens: 10 });
    expect(provider.complete).toHaveBeenCalledOnce();
  });
  it("preserves metered protocol rejection and keeps unknown transport usage explicitly unresolved", async () => {
    const paid = Object.assign(new Error("protocol rejected"), { usage: { promptTokens: 9, completionTokens: 4 }, modelId: DEFAULT_DEEPSEEK_MODEL, responseId: "paid-rejection" });
    const provider = providerWith([paid]);
    const failure = await createReviewedEmployeeExecutor(provider, async () => generated())(input()).catch((value) => value);
    expect(failure).toMatchObject({ usage: { promptTokens: 29, completionTokens: 14 }, receipt: { usageComplete: true, modelRequests: 2 } });
    const unknown = providerWith([new Error("network failed")]);
    const rejected = await createReviewedEmployeeExecutor(unknown, async () => generated())(input()).catch((value) => value);
    expect(rejected).toMatchObject({ usage: { promptTokens: 20, completionTokens: 10 }, receipt: { usageComplete: false, modelRequestsComplete: false,
      stages: [{ stage: "generation" }, { stage: "review", dispatch: "sent_usage_unknown" }] } });
    expect(unknown.complete).toHaveBeenCalledOnce();
  });
  it("honors a definitive zero-I/O denial after beforeRequest and marks unknown returned usage for reconciliation", async () => {
    const denied = providerWith([Object.assign(new Error("durable admission rejected"), { dispatchState: "blocked-before-send" })]);
    const failure = await createReviewedEmployeeExecutor(denied, async () => generated())(input()).catch((value) => value);
    expect(failure).toMatchObject({ usage: { promptTokens: 20, completionTokens: 10 }, receipt: { modelRequests: 1,
      modelRequestsComplete: true, usageComplete: true, reconciliationRequired: false,
      stages: [{ stage: "generation" }, { stage: "review", dispatch: "blocked_before_send" }] } });
    const unknown = providerWith([completion(JSON.stringify(review()), { usage: undefined })]);
    const unresolved = await createReviewedEmployeeExecutor(unknown, async () => generated())(input()).catch((value) => value);
    expect(unresolved).toMatchObject({ receipt: { usageComplete: false, reconciliationRequired: true } });
    expect(denied.complete).toHaveBeenCalledOnce(); expect(unknown.complete).toHaveBeenCalledOnce();
  });
  it("validates review anchors against the exact masked JSON view sent to the provider", async () => {
    const task = input();
    task.task.goal = task.preset.essentials.goal = "联系人 case.person@example.test；两个金额为2和4。";
    const original = "联系人 case.person@example.test；合计7";
    const fixed = "联系人已脱敏；合计6";
    const finding = review("repair");
    finding.issues[0]!.sourceQuote = maskText(task.task.goal).text;
    finding.issues[0]!.outputQuote = maskText(original).text;
    const provider = providerWith([completion(JSON.stringify(finding)), completion(fixed), completion(JSON.stringify(review()))]);
    const result = await createReviewedEmployeeExecutor(provider, async () => generated(original))(task);
    expect(result.files[0]!.content).toBe(fixed);
    const sent = String(provider.complete.mock.calls[0]![0][1]!.content);
    expect(sent).not.toContain("case.person@example.test"); expect(sent).toContain("[PII:EMAIL:");
    expect(result.receipt).toMatchObject({ semanticAnchorView: "provider-masked", modelRequests: 4 });
  });
  it("allows one metered anchor correction on the same immutable draft without applying the invalid critique", async () => {
    const invalid = review("repair"); invalid.issues[0]!.outputQuote = "未写入的段落";
    const provider = providerWith([completion(JSON.stringify(invalid), { responseId: "bad-anchor" }),
      completion(JSON.stringify(review("repair")), { responseId: "anchored" }),
      completion("合计6", { responseId: "revised" }), completion(JSON.stringify(review()), { responseId: "final-review" })]);
    const result = await createReviewedEmployeeExecutor(provider, async () => generated("合计7"))(input());
    expect(result.files[0]!.content).toBe("合计6");
    expect(result.usage).toEqual({ promptTokens: 60, completionTokens: 30 });
    expect(result.receipt).toMatchObject({ modelRequests: 5, usageComplete: true, stages: [
      { stage: "generation" }, { stage: "review", status: "failed", anchorError: "candidate", responseId: "bad-anchor" },
      { stage: "review", anchorCorrection: "candidate", verdict: "repair" }, { stage: "revision" }, { stage: "review", verdict: "pass" },
    ] });
    const [first, retry] = provider.complete.mock.calls;
    expect(first![0][1]!.content).toBe(retry![0][1]!.content);
    expect(retry![0][0]!.content).not.toContain(invalid.issues[0]!.outputQuote);
    expect(retry![1]).toMatchObject({ thinking: "enabled", reasoningEffort: "high", requireUsage: true });
  });
  it("stops if a settled anchor correction fails again, and never retries unknown usage", async () => {
    const invalid = review("repair"); invalid.issues[0]!.sourceQuote = "外部新规则";
    const bad = completion(JSON.stringify(invalid));
    const provider = providerWith([bad, bad]);
    const error = await createReviewedEmployeeExecutor(provider, async () => generated("合计7"))(input()).catch(e => e);
    expect(error).toMatchObject({ code: "SEMANTIC_REVIEW_INVALID", receipt: { modelRequests: 3, usageComplete: true } });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const unmetered = providerWith([{ ...bad, usage: undefined }]);
    const unknown = await createReviewedEmployeeExecutor(unmetered, async () => generated("合计7"))(input()).catch(e => e);
    expect(unknown).toMatchObject({ code: "MODEL_RECEIPT_MISSING", receipt: { usageComplete: false, reconciliationRequired: true } });
    expect(unmetered.complete).toHaveBeenCalledOnce();
  });
  it("blocks an unresolved source contradiction without anchor correction", async () => {
    const blocked = providerWith([completion(JSON.stringify(review("blocked")))]);
    await expect(createReviewedEmployeeExecutor(blocked, async () => generated())(input())).rejects.toMatchObject({ code: "SEMANTIC_REVIEW_BLOCKED" });
    expect(blocked.complete).toHaveBeenCalledOnce();
  });
  it("keeps output ownership on revision and snapshots it before an injected generator mutates input", async () => {
    const provider = providerWith([completion(JSON.stringify(review()))]);
    const generate: EmployeeExecutor = async (task) => { task.task.outputRefs = ["other.md"]; return { ...generated(), files: [{ path: "other.md", content: "unowned" }] }; };
    await expect(createReviewedEmployeeExecutor(provider, generate)(input())).rejects.toMatchObject({ code: "UNDECLARED_ARTIFACT" });
    expect(provider.complete).not.toHaveBeenCalled();
    const task = input(); task.task.outputRefs = ["result.md", "second.md"];
    const revision = providerWith([completion(JSON.stringify(review("repair"))), completion(JSON.stringify({ files: [{ path: "result.md", content: "合计6" }], summary: "缺文件" }))]);
    const twoFiles = { ...generated("合计7"), files: [{ path: "result.md", content: "合计7" }, { path: "second.md", content: "辅助说明" }] };
    await expect(createReviewedEmployeeExecutor(revision, async () => twoFiles)(task)).rejects.toMatchObject({ code: "MISSING_ARTIFACT", usage: { promptTokens: 40, completionTokens: 20 } });
    expect(revision.complete).toHaveBeenCalledTimes(2);
  });
  it("stops on cancellation, evidence persistence failure, and noncanonical provider before later calls", async () => {
    const provider = providerWith([]);
    const controller = new AbortController(); controller.abort(); const task = input(); task.signal = controller.signal;
    const generate = vi.fn(async () => generated());
    await expect(createReviewedEmployeeExecutor(provider, generate)(task)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    const missingDirectory = input(); missingDirectory.outputDir = join(directory, "missing");
    const failed = await createReviewedEmployeeExecutor(provider, generate)(missingDirectory).catch((value) => value);
    expect(failed).toMatchObject({ usage: { promptTokens: 20, completionTokens: 10 }, receipt: { final: false } });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(() => createReviewedEmployeeExecutor({ ...provider, modelId: "mock" }, generate)).toThrow("同一已登记");
  });
});

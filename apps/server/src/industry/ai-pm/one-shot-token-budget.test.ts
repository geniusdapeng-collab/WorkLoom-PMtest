import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "@workloom/base/model-router";
import { createOneShotEmployeeExecutor } from "./service.js";
import type { EmployeeExecutionInput } from "./types.js";

describe("PM complete input and actual wire window", () => {
  it("passes a dependency beyond the historical 96KiB limit intact and records the actual window", async () => {
    const content = "SOURCE-HEAD\n" + "完整原始材料🙂".repeat(7000) + "\nSOURCE-TAIL";
    expect(Buffer.byteLength(content)).toBeGreaterThan(96 * 1024);
    const request = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      expect(JSON.parse(body.messages[1].content).dependencyArtifacts[0].content).toBe(content);
      expect(body).toMatchObject({ model: "deepseek-flash", max_tokens: 393216, thinking: { type: "disabled" } });
      return Response.json({ id: "fixture-window", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "# 完整产物" } }],
        usage: { prompt_tokens: 42000, completion_tokens: 12, total_tokens: 42012 } });
    });
    const input: EmployeeExecutionInput = {
      scope: { tenantId: "fixture", workspaceId: "fixture" }, runId: "fixture-window",
      task: { id: "summary", presetKey: "chief-pm", goal: "按全部原始证据总结", dependsOn: ["upstream"], acceptance: ["保留来源"], outputRefs: ["result.md"] },
      preset: { agentId: "fixture", presetKey: "chief-pm", version: "v1", highRisk: false, tools: [], fenceBindings: [], prompt: { role: "统筹" },
        essentials: { goal: "完整原始目标", stage: "delivery", archive: {} } },
      skillText: "核实事实", dependencyArtifacts: [{ id: "fixture-source", runId: "fixture-window", taskId: "upstream", path: "source.md", content,
        sizeBytes: Buffer.byteLength(content), mediaType: "text/markdown", verifiedAt: "2026-11-03T00:00:00.000Z", sha256: createHash("sha256").update(content).digest("hex") }],
      outputDir: "/unused-fixture", signal: new AbortController().signal,
    };
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: "https://api.deepseek.com", fetch: request });
    const result = await createOneShotEmployeeExecutor(provider)(input);
    expect(request).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({ outputTokenLimit: 393216, modelRequest: { model: "deepseek-flash", maxTokens: 393216, contextTokens: 1048576 } });
    expect((result.receipt!.modelRequest as { fullInputTokens: number }).fullInputTokens).toBeGreaterThan(7000);
  }, 30_000);
});

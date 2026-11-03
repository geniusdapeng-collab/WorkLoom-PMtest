import { describe, expect, it } from "vitest";
import { parseTeamPlan } from "./contract.js";
import { reconcilePmTeamPlan } from "./planning.js";
import type { PmTaskPlan } from "./types.js";
const employees = ["chief-pm", "doc-writer", "requirement-analyst", "dev-orchestrator", "eval-master", "red-teamer", "user-listener", "model-scout"];
const task = (id: string, presetKey: string, path: string, goal = "完成明确岗位产物", dependsOn: string[] = []): PmTaskPlan => ({ id, presetKey, goal, dependsOn, acceptance: ["内容满足目标"], outputRefs: [path] });
const reconcile = (tasks: PmTaskPlan[]) => reconcilePmTeamPlan(parseTeamPlan({ tasks }, employees), { allowedEmployees: employees });
describe("professional plan ownership and evidence dependency", () => {
  it("uses the artifact basename before an incidental project directory", () => {
    expect(reconcile([task("prd", "doc-writer", "security/prd.md")]).plan[0]?.presetKey).toBe("doc-writer");
    expect(reconcile([task("requirements", "requirement-analyst", "eval/requirements.md")]).plan[0]?.presetKey).toBe("requirement-analyst");
  });
  it("does not equate a generic review with customer-feedback work", () => {
    expect(reconcile([task("review", "eval-master", "review.md")]).plan[0]?.presetKey).toBe("eval-master");
  });
  it("does not override a semantic owner using an ambiguous compound filename", () => {
    expect(reconcile([task("assessment", "model-scout", "model-eval.md")]).plan[0]?.presetKey).toBe("model-scout");
  });
  it("rejects missing dependency edges when a task explicitly consumes another output", () => {
    expect(() => reconcile([task("source", "requirement-analyst", "requirements.md"), task("prd", "doc-writer", "prd.md", "根据 requirements.md 编写完整 PRD")])).toThrow(/依赖/);
  });
  it("accepts transitive evidence dependencies and does not require a self-edge", () => {
    const result = reconcile([task("source", "requirement-analyst", "requirements.md"), task("draft", "doc-writer", "prd.md", "根据 requirements.md 编写 PRD", ["source"]), task("review", "eval-master", "review.md", "核对 requirements.md 与 prd.md，输出 review.md", ["draft"])]);
    expect(result.plan.map(t => t.dependsOn)).toEqual([[], ["source"], ["draft"]]);
  });
  it("does not mistake a different path suffix for a consumed file", () => {
    expect(() => reconcile([task("source", "requirement-analyst", "requirements.md"), task("other", "doc-writer", "guide.md", "说明 old-requirements.md 的历史背景")])).not.toThrow();
  });
});

it("keeps generic summaries with their professional evidence-producing role", () => {
  for (const [role, path] of [["eval-master", "eval/summary.md"], ["chief-pm", "summary.md"], ["red-teamer", "security/summary.md"]]) {
    expect(reconcile([task("summary", role!, path!)]).plan[0]?.presetKey).toBe(role);
  }
});

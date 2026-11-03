import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPmEmployeeCatalog } from "./employees.js";

const doubles = vi.hoisted(() => ({ assemble: vi.fn(), assets: vi.fn(), manifest: vi.fn() }));
vi.mock("@workloom/runtime", () => ({ assemblePreset: doubles.assemble }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({}) }));
vi.mock("@workloom/base/bundles", () => ({ bundlesRoot: () => "/fixture", loadVerifiedBundleManifest: doubles.manifest, loadVerifiedBundleWorkforcePresets: doubles.assets }));
vi.mock("../../service/active-bundle.js", () => ({ resolveWorkspaceActiveBundle: async () => ({ state: "ready", bundleId: "ai-pm" }) }));
const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" };
const source = { preset_key: "red-teamer", name: "红队官", description: "隔离质量评测", version: "v3.0", readonly: false,
  high_risk: true, fence_bindings: ["R-PM13"], skills: [], prompt: { role: "verified-source" },
  tools: [{ name: "redteam.report.write", access: "write" }, { name: "redteam.targets.read", access: "read" }] };
const assembled = () => ({ agentId: "fixture-agent", presetKey: source.preset_key, version: source.version, highRisk: true,
  fenceBindings: ["R-PM13", "EXTRA-TIGHTER"], tools: structuredClone(source.tools), prompt: { role: "stale database" },
  essentials: { goal: "检查隔离候选", stage: "delivery", archive: { fixture: true } } });
beforeEach(() => {
  doubles.assets.mockReturnValue([structuredClone(source)]);
  doubles.manifest.mockReturnValue({ version: "3.0.1", workloom: { provides: { skills: [], presets: ["presets/red-teamer.yml"] } },
    integrity: { digest: "a".repeat(64), assets: { "presets/red-teamer.yml": "b".repeat(64) } } });
  doubles.assemble.mockResolvedValue(assembled());
});
const catalog = () => createPmEmployeeCatalog({ employees: async () => [{ presetKey: "red-teamer", name: "红队官", description: "ready" }] });
describe("PM employee source and runtime authority agreement", () => {
  it("keeps extra tightened bindings and uses the verified prompt", async () => {
    const result = await catalog().assemble(scope, "red-teamer", "检查隔离候选");
    expect(result.preset.prompt).toEqual(source.prompt);
    expect(result.preset.fenceBindings).toEqual(["R-PM13", "EXTRA-TIGHTER"]);
  });
  it.each([
    ["missing source fence", { fenceBindings: ["UNRELATED"] }],
    ["lowered risk", { highRisk: false }],
    ["wrong employee identity", { presetKey: "doc-writer" }],
    ["duplicated tool hiding a missing declaration", { tools: [source.tools[0], source.tools[0]] }],
  ])("rejects %s before executing any employee", async (_name, patch) => {
    doubles.assemble.mockResolvedValue({ ...assembled(), ...patch });
    await expect(catalog().assemble(scope, "red-teamer", "检查隔离候选")).rejects.toMatchObject({ code: "EMPLOYEE_ASSET_DRIFT" });
  });
});

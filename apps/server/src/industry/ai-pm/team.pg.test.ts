import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssembledPreset } from "@workloom/runtime";
import { bundlesRoot, loadVerifiedBundleManifest, loadVerifiedBundleWorkforcePresets } from "@workloom/base/bundles";
import { OpenAiCompatibleProvider, type CompletionProvider, type CompletionResult } from "@workloom/base/model-router";
import { ArtifactStore } from "./artifacts.js";
import { PmTeamService, createOneShotEmployeeExecutor } from "./service.js";
import { PgPmStore } from "./store.js";
import { PmError, type EmployeeExecutionInput, type EmployeeExecutionResult, type PmAssetBinding, type PmTaskPlan, type PmScope } from "./types.js";
import { createPmEmployeeCatalog, type PmEmployeeCatalog } from "./employees.js";
import { TRUSTED_PM_EVIDENCE_POLICY } from "./skill-contracts.js";
import { requireIsolatedPgTestConfig } from "../../test-support/isolated-pg.js";

const enabled = process.env.RUN_DB_TESTS === "1";
const run = enabled ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const scopeA = { tenantId: `tenant-pmtest-${suffix}-a`, workspaceId: `ws-pmtest-${suffix}-a` };
const scopeB = { tenantId: `tenant-pmtest-${suffix}-b`, workspaceId: `ws-pmtest-${suffix}-b` };
const assets = loadVerifiedBundleWorkforcePresets("ai-pm");
const plan: PmTaskPlan[] = [
  { id: "requirements", presetKey: "requirement-analyst", goal: "提炼需求与明确的边界条件", dependsOn: [], acceptance: ["列出验收条件"], outputRefs: ["requirements.md"] },
  { id: "prd", presetKey: "doc-writer", goal: "依据上游需求起草完整PRD", dependsOn: ["requirements"], acceptance: ["引用上游需求"], outputRefs: ["prd.md"] },
];
const fixtureResult = (input: EmployeeExecutionInput): EmployeeExecutionResult => ({
  files: input.task.outputRefs.map((path) => ({ path, content: `${input.task.goal}\n完整验收条件\n${input.dependencyArtifacts.map((artifact) => artifact.content).join("\n")}` })),
  summary: "离线注入员工夹具完成真实文件写入", usage: { promptTokens: 31, completionTokens: 17 }, modelId: "fixture-deepseek",
  responseId: `fixture-${input.task.id}`, receipt: { adapter: "offline-test-fixture", dataMode: "fixture", final: true },
});
function completion(text: string): CompletionResult {
  return { text, message: { role: "assistant", content: text }, model: "fixture-deepseek", responseId: `fixture-${randomUUID()}`,
    promptTokens: 23, completionTokens: 11, finishReason: "stop", usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 } };
}
const provider = (tasks = plan): CompletionProvider => ({ modelId: "fixture-deepseek", complete: vi.fn(async () => completion(JSON.stringify({ tasks }))) });
function fixtureBinding(presetKey: string, digit: string): PmAssetBinding {
  return { schema: "workloom.pm.asset-binding/v1", bundleId: "ai-pm", bundleVersion: `3.0.${digit === "a" ? "1" : "2"}-fixture`,
    manifestSha256: digit.repeat(64), bundleIntegrityDigest: digit.repeat(64), presetKey, presetSha256: digit.repeat(64), skillTextSha256: digit.repeat(64),
    skills: [{ name: "fixture-skill", path: "skills/fixture-skill/SKILL.md", sha256: digit.repeat(64) }] };
}

run("MC-PM-002 isolated PostgreSQL + real artifact state machine (model fixtures, no paid I/O)", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let store: PgPmStore;
  let artifactStore: ArtifactStore;
  let artifactRoot: string;
  let appUser: string;
  const services: PmTeamService[] = [];
  const catalog: PmEmployeeCatalog = {
    async list() { return assets.map((asset) => ({ presetKey: asset.preset_key, name: asset.name, description: asset.description })); },
    async assemble(_scope, presetKey, goal) {
      const asset = assets.find((item) => item.preset_key === presetKey);
      if (!asset) throw new PmError("EMPLOYEE_NOT_READY", "fixture employee absent");
      const preset: AssembledPreset = { agentId: `fixture-${presetKey}`, presetKey, version: asset.version, highRisk: asset.high_risk,
        fenceBindings: asset.fence_bindings, tools: asset.tools, prompt: asset.prompt,
        essentials: { archive: { internalFixture: true }, stage: "delivery", goal } };
      return { preset, skillText: "已核验技能夹具正文，实际岗位工具来自原始14员工资产" };
    },
  };
  function service(overrides: Partial<ConstructorParameters<typeof PmTeamService>[0]> = {}) {
    const value = new PmTeamService({ store, artifactStore, catalog, providerFactory: () => provider(),
      employeeReview: (_provider, generate) => generate, employeeExecutor: async (input) => fixtureResult(input), ...overrides });
    services.push(value); return value;
  }
  async function create(current: PmTeamService, input: Record<string, unknown> = {}) {
    return (await current.create(scopeA, { goal: "从需求到PRD产出完整可测量交付文件", idempotencyKey: randomUUID(), ...input }, "MEM-PM-FIXTURE")).detail;
  }
  async function scoped<T>(scope: PmScope, fn: (client: pg.PoolClient) => Promise<T>) {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      const value = await fn(client); await client.query("COMMIT"); return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  beforeAll(async () => {
    const database = requireIsolatedPgTestConfig();
    appUser = database.users.app;
    owner = new pg.Pool({ connectionString: database.ownerUrl, max: 5 });
    app = new pg.Pool({ connectionString: database.appUrl, max: 20 });
    const migration = await readFile(new URL("../../../../../packages/db/migrations/0043_pm_team.sql", import.meta.url), "utf8");
    await owner.query(migration);
    for (const scope of [scopeA, scopeB]) {
      await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'pro')", [scope.tenantId, "PM test fixture"]);
      await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'PM test fixture',$1,'ai-pm','delivery')", [scope.workspaceId, scope.tenantId]);
    }
    store = new PgPmStore(app);
    artifactRoot = await mkdtemp(join(tmpdir(), "pm-team-pg-")); artifactStore = new ArtifactStore(artifactRoot);
  });
  afterAll(async () => {
    await Promise.allSettled(services.map((value) => value.close()));
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
    await Promise.allSettled([owner?.end(), app?.end()]);
    // Do not delete append-only lifecycle evidence. UUID fixture rows remain in this isolated DB.
  });

  it("full goal and concurrent idempotency preserved; different payload conflicts", async () => {
    const current = service(); const key = randomUUID(); const goal = "长目标保留独特验收词。".repeat(800);
    const input = { goal, idempotencyKey: key, employee: "doc-writer" };
    const values = await Promise.all(Array.from({ length: 12 }, () => current.create(scopeA, input, "MEM-PM-FIXTURE")));
    expect(new Set(values.map((value) => value.detail.run.id)).size).toBe(1);
    expect(values.filter((value) => value.created)).toHaveLength(1);
    expect(values[0]!.detail.run.goal).toBe(goal);
    await expect(current.create(scopeA, { ...input, goal: "不同的目标内容" }, "MEM-PM-FIXTURE")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("all14 seeded employees assemble their own integrity-checked skill text with their actual tool contract", async () => {
    const workspace = await owner.query<{ tenant_id: string; id: string }>("SELECT id,tenant_id FROM workspaces WHERE id='ws-aipm-demo'");
    expect(workspace.rows[0], "root-approved AI-PM seed must be present; this test never reseeds the live sandbox").toBeDefined();
    const seeded = { tenantId: workspace.rows[0]!.tenant_id, workspaceId: workspace.rows[0]!.id };
    const actualCatalog = createPmEmployeeCatalog(store);
    const employees = await actualCatalog.list(seeded);
    expect(employees).toHaveLength(14);
    for (const employee of employees) {
      const assembled = await actualCatalog.assemble(seeded, employee.presetKey, "核验真实岗位技能与隔离交付合同");
      const asset = assets.find((item) => item.preset_key === employee.presetKey)!;
      expect(assembled.skillText.length, employee.presetKey).toBeGreaterThan(100);
      expect(assembled.preset.tools, employee.presetKey).toEqual(asset.tools);
      expect(assembled.preset.prompt, employee.presetKey).toEqual(asset.prompt);
      expect(asset.skills.every((name) => assembled.skillText.includes(`## ${name}\n`)), employee.presetKey).toBe(true);
      const manifest = loadVerifiedBundleManifest("ai-pm");
      expect(assembled.assetBinding).toMatchObject({ schema: "workloom.pm.asset-binding/v1", bundleId: "ai-pm", bundleVersion: "3.0.1",
        manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), bundleIntegrityDigest: manifest.integrity!.digest,
        presetKey: employee.presetKey, presetSha256: manifest.integrity!.assets[`presets/${employee.presetKey}.yml`],
        skillTextSha256: createHash("sha256").update(assembled.skillText).digest("hex") });
      for (const skill of assembled.assetBinding!.skills) {
        expect(skill.sha256).toBe(createHash("sha256").update(await readFile(join(bundlesRoot(), "ai-pm", skill.path))).digest("hex"));
      }
    }
  }, 30_000);

  it("all14 employees execute representative real tasks through the actual one-shot file and receipt pipeline", async () => {
    const matrix = [
      ["chief-pm", "支付故障、配色和文案错别字只有一个开发人日，请排P0/P1/P2、执行顺序、停止条件和验收证据", "P0/P1/P2"],
      ["requirement-analyst", "设计反馈收集功能，包含三个场景、字段约束、状态流转和边界验收", "字段约束"],
      ["competitor-scout", "扫描竞品新版本功能变化，做来源核实与威胁评级", "威胁评级"],
      ["data-insight", "计算访问到付费漏斗转化率并输出本周指标异动日报", "转化率"],
      ["user-listener", "聚类本周用户差评、情绪和代表原声，并起草回复建议", "代表原声"],
      ["doc-writer", "根据已经确认的需求材料撰写完整PRD和用户可读版本说明", "完整PRD"],
      ["industry-radar", "汇总本周AI行业政策、模型发布和投融资动态，附来源", "投融资"],
      ["release-guardian", "为明天版本制作发布检查单、回滚预案和变更日志", "回滚预案"],
      ["dev-orchestrator", "实现一个可通过测试的JavaScript模块并交付完整测试文件", "JavaScript模块"],
      ["model-scout", "比较候选模型的质量、时延、成本和换型风险", "换型风险"],
      ["eval-master", "设计正常边界和对抗评测集，并回归badcase", "badcase"],
      ["prompt-curator", "版本化生产prompt，比较新旧版回归差异并给出回滚评估", "回归差异"],
      ["red-teamer", "对上线候选做提示注入、越权、路径穿越和SSRF红队扫描", "SSRF"],
      ["knowledge-curator", "盘点知识库过期与冲突条目，并生成团队学习周刊", "学习周刊"],
    ] as const;
    const provider = {
      modelId: "fixture-deepseek",
      complete: vi.fn(async (messages: Parameters<CompletionProvider["complete"]>[0]) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as { employee: string; task: { goal: string } };
        const row = matrix.find(([employee]) => employee === input.employee);
        if (!row) throw new Error(`unexpected employee ${input.employee}`);
        return completion(`# ${row[0]} 完整交付\n任务：${input.task.goal}\n关键结论：${row[2]}\n已完成隔离文件产物，未执行外部动作。`);
      }),
    };
    const current = service({
      providerFactory: () => provider,
      employeeExecutor: undefined,
      codingExecutor: createOneShotEmployeeExecutor(provider),
    });

    for (const [employee, goal, expected] of matrix) {
      const detail = (await current.create(scopeA, {
        goal,
        idempotencyKey: randomUUID(),
        employee,
      }, "MEM-PM-FIXTURE")).detail;
      await current.start(scopeA, detail.run.id);
      const finished = await current.waitForRun(scopeA, detail.run.id);
      expect(finished.run.status, `${employee}: ${finished.run.error ?? ""}`).toBe("completed");
      expect(finished.tasks).toHaveLength(1);
      expect(finished.tasks[0]?.presetKey).toBe(employee);
      expect(finished.tasks[0]?.executionBackend).toBe("deepseek-completion");
      expect(finished.tasks[0]?.adapterReceipt?.adapter).toBe("deepseek-completion");
      expect(finished.artifacts).toHaveLength(1);
      const artifact = await artifactStore.read(scopeA, finished.run.id, finished.artifacts[0]!);
      expect(artifact, employee).toContain(expected);
      expect(finished.run.usage.promptTokens).toBeGreaterThan(0);
      expect(finished.run.usage.completionTokens).toBeGreaterThan(0);
    }
  }, 45_000);

  it("a self-consistently re-sealed unsafe skill still fails the semantic asset contract before employee dispatch", async () => {
    const previousRoot = process.env.BUNDLES_ROOT;
    const sourceRoot = bundlesRoot(); const isolatedRoot = await mkdtemp(join(tmpdir(), "pm-unsafe-bundle-"));
    try {
      await cp(join(sourceRoot, "ai-pm"), join(isolatedRoot, "ai-pm"), { recursive: true });
      const path = "skills/changeset-harvest/SKILL.md";
      const unsafe = (await readFile(join(isolatedRoot, "ai-pm", path), "utf8")).replace("mockEvidence: blocked", "mockEvidence: allowed");
      await writeFile(join(isolatedRoot, "ai-pm", path), unsafe);
      const manifestPath = join(isolatedRoot, "ai-pm/bundle.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.integrity.assets[path] = createHash("sha256").update(unsafe).digest("hex");
      // Import the actual contract implementation by URL for this source-only fixture;
      // the server does not add a new runtime dependency or compile outside its rootDir.
      const { canonicalBundleArtifactPayload, parseBundleManifest } = await import(new URL("../../../../../packages/industry-contract/src/index.ts", import.meta.url).href);
      manifest.integrity.digest = createHash("sha256").update(canonicalBundleArtifactPayload(parseBundleManifest(manifest), manifest.integrity.assets)).digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest));
      process.env.BUNDLES_ROOT = isolatedRoot;
      // This candidate is genuinely hash-consistent. Integrity alone cannot bless an unsafe evidence rule.
      expect(loadVerifiedBundleManifest("ai-pm").integrity!.digest).toBe(manifest.integrity.digest);
      const workspace = await owner.query<{ tenant_id: string; id: string }>("SELECT id,tenant_id FROM workspaces WHERE id='ws-aipm-demo'");
      const seeded = { tenantId: workspace.rows[0]!.tenant_id, workspaceId: workspace.rows[0]!.id };
      await expect(createPmEmployeeCatalog(store).assemble(seeded, "dev-orchestrator", "检查真实来源的安全规则"))
        .rejects.toMatchObject({ code: "SKILL_EVIDENCE_CONTRACT_INVALID" });
    } finally {
      if (previousRoot === undefined) delete process.env.BUNDLES_ROOT; else process.env.BUNDLES_ROOT = previousRoot;
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("double RLS and composite FKs reject cross-tenant and cross-workspace reads/writes", async () => {
    const detail = await create(service());
    await expect(store.detail(scopeB, detail.run.id)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    const unscoped = await app.query("SELECT id FROM pm_runs WHERE id=$1", [detail.run.id]);
    expect(unscoped.rows).toEqual([]);
    const wrongTenant = await scoped({ tenantId: scopeB.tenantId, workspaceId: scopeA.workspaceId }, (client) => client.query("SELECT id FROM pm_runs WHERE id=$1", [detail.run.id]));
    expect(wrongTenant.rows).toEqual([]);
    await expect(owner.query(
      `INSERT INTO pm_tasks(run_id,id,tenant_id,workspace_id,ordinal,preset_key,goal,acceptance,output_refs)
       VALUES($1,'forged',$2,$3,0,'doc-writer','forged target','["pass"]','["x.md"]')`,
      [detail.run.id, scopeB.tenantId, scopeB.workspaceId])).rejects.toMatchObject({ code: "23503" });
  });

  it("CAS admits one run worker and one task claimant; actual DAG artifacts feed downstream by hash", async () => {
    const current = service(); const detail = await create(current);
    const calls: EmployeeExecutionInput[] = [];
    const executing = service({ employeeExecutor: async (input) => { calls.push(input); return fixtureResult(input); } });
    await Promise.all(Array.from({ length: 10 }, () => executing.start(scopeA, detail.run.id)));
    const finished = await executing.waitForRun(scopeA, detail.run.id);
    expect(finished.run.status).toBe("completed"); expect(calls).toHaveLength(2);
    expect(finished.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
    expect(calls[1]!.dependencyArtifacts).toHaveLength(1);
    expect(createHash("sha256").update(calls[1]!.dependencyArtifacts[0]!.content).digest("hex")).toBe(calls[1]!.dependencyArtifacts[0]!.sha256);
    expect(finished.run.usage).toEqual({ promptTokens: 85, completionTokens: 45 }); // one planner + two employee fixtures
    expect(finished.artifacts).toHaveLength(2);
    const events = await owner.query<{ action: string }>("SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE session_id=$1 ORDER BY seq", [detail.run.id]);
    expect(events.rows.map((row) => row.action)).toContain("pm.run.completed");
    const receipts = await owner.query<{ synced: boolean }>("SELECT (payload->'receipt'->>'synced')::boolean AS synced FROM biz_events WHERE session_id=$1 AND payload->'decision'->>'action'='pm.sandbox.artifact.write'", [detail.run.id]);
    expect(receipts.rows).toHaveLength(2); expect(receipts.rows.every((row) => row.synced)).toBe(true);
  });

  it("repairs a misassigned code owner before dispatch and keeps the correction in the planning receipt", async () => {
    const employeeCalls: string[] = [];
    const badPlan = [{
      id: "implementation",
      presetKey: "doc-writer",
      goal: "实现一个完整可测试的 JavaScript 模块",
      dependsOn: [],
      acceptance: ["导出可运行模块", "文件非空"],
      outputRefs: ["src/calculator.mjs"],
    }];
    const current = service({
      providerFactory: () => provider(badPlan),
      employeeExecutor: async (input) => {
        employeeCalls.push(input.preset.presetKey);
        return fixtureResult(input);
      },
      verifyRun: async () => [],
    });
    const detail = await create(current, { goal: "实现一个完整可测试的 JavaScript 模块" });
    await current.start(scopeA, detail.run.id);
    const finished = await current.waitForRun(scopeA, detail.run.id);

    expect(finished.run.status).toBe("completed");
    expect(finished.tasks[0]?.presetKey).toBe("dev-orchestrator");
    expect(finished.run.planningReceipt).toMatchObject({
      ownerCorrections: [{
        taskId: "implementation",
        from: "doc-writer",
        to: "dev-orchestrator",
      }],
    });
    expect(employeeCalls).toEqual(["dev-orchestrator"]);
  });

  it("rejects a mixed code/evaluation task before any employee model call or artifact write", async () => {
    const employeeCalls = vi.fn();
    const badPlan = [{
      id: "mixed",
      presetKey: "dev-orchestrator",
      goal: "同时实现代码并生成独立评测报告",
      dependsOn: [],
      acceptance: ["代码可运行", "评测报告完整"],
      outputRefs: ["src/calculator.mjs", "eval/report.md"],
    }];
    const current = service({
      providerFactory: () => provider(badPlan),
      employeeExecutor: employeeCalls,
    });
    const detail = await create(current, { goal: "同时实现代码并生成独立评测报告" });
    await current.start(scopeA, detail.run.id);
    const failed = await current.waitForRun(scopeA, detail.run.id);

    expect(failed.run.status).toBe("failed");
    expect(failed.run.errorCode).toBe("PLAN_OWNER_CONFLICT");
    expect(employeeCalls).not.toHaveBeenCalled();
    expect(failed.artifacts).toEqual([]);
  });

  it("the default coding executor produces real DSH files beyond four calls and respects OS verification availability", async () => {
    let calls = 0;
    const scripted: CompletionProvider = { modelId: "fixture-deepseek", complete: vi.fn(async (messages: Parameters<CompletionProvider["complete"]>[0]) => {
      expect(messages.some((message) => message.role === "system" && String(message.content).includes(TRUSTED_PM_EVIDENCE_POLICY))).toBe(true);
      calls += 1;
      const result = completion(calls === 5 ? "已生成模块和测试，执行结果以独立沙箱回执为准。" : "");
      const actions = [
        ["read_file", { path: "inputs/context.json" }],
        ["write_file", { path: "sum.mjs", content: "export function sum(values){return values.reduce((total,value)=>total+value,0)}\n" }],
        ["read_file", { path: "sum.mjs" }],
        ["write_file", { path: "sum.test.mjs", content: "import{test}from'node:test';import assert from'node:assert/strict';import{sum}from'./sum.mjs';test('sum empty and populated',()=>{assert.equal(sum([]),0);assert.equal(sum([1,2]),3)})\n" }],
      ] as const;
      if (calls <= actions.length) {
        const [name, args] = actions[calls - 1]!;
        result.message = { role: "assistant", content: "", tool_calls: [{ id: `fixture-call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      return result;
    }) };
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, "a") };
    } };
    const current = service({ employeeExecutor: undefined, catalog: boundCatalog, providerFactory: () => scripted });
    const detail = await create(current, { employee: "dev-orchestrator", goal: "编写sum模块和可运行的边界测试，依次读取上下文、写模块、复读模块、写测试、提交最终回执。",
      checks: [{ type: "fileExists", path: "sum.mjs" }, { type: "fileExists", path: "sum.test.mjs" }] });
    await current.start(scopeA, detail.run.id);
    const finished = await current.waitForRun(scopeA, detail.run.id);
    expect(calls).toBe(5);
    const task = finished.tasks[0]!;
    // This state contains only fixture IDs, fixed error messages and metering.
    // The code owner's verification happens before completion. Unsupported
    // hosts must retain a failed owner and no published artifacts.
    const executionState = JSON.stringify({ platform: process.platform, nodeMajor: Number(process.versions.node.split(".")[0]),
      run: { status: finished.run.status, errorCode: finished.run.errorCode, error: finished.run.error, usage: finished.run.usage },
      task: { status: task.status, errorCode: task.errorCode, error: task.error, usage: task.usage,
        receipt: { adapter: task.adapterReceipt?.adapter, modelCalls: task.adapterReceipt?.modelCalls,
          usageComplete: task.adapterReceipt?.usageComplete, final: task.adapterReceipt?.final,
          secretRejected: task.adapterReceipt?.secretRejected, receiptTooLarge: task.adapterReceipt?.receiptTooLarge },
        attempts: task.attemptReceipts.map((attempt) => ({ final: attempt.final, usage: attempt.usage })) },
      artifacts: finished.artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })) });
    const checks = finished.run.verification!.checks as Array<{ passed: boolean; message: string }>;
    if (!["darwin", "linux"].includes(process.platform) || Number(process.versions.node.split(".")[0]) < 24) {
      // Unsupported hosts retain the real fail-closed branch. macOS Seatbelt and
      // Linux bubblewrap are both production-supported OS sandboxes.
      expect(finished.run.status).toBe("failed");
      expect(finished.run.errorCode).toBe("TASK_CODE_CHECK_FAILED");
      expect(task.status, executionState).toBe("failed");
      expect(finished.artifacts).toEqual([]);
      expect(finished.run.usage).toEqual({ promptTokens: 115, completionTokens: 55 });
      expect(checks.some((check) => !check.passed && check.message.startsWith("OS_SANDBOX_UNAVAILABLE:"))).toBe(true);
      return;
    }
    expect(task.status, executionState).toBe("completed");
    expect(finished.tasks[0]!.adapterReceipt).toMatchObject({ adapter: "deepseek-harness-headless", modelCalls: 5, exitCode: 0, usageComplete: true,
      assetBinding: fixtureBinding("dev-orchestrator", "a"), assetBindingSource: "verified-catalog" });
    expect(finished.run.usage).toEqual({ promptTokens: 115, completionTokens: 55 });
    expect(finished.artifacts.map((artifact) => artifact.path).sort()).toEqual(["sum.mjs", "sum.test.mjs"]);
    expect(finished.run.status, finished.run.error ?? "coding run must complete").toBe("completed");
    const executed = checks.find((check) => check.passed && check.message.startsWith("{"));
    expect(executed, "the code must have an actual OS execution receipt, not just two existence checks").toBeDefined();
    const verification = JSON.parse(executed!.message);
    expect(verification).toMatchObject({ exitCode: 0, testSummary: { success: true } });
    expect(verification.testSummary.counts.passed).toBeGreaterThan(0);
  }, 45_000);

  it("a real DSH process with a metered final but no output retains its source binding in the failed attempt", async () => {
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, "a") };
    } };
    const scripted: CompletionProvider = { modelId: "fixture-deepseek", complete: vi.fn(async () => completion("未写文件，仅返回最终文本。")) };
    const current = service({ employeeExecutor: undefined, catalog: boundCatalog, providerFactory: () => scripted });
    const detail = await create(current, {
      employee: "dev-orchestrator",
      goal: "生成完整实现到sum.mjs",
      checks: [{ type: "fileExists", path: "sum.mjs" }],
    });
    await current.start(scopeA, detail.run.id); const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.status).toBe("failed"); expect(failed.run.errorCode).toBe("DSH_OUTPUT_MISSING");
    expect(failed.run.usage).toEqual({ promptTokens: 23, completionTokens: 11 });
    expect(failed.tasks[0]!.attemptReceipts[0]).toMatchObject({ final: false, receipt: { adapter: "deepseek-harness-headless", modelCalls: 1,
      assetBinding: fixtureBinding("dev-orchestrator", "a"), assetBindingSource: "verified-catalog" } });
    expect(failed.artifacts).toEqual([]);
  }, 45_000);

  it("failed employee blocks downstream; known failed model usage is retained across explicit resume", async () => {
    let failed = true; const calls: string[] = [];
    const current = service({ employeeExecutor: async (input) => {
      calls.push(input.task.id);
      if (failed) {
        failed = false;
        throw Object.assign(new PmError("DSH_OUTPUT_MISSING", "paid fixture failed before artifact"), {
          usage: { promptTokens: 9, completionTokens: 4 }, modelId: "fixture-deepseek", receipt: { adapter: "offline-test-fixture", final: false, usageComplete: true },
        });
      }
      return fixtureResult(input);
    } });
    const detail = await create(current);
    await current.start(scopeA, detail.run.id); const failure = await current.waitForRun(scopeA, detail.run.id);
    expect(failure.run.status).toBe("failed"); expect(failure.tasks[1]!.status).toBe("blocked");
    expect(calls).toEqual(["requirements"]); expect(failure.run.usage).toEqual({ promptTokens: 32, completionTokens: 15 });
    await current.start(scopeA, detail.run.id, true); const completed = await current.waitForRun(scopeA, detail.run.id);
    expect(completed.run.status).toBe("completed");
    expect(completed.run.usage).toEqual({ promptTokens: 94, completionTokens: 49 });
    expect(completed.tasks[0]!.attemptReceipts).toHaveLength(2);
    expect(completed.tasks[0]!.usage).toEqual({ promptTokens: 40, completionTokens: 21 });
  });

  it("code verification blocks handoff before completion and explicit resume repairs only the failed owner with feedback", async () => {
    const codingPlan: PmTaskPlan[] = [plan[0]!,
      { id: "code", presetKey: "dev-orchestrator", goal: "依据requirements.md实现模块与测试", dependsOn: ["requirements"],
        acceptance: ["实现与测试均通过"], outputRefs: ["module.mjs", "module.test.mjs"] },
      { id: "delivery", presetKey: "doc-writer", goal: "依据module.mjs写交付说明", dependsOn: ["code"],
        acceptance: ["只引用通过的产物"], outputRefs: ["delivery.md"] }];
    let valid = false;
    const planning = provider(codingPlan);
    const calls: EmployeeExecutionInput[] = [];
    const current = service({ providerFactory: () => planning,
      employeeExecutor: async (input) => { calls.push(input); return fixtureResult(input); },
      verifyRun: async () => [{ check: { type: "fileExists", path: "module.test.mjs" }, passed: valid,
        message: valid ? "trusted fixture: 6 passed" : "trusted fixture: expected size 4, got 5" }] });
    const detail = await create(current, { goal: "需求、模块实现与交付说明" });
    await current.start(scopeA, detail.run.id);
    const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.errorCode).toBe("TASK_CODE_CHECK_FAILED");
    expect(failed.tasks.map((task) => task.status)).toEqual(["completed", "failed", "blocked"]);
    expect(calls.map((input) => input.task.id)).toEqual(["requirements", "code"]);
    expect(failed.artifacts.map((artifact) => artifact.path)).toEqual(["requirements.md"]);
    expect(failed.tasks[1]!.attemptReceipts[0]).toMatchObject({ final: false,
      receipt: { validationFeedback: { source: "server-code-verifier", passed: false } } });
    expect(failed.run.verification).toMatchObject({ checks: [{ passed: false }] });
    expect(failed.run.usage).toEqual({ promptTokens: 85, completionTokens: 45 });
    valid = true;
    await current.start(scopeA, detail.run.id, true);
    const finished = await current.waitForRun(scopeA, detail.run.id);
    expect(finished.run.status).toBe("completed");
    expect(calls.map((input) => input.task.id)).toEqual(["requirements", "code", "code", "delivery"]);
    expect(calls[2]!.task.acceptance.join("\n")).toContain("expected size 4, got 5");
    expect(calls[3]!.task.acceptance.join("\n")).toContain("trusted fixture: 6 passed");
    expect(calls[3]!.task.acceptance.join("\n")).toContain("module.test.mjs");
    expect(calls[3]!.task.acceptance.join("\n")).toContain(finished.artifacts.find((file) => file.path === "module.mjs")!.sha256);
    expect(finished.tasks[1]!.acceptance).toEqual(codingPlan[1]!.acceptance);
    expect(finished.tasks[1]!.attemptReceipts).toHaveLength(2);
    expect(finished.tasks[1]!.attemptReceipts[0]).toEqual(failed.tasks[1]!.attemptReceipts[0]);
    expect(finished.tasks[1]!.adapterReceipt).toMatchObject({ validationFeedback: { source: "server-code-verifier", passed: true } });
    expect(finished.run.usage).toEqual({ promptTokens: 147, completionTokens: 79 });
    expect(planning.complete).toHaveBeenCalledTimes(1);
  });

  it("a code verifier exception retains paid usage and never sends unverified code downstream", async () => {
    const codingPlan: PmTaskPlan[] = [
      { id: "code", presetKey: "dev-orchestrator", goal: "实现模块", dependsOn: [], acceptance: ["执行测试"], outputRefs: ["module.mjs", "module.test.mjs"] },
      { id: "docs", presetKey: "doc-writer", goal: "读取module.mjs写说明", dependsOn: ["code"], acceptance: ["说明"], outputRefs: ["delivery.md"] }];
    const worker = vi.fn(async (input: EmployeeExecutionInput) => fixtureResult(input));
    const current = service({ providerFactory: () => provider(codingPlan), employeeExecutor: worker,
      verifyRun: async () => { throw new Error("synthetic sandbox unavailable"); } });
    const detail = await create(current, { goal: "实现模块并写交付说明" });
    await current.start(scopeA, detail.run.id);
    const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.status).toBe("failed");
    expect(failed.tasks[0]!.status).toBe("failed"); expect(failed.tasks[1]!.status).toBe("blocked");
    expect(failed.artifacts).toEqual([]); expect(worker).toHaveBeenCalledTimes(1);
    expect(failed.run.usage).toEqual({ promptTokens: 54, completionTokens: 28 });
    expect(failed.tasks[0]!.attemptReceipts).toHaveLength(1);
  });

  it("removes only an unregistered artifact and resumes after a database completion failure", async () => {
    const recoveryStore = new PgPmStore(app);
    const complete = vi.spyOn(recoveryStore, "completeTask").mockRejectedValueOnce(new Error("fixture completion commit unavailable"));
    const current = service({ store: recoveryStore });
    const detail = await create(current, { employee: "doc-writer", goal: "生成可核验的恢复测试文档" });
    await current.start(scopeA, detail.run.id);
    const failed = await current.waitForRun(scopeA, detail.run.id);

    expect(failed.run.status).toBe("failed");
    expect(failed.artifacts).toEqual([]);
    const artifactPath = await artifactStore.resolveFile(scopeA, detail.run.id, "result.md");
    await expect(readFile(artifactPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await current.start(scopeA, detail.run.id, true);
    const recovered = await current.waitForRun(scopeA, detail.run.id);
    expect(recovered.run.status).toBe("completed");
    expect(recovered.artifacts).toHaveLength(1);
    expect(await artifactStore.read(scopeA, detail.run.id, recovered.artifacts[0]!)).toContain("生成可核验的恢复测试文档");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("server-owned catalog provenance survives worker forgery, mutation, paid failure and a later asset version on resume", async () => {
    let digit = "a"; let fail = true;
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, digit) };
    } };
    const planningProvider = provider();
    const current = service({ catalog: boundCatalog, providerFactory: () => planningProvider, employeeExecutor: async (input) => {
      expect(input.assetBinding).toEqual(fixtureBinding(input.task.presetKey, digit));
      // A hostile adapter can mutate its own copy and self-report a different binding.
      (input.assetBinding!.skills[0] as { sha256: string }).sha256 = "f".repeat(64);
      const forged = { adapter: "offline-test-fixture", final: !fail, assetBinding: fixtureBinding("model-forged", "f"), assetBindingSource: "model" };
      if (fail) { fail = false; throw Object.assign(new PmError("DSH_OUTPUT_MISSING", "known paid fixture failure"), {
        usage: { promptTokens: 9, completionTokens: 4 }, modelId: "fixture-deepseek", receipt: forged,
      }); }
      return { ...fixtureResult(input), receipt: forged };
    } });
    const detail = await create(current); await current.start(scopeA, detail.run.id);
    const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.status).toBe("failed");
    expect(failed.run.planningReceipt).toMatchObject({ assetBinding: fixtureBinding("chief-pm", "a"), assetBindingSource: "verified-catalog" });
    expect(vi.mocked(planningProvider.complete).mock.calls[0]![0][0]!.content).toContain(TRUSTED_PM_EVIDENCE_POLICY);
    expect(failed.tasks[0]!.attemptReceipts[0]).toMatchObject({ final: false, receipt: { assetBinding: fixtureBinding("requirement-analyst", "a"), assetBindingSource: "verified-catalog" } });
    digit = "b"; await current.start(scopeA, detail.run.id, true);
    const completed = await current.waitForRun(scopeA, detail.run.id);
    expect(completed.run.status).toBe("completed");
    expect(completed.run.planningReceipt).toEqual(failed.run.planningReceipt);
    expect(completed.tasks[0]!.attemptReceipts).toHaveLength(2);
    expect(completed.tasks[0]!.attemptReceipts[0]).toEqual(failed.tasks[0]!.attemptReceipts[0]);
    expect(completed.tasks[0]!.attemptReceipts[1]).toMatchObject({ receipt: { assetBinding: fixtureBinding("requirement-analyst", "b"), assetBindingSource: "verified-catalog" } });
    expect(completed.tasks[1]!.adapterReceipt).toMatchObject({ assetBinding: fixtureBinding("doc-writer", "b"), assetBindingSource: "verified-catalog" });
  });

  it("an injected worker without catalog proof cannot self-certify verified asset provenance", async () => {
    const current = service({ employeeExecutor: async (input) => ({ ...fixtureResult(input), receipt: {
      adapter: "offline-test-fixture", assetBinding: fixtureBinding("forged", "f"), assetBindingSource: "verified-catalog",
    } }) });
    const detail = await create(current, { employee: "doc-writer" }); await current.start(scopeA, detail.run.id);
    const completed = await current.waitForRun(scopeA, detail.run.id);
    expect(completed.run.status).toBe("completed");
    expect(completed.tasks[0]!.adapterReceipt).toEqual({ adapter: "offline-test-fixture" });
  });

  it("cancellation aborts the in-flight worker and cannot be overwritten by late completion", async () => {
    let started!: () => void; const entered = new Promise<void>((done) => { started = done; });
    const current = service({ employeeExecutor: async (input) => {
      started(); return new Promise((_done, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    } });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id); await entered;
    await current.cancel(scopeA, detail.run.id, "MEM-PM-FIXTURE");
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("cancelled"); expect(result.artifacts).toEqual([]);
    await expect(current.start(scopeA, detail.run.id, true)).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
  });

  it("a paid response arriving after cancellation retains metering without reviving the run", async () => {
    let started!: () => void; const entered = new Promise<void>((done) => { started = done; });
    let release!: () => void; const finish = new Promise<void>((done) => { release = done; });
    const current = service({ employeeExecutor: async (input) => {
      started(); await finish; return fixtureResult(input); // deliberately simulates a transport that ignores abort
    } });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id); await entered;
    await current.cancel(scopeA, detail.run.id, "MEM-PM-FIXTURE"); release();
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("cancelled"); expect(result.artifacts).toEqual([]);
    expect(result.run.usage).toEqual({ promptTokens: 31, completionTokens: 17 });
    expect(result.tasks[0]!.attemptReceipts).toHaveLength(1);
    expect(result.tasks[0]!.attemptReceipts[0]).toMatchObject({ final: false, usage: { promptTokens: 31, completionTokens: 17 } });
  });

  it("cancellation waiting on a completing transaction cannot overwrite its completed terminal state", async () => {
    const initial = await create(service()); const lock = await owner.connect();
    let cancelling: Promise<unknown> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("UPDATE pm_runs SET status='completed' WHERE id=$1", [initial.run.id]);
      cancelling = store.cancel(scopeA, initial.run.id, "MEM-PM-FIXTURE");
      const expectation = expect(cancelling).rejects.toMatchObject({ code: "RUN_ALREADY_COMPLETED" });
      // Wait for a real PostgreSQL lock wait, rather than relying on scheduler timing.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const blocked = await owner.query<{ blocked: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE '%pm_runs%') AS blocked", [appUser]);
        waiting = blocked.rows[0]!.blocked;
        if (!waiting) await new Promise((done) => setTimeout(done, 5));
      }
      expect(waiting, "the cancel transaction must actually wait for the concurrent terminal commit").toBe(true);
      await lock.query("COMMIT"); await expectation;
      expect((await store.detail(scopeA, initial.run.id)).run.status).toBe("completed");
    } finally { await lock.query("ROLLBACK"); lock.release(); await cancelling?.catch(() => undefined); }
  });

  it("a truncated paid planner response stays blocked and retains the actual usage receipt", async () => {
    const value = completion('{"tasks":['); value.finishReason = "length";
    const boundCatalog: PmEmployeeCatalog = { ...catalog, async assemble(scope, presetKey, goal) {
      return { ...await catalog.assemble(scope, presetKey, goal), assetBinding: fixtureBinding(presetKey, "a") };
    } };
    const current = service({ catalog: boundCatalog, providerFactory: () => ({ modelId: "fixture-deepseek", complete: vi.fn(async () => value) }) });
    const detail = await create(current);
    await current.start(scopeA, detail.run.id);
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("blocked"); expect(result.run.errorCode).toBe("MODEL_RECEIPT_MISSING");
    expect(result.run.usage).toEqual({ promptTokens: 23, completionTokens: 11 });
    expect(result.run.planningReceipts).toHaveLength(1); expect(result.tasks).toEqual([]);
    expect(result.run.planningReceipts[0]).toMatchObject({ receipt: { assetBinding: fixtureBinding("chief-pm", "a"), assetBindingSource: "verified-catalog" } });
  });

  it.each([undefined, "", " \t\n"])("a planner response with missing or blank ID %j cannot dispatch employees and keeps metering", async (responseId) => {
    const value = completion(JSON.stringify({ tasks: plan })); value.responseId = responseId;
    const complete = vi.fn(async () => value);
    const worker = vi.fn(async (input: EmployeeExecutionInput) => fixtureResult(input));
    const current = service({ providerFactory: () => ({ modelId: "fixture-deepseek", complete }), employeeExecutor: worker });
    const detail = await create(current);
    await current.start(scopeA, detail.run.id);
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("blocked");
    expect(result.run.errorCode).toBe("MODEL_RECEIPT_MISSING");
    expect(result.run.usage).toEqual({ promptTokens: 23, completionTokens: 11 });
    expect(result.run.planningReceipts).toHaveLength(1);
    expect(result.run.planningReceipts[0]).toMatchObject({ final: false, usage: { promptTokens: 23, completionTokens: 11 },
      receipt: { adapter: "chief-pm-planner", usageComplete: true } });
    expect(result.tasks).toEqual([]); expect(result.artifacts).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1); expect(worker).not.toHaveBeenCalled();
  });

  it("a parsed but empty truncated provider response retains paid tokens in the failed employee ledger", async () => {
    const request = vi.fn(async () => Response.json({ id: "fixture-truncated-paid", model: "fixture-deepseek",
      choices: [{ finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: "private-thought-do-not-persist" } }],
      usage: { prompt_tokens: 23, completion_tokens: 8192, total_tokens: 8215, completion_tokens_details: { reasoning_tokens: 8192 } } }));
    const value = new OpenAiCompatibleProvider("fixture-deepseek", { baseUrl: "https://synthetic.invalid", fetch: request });
    const current = service({ providerFactory: () => value, employeeExecutor: undefined });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id);
    const result = await current.waitForRun(scopeA, detail.run.id);
    expect(result.run.status).toBe("failed");
    expect(result.run.usage).toEqual({ promptTokens: 23, completionTokens: 8192 });
    expect(result.tasks[0]!.responseId).toBe("fixture-truncated-paid");
    expect(result.tasks[0]!.attemptReceipts.filter((row) => row.kind === "model-attempt")).toHaveLength(2);
    const settlements = result.tasks[0]!.attemptReceipts.filter((row) => row.kind !== "model-attempt");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ final: false,
      usage: { promptTokens: 23, completionTokens: 8192 }, modelId: "fixture-deepseek",
      receipt: { adapter: "completion-protocol", responseId: "fixture-truncated-paid", usageComplete: true, finishReason: "length" } });
    expect(JSON.stringify(result)).not.toContain("private-thought-do-not-persist");
    expect(result.artifacts).toEqual([]); expect(request).toHaveBeenCalledTimes(1);
  });

  it("failed final verification preserves its evidence; explicit recheck does not rerun completed paid employees", async () => {
    const worker = vi.fn(async (input: EmployeeExecutionInput) => fixtureResult(input));
    let passes = false;
    const current = service({ employeeExecutor: worker, verifyRun: async () => [{
      check: { type: "fileExists", path: "result.md" }, passed: passes,
      message: JSON.stringify({ backend: "trusted-offline-verifier-fixture", exitCode: passes ? 0 : 1, evidence: "fixture-check-hash" }),
    }] });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id);
    const rejected = await current.waitForRun(scopeA, detail.run.id);
    expect(rejected.run.status).toBe("failed"); expect(rejected.run.errorCode).toBe("RUN_CHECK_FAILED");
    expect(rejected.run.verification).toMatchObject({ checks: [{ passed: false, message: expect.stringContaining("fixture-check-hash") }] });
    const metered = rejected.run.usage;
    passes = true; await current.start(scopeA, detail.run.id, true);
    const rechecked = await current.waitForRun(scopeA, detail.run.id);
    expect(rechecked.run.status).toBe("completed"); expect(worker).toHaveBeenCalledTimes(1);
    expect(rechecked.run.usage).toEqual(metered);
    expect(rechecked.run.verification).toMatchObject({ checks: [{ passed: true }] });
  });

  it("expired crash lease pauses; explicit resume checks hashes and skips only verified completed tasks", async () => {
    const initial = await create(service()); const id = initial.run.id;
    await store.claimRun(scopeA, id, "dead-worker", false);
    await store.savePlan(scopeA, id, "dead-worker", plan, { source: "model", modelId: "fixture-deepseek", promptTokens: 1, completionTokens: 1 });
    await store.claimTask(scopeA, id, "requirements", "dead-worker");
    const first = fixtureResult({ task: plan[0]!, dependencyArtifacts: [] } as unknown as EmployeeExecutionInput);
    const written = await artifactStore.persist(scopeA, id, "requirements", first.files);
    await store.completeTask(scopeA, id, "requirements", "dead-worker", first, written, [], "requirements.write");
    await store.claimTask(scopeA, id, "prd", "dead-worker");
    await owner.query("UPDATE pm_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    const calls: string[] = [];
    const restarted = service({ employeeExecutor: async (input) => { calls.push(input.task.id); return fixtureResult(input); } });
    expect((await restarted.detail(scopeA, id)).run.status).toBe("paused");
    expect(calls).toEqual([]);
    await restarted.start(scopeA, id, true);
    expect((await restarted.waitForRun(scopeA, id)).run.status).toBe("completed");
    expect(calls).toEqual(["prd"]);
    expect((await store.detail(scopeA, id)).run.goal).toBe(initial.run.goal);
  });

  it("tampered completed artifact forbids resume, rather than falsely skipping work", async () => {
    const initial = await create(service()); const id = initial.run.id;
    await store.claimRun(scopeA, id, "crashed", false);
    await store.savePlan(scopeA, id, "crashed", plan, { source: "model", modelId: "fixture-deepseek", promptTokens: 1, completionTokens: 1 });
    await store.claimTask(scopeA, id, "requirements", "crashed");
    const first = fixtureResult({ task: plan[0]!, dependencyArtifacts: [] } as unknown as EmployeeExecutionInput);
    const [artifact] = await artifactStore.persist(scopeA, id, "requirements", first.files);
    await store.completeTask(scopeA, id, "requirements", "crashed", first, [artifact!], [], "requirements.write");
    await owner.query("UPDATE pm_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    await writeFile(await artifactStore.resolveFile(scopeA, id, artifact!.path), "tampered bytes");
    const current = service();
    expect((await current.detail(scopeA, id)).run.status).toBe("paused");
    await expect(current.start(scopeA, id, true)).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
  });

  it("journal failure rolls back creation; artifact receipt rows remain append-only", async () => {
    const failing = new PgPmStore(app, { appendEvent: async () => { throw new Error("fixture journal unavailable"); } });
    const key = randomUUID();
    await expect(failing.create(scopeA, { goal: "事务回滚检查目标", idempotencyKey: key }, "MEM-PM-FIXTURE", "fixture-deepseek", "fixture-policy")).rejects.toThrow();
    const rows = await owner.query("SELECT id FROM pm_runs WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3", [scopeA.tenantId, scopeA.workspaceId, key]);
    expect(rows.rows).toEqual([]);
    const actual = await create(service(), { employee: "doc-writer" });
    await service().start(scopeA, actual.run.id); // a second trusted controller instance owns this run
    // Test append-only directly with an existing receipt from an earlier successful test, if present.
    const receipt = await owner.query<{ id: string }>("SELECT id FROM pm_artifacts WHERE tenant_id=$1 AND workspace_id=$2 LIMIT 1", [scopeA.tenantId, scopeA.workspaceId]);
    expect(receipt.rows[0]).toBeDefined();
    await expect(scoped(scopeA, (client) => client.query("UPDATE pm_artifacts SET sha256=$2 WHERE id=$1", [receipt.rows[0]!.id, "0".repeat(64)]))).rejects.toThrow();
  });

  it.each(["planner", "employee"])("unknown %s usage is durable and explicit resume cannot send a second paid request", async (stage) => {
    const request = vi.fn(async () => Response.json({ id: "synthetic-unknown-usage", model: "fixture-deepseek",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "private unknown response" } }] }));
    const physical = new OpenAiCompatibleProvider("fixture-deepseek", { baseUrl: "https://synthetic.invalid", fetch: request });
    const current = service({ providerFactory: () => physical, employeeExecutor: undefined });
    const detail = await create(current, stage === "employee" ? { employee: "doc-writer" } : {});
    await current.start(scopeA, detail.run.id);
    const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.status).toBe("blocked");
    expect(failed.run.errorCode).toBe("MODEL_USAGE_RECONCILIATION_REQUIRED");
    const receipts = stage === "employee" ? failed.tasks[0]!.attemptReceipts : failed.run.planningReceipts;
    expect(receipts.some((row) => (row.requestReceipt as Record<string, unknown> | undefined)?.dispatchState === "possibly-sent")).toBe(true);
    expect(receipts.at(-1)).toMatchObject({ final: false, receipt: { usageComplete: false, reconciliationRequired: true } });
    expect(receipts.at(-1)?.usage ?? null).toBeNull();
    if (stage === "employee") expect(failed.tasks[0]!.usage).toBeNull();
    expect(JSON.stringify(receipts)).not.toContain("private unknown response");
    const restarted = service({ providerFactory: () => physical, employeeExecutor: undefined });
    await expect(restarted.start(scopeA, detail.run.id, true)).rejects.toMatchObject({ code: "MODEL_USAGE_RECONCILIATION_REQUIRED" });
    await expect(store.claimRun(scopeA, detail.run.id, "bypass-service", true)).rejects.toMatchObject({ code: "MODEL_USAGE_RECONCILIATION_REQUIRED" });
    expect(request).toHaveBeenCalledTimes(1); expect(failed.artifacts).toEqual([]);
  });

  it("nested DSH partial known usage is retained while its unknown continuation forbids resume", async () => {
    const worker = vi.fn(async () => {
      throw Object.assign(new PmError("DSH_WORKER_FAILED", "synthetic partial DSH failure"), {
        usage: { promptTokens: 19, completionTokens: 7 }, modelId: "fixture-deepseek",
        receipt: { adapter: "deepseek-harness-headless", modelCalls: 2, usageComplete: false, final: false },
        cause: { partial: { requestReceipt: { attemptId: "synthetic-unknown-second", model: "fixture-deepseek", dispatchState: "possibly-sent", usageComplete: false } } },
      });
    });
    const current = service({ employeeExecutor: worker }); const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id); const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(failed.run.errorCode).toBe("MODEL_USAGE_RECONCILIATION_REQUIRED");
    expect(failed.run.usage).toEqual({ promptTokens: 19, completionTokens: 7 });
    expect(failed.tasks[0]!.attemptReceipts.at(-1)).toMatchObject({ usage: { promptTokens: 19, completionTokens: 7 },
      receipt: { usageComplete: false, knownUsageScope: "partial-measured-only" } });
    await expect(current.start(scopeA, detail.run.id, true)).rejects.toMatchObject({ code: "MODEL_USAGE_RECONCILIATION_REQUIRED" });
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("definite no-send admission rejection can resume without inventing a paid attempt", async () => {
    let deny = true;
    const request = vi.fn(async () => Response.json({ id: "fixture-known-after-admission", model: "fixture-deepseek",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "完整可核验正文" } }],
      usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 } }));
    const physical = new OpenAiCompatibleProvider("fixture-deepseek", { baseUrl: "https://synthetic.invalid", fetch: request,
      beforeRequest: () => { if (deny) throw new Error("synthetic budget denial before network"); } });
    const current = service({ providerFactory: () => physical, employeeExecutor: undefined });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id); const rejected = await current.waitForRun(scopeA, detail.run.id);
    expect(rejected.run.errorCode).toBe("MODEL_BUDGET_EXHAUSTED"); expect(request).not.toHaveBeenCalled();
    expect(rejected.tasks[0]!.usage).toBeNull();
    deny = false; await current.start(scopeA, detail.run.id, true);
    expect((await current.waitForRun(scopeA, detail.run.id)).run.status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a durable dispatch marker survives a process crash and blocks lease recovery from replaying it", async () => {
    const current = service(); const detail = await create(current);
    await store.claimRun(scopeA, detail.run.id, "synthetic-crashed-after-dispatch", false);
    await store.recordModelAttempt(scopeA, detail.run.id, "synthetic-crashed-after-dispatch", undefined,
      { attemptId: "synthetic-pending-attempt", model: "fixture-deepseek", dispatchState: "possibly-sent", usageComplete: false, requestSha256: "a".repeat(64) });
    await owner.query("UPDATE pm_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [detail.run.id]);
    const recovered = await current.detail(scopeA, detail.run.id);
    expect(recovered.run.status).toBe("blocked"); expect(recovered.run.errorCode).toBe("MODEL_USAGE_RECONCILIATION_REQUIRED");
    await expect(current.start(scopeA, detail.run.id, true)).rejects.toMatchObject({ code: "MODEL_USAGE_RECONCILIATION_REQUIRED" });
    expect(recovered.run.planningReceipts).toHaveLength(1);
  });

  it("an internal per-call quota wrapper cannot change the fixed model or claim a run on wrapper failure", async () => {
    const physical = provider(); const current = service({ providerFactory: () => physical });
    const detail = await create(current);
    await expect(current.start(scopeA, detail.run.id, false, () => ({ modelId: "other-model", complete: physical.complete })))
      .rejects.toMatchObject({ code: "MODEL_DRIFT" });
    expect((await store.detail(scopeA, detail.run.id)).run.status).toBe("created");
    const wrappedCalls = vi.fn(async (...args: Parameters<CompletionProvider["complete"]>) => physical.complete(...args));
    await current.start(scopeA, detail.run.id, false, (fixed) => ({ modelId: fixed.modelId, complete: wrappedCalls }));
    expect((await current.waitForRun(scopeA, detail.run.id)).run.status).toBe("completed");
    expect(wrappedCalls).toHaveBeenCalledTimes(1);
  });

  it("failure to persist the pre-dispatch marker prevents network I/O", async () => {
    const guardedStore = new PgPmStore(app);
    vi.spyOn(guardedStore, "recordModelAttempt").mockRejectedValueOnce(new Error("synthetic durable marker unavailable"));
    const request = vi.fn(async () => Response.json({}));
    const physical = new OpenAiCompatibleProvider("fixture-deepseek", { baseUrl: "https://synthetic.invalid", fetch: request });
    const current = service({ store: guardedStore, providerFactory: () => physical, employeeExecutor: undefined });
    const detail = await create(current, { employee: "doc-writer" });
    await current.start(scopeA, detail.run.id); const failed = await current.waitForRun(scopeA, detail.run.id);
    expect(request).not.toHaveBeenCalled(); expect(failed.run.status).toBe("failed");
    expect(failed.tasks[0]!.usage).toBeNull(); expect(failed.tasks[0]!.attemptReceipts).toEqual([]);
  });
});

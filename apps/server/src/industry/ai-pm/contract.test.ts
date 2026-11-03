import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoSecrets, CreatePmRunSchema, parseTeamPlan, parseModelJson, safeArtifactPath, validateEmployeeResult } from "./contract.js";

afterEach(() => vi.unstubAllEnvs());

const task = (id: string, dependsOn: string[] = [], path = `${id}.md`) => ({
  id, presetKey: "doc-writer", goal: `完成${id}的明确文档目标`, dependsOn,
  acceptance: ["包含可测量验收标准"], outputRefs: [path],
});

describe("credential boundaries in complete employee data and DSH receipts", () => {
  const formats = [
    ["model key", "s" + "k-" + "f".repeat(32)],
    ["project model key", "s" + "k-proj-" + "q".repeat(48)],
    ...["p", "o", "u", "s", "r"].map((kind) => [`GitHub ${kind} token`, "gh" + kind + "_" + "q".repeat(32)]),
    ["fine-grained GitHub token", "github_" + "pat_" + "q".repeat(32)],
    ["AWS access key", "AK" + "IA" + "Z".repeat(16)],
    ["Bearer token", "Bearer " + "q".repeat(32)],
    ["PEM private key", "-----BEGIN " + "PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----"],
  ];
  const prefixes = ["", " ", '"', "'", ":", "=", "(", "\n", "密钥：", "前缀"];

  it.each(formats)("still rejects %s after delimiters in raw text and nested JSON", (_name, credential) => {
    for (const prefix of prefixes) {
      for (const value of [prefix + credential, { receipt: { sessionEvidence: [{ path: prefix + credential }] } }]) {
        let failure: unknown;
        try { assertNoSecrets(value); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: "SECRET_DETECTED", message: "内容疑似包含秘密，已阻断保存和出站" });
        expect(String(failure)).not.toContain(credential);
      }
    }
  });

  it("accepts the actual short-workspace DSH project-key shape without skipping receipt scanning", () => {
    const path = "sessions/--private-tmp-pm-receipt-repro-fixture-" + "a".repeat(64) + "-" + "b".repeat(64)
      + "-pm-00000000-0000-4000-8000-000000000000-scratch-employee-task-00000000-0000-4000-8000-000000000000--/session-fixture/session.v4.jsonl";
    const receipt = { sessionEvidence: [{ path, sha256: "a".repeat(64), bytes: 500 }], final: true };
    expect(() => assertNoSecrets({ receipt })).not.toThrow();
    const good = { files: [{ path: "sum.mjs", content: "export const sum = 1;" }], summary: "真实文件回执", usage: { promptTokens: 115, completionTokens: 55 }, modelId: "fixture-deepseek", receipt };
    expect(validateEmployeeResult(good, ["sum.mjs"]).receipt).toEqual(receipt);
    expect(() => assertNoSecrets({ receipt: { ...receipt, nestedCredential: formats[0]![1] } })).toThrow("已阻断");
  });

  it.each(["DEEPSEEK_API_KEY", "LLM_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"])("rejects the configured %s anywhere despite a letter prefix", (key) => {
    const credential = "s" + "k-" + "c".repeat(32);
    vi.stubEnv(key, credential);
    expect(() => assertNoSecrets("prefix" + credential + "suffix")).toThrow("已阻断");
    expect(() => assertNoSecrets({ receipt: { sessionEvidence: [{ path: "prefix" + credential + "suffix" }] } })).toThrow("已阻断");
  });

  it("rejects a nonstandard PM loopback credential before an event can be saved", () => {
    const fixtureValue = ["local", "fixture", "transport", "value"].join("-");
    vi.stubEnv("PM_MODEL_API_KEY", fixtureValue);
    expect(() => assertNoSecrets({ input: { goal: "test " + fixtureValue } })).toThrow("已阻断");
  });

  it("also rejects configured values that are JSON-escaped and never echoes them", () => {
    const credential = 'fixture-configured-"quoted"\ncredential';
    vi.stubEnv("LLM_API_KEY", credential);
    const check = (value: unknown) => {
      let failure: unknown;
      try { assertNoSecrets(value); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "SECRET_DETECTED" });
      expect(String(failure)).not.toContain(credential);
    };
    check("prefix" + credential); check({ receipt: { data: "prefix" + credential } });
  });
});

describe("MC-PM-002 团队合同与DAG边界", () => {
  it("保留完整长目标，拒客户端作用域、根目录与额外字段", () => {
    const goal = "具有明确用户目标与可测试验收条件。".repeat(600);
    expect(CreatePmRunSchema.parse({ goal, idempotencyKey: "request-1" }).goal).toBe(goal);
    for (const extra of [{ tenantId: "other" }, { workspaceId: "other" }, { root: "/tmp" }, { pathRoot: "/tmp" }]) {
      expect(() => CreatePmRunSchema.parse({ goal, idempotencyKey: "request-1", ...extra })).toThrow();
    }
    expect(() => CreatePmRunSchema.parse({ goal: " ", idempotencyKey: "r" })).toThrow();
    expect(() => CreatePmRunSchema.parse({ goal: "x".repeat(32_001), idempotencyKey: "r" })).toThrow();
  });
  it("拓扑排序接受乱序输入，保留员工、验收和产物所有权", () => {
    const plan = parseTeamPlan({ tasks: [task("b", ["a"]), task("a")] }, ["doc-writer"]);
    expect(plan.map((item) => item.id)).toEqual(["a", "b"]);
    expect(plan[1]).toMatchObject({ presetKey: "doc-writer", dependsOn: ["a"], outputRefs: ["b.md"] });
  });
  it("拒环、自依赖、重复ID、缺依赖、无效员工和超过八节点", () => {
    const plans = [
      [task("a", ["b"]), task("b", ["a"])], [task("a", ["a"])],
      [task("a"), task("a", [], "other.md")], [task("a", ["missing"])],
      [{ ...task("a"), presetKey: "shell-operator" }],
      Array.from({ length: 9 }, (_, index) => task(`t${index}`)),
    ];
    for (const tasks of plans) expect(() => parseTeamPlan({ tasks }, ["doc-writer"])).toThrow();
  });
  it("拒跨员工同名、大小写与目录前缀写冲突", () => {
    for (const paths of [["PRD.md", "prd.md"], ["src", "src/app.js"], ["src/app.js", "src/app.js"]]) {
      expect(() => parseTeamPlan({ tasks: [task("a", [], paths[0]!), task("b", ["a"], paths[1]!)] }, ["doc-writer"])).toThrow();
    }
  });
  it("路径仅为安全相对路径，拒遍历、绝对、Windows、隐藏配置和控制符", () => {
    expect(safeArtifactPath("src/计算器.ts")).toBe("src/计算器.ts");
    for (const path of ["../secret", "/etc/passwd", "C:/file", "a\\b", "a/../b", ".env", "a/.git/config", "a//b", "a/", "a\u0000b", "https://example.com/a", "node_modules/pkg.js"]) {
      expect(() => safeArtifactPath(path), path).toThrow();
    }
  });
  it("模型JSON允许完整代码围栏但不猜测损坏响应", () => {
    expect(parseModelJson('```json\n{"tasks":[]}\n```')).toEqual({ tasks: [] });
    expect(() => parseModelJson('解释文字 {"tasks":[]}')).toThrow();
    expect(() => parseModelJson("")).toThrow();
  });
  it("交付必须有真实usage与全部声明产物，拒秘密、重复、空白、额外文件", () => {
    const good = { files: [{ path: "a.md", content: "实际产出的完整报告" }], summary: "报告已生成", usage: { promptTokens: 42, completionTokens: 20 }, modelId: "deepseek-flash" };
    expect(validateEmployeeResult(good, ["a.md"]).files).toHaveLength(1);
    for (const bad of [
      { ...good, usage: undefined }, { ...good, usage: { promptTokens: 0, completionTokens: 0 } },
      { ...good, files: [] }, { ...good, files: [{ path: "a.md", content: "   " }] },
      { ...good, files: [good.files[0], good.files[0]] },
      { ...good, files: [{ path: "b.md", content: "extra" }] },
      { ...good, files: [{ path: "a.md", content: `token=sk-${"f".repeat(32)}` }] },
      { ...good, files: [{ path: "a.md", content: "x".repeat(262_145) }] },
    ]) expect(() => validateEmployeeResult(bad, ["a.md"])).toThrow();
  });
});

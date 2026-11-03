import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { assertPmSkillContract, PM_CONTRACT_SKILLS, TRUSTED_PM_EVIDENCE_POLICY } from "./skill-contracts.js";

const root = new URL("../../../../../bundles/ai-pm/skills/", import.meta.url);
const text = (name: string) => readFileSync(new URL(`${name}/SKILL.md`, root), "utf8");
function change(name: string, mutate: (contract: Record<string, unknown>) => void): string {
  const source = text(name); const match = /^---\n([\s\S]*?)\n---/.exec(source)!;
  const front = YAML.parse(match[1]!); mutate(front.delivery_contract);
  return `---\n${YAML.stringify(front)}---${source.slice(match[0].length)}`;
}

describe("verified AI-PM skill evidence contracts", () => {
  it.each(PM_CONTRACT_SKILLS)("the real %s asset has a complete fail-closed delivery contract", (name) => {
    expect(() => assertPmSkillContract(name, text(name))).not.toThrow();
  });
  it.each(["changeset-harvest", "release-cut"])("%s cannot be resealed with mock/missing gates or unbound evidence", (name) => {
    for (const [field, value] of [["missingEvidence", "allow"], ["mockEvidence", "allow"], ["exam", "not-fail"], ["humanApprovalSubstitutesEvidence", true]]) {
      const source = change(name, (contract) => { contract[field as string] = value; });
      expect(() => assertPmSkillContract(name, source)).toThrow("技能交付合同");
    }
    expect(() => assertPmSkillContract(name, change(name, (contract) => { contract.binding = ["workspace", "task"]; }))).toThrow("技能交付合同");
  });
  it("the known-unsafe previous version and absent safe rollback target are never sufficient", () => {
    expect(() => assertPmSkillContract("prompt-regression", change("prompt-regression", (contract) => { contract.knownBadVersionEligible = true; }))).toThrow();
    expect(() => assertPmSkillContract("prompt-regression", change("prompt-regression", (contract) => { contract.rollbackEvidence = "previous-version-number"; }))).toThrow();
    expect(() => assertPmSkillContract("prompt-regression", change("prompt-regression", (contract) => { contract.noSafeVersion = "use-original"; }))).toThrow();
  });
  it("a metric point threshold alone and omitted uncertainty cannot certify a causal experiment", () => {
    expect(() => assertPmSkillContract("metric-digest", change("metric-digest", (contract) => { contract.pointThresholdAloneFalsifies = true; }))).toThrow();
    expect(() => assertPmSkillContract("metric-digest", change("metric-digest", (contract) => { contract.experimentFields = ["effect", "allocation"]; }))).toThrow();
  });
  it("PRD fields cannot omit the consistent nullability/state contract or functional priority tiers", () => {
    expect(() => assertPmSkillContract("prd-forge", change("prd-forge", (contract) => { contract.fieldStateConsistency = false; }))).toThrow();
    expect(() => assertPmSkillContract("prd-forge", change("prd-forge", (contract) => { contract.functionalPriorityTiers = ["P0"]; }))).toThrow();
  });
  it("a legacy text-only skill document and an unparseable contract stay unverified", () => {
    const old = "---\nname: changeset-harvest\nversion: 1.0.0\n---\n模型缺配置降级放行并标 mock；verdict=fail 才拦。";
    expect(() => assertPmSkillContract("changeset-harvest", old)).toThrow("技能交付合同");
    expect(() => assertPmSkillContract("metric-digest", "---\n[malformed\n---\nbody")).toThrow("技能交付合同");
    // All declared skills now require their reviewed source contract.
    expect(() => assertPmSkillContract("meeting-digest", "existing asset")).toThrow();
  });
  it("the trusted policy constrains evidence and safe rollback rather than supplying a task answer", () => {
    expect(TRUSTED_PM_EVIDENCE_POLICY).toContain("可信执行纪律");
    expect(TRUSTED_PM_EVIDENCE_POLICY).toContain("独立");
    expect(TRUSTED_PM_EVIDENCE_POLICY).not.toMatch(/1000|40%|产品甲|C\s*>\s*A|No-Go/);
  });
});

describe("all declared PM skills have enforceable professional evidence contracts", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../../../bundles/ai-pm/bundle.json", import.meta.url), "utf8"));
  const declared: string[] = manifest.workloom.provides.skills.map((path: string) => path.split("/")[1]);
  it("covers the complete signed skill manifest, with no unchecked skill name", () => {
    expect([...PM_CONTRACT_SKILLS].sort()).toEqual([...declared].sort());
    expect(() => assertPmSkillContract("unregistered-skill", "pretend skill")).toThrow();
  });
  it.each(declared)("%s rejects missing, unknown and weakened evidence terms", (name) => {
    expect(() => assertPmSkillContract(name, text(name))).not.toThrow();
    const source = text(name); const front = /^---\n([\s\S]*?)\n---/.exec(source)!;
    const metadata = YAML.parse(front[1]!);
    expect(metadata.delivery_contract).toBeDefined();
    for (const field of Object.keys(metadata.delivery_contract ?? {})) {
      expect(() => assertPmSkillContract(name, change(name, (contract) => { delete contract[field]; }))).toThrow();
      expect(() => assertPmSkillContract(name, change(name, (contract) => { contract[field] = "allow-unverified"; }))).toThrow();
    }
    expect(() => assertPmSkillContract(name, change(name, (contract) => { contract.unknownOverride = true; }))).toThrow();
  });
});

describe("independent real-output regressions remain in the source contracts", () => {
  const requiredTerms: Array<[string, string, unknown]> = [
    ["competitor-scan", "productResponse", "scenario-proposal-and-verification"],
    ["competitor-scan", "capabilityEntitlement", "separate-capability-inclusion-access-and-test"],
    ["competitor-scan", "totalCostDirection", "comparable-complete-inputs-required"],
    ["competitor-scan", "claimConsistency", "source-strength-preserved-across-sections"],
    ["metric-digest", "analysisScope", "requested-descriptive-before-optional-experiment"],
    ["metric-digest", "conditionConsistency", "one-exhaustive-decision-rule"],
    ["eval-forge", "comparatorMutation", "boundary-truth-table"],
    ["model-scout", "eligibilityStatus", "satisfied-violated-unknown"],
    ["model-scout", "currentModelSource", "explicit-evidence-only"],
    ["redteam-scan", "permissionCoverage", "declared-role-resource-operation-matrix"],
    ["redteam-scan", "authorizationControls", "declared-scope-allow-and-deny"],
    ["dev-dispatch", "acceptanceAuthority", "independent-owner-bound-evidence"],
    ["prd-forge", "roleStatePermissionMatrix", true],
    ["prd-forge", "permissionMatrixScope", "declared-domain-only"],
    ["prd-forge", "administratorException", "explicit-per-state"],
    ["prd-forge", "missingSourceFacts", "unknown-not-negative"],
    ["prd-forge", "claimConsistency", "source-mapped-across-all-sections"],
    ["prd-forge", "identifierScope", "explicit-and-consistent"],
    ["prd-forge", "acceptanceFixtures", "complete-preconditions-and-single-oracle"],
    ["prd-forge", "unspecifiedPermissions", "unknown-or-labeled-design-default"],
    ["prd-forge", "requestedDeliverables", "artifact-contained-complete"],
    ["metric-digest", "intervalDecision", "direction-and-prespecified-effect"],
    ["metric-digest", "missingWindow", "explicit-computation-assumption"],
    ["metric-digest", "quantitativeClaims", "recompute-every-comparison"],
    ["metric-digest", "sampleSize", "formula-or-explicitly-not-calculated"],
    ["metric-digest", "relativeChange", "same-metric-same-unit"],
    ["metric-digest", "experimentAudit", "allocation-attrition-window-denominator"],
    ["eval-forge", "frozenOracle", true],
    ["eval-forge", "metricDenominators", "enumerated-stable-ids"],
    ["eval-forge", "deliveryDenominator", "all-eligible-cases"],
    ["eval-forge", "modeRoutingSeparateFromClassification", true],
    ["eval-forge", "caseIndex", "one-request-one-id-derived-metric-sets"],
    ["eval-forge", "rubric", "canonical-case-table-only"],
    ["eval-forge", "lengthEvidence", "formula-or-measurement-only"],
    ["eval-forge", "caseState", "explicit-isolated-preconditions"],
    ["eval-forge", "mutationOracle", "discriminating-input-required"],
    ["eval-forge", "caseCount", "risk-coverage-and-user-request"],
    ["eval-forge", "leakageEffect", "independence-lost-direction-unidentified"],
    ["prompt-regression", "inputBoundary", "server-assigned-roles-and-serialized-data"],
    ["prompt-regression", "tagsAreSecurityBoundary", false],
    ["prompt-regression", "lengthBoundaries", "exact-unit-below-equal-above"],
    ["kb-fresh", "inScopeValidStatus", "active-with-scope"],
    ["kb-fresh", "crossScopeReplacement", false],
    ["industry-radar", "reportDate", "separate-from-source-times"],
    ["industry-radar", "missingBehavior", "unknown-not-negative"],
  ];
  it.each(requiredTerms)("%s cannot lose the reviewed %s requirement", (name, field, expected) => {
    const source = text(name); const front = /^---\n([\s\S]*?)\n---/.exec(source)!;
    expect(YAML.parse(front[1]!).delivery_contract[field]).toEqual(expected);
    expect(() => assertPmSkillContract(name, change(name, (contract) => { delete contract[field]; }))).toThrow();
    expect(() => assertPmSkillContract(name, change(name, (contract) => { contract[field] = "unsafe-previous-rule"; }))).toThrow();
  });
});

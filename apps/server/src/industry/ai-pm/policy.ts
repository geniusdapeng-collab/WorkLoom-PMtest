import { judge, type RuntimeRule, type JudgeVerdict } from "@workloom/base/fence-engine";
import type { AssembledPreset } from "@workloom/runtime";
import { PmError } from "./types.js";

export const PM_SANDBOX_POLICY_VERSION = "workloom-pm.sandbox-artifacts/v1";

/** This is capability attribution for draft generation, never a call to the original business handler. */
const DRAFT_CAPABILITIES: Record<string, { tool: string; objectType: string }> = {
  "chief-pm": { tool: "team.assign.write", objectType: "team_plan" },
  "requirement-analyst": { tool: "requirements.write", objectType: "requirement" },
  "competitor-scout": { tool: "competitor.report.write", objectType: "report" },
  "data-insight": { tool: "report.write", objectType: "report" },
  "user-listener": { tool: "feedback.reply.write", objectType: "feedback_reply" },
  "doc-writer": { tool: "documents.write", objectType: "document" },
  "industry-radar": { tool: "intel.write", objectType: "report" },
  "release-guardian": { tool: "release.checklist.write", objectType: "release" },
  "dev-orchestrator": { tool: "devtools.task.write", objectType: "dev_task" },
  "model-scout": { tool: "intel.write", objectType: "report" },
  "eval-master": { tool: "eval_set.write", objectType: "eval_set" },
  "prompt-curator": { tool: "prompt.write", objectType: "prompt" },
  "red-teamer": { tool: "redteam.report.write", objectType: "redteam_finding" },
  "knowledge-curator": { tool: "digest.write", objectType: "knowledge_item" },
};

export interface SandboxContext { internalSandbox: boolean; external?: boolean; production?: boolean }
export interface SandboxVerdict extends JudgeVerdict {
  action: "pm.sandbox.artifact.write" | "pm.sandbox.assign"; declaredCapability: string; policyVersion: string;
}

/** Independent explicit PM policy; does not modify or downgrade any installed baseline. */
export function pmSandboxRules(): RuntimeRule[] {
  const base = { version: PM_SANDBOX_POLICY_VERSION, is_baseline: false };
  return [
    { ...base, rule_id: "PM-SBX-INTERNAL", name: "仅内部沙箱产物", level: "auto",
      objectTypes: ["pm_sandbox_artifact"], actions: ["pm.sandbox.artifact.write", "pm.sandbox.assign"],
      when: "context.pm_sandbox == true and context.external == false and context.production == false" },
    { ...base, rule_id: "PM-SBX-NO-EXTERNAL", name: "沙箱不得外发或执行生产动作", level: "block",
      objectTypes: ["pm_sandbox_artifact"], actions: ["pm.sandbox.artifact.write", "pm.sandbox.assign"],
      when: "context.external == true or context.production == true" },
  ];
}

export function judgeSandboxArtifact(preset: AssembledPreset, baseline: RuntimeRule[], context: SandboxContext): SandboxVerdict {
  return judgeController(preset, baseline, context, "pm.sandbox.artifact.write");
}

export function judgeSandboxAssignment(preset: AssembledPreset, baseline: RuntimeRule[], context: SandboxContext): SandboxVerdict {
  if (preset.presetKey !== "chief-pm") throw new PmError("MANAGER_NOT_DECLARED", "团队任务规划必须由产品总监组织");
  return judgeController(preset, baseline, context, "pm.sandbox.assign");
}

function judgeController(preset: AssembledPreset, baseline: RuntimeRule[], context: SandboxContext, action: SandboxVerdict["action"]): SandboxVerdict {
  const capability = DRAFT_CAPABILITIES[preset.presetKey];
  if (!capability || !preset.tools.some((tool) => tool.name === capability.tool && tool.access !== "read")
    || preset.fenceBindings.length === 0) {
    throw new PmError("CAPABILITY_NOT_DECLARED", "该员工没有声明可用于沙箱产物起草的能力或围栏");
  }
  const flags = { pm_sandbox: context.internalSandbox, external: context.external === true, production: context.production === true };
  // A separate semantic-capability decision keeps any installed business block/review binding effective.
  const sourceGrant: RuntimeRule = {
    rule_id: `PM-SBX-DRAFT-${preset.presetKey}`, name: "仅起草隔离文件，不执行原业务工具", version: PM_SANDBOX_POLICY_VERSION,
    is_baseline: false, level: "auto", objectTypes: [capability.objectType], actions: [capability.tool],
    when: "context.pm_sandbox == true and context.external == false and context.production == false",
  };
  const semantic = judge({ object: { type: capability.objectType }, action: capability.tool, effect: "write",
    params: { declaredCapability: capability.tool, artifactOnly: true }, context: flags }, [...baseline, sourceGrant], "review");
  const controller = judge({ object: { type: "pm_sandbox_artifact" }, action, effect: "write",
    params: { employee: preset.presetKey, declaredCapability: capability.tool }, context: flags }, [...baseline, ...pmSandboxRules()], "review");
  const levels = { auto: 0, review: 1, block: 2 };
  const level = levels[semantic.level] > levels[controller.level] ? semantic.level : controller.level;
  return { action, declaredCapability: capability.tool, policyVersion: PM_SANDBOX_POLICY_VERSION,
    level, impacts: [...semantic.impacts, ...controller.impacts], triggeredBy: [...semantic.triggeredBy, ...controller.triggeredBy],
    evalErrors: [...semantic.evalErrors, ...controller.evalErrors] };
}

/** Only a separately supplied public query can use the PM evidence connector. */
export function judgePmPublicSearch(rules: RuntimeRule[]): JudgeVerdict {
  const grant: RuntimeRule = {
    rule_id: "PM-SBX-PUBLIC-EVIDENCE", name: "成员显式请求的公开资料检索",
    version: PM_SANDBOX_POLICY_VERSION, is_baseline: false, level: "auto",
    objectTypes: ["public_evidence"], actions: ["web.research"],
    when: "context.explicit_public_query == true",
  };
  return judge({ object: { type: "public_evidence" }, action: "web.research", effect: "read",
    params: {}, context: { explicit_public_query: true } }, [...rules, grant], "review");
}

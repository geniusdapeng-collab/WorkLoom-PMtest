import { PmError, type PmTaskPlan } from "./types.js";

export interface PmOwnerCorrection {
  taskId: string;
  from: string;
  to: string;
  reason: string;
}

interface PathOwnership {
  owners: readonly string[];
  preferred: string;
  reason: string;
}

/**
 * High-confidence ownership only. Unknown output names remain with the
 * planner's employee; the guard never guesses from an arbitrary filename.
 */
const PATH_RULES: Array<{ match: RegExp; ownership: PathOwnership }> = [
  {
    match: /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|sh|ps1)$|(?:^|\/)package\.json$/i,
    ownership: { owners: ["dev-orchestrator"], preferred: "dev-orchestrator", reason: "代码或测试文件只能由研发编排岗位拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:red[-_]?team|security|threat|vuln)(?:[/_.-]|$)/i,
    ownership: { owners: ["red-teamer"], preferred: "red-teamer", reason: "安全检查报告由红队官拥有" },
  },
  {
    match: /(?:^|[/_.-])prompt(?:[/_.-]|$)/i,
    ownership: { owners: ["prompt-curator"], preferred: "prompt-curator", reason: "提示词版本与回归资料由提示词主理官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:eval|badcase|benchmark|regression)(?:[/_.-]|$)/i,
    ownership: { owners: ["eval-master"], preferred: "eval-master", reason: "评测、坏例与回归报告由模型评测官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:competitor|competitive|竞品)(?:[/_.-]|$)/i,
    ownership: { owners: ["competitor-scout"], preferred: "competitor-scout", reason: "竞品研究报告由竞品侦察官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:industry|radar|policy)(?:[/_.-]|$)/i,
    ownership: { owners: ["industry-radar"], preferred: "industry-radar", reason: "行业情报与政策报告由行业瞭望官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:model|usage)(?:[/_.-]|$)/i,
    ownership: { owners: ["model-scout"], preferred: "model-scout", reason: "模型选型与成本报告由模型侦察官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:knowledge|kb|learning)(?:[/_.-]|$)/i,
    ownership: { owners: ["knowledge-curator"], preferred: "knowledge-curator", reason: "知识保鲜与学习周刊由知识保鲜官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:release|changelog|rollback|canary)(?:[/_.-]|$)/i,
    ownership: { owners: ["release-guardian"], preferred: "release-guardian", reason: "发布检查单与回滚资料由发布护航官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:feedback|user[-_]?review|user[-_]?insight|voice[-_]?of[-_]?customer)(?:[/_.-]|$)/i,
    ownership: { owners: ["user-listener"], preferred: "user-listener", reason: "用户反馈聚类与回复建议由用户倾听官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:metric|metrics|analytic|funnel)(?:[/_.-]|$)/i,
    ownership: { owners: ["data-insight"], preferred: "data-insight", reason: "指标计算与数据分析报告由数据洞察官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:requirement|requirements|acceptance|user[-_]?story)(?:[/_.-]|$)/i,
    ownership: {
      owners: ["requirement-analyst", "doc-writer"],
      preferred: "requirement-analyst",
      reason: "需求分析与验收条目由需求分析官拥有，文档主笔可承接成稿",
    },
  },
  {
    match: /(?:^|[/_.-])(?:prd|product[-_]?spec)(?:[/_.-]|$)/i,
    ownership: {
      owners: ["doc-writer", "requirement-analyst"],
      preferred: "doc-writer",
      reason: "PRD 成稿由文档主笔拥有，需求分析官可承接定义",
    },
  },
  {
    match: /(?:^|[/_.-])(?:doc|document|meeting|postmortem|faq|summary)(?:[/_.-]|$)/i,
    ownership: { owners: ["doc-writer"], preferred: "doc-writer", reason: "通用文档成稿由文档主笔官拥有" },
  },
  {
    match: /(?:^|[/_.-])(?:priority|roadmap|decision|team[-_]?plan|plan)(?:[/_.-]|$)/i,
    ownership: { owners: ["chief-pm"], preferred: "chief-pm", reason: "优先级、路线图和团队决策由产品总监拥有" },
  },
];

function ruleFor(path: string): PathOwnership | undefined {
  // Code is a capability boundary. For documents, the deliverable name is more
  // specific than a project directory (security/prd.md is still a PRD).
  if (PATH_RULES[0]!.match.test(path)) return PATH_RULES[0]!.ownership;
  const basename = path.split("/").at(-1)!;
  const genericName = /^(?:summary|report|review|result)(?:\.[^.]+)?$/i.test(basename);
  const matches = genericName ? [] : PATH_RULES.slice(1).filter((rule) => rule.match.test(basename));
  if (matches.length > 0) {
    const owners = matches[0]!.ownership.owners.filter((owner) => matches.every((rule) => rule.ownership.owners.includes(owner)));
    // model-eval.md is ambiguous, not evidence to overrule the planner.
    if (!owners.length) return undefined;
    const preferred = matches.map((rule) => rule.ownership.preferred).find((owner) => owners.includes(owner)) ?? owners[0]!;
    return { ...matches[0]!.ownership, owners, preferred };
  }
  // A generic review is not a customer-feedback-role hint.
  // Only use a specific nearest directory when the filename gives no signal.
  const directory = path.split("/").slice(0, -1).reverse();
  for (const part of directory) {
    const match = PATH_RULES.slice(1, -2).find((rule) => rule.match.test(part));
    if (match) return match.ownership;
  }
  return undefined;
}

function requireEvidenceDependencies(plan: PmTaskPlan[]): void {
  const byId = new Map(plan.map((task) => [task.id, task]));
  for (const task of plan) {
    const ancestors = new Set<string>();
    const visit = (id: string) => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      byId.get(id)?.dependsOn.forEach(visit);
    };
    task.dependsOn.forEach(visit);
    const text = [task.goal, ...task.acceptance].join("\n");
    for (const producer of plan) {
      if (producer.id === task.id || ancestors.has(producer.id)) continue;
      for (const path of producer.outputRefs) {
        const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(?<![A-Za-z0-9_./-])${escaped}(?![A-Za-z0-9_./-])`).test(text)) {
          throw new PmError("PLAN_EVIDENCE_DEPENDENCY_MISSING", `任务 ${task.id} 引用了 ${producer.id} 的产物 ${path}，但缺少前置依赖，未派发员工`);
        }
      }
    }
  }
}

/**
 * Reconcile a parsed DAG with deterministic output ownership and require the
 * semantic primary employee to participate. This is a business-logic check,
 * not a schema change: task IDs, dependencies, acceptance and files stay
 * untouched. A task that mixes incompatible owners is rejected before any
 * employee is called or any artifact is written.
 */
export function reconcilePmTeamPlan(
  plan: PmTaskPlan[],
  options: { primaryOwner?: string; allowedEmployees: readonly string[] } = { allowedEmployees: [] },
): { plan: PmTaskPlan[]; corrections: PmOwnerCorrection[] } {
  requireEvidenceDependencies(plan);
  const allowed = new Set(options.allowedEmployees);
  const corrections: PmOwnerCorrection[] = [];
  const reconciled = plan.map((task) => {
    const ownerships = task.outputRefs.map(ruleFor).filter((value): value is PathOwnership => value !== undefined);
    if (ownerships.length === 0) return task;

    const intersection = new Set(ownerships[0]!.owners);
    for (const ownership of ownerships.slice(1)) {
      for (const owner of [...intersection]) if (!ownership.owners.includes(owner)) intersection.delete(owner);
    }
    if (intersection.size === 0) {
      throw new PmError("PLAN_OWNER_CONFLICT", `任务 ${task.id} 同时包含不同岗位职责的产物，必须拆分后再派发`);
    }
    if (intersection.has(task.presetKey)) return task;
    const preferred = ownerships.find((ownership) => intersection.has(ownership.preferred))?.preferred
      ?? [...intersection][0]!;
    if (!allowed.has(preferred)) {
      throw new PmError("EMPLOYEE_NOT_READY", `任务 ${task.id} 需要 ${preferred}，但该员工未就绪`);
    }
    const reason = ownerships.find((ownership) => ownership.preferred === preferred)?.reason ?? "产物职责与岗位不匹配";
    corrections.push({ taskId: task.id, from: task.presetKey, to: preferred, reason });
    return { ...task, presetKey: preferred };
  });

  if (options.primaryOwner && allowed.has(options.primaryOwner)
    && !reconciled.some((task) => task.presetKey === options.primaryOwner)) {
    throw new PmError("PLAN_PRIMARY_OWNER_MISSING", `团队计划没有包含目标的主责岗位 ${options.primaryOwner}，未派发员工`);
  }
  return { plan: reconciled, corrections };
}

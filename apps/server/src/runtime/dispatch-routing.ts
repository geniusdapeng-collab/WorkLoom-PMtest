/**
 * 派活岗位路由（N-14，2026-09-28 真机实证）。
 *
 * 问题：`resolveDispatchPresetKey` 原先只按 **Bundle 清单顺序**取第一个 kind=orchestrator 的就绪岗位——
 * geo-growth 的 presets 列表里 `production-planner`（视频生产编排员）排在 `growth-lead` 之前，
 * 于是"统计渠道线索并做复盘"这类增长任务被派给视频工装的岗位：
 * 工装工具（shot.decompose/shootlist.emit/ai_task.emit）与任务语义无关，交付物必然错位。
 *
 * 口径：先按**任务语义**做确定性匹配（视觉/视频/增长/发布四类通用能力域），
 * 未命中再落行业默认指挥岗位；都取不到时由调用方回落到 Bundle 顺序 → 指挥层兜底 → 任意就绪员工。
 * 本表运行在部署层（apps/server），行业词不进底座（D18）。
 */

export interface DispatchRoutingInput {
  goal: string;
  industry?: string | null;
}

interface RoutingRule {
  id: string;
  /** When set, the rule only applies to the named active bundles. */
  industries?: readonly string[];
  /** 任务语义匹配（口语说法覆盖） */
  match: RegExp;
  /** 优先岗位（按序取第一个就绪项） */
  presets: string[];
}

/**
 * 通用能力域 → 岗位偏好。顺序即优先级：越具体的域越靠前
 * （例如"生成视频封面图"同时含"视频"和"封面"，按视觉域处理更贴合真实交付物）。
 */
const RULES: RoutingRule[] = [
  /**
   * AI-PM owns fourteen distinct job families. These rules must run before
   * generic visual/publish/growth domains: otherwise words such as "发布" or
   * "增长" can route a product-management goal to a legacy orchestrator.
   *
   * High-risk quality work is deliberately evaluated before its adjacent
   * domains (for example red-team before release, prompt regression before
   * evaluation) so a security request cannot be diluted into a report task.
   */
  {
    id: "ai-pm-red-team",
    industries: ["ai-pm"],
    match: /红队|对抗测试|防御性(?:授权)?测试|安全演练|风险分级|提示注入|越权|越狱|jailbreak|SSRF|跨站脚本|XSS|SQL\s*注入|路径穿越|安全扫描|攻击面/i,
    presets: ["red-teamer"],
  },
  {
    id: "ai-pm-prompt",
    industries: ["ai-pm"],
    match: /提示词|提示改动|system\s*prompt|\bprompt\b|提示注入防护/i,
    presets: ["prompt-curator"],
  },
  {
    id: "ai-pm-model",
    industries: ["ai-pm"],
    match: /模型选型|候选模型|模型比较|模型能力|换型|上下文预算|token\s*用量|\busage\b|模型路由|质量.{0,20}时延.{0,20}成本|时延.{0,20}成本/i,
    presets: ["model-scout"],
  },
  {
    id: "ai-pm-evaluation",
    industries: ["ai-pm"],
    match: /\beval(?:uation)?\b|评测集|评测官|回归用例|分类验证报告|独立再评测|badcase|坏例|微调|judge|混淆矩阵|评测回归/i,
    presets: ["eval-master"],
  },
  {
    id: "ai-pm-knowledge",
    industries: ["ai-pm"],
    match: /知识库|知识条目|知识保鲜|知识裁决|学习周刊|学习飞轮|过期条目|冲突知识|来源优先级|术语表|经验固化|归档建议/i,
    presets: ["knowledge-curator"],
  },
  {
    id: "ai-pm-competitor",
    industries: ["ai-pm"],
    match: /竞品|竞对|竞争对手|竞争方案|威胁评级|功能变化对比/i,
    presets: ["competitor-scout"],
  },
  {
    id: "ai-pm-industry",
    industries: ["ai-pm"],
    match: /行业动态|行业情报|行业简报|技术动态|行业雷达|行业政策|政策动态|投融资|模型发布|工具链演进|官方更新日志|新闻源|发布速报/i,
    presets: ["industry-radar"],
  },
  {
    id: "ai-pm-user-listener",
    industries: ["ai-pm"],
    match: /用户反馈|用户问题摘要|待审回复|受访者|用户差评|差评|评论|投诉|反馈聚类|访谈摘要|情绪趋势|代表原声|回复建议|流失用户/i,
    presets: ["user-listener"],
  },
  {
    id: "ai-pm-data-insight",
    industries: ["ai-pm"],
    match: /数据洞察|指标|漏斗|转化率|留存|ARPU|LTV|CAC|p95|环比|同比|异动|A\/B\s*判定|日报|周报/i,
    presets: ["data-insight"],
  },
  {
    id: "ai-pm-release",
    industries: ["ai-pm"],
    match: /发布检查|发布门禁|变更日志|回滚预案|Canary|灰度|功能开关|Feature\s*Flag|SBOM|迁移回滚|上线检查/i,
    presets: ["release-guardian"],
  },
  {
    id: "ai-pm-development",
    industries: ["ai-pm"],
    match: /开发任务|研发任务|研发分工|返修任务书|机床交付|文件所有权|代码实现|JavaScript|TypeScript|\bESM\b|实现.{0,16}(?:模块|函数|算法|接口)|修复.{0,12}(?:bug|错误|缺陷)|测试代码|代码审计|\bPR\b/i,
    presets: ["dev-orchestrator"],
  },
  {
    id: "ai-pm-requirements",
    industries: ["ai-pm"],
    match: /需求分析|需求池|需求分诊|需求条理化|字段约束|状态流转|权限矩阵|边界验收|普通客户.{0,20}企业客户|输入.{0,12}最大.{0,12}重试/i,
    presets: ["requirement-analyst"],
  },
  {
    id: "ai-pm-document",
    industries: ["ai-pm"],
    match: /\bPRD\b|会议纪要|决策纪要|版本说明|事故复盘|值班手册|FAQ|高管摘要|产品文档|用户可读|撰写.{0,12}(?:文档|说明|手册)/i,
    presets: ["doc-writer"],
  },
  {
    id: "ai-pm-decision",
    industries: ["ai-pm"],
    match: /优先级|排P[0-2]|P[0-2]\/P[0-2]|路线图|资源分配|范围裁剪|Go\/No-Go|冲突裁决|关键路径|产品决策|决策卡|迭代建议|团队计划|项目排期/i,
    presets: ["chief-pm"],
  },
  {
    id: "visual",
    match: /海报|配图|封面|生图|出图|主视觉|素材图|图片|生成.{0,12}图|画一?[张幅].{0,12}图|做一?[张幅].{0,12}图/,
    presets: ["visual-designer", "cover-designer", "cro-designer"],
  },
  {
    id: "video",
    match: /视频|短片|成片|影片|分镜|镜头|口播|剪辑|宣传片|TVC|纪录片|混剪|配乐|调色|字幕/,
    presets: ["director", "production-planner", "scriptwriter", "explainer-director"],
  },
  {
    id: "publish",
    match: /发布|外发|分发|投放|加投|上架|群发|铺量/,
    presets: ["publish-operator", "source-distributor", "distribution-operator"],
  },
  {
    /**
     * N-13（第三轮实测）验收项：「把雅致大床房调价到 510 元」必须落到持有 pms.price.write 的定价岗位，
     * 而不是 orchestrator 的晨报工具——价格/库存/券务类目标走定价与券务岗位。
     */
    id: "pricing",
    match: /调价|定价|改价|价格|房价|报价|折扣|优惠|券|库存|房态|保底价/,
    presets: ["pricing-agent", "coupon-operator", "revenue-manager", "ads-optimizer"],
  },
  {
    id: "service-ops",
    match: /报修|维修|派单|送物|清洁|打扫|客房|入住|退房|前台|接听|工单/,
    presets: ["frontdesk-agent", "housekeeper-agent", "ai-receptionist", "phone-agent"],
  },
  {
    id: "growth",
    match: /增长|复盘|预算|投放|线索|转化|渠道|获客|ROI|CAC|漏斗|实验|内容规划|选题|能见度|GEO|排名|信源/,
    presets: ["growth-lead", "growth-strategist", "data-board-officer"],
  },
];

/** Explicit requested deliverables outrank incidental domain words in context.
 * Keep this a narrow high-confidence hint, not a replacement semantic planner.
 * Choose the first requested artifact; other matched roles remain collaborators.
 */
const PM_DELIVERABLES: Array<{ preset: string; match: RegExp }> = [
  { preset: "doc-writer", match: /(?:写|撰写|起草|编写|生成|输出|整理)[^，,。！？；;\n]{0,24}(?:PRD|产品文档|会议纪要|决策纪要|版本说明|用户手册|FAQ)/i },
  { preset: "release-guardian", match: /(?:制作|编写|撰写|生成|输出|准备|写)[^，,。！？；;\n]{0,16}(?:发布检查单|发布检查|发布卡|回滚预案|上线检查)|(?:审核|审阅)[^，,。！？；;\n]{0,24}发布包|(?:给出|判断)[^，,。！？；;\n]{0,12}发布\s*Go\/No-Go/i },
  { preset: "chief-pm", match: /(?:制定|规划|输出|编排|调整|整理)[^，,。！？；;\n]{0,24}(?:项目排期|团队计划|路线图|优先级|资源分配|迭代建议|决策卡)/i },
  { preset: "requirement-analyst", match: /(?:完成|开展|进行|输出|整理)[^，,。！？；;\n]{0,16}(?:需求分析|需求分诊|需求池|字段约束)|(?:设计|定义|梳理|细化)[^，,。！？；;\n]{0,32}(?:需求|功能)/i },
  { preset: "eval-master", match: /(?:设计|构建|编写|生成|输出)[^，,。！？；;\n]{0,24}(?:评测集|评测用例|评测方案|回归用例)|(?:审计|评审)[^，,。！？；;\n]{0,24}(?:分类验证报告|评测报告)/i },
  { preset: "competitor-scout", match: /(?:对比|比较)[^，,。！？；;\n]{0,24}(?:产品|竞品|厂商|套餐)|(?:产品|协作工具)[^，,。！？；;\n]{0,16}(?:采购对比|选型对比)/i },
  { preset: "industry-radar", match: /(?:写|撰写|编写|做|输出|汇总)[^，,。！？；;\n]{0,20}(?:行业简报|行业情报|行业动态|技术动态)/i },
  { preset: "dev-orchestrator", match: /(?:设计|编制|编写|生成|拆解|输出)[^，,。！？；;\n]{0,24}(?:研发任务|研发分工|开发任务)|(?:写|输出)[^，,。！？；;\n]{0,16}返修任务书/i },
  { preset: "red-teamer", match: /(?:设计|编写|开展|进行)[^，,。！？；;\n]{0,16}(?:防御性(?:授权)?测试|对抗测试|红队测试)/i },
  { preset: "data-insight", match: /(?:分析|复算|计算)[^，,。！？；;\n]{0,24}(?:注册转化|漏斗|转化率|经营指标)|(?:评审|分析)[^，,。！？；;\n]{0,16}实验报告/i },
  { preset: "user-listener", match: /(?:整理|汇总|聚类)[^，,。！？；;\n]{0,24}(?:用户反馈|受访者|用户原话)|(?:生成|输出)[^，,。！？；;\n]{0,16}(?:用户问题摘要|待审回复)/i },
  { preset: "prompt-curator", match: /(?:设计|改进|产出|编写|版本化)[^，,。！？；;\n]{0,24}(?:提示词|提示改动|prompt)/i },
  { preset: "model-scout", match: /(?:判断|评审|审查)[^，,。！？；;\n]{0,20}换型提案|(?:做|提供|输出|给出)[^，,。！？；;\n]{0,12}选型建议(?=[\s\S]{0,100}模型)|(?:比较|选择|评估)[^，,。！？；;\n]{0,16}(?:候选模型|文本模型|语言模型)/i },
  { preset: "knowledge-curator", match: /(?:整理|盘点|做|输出)[^，,。！？；;\n]{0,16}(?:知识库|知识裁决|知识保鲜)/i },
];

/** Excluding a work item is not a request for that item's owner. Bound the
 * exclusion to its clause; contrast and double negation can require work again.
 * This affects routing hints only and never removes source text from the task.
 */
function isExcludedPmWork(goal: string, index: number): boolean {
  const prefix = goal.slice(Math.max(0, index - 80), index)
    .split(/[，,。！？；;\n]|(?:但是|但|而是|而要|只需|改为|转为|仍需)/u).at(-1) ?? "";
  if (/(?:不得不|不能不|不可不)[^，,。！？；;\n]{0,36}$/u.test(prefix)) return false;
  return /(?:无需|无须|不必|不要|禁止|不得|别|不)(?:再|实际|直接|现在|去)?(?:(?:做|进行|开展|生成|编写|撰写|输出|制作|整理|分析|讨论|考虑|涉及|处理|评估|设计|实现|写|修改|改|比较|核验)[^，,。！？；;\n]{0,36})?$/u.test(prefix);
}

function requestedPmDeliverable(goal: string): string | undefined {
  const candidates = PM_DELIVERABLES.flatMap((rule) => [...goal.matchAll(new RegExp(rule.match.source, `${rule.match.flags}g`))]
    .filter((match) => !isExcludedPmWork(goal, match.index))
    .map((match) => ({ preset: rule.preset, index: match.index })));
  return candidates.sort((a, b) => a.index - b.index)[0]?.preset;
}

/** 行业默认指挥岗位（Bundle 清单顺序缺省时使用；hotel 保持原"清单顺序"行为，不在此表内） */
const INDUSTRY_DEFAULTS: Record<string, string[]> = {
  "ai-pm": ["chief-pm"],
  "geo-growth": ["growth-lead", "growth-strategist"],
  "ai-video": ["director", "production-planner"],
  // hotel：默认指挥岗位不放生产编排（那是 ai-video 依赖包带来的视频岗），走公司与增长负责人
  hotel: ["company-ceo", "growth-lead"],
};

/** 命中语义规则后的候选岗位，不包含行业默认岗位。 */
export function preferredDispatchRulePresets(input: DispatchRoutingInput): string[] {
  const goal = input.goal ?? "";
  const out: string[] = [];
  if (input.industry === "ai-pm") {
    const explicit = requestedPmDeliverable(goal);
    if (explicit) out.push(explicit);
  }
  const push = (key: string) => { if (key && !out.includes(key)) out.push(key); };
  for (const rule of RULES) {
    if (rule.industries && !rule.industries.includes(input.industry ?? "")) continue;
    const matched = input.industry === "ai-pm"
      ? [...goal.matchAll(new RegExp(rule.match.source, `${rule.match.flags}g`))].some((match) => !isExcludedPmWork(goal, match.index))
      : rule.match.test(goal);
    if (matched) rule.presets.forEach(push);
  }
  return out;
}

/** 返回按优先级排序的候选岗位（纯函数，便于单测与复盘"为什么派给了谁"） */
export function preferredDispatchPresets(input: DispatchRoutingInput): string[] {
  const out = preferredDispatchRulePresets(input);
  const push = (key: string) => { if (key && !out.includes(key)) out.push(key); };
  for (const key of INDUSTRY_DEFAULTS[input.industry ?? ""] ?? []) push(key);
  return out;
}

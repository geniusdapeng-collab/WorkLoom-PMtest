---
name: competitor-scan
version: 1.0.3
description: 竞品侦察。真实联网抓取竞品站点/更新日志，LLM 对比摘要与威胁评级。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  productResponse: scenario-proposal-and-verification
  capabilityEntitlement: separate-capability-inclusion-access-and-test
  totalCostDirection: comparable-complete-inputs-required
  claimConsistency: source-strength-preserved-across-sections
  primarySourceRequired: true
  comparisonScopeRequired: true
  missingSnapshot: "unknown-not-unchanged"
  vendorClaim: "claim-not-tested"
---

# 竞品扫描对比

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 复用 browser-playwright/scrapling-collector 抓取竞品更新页
2. 与上一版快照 diff 提取变化点
3. LLM 生成对比摘要与威胁评级（高威胁挂审批 R-PM3）

4. 先列竞品、产品版本/套餐、目标用户、比较维度与截止日期；用官方原文、访问时间和证据摘录逐项建立对比矩阵，厂商宣称与亲测能力分列。
5. 上一版快照缺失只建立基线，抓取失败记未知，不能写无变化；不同地区/套餐/发布时间不直接比较。威胁评级写明受影响用户、差异、替代成本与可验证行动，不能按新闻热度自动判高威胁。

6. 用户要求应对建议时，单列“本产品应对”：按受影响用户场景提出至少一个产品行为/方案/原型建议、代价、适用前提和可核查验收；补资料或继续调研只是证据计划，不能替代产品方案。当前产品能力未知时明确写为待评审提案，不声称已具备或已执行；无充分证据先做隔离原型/访谈验证，不编上线承诺。

7. 对每项能力分列来源宣称、套餐是否包含、开通/取得条件及实际验证状态；“支持/可使用”不能改写成“默认包含/免费/自动开通”，未说明的维度保持未知。比较完整成本前先核齐同口径必要组成、价格、计费周期与数量以及迁移/配置条件；必需输入缺失时只能报告已知分项与未知项，不能断言总成本、替代成本或成本优势的方向。摘要、威胁评级、对比表和正文逐项回查同一来源，保持原文的条件与证据强度，不在概括时升级为默认可用、实测可用或更低成本。

## 四、边界与围栏
- 权限面：联网只读；报告写库（L1）。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。

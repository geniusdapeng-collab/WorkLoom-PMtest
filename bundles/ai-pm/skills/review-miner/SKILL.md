---
name: review-miner
version: 1.0.1
description: 评论挖掘。评论/反馈 LLM 聚类、情绪打分、代表原声提取。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  sourceIdRequired: true
  quote: "verbatim-or-explicit-redaction"
  insufficientQuotes: "report-available-only"
  denominatorAndDeduplicationRequired: true
---

# 反馈聚类与情绪分析

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 读取反馈集（新增优先）
2. LLM 聚类出主题分布（差评/建议/咨询）
3. 每主题最多提取代表原声 2 条（不足时只列实际原声）；差评自动生成工单草稿

4. 先按反馈 ID 和用户/事件去重，声明样本时间窗、有效样本量、主题计数分母与多标签规则；情绪与问题严重度分开，少数高危反馈不能因数量低被忽略。
5. 原声必须逐字引用并挂源 ID，脱敏处显式标记，不把改写当原话；主题不足两条只报告实际可得数量，禁止凑数。回复是草稿，承诺修复时间/退款须有授权；工单创建须独立真实回执。

## 四、边界与围栏
- 权限面：读反馈库；工单创建（L1）。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。

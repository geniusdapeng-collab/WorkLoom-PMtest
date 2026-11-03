---
name: competitor-scan
version: 1.0.1
description: 竞品侦察。真实联网抓取竞品站点/更新日志，LLM 对比摘要与威胁评级。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
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

## 四、边界与围栏
- 权限面：联网只读；报告写库（L1）。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。

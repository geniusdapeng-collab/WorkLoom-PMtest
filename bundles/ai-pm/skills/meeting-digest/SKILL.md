---
name: meeting-digest
version: 1.0.1
description: 会议文本抽取决议/待办/负责人。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  decisionStates: ["confirmed", "proposal", "open"]
  sourceAnchorRequired: true
  unknownOwnerOrDate: "explicitly-missing"
  relativeDateNeedsAnchor: true
---

# 会议纪要结构化

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 读取会议原始文本
2. 抽取决议条目（含上下文）
3. 抽取待办（负责人+时限）
4. 输出结构化纪要入文档库

5. 每条保留原文段落/发言或时间戳锚点，明确区分已确认决议、建议方案、未决问题；参会者提出的愿望不自动成为团队承诺。
6. 待办逐条对应负责人、截止时间、依赖和验收结果；原文未给负责人或日期写未指定/待确认，不代填。相对日期只有在会议日期与时区明确时才换算，保留原始说法；冲突意见与变更撤回不得静默合并成一致决议。

## 四、边界与围栏
- 权限面：读输入；写文档库（L1）。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。

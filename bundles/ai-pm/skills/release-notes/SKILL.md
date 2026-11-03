---
name: release-notes
version: 1.0.1
description: 读取版本记录生成发布说明与变更日志。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  versionAndCommitRequired: true
  changeStatusSeparate: true
  rollbackRequiresKnownSafeVersion: true
  publishRequiresReceipt: true
---

# 发布说明生成

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 读取版本提交/变更记录
2. 按「新功能/优化/修复/已知风险」分类成文
3. 附发布检查单（回滚预案必填）

4. 绑定目标版本、基线/候选 commit、变更条目与验证回执；严格区分计划、已实现、已测试、已合并、已部署，不能把开放 PR 写成已上线。
5. 说明用户影响、兼容性与迁移要求、已知问题、监控窗口和负责岗位；回滚指定已验证安全的版本、触发阈值、动作与复验，旧版本有已知漏洞时停止/停用而非恢复漏洞。未执行发布只能交草稿和待执行检查单。

## 四、边界与围栏
- 权限面：读版本库；写文档库（L1）。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。

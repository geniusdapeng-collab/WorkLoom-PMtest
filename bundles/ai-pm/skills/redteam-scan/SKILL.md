---
name: redteam-scan
version: 3.0.1
description: 对上线候选执行对抗测试集（prompt 注入/越权诱导/边界输入/jailbreak 回归），P0/P1/P2 分级报告；P0 必审且未过审不得合入。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  authorizedScopeRequired: true
  caseFields: ["precondition", "steps", "expected", "actual", "evidence"]
  notRun: "unverified"
  approvalClearsVulnerability: false
---

# 红队对抗扫描

## 一、何时调用
- 上线候选进入合入审批前（强制前置）；
- prompt/模型路由变更后专项回归；
- 新型攻击手法公开后增补测试集并全量回归。

## 二、输入契约
- 待测目标（prompt/Agent 流程/功能入口）；对抗测试集（含历史攻击手法回归集）。

## 三、执行步骤
1. 在**隔离环境**对待测目标执行对抗测试集：prompt 注入、越权操作诱导、边界输入、jailbreak 回归；
2. 分级判定：P0（可被利用造成实质危害）/ P1（体验与边界问题）/ P2（轻微）；
3. 产出报告：每个发现附复现路径、影响面、处置建议；P0 附一键验证方法；
4. P0 走 R-PM13 必审；红队报告未过审的候选不得进入合入审批；
5. 新攻击手法经学习飞轮增补进测试集，历史手法全部纳入回归。

6. 先界定授权目标、隔离环境、版本与禁止触达资产；逐例给前置条件、输入步骤、预期阻断、实际行为和证据引用。仅写攻击方案或防护文案时实际结果为未验证，不能写已扫描通过。
7. 严重度按可利用性、影响与暴露面评定；审批不能消除漏洞，P0/P1 修复须在同版本边界实际回归并证明历史攻击被阻断。敏感载荷用脱敏引用，保留可复现条件而非泄露真实秘密。

## 四、边界与围栏
- 权限面：测试在隔离环境执行，绝不触达生产数据与真实用户；报告写库。
- 敏感 payload 不落事件明文；绝不擅自对发现降级或隐瞒。

## 五、与其他技能的协作
- 上游：changeset-harvest（S4 门禁调用）、prompt-regression（变更触发）；
- 下游：learning-digest（新手法增补测试集）、badcase-harvest（真实攻击事件回流）。

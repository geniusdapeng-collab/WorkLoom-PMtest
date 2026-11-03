---
name: dev-dispatch
version: 1.0.2
description: 开发任务派发——选机床、建隔离 worktree、快照、启动受管会话。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  dependencyAcceptanceRequired: true
  acceptanceAuthority: independent-owner-bound-evidence
  oneOutputOwner: true
  authorizationBeforeExecution: true
  dispatchRequiresReceipt: true
---

# 开发任务派发

## 一、何时调用
- 任务单经人类确认（S2 confirmed）后，由开发总指挥触发；返修再派由系统自动接续。

## 二、输入契约
- dev_tasks（confirmed）+ dev_repos 白名单 + dev_tool_installs 在线机床台账。

## 三、执行步骤
1. 选派机床：指派优先，缺省按注册表顺序（Codex 优先，能力匹配）
2. git worktree 建隔离分支 `dev/<task-id>`（主分支零直写）
3. 快照先行：基线 commit + status 指纹（回滚锚点）
4. 凭据 L4 注入环境变量（secret 不进事件明文），启动受管会话
5. 返修第 2 轮起：携带打回原因，支持续跑的机床 resume 原线程

6. 每个任务单必须有单一负责人、输入来源、依赖任务及其交付验收、接口约束、唯一产物所有权、完成条件与失败恢复；关键依赖未验收时不派发后继任务。
7. 同一文件不能交给两个并行任务修改；跨模块先约定接口再并行，列关键路径与可并行项。机床不可用、授权缺失或接口冲突应阻断对应执行，保留可完成的设计产物；无会话回执不写已派发。

8. 产物负责人交付后，安排不同的验收责任人或服务端可信验收器按冻结需求验证；验收回执绑定候选版本/文件摘要、输入、判据、实际结果与验证主体。生成的文件、作者自测、模型评语或口头批准不能单独证明独立验收已完成；审批也不能替代实际验证。任务单明确独立验收节点及失败返修路径，后继依赖只在对应验收真实通过后放行；只写方案时将该节点标待执行，不虚构验收者已确认。

## 四、边界与围栏
- 未登记目录机床一寸都进不去（白名单 + 路径钳制双重强制）
- 会话三重熔断：超时 / 连续围栏拦截 / 进程异常
- 绝不假装：无在线机床时返回安装指引，不模拟开发

## 五、与其他技能的协作
- 会话监督交 session-watch；终点自动接 changeset-harvest 审计；
  失败按返修纪律（≤2 轮）自动再派，再败转人工。

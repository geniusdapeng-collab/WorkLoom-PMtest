---
name: github-pulse
version: 1.0.1
description: 仓库脉搏。gh API 读取 issue/PR/提交节奏，LLM 分析产品健康度。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  credentialDestination: "official-origin-only"
  redirectWithCredential: "reject"
  paginationRequired: true
  missingData: "unknown-not-zero"
---

# GitHub 仓库脉搏

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 凭据走 L4 Patch 注入（只读 token，不进事件明文）
2. 拉取近 7 天 issue/PR/commit 节奏
3. LLM 生成仓库脉搏分析（活跃度/阻塞点/建议）

4. 固定仓库、分支、完整起止时间与时区；issues 排除 PR，分页取完或披露覆盖缺口，PR 状态区分 open/closed/merged，提交按目标分支统计。
5. 空结果与请求失败分开；不以提交数量推断团队生产率或业务价值，给阻塞项链接、等待时长、负责人及下一动作。未取到主干/CI/合并回执时不得声称已发布。

## 四、边界与围栏
- 权限面：联网只读。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。

## 六、运行配置
- 认证请求只发送到官方 `https://api.github.com`，携带凭据时拒绝重定向；连接失败时保留失败，不把令牌转发第三方镜像。
- 无凭据只读开发端点可以显式配置，但不得接收真实凭据。来源失败记「未验证」，mock/演示结果不能计入真实结论。

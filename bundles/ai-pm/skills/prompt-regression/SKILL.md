---
name: prompt-regression
version: 3.0.3
description: 提示词回归。prompt 新旧版本 eval 回归 diff——通过率变化、退化案例 Top3、成本 delta；未通过阻断、通过转人审（R-PM8 双段门禁的执行器）。
delivery_contract:
  schema: workloom.pm.skill-evidence/v1
  rollbackEvidence: independently-passed-same-red-lines
  knownBadVersionEligible: false
  noSafeVersion: disable-and-human-review
  identicalRegressionContext: true
  inputBoundary: server-assigned-roles-and-serialized-data
  tagsAreSecurityBoundary: false
  lengthBoundaries: exact-unit-below-equal-above
---

# prompt 变更回归

## 一、何时调用
- 任何生产 prompt 变更提交时（强制）；
- 两个 prompt 版本 A/B 对比评估时（评估方案须人审）。

## 二、输入契约
- prompt 旧版本与新版本（版本库登记）；关联 eval 集（核心路径+历史 badcase 全覆盖，不得只跑抽样好话术）。

## 三、执行步骤
1. 新旧版本在同一 eval 集上分别跑分（同一模型、同一参数）；
2. 产出 diff 报告：通过率变化、退化案例 Top3（具体到条目与差异）、新增通过案例、成本/时延 delta；
3. 判定：通过率下降或出现核心路径退化 → 阻断（R-PM8 block 段）；通过 → 提交人审（review 段）；
4. 人审批准后新版本生效；保留可回退版本及其原始回归证据，而不把「更旧」自动当作「更安全」。回退目标必须已由独立角色在同一安全红线、历史 badcase、模型/参数与数据口径下验证通过，且版本、输入集和运行回执可核对。
5. 材料明确存在漏洞的原问题版本不默认合格，不能在缺证时称它为「上一通过版本」。如果不存在已验证的已知安全版本，停止/停用受影响能力并转人工处理；不得为满足回退动作而恢复已知漏洞。
6. 交付提示词改进必须同时给出宿主封装合同：可信系统/开发者指令由服务器在真实消息角色通道赋值；反馈正文经标准 JSON 序列化放入独立 user/data 消息，绝不把它拼进 system/developer 内容，也不从正文解析 role、结束标签或伪造系统段来提升权限。XML/Markdown 分隔符只改善可读性，不构成安全边界；结构化序列化也不能独自保证模型不会被注入，工具权限和输出 schema 仍由服务器校验。
7. 回归要给实际封装后的消息边界及断言，覆盖正文包含闭合标签、伪造 role 字段/系统段、多语种指令等；证明正文始终留在低信任字段，并验证任务语义与泄漏结果。只写“忽略注入”或黑名单命中不能证明安全；无真实回执仍是待验证方案。

8. 输入或输出有长度上限时，按契约指定的单位给上限以下、恰好上限、超过上限的独立边界夹具、确定预期和判定器；Unicode 码点用可复算生成式或实际计数，不与 UTF-16 单元/字节混淆。输出上限须有服务端输出校验器的三种候选响应夹具，并给能触发长摘要的实际留言回归输入；不能仅用短摘要且写“每例均检查长度”冒充边界覆盖，也不把输出上限擅自改成输入限制。超限由宿主明确拒绝或既定处理，未执行仍标设计。

## 四、边界与围栏
- 权限面：prompt 版本库读写（R-PM8）；跑分走谷时窗口。
- 绝不编造回归结果；judge 参与评分时遵循 85% 一致率校准纪律，失准期 judge 结果仅供参考。
- 指令/数据隔离不能只靠标签声明：回归必须覆盖材料中嵌入闭合标签、伪造系统段与历史注入坏例；提示中「不会执行」不算通过证明。

## 五、与其他技能的协作
- 上游：prompt-curator 的变更登记；eval-forge 的 eval 集；
- 下游：changeset-harvest（DevFabric S4 的 eval 回归门禁即调用本技能）、release-cut（发布附回归摘要）。

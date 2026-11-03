# PM 专属验收入口

这些入口位于现有 `apps/server/src/industry/**` 产品保留面。公共基座同步不下发 PM 任务、模型评测材料或行业实现依赖；没有为这些入口新增同步例外。

从仓库根目录执行：

```sh
pnpm test:pm-dsh
pnpm test:pm-evaluation-state
pnpm pm:eval
```

`test:pm-dsh` 显式使用 Node test runner 运行 `dsh-integration.mts`。它真实启动锁定 DSH 子进程，模型由本地确定性夹具提供，验证读写产物、会话日志、Unicode、越权拒绝、调用预算、配额错误、缺失计量、取消和超时；不调用收费模型。该文件有意不以 `.test.mts` 命名，避免服务端的 Vitest 自动发现把 Node test runner 入口重复执行。

`pm:eval` 运行 `evaluate.mts`，保留真实 HTTP、单员工、跨员工 DAG、独立代码验收、意图与岗位路由及官方搜索评测。它必须由已经配置的 loopback 预算代理保护，真实凭据只存在代理进程；实际调用受同一个持久化预算 run 约束。文件迁移不改变评测数据、收费上限、恢复阶段或判分规则。完整运行规范见仓库根 `docs/PM-EVALUATION.md`。

来源完整性单元测试位于本目录上一级的 `aipm-integrity.test.ts`，由服务端 Vitest 常规发现。可单独执行：

```sh
pnpm -C apps/server exec vitest run src/industry/ai-pm/aipm-integrity.test.ts
```

`PM_DSH_EVIDENCE_ROOT` 可显式保留真实 DSH 夹具证据；`PM_DSH_PACKAGE_ROOT` 仅用于明确选择正式 npm-ci desktop stage。两者都没有设置时，DSH 入口使用服务端自己的声明依赖，临时目录仍位于本任务仓库父目录，完成后按原规则清理。

评测记录追加规则：首次运行使用新的 `PM_EVAL_OUT` 和固定的 `PM_EVAL_RUN_ID`；已存在 `evaluation.json` 时 `initial` 阶段拒绝覆盖。后续分段或修复使用相同 session，并显式设置非 `initial` 的 `PM_EVAL_PHASE` 与 `PM_EVAL_ONLY`。失败任务修复继续原服务端 run/DAG，保留已付费规划和完成的祖先；目标、员工或 checks 漂移时拒绝复用。每次尝试使用不同证据目录，初次失败仍在分母中。预算代理沿用同一个持久化 run；修改阶段名不会扩大费用额度。

恢复时 checks 按深层值比较：对象键顺序不影响合同（兼容 PostgreSQL jsonb 回读），数组顺序、字段和值仍严格一致。恢复身份从该逻辑 case 的全部尝试中追溯唯一原 run，不因一次前置校验失败缺少 runId 而创建新 run；若同 case 出现不同 runId，则拒绝猜测。HTTP 响应丢失、尚未记录 runId 时也复用首次 case 的幂等键，不把尝试目录后缀用于新收费任务。

`PM_EVAL_CASE_TIMEOUT_MS` 控制单例结果捕获时限，必须为正安全整数毫秒；默认保留 9 分钟，长任务可显式设置 `2700000`（45 分钟）。捕获到时只追加 `captureStatus: pending` 与原 runId、已读状态和产物，**不自动取消或重试收费运行**；后续用相同 session 的显式阶段继续读取原 run。单次 HTTP 传输仍为 30 秒，模型容量和硬预算不受该捕获时限影响。

14 个单岗目标包含负责人冲突、状态约束、计费口径未知、零分母、反馈去重、提议与决议区分、转载来源独立性、已知漏洞版本回滚、文件所有权、单样本统计、独立评测 oracle、提示注入及知识版本范围。文件 marker 通过只证明对应有限断言；交付报告还须逐份审阅正文，不能将 marker 成绩写成完整职业能力达标。

意图分类的默认端到端时限为 10 秒，包含预算代理、tokenizer 前置及模型往返；调用者仍可显式覆盖，同步交互常量保持 3 秒、正式派遣入口保持 12 秒。超时会取消底层请求，并以 `timeout_fallback` 明示规则回退；规则答对也不算 LLM 分类成功。评测行记录本次 `routeTimeoutMs`，修复重测使用新的尝试 ID、保留逻辑 `caseId` 与原 3 秒失败/回退样本，不覆盖旧成绩。

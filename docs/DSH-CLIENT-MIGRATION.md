# WorkLoom PM · DeepSeek Harness 桌面入口

## 目标

PMTest 原来的客户端同时承载经营首页、团队、任务、审批、技能、模型、考试、记忆、组织与诊断页面。对第一次使用的用户，入口太多，且“应该先做什么”不清楚。

0.2.0 把默认入口收敛为一个 DSH 会话：

1. 用户描述目标。
2. DSH 调用 `pm_create_mission`，把目标交给产品总监和 PM 团队。
3. DSH 显示真实运行状态、岗位步骤、用量与已核验产物。
4. 用户继续在会话中追问、取消、恢复或读取交付。

原来的多页工作台仍完整保留，作为显式回滚和高级诊断入口。

## 三个实际使用场景

| 用户 | 场景 | 默认 DSH 路径 |
|---|---|---|
| 产品负责人 | 把模糊想法写成有边界的 PRD | 直接描述用户、业务目标和限制；DSH 创建 PM 任务，产品总监编排需求、文档与评测岗位 |
| 创业者 | 在隔离目录做一个可运行的小工具 | 说明功能、输入输出、测试要求和不做清单；PM 研发节点使用受限文件工具落地并返回测试证据 |
| 小型研发团队 | 把线上问题转成复现、修复和回归资料 | 提交现象、日志和期望行为；团队按依赖生产复现、根因、修复、测试和发布说明 |

## 架构

```mermaid
flowchart LR
  U[用户] --> DSH[DeepSeek Harness 会话界面]
  DSH --> P[workloom-pm-client 宿主插件]
  P -->|回环 HTTP + 每次启动随机能力| B[/api/pm-dsh]
  B --> A[成员 / 套餐 / Bundle / 动作授权]
  A --> S[PmTeamService]
  S --> D[岗位 DAG]
  D --> E[普通 Completion 员工]
  D --> H[受限 DSH 研发员工]
  E --> R[文件 + SHA-256 + 检查回执]
  H --> R
  R --> P
  P --> DSH
```

### 不修改 DSH 内核

PM 适配包位于 [`packages/pm-dsh-client`](../packages/pm-dsh-client)，只使用 DSH 文档化的宿主插件、工具注册、系统提示 section 和浏览器 Slot：

- `pm_create_mission`
- `pm_get_mission`
- `pm_wait_mission`
- `pm_read_artifact`
- `pm_cancel_mission`
- `pm_resume_mission`

浏览器半部占据 `sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark`，显示 WorkLoom 品牌；空会话还会贡献三个起始任务。

这样 DSH 升级时不需要维护一份分叉内核，PM 只在文档化扩展点之上演进。

## 本机桥安全

桌面启动器每次运行生成 32 字节随机能力，只将它传入 PM server 和 DSH 宿主进程的环境。浏览器、模型提示、工具参数、工具结果和 DSH Session 日志都看不到该值。DSH 宿主使用独立工作目录和环境白名单，PM 服务的数据库及会话凭据留在服务进程。会话预设保留 PM 派单工具和用户澄清工具，文件操作及命令执行由 PM 团队在既有权限边界内处理。

Electron 通过子进程 IPC 接收该次 DSH 启动的认证地址。首次访问由上游 DSH 颁发浏览器会话并跳转到干净地址，启动日志仅记录回环来源。

服务端执行以下检查：

- 缺少 `PM_DSH_BRIDGE_TOKEN` 时不挂载 `/api/pm-dsh`。
- Token 格式无效、绑定地址不是回环地址时失败关闭。
- 请求头 `x-workloom-pm-bridge` 使用长度校验和 `timingSafeEqual` 比较。
- Bridge 不绕过成员、套餐、活动 Bundle、`ai-pm.development.read`、`tasks.read`、`task.dispatch` 与 `workspace.write`。
- 请求体、任务 id、产物路径和错误响应沿用 PM HTTP 合同。

该桥只适合产品自有、单机回环的桌面运行；不是公网服务，也不能被其它工作区复用。

## 上游版本口径

上游源码下载与审阅固定到：

- 仓库：`https://github.com/deepseek-ai/deepseek-harness`
- Tag：`dsh-v0.2.2-rc.5`
- Commit：`9c2670d3bce5275e0d1610272958121af87787bb`
- License：MIT

本版固定使用 PMTest 既有评测版本 `@deepseek-ai/dsh@0.2.1-rc.2`，并在 PMTest 的 Electron 壳中装载同版本的官方桌面共用界面 `@deepseek-ai/dsh-web-frontend`。运行版本对应上游 [dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)，源码审阅使用上面登记的 rc.5。升级运行版本时需重新执行 PM DSH 集成、预算、会话持久化、崩溃恢复和桌面载荷验证。

## 用户路径

源码运行：

```bash
pnpm install --frozen-lockfile
pnpm app:dev
```

源码运行需要先按 README 配置 PMTest 专用数据库、迁移和装配示例 PM 团队。首次使用需为启动进程配置 `DEEPSEEK_API_KEY`，供 DSH 对话和 PM 团队使用。安装包在本地初始化数据库。模型密钥由进程环境或本机受控配置提供。

回滚：

```bash
WORKLOOM_CLIENT=legacy pnpm app
```

回滚入口仍使用 `/development`，并保留旧桌面视觉、页面、移动端与经营能力。

## 验收

最低验收集：

```bash
node --test scripts/dsh-runtime.test.mjs
node --test packages/pm-dsh-client/test/*.test.mjs
pnpm --filter @workloom/server test
pnpm typecheck
pnpm product:verify
pnpm runtime:deps:verify
pnpm secrets:scan:staged
```

桌面发布还需验证：

- 官方 DSH 前端包与 PM 插件进入载荷归档。
- 打包后的 Electron 打开 DSH `/`，而不是 legacy `/development`。
- WorkLoom PM 品牌、文档标题和真实 composer 可见。
- `WORKLOOM_CLIENT=legacy` 仍可打开原 WorkLoom 首页。
- DSH Session 与工作区存放在产品独立目录，升级和回滚不覆盖 PM 数据库。

离线或受限网络打包可复用已经按相同版本验证过的 `node/`、`pg/`、`nats/` 展开目录：

```bash
WORKLOOM_PREBUILT_RUNTIME_DIR=/path/to/verified-runtime \
  bash scripts/pack-electron-payload.sh --platform mac --arch arm64 --version v0.2.0
```

脚本会重新核对 Node 24.19.0、PostgreSQL 17、NATS 2.11.4 和 pgvector。

## 当前不解决

- 不把 PM 的任意复杂项目成功承诺提升为 100%；固定任务集成绩不等于开放世界成绩。
- 不自动创建工作区、不绕过 DeepSeek 模型配额，也不替用户申请 Key。
- 不将 DSH 插件发布到公共市场；本版插件随 PMTest 载荷分发。
- 不把本机桥能力改成长期固定密钥，也不开放非回环访问。
- 不修改官方 DSH 内核；需要内核能力时先向上游提案或另开受审查升级任务。

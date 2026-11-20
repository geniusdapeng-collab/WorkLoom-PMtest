# WorkLoom PMtest 桌面 Harness 内核

桌面首屏仍是原有 WorkLoom PC 的「开发场域」`/development`。产品负责人可以和原来一样提交目标、查看 PM 团队的任务图、取消或恢复任务、预览产物和核对回执。DevFabric、导航、旧工作区数据及浏览器三端继续使用现有页面与请求契约。

## 用户操作如何进入内核

1. 原工作台向 WorkLoom `POST /api/pm/events` 提交需求，服务端使用当前成员、租户、工作区、Bundle 与派发权限判定准入。
2. PM 团队按既有岗位 DAG 执行。遇到需要使用文件工具的研发步骤时，桌面安装包和 `pnpm app` 都用官方 DeepSeek Harness Desktop profile 启动隔离子进程。普通文本工作、搜索与审批沿用各自的 WorkLoom 服务合同。
3. 启动器从官方运行上下文核对 `profileContext.name=desktop`，通过私有 IPC 接收该实例的回环会话地址。服务端创建会话、提交提示，并把同一会话的正式终态、工具回执和文件摘要写入原任务记录。
4. 原工作台按原接口轮询状态和读取产物。客户端按 SHA-256 检查字节，研发产物继续走独立代码验证。

| 原操作 | 可核对结果 |
|---|---|
| 提交文档需求 | 原岗位、进度和文档预览继续走 WorkLoom 的 PM 工作流 |
| 提交带代码和测试的需求 | 研发节点记录 `deepseek-harness-desktop`、`dshProfile=desktop`、Harness 会话 ID、工具次数、模型用量及日志 SHA-256 |
| 停止任务或恢复已中断任务 | 运行态与可恢复性由原 PM 账本和用量对账决定，已有 headless 回执仍可读 |

## 官方来源与版本

- 官方 Desktop Host 源码调用公开的 `@deepseek-ai/dsh/profile-boot`。PMtest 使用同一入口、同一 `desktop` 运行上下文和同一 Web 组件初始化顺序，由 WorkLoom Electron 壳展示 WorkLoom 页面。 [固定版本的官方 Host 入口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/desktop-host/src/index.ts)
- 实际运行包为官方 npm `@deepseek-ai/dsh@0.2.1-rc.2`，锁定依赖随安装包分发，载荷检查包含 MIT 许可证。 [运行版本](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) · [上游 MIT 许可证](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)
- 已核对的独立上游开发源码为 `dsh-v0.2.2-rc.5`，提交 `9c2670d3bce5275e0d1610272958121af87787bb`。该源码用于审阅。 [官方源码发行](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)

## 隔离与异常行为

每个研发步骤拥有独立 Harness 会话目录和工作区。子进程只收到该步骤的回环模型代理能力，用户模型密钥留在原服务端。模型代理核对请求模型、工具目录和真实用量。`list_files`、`read_file` 和 `write_file` 继续受原路径、产物所有权、工具次数和大小约束。会话转接校验同一请求、单调事件序号和已完成轮次。运行失败、用量无法对账或缺少产物时，任务保留真实失败状态。普通浏览器与既有自动化的默认执行配置继续读写 headless 回执。

## 本地验证

```bash
pnpm app --smoke
pnpm test:pm-dsh
WORKLOOM_PM_DSH_PROFILE=desktop pnpm test:pm-dsh
pnpm typecheck
pnpm test
```

两种 profile 的集成用实际固定版本 DSH 子进程与可重复的本机模型夹具。生产模型、平台签名和公证须分别验收。安装包按仓库的桌面载荷和目标平台流程构建。

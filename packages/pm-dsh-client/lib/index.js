/**
 * WorkLoom PM host plugin for DeepSeek Harness.
 *
 * The bridge capability is read from the DSH process environment. It is never
 * included in a tool argument, tool result, system prompt, or session event.
 */
import { randomUUID } from "node:crypto";

export const name = "workloom-pm-client";
export const inject = ["tools", "systemPrompt"];

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "blocked", "cancelled", "paused"]);
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_WAIT_MS = 45000;

function requiredEnvironment() {
  const apiUrl = process.env.WORKLOOM_PM_API_URL?.trim();
  const token = process.env.PM_DSH_BRIDGE_TOKEN?.trim();
  if (!apiUrl) throw new Error("WORKLOOM_PM_API_URL is required for the WorkLoom PM DSH plugin");
  if (!token || !/^[A-Za-z0-9_-]{32,200}$/u.test(token)) {
    throw new Error("PM_DSH_BRIDGE_TOKEN is missing or malformed");
  }
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("WORKLOOM_PM_API_URL is not a valid URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("WORKLOOM_PM_API_URL must be a loopback HTTP URL with no path or credentials");
  }
  return { apiUrl: new URL("/api/pm-dsh", url).href, token };
}

function idempotencyKey(callId) {
  const normalized = String(callId ?? randomUUID())
    .replace(/[^A-Za-z0-9_.:-]/gu, "_")
    .slice(0, 100);
  return `dsh-${normalized || randomUUID()}`;
}

function missionView(detail, extra = {}) {
  const run = detail?.run;
  if (!run || typeof run.id !== "string") throw new Error("PM bridge returned an incomplete mission receipt");
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
  return {
    runId: run.id,
    threadId: run.threadId ?? null,
    status: run.status,
    goal: run.goal,
    modelId: run.modelId,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
    resumeBlock: detail.resumeBlock ?? null,
    usage: run.usage ?? null,
    tasks: tasks.map((task) => ({
      id: task.id,
      presetKey: task.presetKey,
      status: task.status,
      summary: task.summary ?? null,
      error: task.error ?? null,
      outputRefs: task.outputRefs,
    })),
    artifacts: artifacts.map((artifact) => ({
      taskId: artifact.taskId,
      path: artifact.path,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      mediaType: artifact.mediaType,
      verifiedAt: artifact.verifiedAt,
    })),
    ...extra,
  };
}

/**
 * Register the PM bridge tools and routing prompt.
 * @param ctx - Cordis host context with `tools` and `systemPrompt`.
 */
export function apply(ctx) {
  const { apiUrl, token } = requiredEnvironment();

  if (process.send) {
    ctx.inject(["webApp", "connection"], (webCtx) => {
      const url = webCtx.connection.authenticatedUrl(webCtx.webApp.getAdvertisedUrl());
      process.send({ type: "workloom:dsh-ready", url }, (error) => {
        if (error) console.error("WorkLoom PM 无法与桌面启动器建立会话");
      });
    });
  }

  const request = async (path, { method = "GET", body, signal } = {}) => {
    const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          "x-workloom-pm-bridge": token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (error) {
      if (combined.aborted) throw new Error("WorkLoom PM 本机桥接请求超时或被取消；未宣称任务成功");
      throw new Error(`WorkLoom PM 本机桥接不可用：${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.error;
      const message = typeof detail === "string" ? detail : detail?.message ?? `HTTP ${response.status}`;
      const code = typeof detail === "object" && detail?.code ? `${detail.code}: ` : "";
      throw new Error(`${code}${message}`);
    }
    if (!payload || typeof payload !== "object") throw new Error("WorkLoom PM 本机桥接返回了不完整数据");
    return payload;
  };

  const output = {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  };

  ctx.effect(() => ctx.systemPrompt.section({
    name: "workloom:pm-routing",
    order: 25,
    text: [
      "你是 WorkLoom PM 的产品研发主入口。",
      "当用户要求澄清需求、研究、规划、实现、测试、修复、评测或交付软件/产品产物时，先调用 pm_create_mission 把完整目标交给 PM 团队。",
      "不要用普通 shell 工作流替代 PM 任务，也不要在没有真实运行状态和产物回执时声称完成。",
      "用 pm_wait_mission 或 pm_get_mission 跟进同一 runId；只有 status=completed 且 artifacts 非空时才能说产物已交齐。",
      "需要读取交付正文时调用 pm_read_artifact。Paused、blocked、failed 和 cancelled 不是成功，必须如实说明原因与下一步。",
      "密钥、令牌和客户隐私不得写入目标、验收条件、工具参数或回复。",
    ].join("\n"),
  }));

  const register = (definition) => ctx.tools.register({ ...definition, output });

  register({
    name: "pm_create_mission",
    description: "把完整产品/研发目标交给 WorkLoom PM 团队，创建并启动一个有 DAG、员工产物和验收回执的异步任务。返回 runId。",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "完整目标、范围、约束和期望产物" },
        employee: { type: "string", description: "可选的单一员工 presetKey；省略时由产品总监编排团队" },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const goal = typeof args?.goal === "string" ? args.goal.trim() : "";
      if (goal.length < 4 || goal.length > 32000) throw new Error("PM 目标长度必须为 4 至 32,000 个字符");
      const employee = typeof args?.employee === "string" && args.employee.trim() ? args.employee.trim() : undefined;
      const created = await request("/runs", {
        method: "POST",
        body: { goal, idempotencyKey: idempotencyKey(exec.callId), ...(employee ? { employee } : {}) },
        signal: exec.signal,
      });
      const runId = created?.run?.id;
      if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(runId)) {
        throw new Error("PM 创建回执缺少有效 runId");
      }
      let started;
      try {
        started = await request(`/runs/${encodeURIComponent(runId)}/start`, {
          method: "POST", body: {}, signal: exec.signal,
        });
      } catch (error) {
        throw new Error(`PM 已创建任务 ${runId}，启动未获确认：${error.message}`);
      }
      if (started?.run?.id !== runId) throw new Error(`PM 任务 ${runId} 的启动回执不匹配`);
      return JSON.stringify(missionView(started, {
        next: "调用 pm_wait_mission 或 pm_get_mission 跟进同一任务。",
      }), null, 2);
    },
  });

  register({
    name: "pm_get_mission",
    description: "读取一个 WorkLoom PM 任务的当前状态、团队步骤、模型用量和已核验产物清单。",
    parameters: {
      type: "object",
      properties: { runId: { type: "string", description: "pm_create_mission 返回的 runId" } },
      required: ["runId"],
      additionalProperties: false,
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (typeof args?.runId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(args.runId)) {
        throw new Error("runId 格式无效");
      }
      const detail = await request(`/runs/${encodeURIComponent(args.runId)}`, { signal: exec.signal });
      return JSON.stringify(missionView(detail), null, 2);
    },
  });

  register({
    name: "pm_wait_mission",
    description: "在当前工具预算内等待 WorkLoom PM 任务进入终态或超时，返回最新真实状态和产物回执。",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "pm_create_mission 返回的 runId" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: MAX_WAIT_MS, description: "最多等待毫秒数，默认 30000" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args?.runId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(args.runId)) {
        throw new Error("runId 格式无效");
      }
      const timeoutMs = Number.isInteger(args?.timeoutMs) ? Math.min(MAX_WAIT_MS, Math.max(1000, args.timeoutMs)) : 30000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        exec.signal.throwIfAborted();
        const detail = await request(`/runs/${encodeURIComponent(args.runId)}`, { signal: exec.signal });
        if (TERMINAL_RUN_STATES.has(detail?.run?.status) || Date.now() >= deadline) {
          return JSON.stringify(missionView(detail, {
            waitedMs: timeoutMs - Math.max(0, deadline - Date.now()),
            timedOut: !TERMINAL_RUN_STATES.has(detail?.run?.status),
          }), null, 2);
        }
        const pause = Math.min(1000, Math.max(0, deadline - Date.now()));
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(exec.signal.reason ?? new Error("PM wait cancelled"));
          };
          const timer = setTimeout(() => {
            exec.signal.removeEventListener("abort", onAbort);
            resolve();
          }, pause);
          exec.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
  });

  register({
    name: "pm_read_artifact",
    description: "读取 WorkLoom PM 任务中一个已核验产物的 UTF-8 正文和 SHA-256 回执。",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "任务 runId" },
        path: { type: "string", description: "pm_get_mission 返回的精确产物路径" },
      },
      required: ["runId", "path"],
      additionalProperties: false,
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (typeof args?.runId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(args.runId)) throw new Error("runId 格式无效");
      if (typeof args?.path !== "string" || !args.path.trim()) throw new Error("产物路径不能为空");
      const detail = await request(
        `/runs/${encodeURIComponent(args.runId)}/artifacts?path=${encodeURIComponent(args.path)}`,
        { signal: exec.signal },
      );
      return JSON.stringify(detail, null, 2);
    },
  });

  register({
    name: "pm_cancel_mission",
    description: "请求取消一个 WorkLoom PM 任务；返回持久化后的真实状态，不把取消写成失败之外的其它成功。",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args?.runId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(args.runId)) throw new Error("runId 格式无效");
      const result = await request(`/runs/${encodeURIComponent(args.runId)}/cancel`, {
        method: "POST", body: {}, signal: exec.signal,
      });
      return JSON.stringify(result, null, 2);
    },
  });

  register({
    name: "pm_resume_mission",
    description: "显式恢复一个 paused、failed 或 blocked 的 WorkLoom PM 任务；存在用量或检索对账阻断时会继续失败关闭。",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    async execute(args, exec) {
      if (typeof args?.runId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(args.runId)) throw new Error("runId 格式无效");
      const result = await request(`/runs/${encodeURIComponent(args.runId)}/resume`, {
        method: "POST", body: {}, signal: exec.signal,
      });
      return JSON.stringify(result, null, 2);
    },
  });
}

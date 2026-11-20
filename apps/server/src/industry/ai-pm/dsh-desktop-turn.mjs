import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_EVENTS = 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 120_000;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function protocol(message) {
  return failure("DSH_PROTOCOL", message);
}

function startupUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw protocol("DSH Desktop 就绪地址无效");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/"
    || url.username || url.password || url.hash || !/^\?token=[A-Za-z0-9_-]{32,200}$/u.test(url.search)) {
    throw protocol("DSH Desktop 就绪地址必须使用本会话回环认证入口");
  }
  return url;
}

async function request(url, options, signal) {
  try {
    return await fetch(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch {
    signal.throwIfAborted();
    throw failure("DSH_DESKTOP_UNAVAILABLE", "DSH Desktop 本机请求失败");
  }
}

async function authenticate(url, signal) {
  const response = await request(url, {}, signal);
  await response.body?.cancel();
  const cookies = response.headers.getSetCookie();
  const cookie = cookies[0]?.split(";", 1)[0];
  if (response.status !== 303 || response.headers.get("location") !== "./" || cookies.length !== 1
    || !/^dsh-auth-[A-Za-z0-9_-]{43}=v[12]\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43}$/u.test(cookie ?? "")) {
    throw protocol("DSH Desktop 未返回预期的回环会话认证回执");
  }
  return cookie;
}

async function readJson(response) {
  if (!response.body) throw protocol("DSH Desktop 响应没有正文");
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw failure("DSH_OUTPUT_LIMIT", "DSH Desktop 会话回执超出大小限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw protocol("DSH Desktop 响应不是合法 UTF-8 JSON");
  }
}

function buildRpc(origin, cookie) {
  return async (method, input, signal) => {
    const rpcId = randomUUID();
    const response = await request(`${origin}/api/${method}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args: { request: input } } }),
    }, signal);
    if (response.status !== 200) {
      await response.body?.cancel();
      throw protocol(`DSH Desktop 会话调用失败（${method}，HTTP ${response.status}）`);
    }
    const envelope = await readJson(response);
    if (envelope?.rpcId !== rpcId || envelope?.result?.ok !== true) {
      throw protocol(`DSH Desktop 会话调用回执无效（${method}）`);
    }
    return envelope.result.value;
  };
}

function textBlocks(content) {
  if (!Array.isArray(content)) throw protocol("DSH Desktop 消息内容无效");
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** Execute one turn through the official Desktop session API, using only committed journal events as evidence. */
export async function executeDesktopTurn({ url, workspace, prompt, signal, onEvent }) {
  if (typeof workspace !== "string" || !isAbsolute(workspace) || typeof prompt !== "string" || !prompt.trim()) {
    throw protocol("DSH Desktop 任务缺少绝对工作目录或有效目标");
  }
  const deadline = signal ? undefined : AbortSignal.timeout(TURN_TIMEOUT_MS);
  const active = signal ?? deadline;
  active.throwIfAborted();
  const launch = startupUrl(url);
  const rpc = buildRpc(launch.origin, await authenticate(launch, active));
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const events = [];
  const emit = async (event) => {
    events.push(event);
    await onEvent?.(event);
  };

  let submitted = false;
  let ended = false;
  try {
    const session = await rpc("session/create", { sessionId, cwd: workspace }, active);
    if (session?.sessionId !== sessionId) throw protocol("DSH Desktop 创建的会话与请求不一致");
    await emit({ type: "session", sessionId });
    submitted = true; // A transport failure can occur after server-side admission.
    const admission = await rpc("session/prompt", {
      sessionId, requestId, mode: "queue", content: [{ type: "text", text: prompt }],
    }, active);
    if (admission?.accepted !== true) throw protocol("DSH Desktop 未接收本次提示");

    const calls = new Map();
    let nextSeq = 0;
    let turn;
    let admitted = false;
    let finalText = "";
    while (!ended) {
      const timeline = await rpc("session/projections", { sessionId }, active);
      const throughSeq = timeline?.asOfSeq;
      if (!Number.isSafeInteger(throughSeq) || throughSeq < nextSeq - 1 || throughSeq >= MAX_SESSION_EVENTS) {
        throw protocol("DSH Desktop 会话事件游标无效或超出限制");
      }
      if (throughSeq >= nextSeq) {
        const page = await rpc("session/page", {
          address: { kind: "session", sessionId }, throughSeq, maxMessages: MAX_SESSION_EVENTS,
        }, active);
        if (page?.hasMore !== false || !Array.isArray(page.records) || page.records.length !== throughSeq + 1) {
          throw protocol("DSH Desktop 会话缺少完整的事件记录");
        }
        for (const record of page.records.slice(nextSeq)) {
          active.throwIfAborted();
          const event = record?.event;
          if (record?.type !== "event" || event?.seq !== nextSeq || typeof event.type !== "string") {
            throw protocol("DSH Desktop 会话记录缺号或无效");
          }
          nextSeq += 1;
          const data = event.data;
          switch (event.type) {
            case "turn/start":
              if (turn !== undefined || !Number.isSafeInteger(data?.turn) || data.turn < 1) {
                throw protocol("DSH Desktop 返回了意外的轮次");
              }
              turn = data.turn;
              break;
            case "user/message":
              if (data?.source?.kind !== "user" || data.source.rpcId !== requestId) break;
              if (turn === undefined || admitted || textBlocks(data.content) !== prompt) {
                throw protocol("DSH Desktop 已记录的用户目标与请求不一致");
              }
              admitted = true;
              break;
            case "assistant/message":
              if (!admitted) throw protocol("DSH Desktop 助手消息未绑定本次请求");
              finalText = textBlocks(data?.message?.content);
              break;
            case "tool/call":
              if (!admitted || !identifier(data?.callId) || !identifier(data.name) || calls.has(data.callId)) {
                throw protocol("DSH Desktop 工具请求缺少唯一标识或归属");
              }
              calls.set(data.callId, false);
              await emit({ type: "tool_call", callId: data.callId, tool: data.name });
              break;
            case "tool/result": {
              if (event.surfaceOp !== "append") break;
              const message = data?.message;
              if (calls.get(message?.toolCallId) !== false) {
                throw protocol("DSH Desktop 工具回执与请求不匹配");
              }
              calls.set(message.toolCallId, true);
              await emit({ type: "tool_result", callId: message.toolCallId, status: message.isError === true ? "error" : "completed" });
              break;
            }
            case "turn/end": {
              if (turn === undefined || data?.turn !== turn || !identifier(data.reason?.kind)) {
                throw protocol("DSH Desktop 终态回执与当前轮次不匹配");
              }
              ended = true;
              await emit({ type: "status", phase: "turn_end", turn, reason: { kind: data.reason.kind } });
              if (data.reason.kind !== "completed") throw failure("DSH_TURN_FAILED", "DSH Desktop 轮次未正常完成");
              if (!admitted || !finalText.trim() || [...calls.values()].some((complete) => !complete)) {
                throw protocol("DSH Desktop 完成轮次缺少目标、最终答复或工具回执");
              }
              break;
            }
          }
          if (ended) break;
        }
      }
      if (!ended) await delay(150, undefined, { signal: active });
    }
    active.throwIfAborted();
    await emit({ type: "final", text: finalText });
    return { events };
  } catch (error) {
    let cancellationError;
    if (submitted && !ended) {
      try {
        const cancelled = await rpc("session/cancel", { sessionId }, AbortSignal.timeout(2000));
        if (cancelled?.accepted !== true) throw protocol("DSH Desktop 未确认取消请求");
      } catch (cause) {
        cancellationError = cause;
      }
    }
    const result = signal?.aborted && signal.reason instanceof Error ? signal.reason
      : deadline?.aborted ? failure("DSH_TIMEOUT", "DSH Desktop 轮次超时") : error;
    if (cancellationError && result instanceof Error) {
      const detail = failure(result.code ?? "DSH_TURN_FAILED", `${result.message}，DSH Desktop 取消未获确认`);
      throw Object.assign(detail, { cause: result });
    }
    throw result;
  }
}

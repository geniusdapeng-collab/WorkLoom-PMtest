// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PmDelivery from "./PmDelivery";

vi.mock("../../lib/trpc", () => ({ ensureDemoLogin: vi.fn(async () => {}), getToken: () => activeToken }));
vi.mock("./P25", () => ({ default: () => <div>研发设备详情</div> }));

type Json = Record<string, unknown>;
type Handler = (path: string, options: RequestInit) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
const configuration = { configured: true, modelId: "deepseek-flash", policyVersion: "fixture", employees: [{ presetKey: "chief-pm", name: "产品总监", description: "拆解目标并核对交付。" }] };
const run = (status = "created", id = "internal-run-private-567890") => ({ id, goal: "交付中文待办功能与验收文件", status, requestedEmployee: null, modelId: "deepseek-flash", createdAt: "2026-10-24T01:00:00Z", updatedAt: "2026-10-24T01:00:00Z", error: null, errorCode: null, usage: { promptTokens: 21, completionTokens: 13 } });
const detail = (status = "created", id?: string) => ({ run: run(status, id), tasks: [], artifacts: [] });
const file = { id: "private-artifact", taskId: "private-task", path: "交付/需求.md", sha256: "a".repeat(64), sizeBytes: 42, mediaType: "text/plain", verifiedAt: "2026-10-24T01:00:00Z" };
let root: Root | undefined;
let host: HTMLDivElement;
let history: (ReturnType<typeof run> & { threadId?: string })[];
let handler: Handler;
let calls: Array<{ path: string; options: RequestInit }>;
let activeToken: string;

async function flush() { await act(async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); }); }
async function mount() { root = createRoot(host); await act(async () => root!.render(<MemoryRouter><PmDelivery /></MemoryRouter>)); await flush(); }
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`button missing: ${text}`);
  return found;
}
async function click(text: string) { await act(async () => button(text).click()); await flush(); }
async function input(id: string, value: string) {
  const node = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
  const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function submit(selector = "form") { await act(async () => host.querySelector(selector)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await flush(); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); history = []; calls = []; activeToken = "fixture-session";
  sessionStorage.clear();
  vi.stubGlobal("crypto", {
    randomUUID: crypto.randomUUID.bind(crypto),
    subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer },
  });
  handler = (path) => path.endsWith("/status") ? { status: 200, body: configuration } : path.endsWith("/runs") ? { status: 200, body: { runs: history } } : { status: 200, body: detail() };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit = {}) => {
    calls.push({ path: url, options }); const result = await handler(url, options);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  }));
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("产品交付页面的中文边界与原交互", () => {
  it("未配置时禁用提交，空态和配置路径仍可见", async () => {
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? { ...configuration, configured: false, modelId: "" } : { runs: [] } });
    await mount();
    expect(button("交给团队执行").disabled).toBe(true);
    expect(host.textContent).toContain("模型待配置"); expect(host.textContent).toContain("还没有任务");
    expect(host.querySelector('a[href="/onboarding"]')).toBeTruthy();
    expect(host.querySelector(".wl-textarea")).toBeTruthy(); expect(host.querySelector(".wl-card")).toBeTruthy();
  }, 30_000);

  it("未知状态、员工和模型均有中文兜底，后端英文错误不泄露", async () => {
    history = [run("unregistered_state")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? { ...configuration, modelId: "private-model-x", employees: [] } : path.endsWith("/runs") ? { runs: history } : { run: { ...run("unregistered_state"), error: "Internal Server Error request_id secret", errorCode: "PRIVATE_CODE", modelId: "private-model-x" }, tasks: [{ id: "task-hidden", presetKey: "private-worker-key", status: "foreign_state", goal: "正确的中文任务目标", dependsOn: ["missing-private-task"], outputRefs: [], error: null, summary: "JSON raw_field", usage: null, modelId: null, executionBackend: null }], artifacts: [] } });
    await mount(); await click("交付中文待办功能");
    expect(host.textContent).toContain("状态待确认"); expect(host.textContent).toContain("待确认员工"); expect(host.textContent).toContain("已配置模型");
    expect(host.textContent).not.toMatch(/unregistered_state|foreign_state|private-worker-key|missing-private-task|private-model-x|Internal Server Error|request_id|PRIVATE_CODE|JSON raw_field/);
  }, 30_000);

  it("短目标和越界文件路径均在提交前拒绝", async () => {
    await mount(); await input("pm-goal", "短"); await submit(); expect(host.textContent).toContain("至少输入4个字");
    await input("pm-goal", "交付可核对的需求"); await input("pm-checks", "../outside.txt"); await submit();
    expect(host.textContent).toContain("相对文件路径"); expect(calls.filter((item) => item.options.method === "POST")).toHaveLength(0);
  }, 30_000);

  it("提交重入只创建一次，失败重试保留事件与线程编号并自动开始", async () => {
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let posts = 0;
    handler = async (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: [] } };
      if (path.endsWith("/events")) {
        posts++;
        if (posts === 1) { await paused; return { status: 503, body: { error: "Internal Server Error" } }; }
        const { eventId, threadId } = JSON.parse(String(options.body));
        return { status: 200, body: { eventId, threadId, runId: run().id, decision: "admitted", replayed: true } };
      }
      return { status: 200, body: detail("planning") };
    };
    await mount(); await input("pm-goal", "交付可验证的需求和文件");
    await input("pm-search-query", "  DeepSeek 公开文档 site:api-docs.deepseek.com  ");
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(posts).toBe(1); expect(button("正在提交目标").disabled).toBe(true);
    await act(async () => release!()); await flush(); expect(host.textContent).toContain("请求未完成");
    await submit();
    const postCalls = calls.filter((item) => item.options.method === "POST");
    expect(postCalls.map((item) => item.path)).toEqual(["/api/pm/events", "/api/pm/events"]);
    const createBodies = postCalls.map((item) => JSON.parse(String(item.options.body)));
    expect(createBodies[0]).toEqual(createBodies[1]);
    expect(createBodies[0]).toMatchObject({ kind: "request", eventId: expect.any(String), threadId: expect.any(String), input: { goal: "交付可验证的需求和文件", searchQuery: "DeepSeek 公开文档 site:api-docs.deepseek.com" } });
    expect(host.textContent).toContain("团队会在后台开始执行");
    expect(host.textContent).toContain("尾号 567890"); expect(host.textContent).not.toContain("internal-run-private");
  }, 30_000);

  it("提交回执丢失后重新打开页面仍使用原事件编号，收到回执后清掉暂存编号", async () => {
    const goal = "仅用于验收的草稿原文";
    let posts = 0;
    handler = (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: [] } };
      if (path.endsWith("/events")) {
        posts++;
        if (posts === 1) return { status: 503, body: { error: "提交回执暂不可用。" } };
        const { eventId, threadId } = JSON.parse(String(options.body));
        return { status: 200, body: { eventId, threadId, runId: run().id, decision: "admitted", replayed: true } };
      }
      return { status: 200, body: detail("planning") };
    };
    await mount(); await input("pm-goal", goal); await submit();
    expect(host.textContent).toContain("提交回执暂不可用");
    expect(sessionStorage).toHaveLength(1);
    const key = sessionStorage.key(0)!;
    expect(key).toMatch(/pm-pending-v1:[0-9a-f]{64}$/);
    expect(sessionStorage.getItem(key)).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    expect(key).not.toContain(activeToken);
    expect(key).not.toContain(goal);
    await act(async () => root!.unmount());
    await mount(); await input("pm-goal", goal); await submit();
    const bodies = calls.filter((call) => call.options.method === "POST").map((call) => call.options.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(sessionStorage).toHaveLength(0);
  });

  it("从历史恢复任务线程，按需读取原文并将补充说明直送同一线程", async () => {
    const threadId = "thread-first";
    const runId = run().id;
    const first = { eventId: "first-event", runId, kind: "request", createdAt: run().createdAt, excerpt: "公开任务摘要", bodyTruncated: true };
    const neighbor = { ...first, eventId: "neighbor-event", runId: "other-run", excerpt: "另一次任务的摘要" };
    const fullGoal = '<script>alert("不执行")</script>\n核验公开文档';
    let followup: Json | null = null;
    let failOnce = true;
    history = [{ ...run("paused"), threadId }];
    handler = (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: history } };
      if (path.endsWith(`/threads/${threadId}/events?limit=20&runId=${runId}`)) return { status: 200, body: { events: followup ? [first, neighbor, { eventId: followup.eventId, runId, kind: "followup", createdAt: run().createdAt, excerpt: followup.text, bodyTruncated: false }] : [first, neighbor] } };
      if (path.endsWith(`/threads/${threadId}/events/${first.eventId}`)) return { status: 200, body: { event: { ...first, input: { goal: fullGoal } } } };
      if (path.endsWith("/events") && options.method === "POST") {
        if (failOnce) { failOnce = false; return { status: 503, body: { error: "Internal Server Error" } }; }
        const parsed = JSON.parse(String(options.body)); followup = parsed;
        return { status: 201, body: { eventId: parsed.eventId, threadId, runId: run().id, decision: "attached", replayed: false } };
      }
      return { status: 200, body: { ...detail("paused"), run: { ...run("paused"), threadId } } };
    };
    await mount(); await click("交付中文待办功能");
    expect(host.textContent).toContain("公开任务摘要"); expect(host.textContent).not.toContain(fullGoal);
    expect(host.textContent).not.toContain("另一次任务的摘要");
    await click("查看完整消息");
    expect(host.textContent).toContain(fullGoal); expect(host.querySelector("script")).toBeNull();
    await click("关闭原文"); expect(host.textContent).not.toContain(fullGoal);
    await input("pm-followup", "只补充公开来源和验证步骤");
    await submit(".pm-thread-compose"); expect(host.textContent).toContain("请求未完成");
    await submit(".pm-thread-compose"); expect(host.textContent).toContain("只补充公开来源和验证步骤");
    const bodies = calls.filter((item) => item.options.method === "POST").map((item) => JSON.parse(String(item.options.body)));
    expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toMatchObject({ kind: "followup", threadId, runId, text: "只补充公开来源和验证步骤" });
    expect(host.querySelector<HTMLTextAreaElement>("#pm-followup")?.value).toBe("");
  }, 30_000);

  it("最后一个执行步骤已开始时明示补充未提交，刷新完成后保留原草稿", async () => {
    const threadId = "thread-window";
    let current = "running";
    history = [{ ...run(current), threadId }];
    handler = (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: history } };
      if (path.includes(`/threads/${threadId}/events?`)) return { status: 200, body: { events: [] } };
      if (path.endsWith("/events") && options.method === "POST") {
        current = "completed";
        return { status: 409, body: { error: { code: "PM_FOLLOWUP_WINDOW_CLOSED", message: "Followup is closed" } } };
      }
      return { status: 200, body: { ...detail(current), run: { ...run(current), threadId } } };
    };
    await mount(); await click("交付中文待办功能");
    await input("pm-followup", "补充一条新的验收细节"); await submit(".pm-thread-compose");
    expect(host.textContent).toContain("这条补充未提交");
    expect(host.textContent).not.toMatch(/PM_FOLLOWUP_WINDOW_CLOSED|Followup is closed/);
    expect(host.querySelector(".pm-thread-compose")).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>(".pm-thread textarea[readonly]")?.value).toBe("补充一条新的验收细节");
  }, 30_000);

  it("拒绝同线程新任务替换当前目标，保留未提交草稿", async () => {
    const threadId = "thread-reused";
    history = [{ ...run("running"), threadId }];
    handler = (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: history } };
      if (path.includes(`/threads/${threadId}/events?`)) return { status: 200, body: { events: [] } };
      if (path.endsWith("/events") && options.method === "POST") {
        expect(JSON.parse(String(options.body))).toMatchObject({ threadId, runId: run().id });
        return { status: 409, body: { error: { code: "PM_FOLLOWUP_RUN_MISMATCH", message: "run changed" } } };
      }
      return { status: 200, body: { ...detail("running"), run: { ...run("running"), threadId } } };
    };
    await mount(); await click("交付中文待办功能");
    await input("pm-followup", "仅属于当前任务的验收细节"); await submit(".pm-thread-compose");
    expect(host.textContent).toContain("线程的当前任务已变化，这条补充未提交");
    expect(host.querySelector<HTMLTextAreaElement>(".pm-thread textarea[readonly]")?.value).toBe("仅属于当前任务的验收细节");
    expect(host.querySelector(".pm-thread-compose")).toBeNull();
  });

  it("身份切换中止前一工作区读取，晚返回的目标和草稿不会出现在新会话", async () => {
    let release: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    handler = async (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs") && (options.headers as Record<string, string>).authorization === "Bearer fixture-session") {
        await delayed;
        return { status: 200, body: { runs: [{ ...run(), goal: "前一工作区尚未返回的目标" }] } };
      }
      return { status: 200, body: { runs: [{ ...run(), goal: "新工作区独有的目标" }] } };
    };
    await mount(); await input("pm-goal", "前一工作区的未提交草稿");
    await act(async () => { activeToken = "next-fixture-session"; window.dispatchEvent(new CustomEvent("workloom:identity-changed")); });
    await flush();
    expect(host.textContent).toContain("新工作区独有的目标");
    expect(host.querySelector<HTMLTextAreaElement>("#pm-goal")?.value).toBe("");
    expect(calls.find((item) => item.path.endsWith("/runs"))?.options.signal?.aborted).toBe(true);
    await act(async () => release!()); await flush();
    expect(host.textContent).toContain("新工作区独有的目标");
    expect(host.textContent).not.toContain("前一工作区尚未返回的目标");
  }, 30_000);

  it("前一工作区的提交未响应时，切换身份后仍可提交新任务", async () => {
    let release: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    handler = async (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: [] } };
      if (path.endsWith("/events")) {
        const { eventId, threadId } = JSON.parse(String(options.body));
        const oldSession = (options.headers as Record<string, string>).authorization === "Bearer fixture-session";
        if (oldSession) await delayed;
        return { status: 202, body: { eventId, threadId, runId: oldSession ? "previous-run-111111" : "next-run-222222", decision: "admitted", replayed: false } };
      }
      return { status: 200, body: detail("completed", "next-run-222222") };
    };
    await mount(); await input("pm-goal", "前一工作区准备提交的目标"); await submit();
    expect(button("正在提交目标").disabled).toBe(true);
    await act(async () => { activeToken = "next-fixture-session"; window.dispatchEvent(new CustomEvent("workloom:identity-changed")); });
    await flush();
    expect(button("交给团队执行").disabled).toBe(false);
    await input("pm-goal", "新工作区准备提交的目标"); await submit();
    expect(host.textContent).toContain("尾号 222222");
    expect(calls.find((item) => item.options.method === "POST")?.options.signal?.aborted).toBe(true);
    await act(async () => release!()); await flush();
    expect(host.textContent).toContain("尾号 222222"); expect(host.textContent).not.toContain("尾号 111111");
  }, 30_000);

  it("开始、恢复和取消保留原接口，最终状态重新读取", async () => {
    let current = "created"; history = [run()];
    handler = (path, options) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: history } };
      if (options.method === "POST") { current = path.endsWith("/start") ? "paused" : path.endsWith("/resume") ? "blocked" : "cancelled"; return { status: 200, body: {} }; }
      return { status: 200, body: detail(current) };
    };
    await mount(); await click("交付中文待办功能"); await click("开始执行"); expect(host.textContent).toContain("已暂停");
    await click("校验并恢复"); expect(host.textContent).toContain("遇到边界，已阻断");
    await click("取消任务"); expect(host.textContent).toContain("已取消");
    expect(calls.filter((item) => item.options.method === "POST").map((item) => item.path.split("/").at(-1))).toEqual(["start", "resume", "cancel"]);
  }, 30_000);

  it.each([
    ["MODEL_USAGE_RECONCILIATION_REQUIRED", "用量还未对账"],
    ["SEARCH_RECEIPT_UNSETTLED", "缺少已核验回执"],
  ])("不对 %s 提供无法执行的恢复按钮", async (resumeBlock, message) => {
    history = [run("paused")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? configuration : path.endsWith("/runs") ? { runs: history } : { ...detail("paused"), resumeBlock } });
    await mount(); await click("交付中文待办功能");
    expect(host.textContent).toContain(message);
    expect(host.textContent).not.toContain("校验并恢复");
    expect(host.textContent).not.toContain("已暂停，可恢复");
  });

  it("详情暂时断线时标明旧状态并自动恢复到实际终态", async () => {
    vi.useFakeTimers();
    let detailCalls = 0;
    history = [run("running")];
    handler = (path) => {
      if (path.endsWith("/status")) return { status: 200, body: configuration };
      if (path.endsWith("/runs")) return { status: 200, body: { runs: history } };
      detailCalls += 1;
      if (detailCalls === 2) return { status: 503, body: { error: "请稍后重试。" } };
      return { status: 200, body: detail(detailCalls === 1 ? "running" : "completed") };
    };
    await mount(); await click("交付中文待办功能");
    expect(host.querySelector(".pm-run-heading")?.textContent).toContain("团队执行中");
    await act(async () => vi.advanceTimersByTimeAsync(2100)); await flush();
    expect(host.textContent).toContain("以下是上次读取的状态");
    expect(button("取消任务").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2100)); await flush();
    expect(detailCalls).toBe(3);
    expect(host.querySelector(".pm-run-heading")?.textContent).toContain("产物已交齐");
    expect(host.textContent).not.toContain("请稍后重试");
  });

  it("手动刷新记录和再次选择同一行都会读取已停止轮询的详情", async () => {
    let current = "paused";
    history = [run(current)];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? configuration : path.endsWith("/runs") ? { runs: history } : detail(current) });
    await mount(); await click("交付中文待办功能");
    current = "failed"; await click("刷新记录");
    expect(host.querySelector(".pm-run-heading")?.textContent).toContain("本次未交付");
    current = "completed"; await click("交付中文待办功能");
    expect(host.querySelector(".pm-run-heading")?.textContent).toContain("产物已交齐");
  });

  it("详情永久拒绝后停止轮询并移除旧工作区内容", async () => {
    vi.useFakeTimers();
    let denied = false;
    history = [run("running")];
    handler = (path) => denied ? { status: 403, body: { error: "当前成员没有开发场域权限。" } }
      : { status: 200, body: path.endsWith("/status") ? configuration : path.endsWith("/runs") ? { runs: history } : detail("running") };
    await mount(); await click("交付中文待办功能");
    denied = true;
    await act(async () => vi.advanceTimersByTimeAsync(6100)); await flush();
    expect(host.textContent).toContain("当前成员没有开发场域权限");
    expect(host.textContent).not.toContain("交付中文待办功能");
    expect(calls.filter((call) => call.path.endsWith(run().id))).toHaveLength(2);
    expect(button("交给团队执行").disabled).toBe(true);
  });

  it("任务派发权限被撤回时仍可读记录，禁止执行及新提交", async () => {
    history = [run("paused")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? { ...configuration, canDispatch: false } : path.endsWith("/runs") ? { runs: history } : detail("paused") });
    await mount(); await click("交付中文待办功能");
    expect(host.textContent).toContain("只允许查看交付记录");
    expect(host.querySelector(".pm-run-heading")?.textContent).toContain("已暂停");
    expect(button("校验并恢复").disabled).toBe(true);
    expect(button("取消任务").disabled).toBe(true);
    expect(button("交给团队执行").disabled).toBe(true);
  });

  it("文件摘要不符时同时拒绝预览和下载", async () => {
    history = [run("completed")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? configuration : path.endsWith("/runs") ? { runs: history } : path.includes("/artifacts?") ? { ...file, content: "不可信内容", sha256: "b".repeat(64) } : { ...detail("completed"), artifacts: [file] } });
    await mount(); await click("交付中文待办功能"); await click("交付/需求.md");
    expect(host.textContent).toContain("产物摘要与任务回执不一致"); expect(host.querySelector("pre")).toBeNull();
    await click("下载"); expect(host.querySelector("pre")).toBeNull();
  }, 30_000);

  it("文件原文按文本预览、可关闭，下载内容与摘要验证后的文件一致", async () => {
    const content = '<script>alert("不执行")</script>\n交付原文'; history = [run("completed")];
    handler = (path) => ({ status: 200, body: path.endsWith("/status") ? configuration : path.endsWith("/runs") ? { runs: history } : path.includes("/artifacts?") ? { ...file, content } : { ...detail("completed"), artifacts: [file] } });
    const makeUrl = vi.fn(() => "blob:fixture"); const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: makeUrl, revokeObjectURL: revoke }));
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await mount(); await click("交付中文待办功能"); await click("交付/需求.md");
    expect(host.querySelector("pre")?.textContent).toBe(content); expect(host.querySelector("script")).toBeNull();
    await click("关闭预览"); expect(host.querySelector("pre")).toBeNull();
    await click("下载"); expect(makeUrl).toHaveBeenCalledOnce(); expect(makeUrl.mock.calls[0]).toHaveLength(1); expect(anchorClick).toHaveBeenCalledOnce();
    const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement; expect(anchor.download).toBe("需求.md"); expect(anchor.href).toBe("blob:fixture");
  }, 30_000);

  it("服务读取失败显示中文错误，重载后恢复原记录", async () => {
    let fail = true;
    handler = (path) => fail ? { status: 503, body: { error: "connection_refused: internal-db" } } : { status: 200, body: path.endsWith("/status") ? configuration : { runs: [] } };
    await mount(); expect(host.textContent).toContain("请求未完成"); expect(host.textContent).not.toContain("connection_refused");
    fail = false; await click("重新加载"); expect(host.textContent).toContain("还没有任务"); expect(host.querySelector('[role="alert"]')).toBeNull();
  }, 30_000);
});

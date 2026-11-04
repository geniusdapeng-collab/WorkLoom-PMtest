import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { AsyncState, Badge, BannerAlert, Button, Card, Icon, Input, Select, Textarea, clientChineseText, clientIdentifierText, clientStatusLabel, clientValueText } from "@workloom/ui";
import { storageKey } from "../../lib/product";
import { ensureDemoLogin, getToken } from "../../lib/trpc";
import P25 from "./P25";
import "./PmDelivery.css";

interface Employee { presetKey: string; name: string; description: string }
type RunState = "created" | "planning" | "running" | "paused" | "blocked" | "failed" | "completed" | "cancelled";
interface Usage { promptTokens: number; completionTokens: number }
interface Run { id: string; threadId?: string; goal: string; status: RunState; requestedEmployee: string | null; modelId: string;
  createdAt: string; updatedAt: string; error: string | null; errorCode: string | null; usage: Usage;
  verification?: unknown }
interface Task { id: string; presetKey: string; goal: string; dependsOn: string[]; acceptance: string[]; outputRefs: string[];
  status: string; summary: string | null; error: string | null; modelId: string | null; usage: Usage | null;
  executionBackend: "deepseek-completion" | "deepseek-harness" | null }
interface Artifact { id: string; taskId: string; path: string; sha256: string; sizeBytes: number; mediaType: string; verifiedAt: string }
interface Detail { run: Run; tasks: Task[]; artifacts: Artifact[]; resumeBlock?: "MODEL_USAGE_RECONCILIATION_REQUIRED" | "SEARCH_RECEIPT_UNSETTLED" | null }
interface Status { configured: boolean; modelId: string; employees: Employee[]; policyVersion: string; canDispatch?: boolean;
  backend?: string; sandboxRootConfigured?: boolean }
interface FileView { path: string; content: string; sha256: string; mediaType: string; sizeBytes: number; taskId: string }
interface EventReceipt { eventId: string; threadId: string; runId: string; decision: "admitted" | "attached"; replayed: boolean }
interface PendingRequest { fingerprint: string; eventId: string; threadId: string; storage?: string }
interface ThreadEventMetadata { eventId: string; runId: string; kind: "request" | "followup"; createdAt: string; excerpt: string; bodyTruncated: boolean }
type ThreadEvent = ThreadEventMetadata & ({ kind: "request"; input: { goal: string; searchQuery?: string } } | { kind: "followup"; text: string });

const LABEL: Record<string, string> = {
  created: "等待开始", planning: "产品经理正在拆解", running: "团队执行中", paused: "已暂停",
  blocked: "遇到边界，已阻断", failed: "本次未交付", completed: "产物已交齐", cancelled: "已取消", pending: "等待上游",
};
const DETAIL_REFRESH_MS = 2000;
const HISTORY_LIMIT = 20;
const EXAMPLES = [
  { tag: "需求定义", title: "把想法写成可验证的需求", goal: "为一家小型研发团队设计需求收集功能。请分析用户场景、明确首期范围，输出需求文档和包含正常、边界、异常的验收用例。所有产物保存在本次沙箱中。" },
  { tag: "研发协作", title: "从需求走到代码与测试", goal: "实现一个零依赖的JavaScript待办清单模块，支持新增、完成、删除、中文和空输入校验。请由产品经理组织需求定义、研发实现、测试与交付说明，输出可用node --test运行的测试。所有文件限于本次沙箱，不执行外部发布。" },
  { tag: "质量改进", title: "把问题变成回归用例", goal: "分析需求中“删除任务后统计数字没有更新”的问题，写出最小复现、根因排查步骤、覆盖空列表和重复删除的回归用例，以及团队交付检查单。请分别安排适合的员工，引用上游产物。" },
];

function messageOf(error: unknown): string {
  return clientChineseText(error instanceof Error ? error.message : null, "请求未完成，请重试；如仍失败，请联系管理员查看诊断记录。");
}
function timeOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未记录" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function byteText(value: number): string { return value < 1024 ? `${value} 字节` : `${(value / 1024).toFixed(1)} 千字节`; }
function modelName(value: string | null | undefined): string {
  if (value === "deepseek-flash") return "深度求索·快速模型";
  if (value === "deepseek-chat") return "深度求索·对话模型";
  return value ? "已配置模型" : "模型待配置";
}
function statusTone(value: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (value === "completed") return "success";
  if (value === "failed" || value === "blocked") return "danger";
  if (value === "paused") return "warning";
  if (value === "running" || value === "planning") return "info";
  return "neutral";
}

class PmRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function pmRequest<T>(path: string, options: { body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`/api/pm${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: options.signal,
  });
  const payload = await response.json().catch(() => null) as { error?: { message?: string; code?: string } | string; message?: string } | null;
  if (!response.ok) {
    const detail = typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? payload?.message;
    const code = typeof payload?.error === "object" ? payload.error?.code : undefined;
    throw new PmRequestError(detail || (response.status === 401 ? "登录后才能查看团队任务。" : `请求失败（${response.status}）`), response.status, code);
  }
  if (!payload || typeof payload !== "object") throw new Error("服务返回的数据不完整，请重试。");
  return payload as T;
}

async function pendingRequest(fingerprint: string, token: string | null): Promise<PendingRequest> {
  const fresh = { fingerprint, eventId: crypto.randomUUID(), threadId: crypto.randomUUID() };
  try {
    // Store only generated IDs and a session-bound digest, never the input or token.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([token, fingerprint])));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const storage = storageKey(`pm-pending-v1:${hash}`);
    const [, eventId, threadId] = sessionStorage.getItem(storage)?.match(/^([a-f0-9-]{36}):([a-f0-9-]{36})$/i) ?? [];
    if (eventId && threadId) return { fingerprint, eventId, threadId, storage };
    sessionStorage.setItem(storage, `${fresh.eventId}:${fresh.threadId}`);
    return { ...fresh, storage };
  } catch {
    // The current page can still replay when browser storage is unavailable.
    return fresh;
  }
}

function PmThreadPanel({ threadId, runId, runStatus, busy, onFollowup }: { threadId: string; runId: string; runStatus: RunState; busy: boolean; onFollowup: () => void }) {
  const [events, setEvents] = useState<ThreadEventMetadata[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [version, setVersion] = useState(0);
  const [listError, setListError] = useState("");
  const [postError, setPostError] = useState("");
  const [targetClosed, setTargetClosed] = useState(false);
  const [readError, setReadError] = useState("");
  const [opened, setOpened] = useState<ThreadEvent | null>(null);
  const [opening, setOpening] = useState("");
  const pending = useRef<{ text: string; eventId: string } | null>(null);
  const sendingRef = useRef(false);
  const path = `/threads/${encodeURIComponent(threadId)}/events`;
  const canFollow = !targetClosed && ["created", "planning", "running", "paused", "blocked", "failed"].includes(runStatus);

  useEffect(() => {
    const controller = new AbortController();
    setListError("");
    void pmRequest<{ events: ThreadEventMetadata[] }>(`${path}?limit=20&runId=${encodeURIComponent(runId)}`, { signal: controller.signal }).then(({ events }) => {
      if (!controller.signal.aborted) setEvents(events.filter((event) => event.runId === runId));
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setListError(messageOf(failure));
    });
    return () => controller.abort();
  }, [path, runId, version]);

  async function postFollowup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canFollow || sendingRef.current) return;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 8000) { setPostError("请填写 1 至 8,000 个字的补充说明。"); return; }
    if (pending.current?.text !== trimmed) pending.current = { text: trimmed, eventId: crypto.randomUUID() };
    sendingRef.current = true; setSending(true); setPostError("");
    const token = getToken();
    try {
      const receipt = await pmRequest<EventReceipt>("/events", { body: { kind: "followup", threadId, runId, ...pending.current } });
      if (getToken() !== token) return;
      if (receipt.eventId !== pending.current.eventId || receipt.threadId !== threadId || receipt.runId !== runId || receipt.decision !== "attached") {
        throw new Error("补充消息的回执不完整，请重试。");
      }
      pending.current = null; setText(""); setVersion((value) => value + 1); onFollowup();
    } catch (failure) {
      if (getToken() !== token) return;
      if (failure instanceof PmRequestError && failure.code === "PM_FOLLOWUP_WINDOW_CLOSED") {
        setPostError("最后一个执行步骤已开始，这条补充未提交。可以保留内容，另开任务处理。");
        setTargetClosed(true);
        onFollowup();
      } else if (failure instanceof PmRequestError && (failure.code === "PM_FOLLOWUP_RUN_MISMATCH" || failure.code === "PM_THREAD_NOT_ACTIVE")) {
        setPostError(failure.code === "PM_FOLLOWUP_RUN_MISMATCH"
          ? "线程的当前任务已变化，这条补充未提交。可复制草稿，再打开要补充的任务。"
          : "当前任务已结束，这条补充未提交。可复制草稿，另开任务处理。");
        setTargetClosed(true);
        onFollowup();
      } else setPostError(messageOf(failure));
    }
    finally { sendingRef.current = false; setSending(false); }
  }

  async function readEvent(eventId: string) {
    setOpening(eventId); setReadError(""); setOpened(null);
    const token = getToken();
    try {
      const { event } = await pmRequest<{ event: ThreadEvent }>(`${path}/${encodeURIComponent(eventId)}`);
      if (getToken() !== token) return;
      if (event.eventId !== eventId || event.runId !== runId) throw new Error("消息原文与当前任务不匹配，请刷新消息。");
      setOpened(event);
    } catch (failure) { if (getToken() === token) setReadError(messageOf(failure)); }
    finally { setOpening(""); }
  }

  return <section className="pm-thread" aria-labelledby="pm-thread-title">
    <div className="pm-thread-heading"><h3 id="pm-thread-title">任务消息</h3><Button variant="quiet" onClick={() => setVersion((value) => value + 1)}>刷新消息</Button></div>
    {listError ? <BannerAlert level="alert">{listError}</BannerAlert> : !events ? <AsyncState status="loading" title="正在读取任务消息…" /> : events.length === 0 ? <p>还没有任务消息。</p> : <ol className="pm-thread-events">{events.map((event) => <li key={event.eventId}>
      <div className="pm-thread-heading"><strong>{event.kind === "request" ? "任务目标" : "补充说明"}</strong><time dateTime={event.createdAt}>{timeOf(event.createdAt)}</time></div>
      <p>{event.excerpt}</p>
      {event.bodyTruncated && <Button variant="quiet" disabled={Boolean(opening)} onClick={() => void readEvent(event.eventId)}>{opening === event.eventId ? "正在读取原文…" : "查看完整消息"}</Button>}
    </li>)}</ol>}
    {readError && <BannerAlert level="alert">{readError}</BannerAlert>}
    {opened && <div className="pm-thread-original"><div className="pm-thread-heading"><h4>消息原文</h4><Button variant="quiet" onClick={() => setOpened(null)}>关闭原文</Button></div>
      <p>{opened.kind === "request" ? opened.input.goal : opened.text}</p>
      {opened.kind === "request" && opened.input.searchQuery && <p>公开网页检索词：{opened.input.searchQuery}</p>}
    </div>}
    {postError && <BannerAlert level="alert">{postError}</BannerAlert>}
    {!canFollow && postError && text && <Textarea label="未提交的补充草稿" value={text} rows={3} readOnly />}
    {canFollow && <form className="pm-thread-compose" onSubmit={(event) => void postFollowup(event)}>
      <Textarea id="pm-followup" label="补充当前任务" value={text} onChange={(event) => { setText(event.target.value); setPostError(""); }} rows={3} maxLength={8000}
        description="补充信息进入同一任务。需要调整已经执行的步骤时，请先核对当前进展。" disabled={sending || busy} required />
      <Button type="submit" variant="primary" disabled={sending || busy || !text.trim()} busy={sending} busyLabel="正在添加…">添加补充说明</Button>
    </form>}
  </section>;
}

export default function PmDelivery() {
  const [view, setView] = useState<"delivery" | "machines">("delivery");
  const [status, setStatus] = useState<Status | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [employee, setEmployee] = useState("");
  const [fileChecks, setFileChecks] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState<{ message: string; retrying: boolean } | null>(null);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [file, setFile] = useState<FileView | null>(null);
  const [fileBusy, setFileBusy] = useState("");
  const actionController = useRef<AbortController | null>(null);
  const fileController = useRef<AbortController | null>(null);
  const requestKey = useRef<PendingRequest | null>(null);
  const selectedRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const { signal } = controller;
    try {
      await ensureDemoLogin();
      if (signal.aborted) return;
      const [configuration, history] = await Promise.all([
        pmRequest<Status>("/status", { signal }), pmRequest<{ runs: Run[] }>("/runs", { signal }),
      ]);
      if (signal.aborted) return;
      setStatus(configuration); setRuns(history.runs); setError("");
    } catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof PmRequestError && (failure.status === 401 || failure.status === 403)) {
        actionController.current?.abort(); actionController.current = null; setBusy(false);
        fileController.current?.abort(); fileController.current = null; setFileBusy(""); setFile(null);
        selectedRef.current = null;
        setSelected(null); setDetail(null); setDetailError(null); setStatus(null); setRuns([]); setNotice("");
      }
      setError(messageOf(failure));
    } finally { if (!signal.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => {
      actionController.current?.abort(); actionController.current = null; setBusy(false);
      fileController.current?.abort(); fileController.current = null;
      selectedRef.current = null; requestKey.current = null;
      setSelected(null); setDetail(null); setFile(null); setFileBusy(""); setStatus(null); setRuns([]);
      setGoal(""); setEmployee(""); setFileChecks(""); setSearchQuery("");
      setNotice(""); setError(""); setDetailError(null); setFormError(""); setLoading(true); void load();
    };
    window.addEventListener("workloom:identity-changed", refresh);
    return () => { loadController.current?.abort(); actionController.current?.abort(); fileController.current?.abort(); window.removeEventListener("workloom:identity-changed", refresh); };
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const token = getToken();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await pmRequest<Detail>(`/runs/${encodeURIComponent(selected)}`, { signal: controller.signal });
        if (controller.signal.aborted || selectedRef.current !== selected || getToken() !== token) return;
        if (next.run.id !== selected) throw new Error("任务详情与当前选择不匹配，请重试。");
        setDetail(next); setDetailError(null);
        setRuns((previous) => previous.some((run) => run.id === next.run.id)
          ? previous.map((run) => run.id === next.run.id ? next.run : run)
          : [next.run, ...previous].slice(0, HISTORY_LIMIT));
        if (["created", "planning", "running"].includes(next.run.status)) timer = setTimeout(() => void poll(), DETAIL_REFRESH_MS);
      } catch (failure) {
        if (controller.signal.aborted || selectedRef.current !== selected || getToken() !== token) return;
        const retrying = !(failure instanceof PmRequestError) || failure.status === 408 || failure.status === 429 || failure.status >= 500;
        if (retrying) timer = setTimeout(() => void poll(), DETAIL_REFRESH_MS);
        else {
          fileController.current?.abort(); fileController.current = null;
          setDetail(null); setFile(null); setFileBusy("");
          if (failure instanceof PmRequestError && (failure.status === 401 || failure.status === 403)) void load();
        }
        setDetailError({ message: messageOf(failure), retrying });
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [load, selected, refreshVersion]);

  function refreshDetail() { setRefreshVersion((value) => value + 1); }

  function selectRun(runId: string) {
    if (selectedRef.current !== runId) {
      fileController.current?.abort(); fileController.current = null; setFileBusy("");
      selectedRef.current = runId;
      setSelected(runId); setDetail(null); setDetailError(null); setFile(null);
    } else refreshDetail();
  }

  function reloadWorkspace() {
    void load();
    if (selectedRef.current) refreshDetail();
  }

  async function createRun(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionController.current || !status?.configured || status.canDispatch === false) return;
    const trimmed = goal.trim();
    if (trimmed.length < 4) { setFormError("请说明要解决的问题和期望产物，至少输入4个字。"); inputRef.current?.focus(); return; }
    const paths = fileChecks.split("\n").map((path) => path.trim()).filter(Boolean);
    if (paths.length > 30 || paths.some((path) => path.length > 220 || path.startsWith("/") || path.split("/").some((part) => !part || part === ".." || part.startsWith(".")))) {
      setFormError("验证路径每行一个，最多30项，请使用不含上级目录或隐藏目录的相对文件路径。"); return;
    }
    const query = searchQuery.trim();
    if ([...query].length > 128) { setFormError("公开网页检索词最多 128 个字符。"); return; }
    const input = { goal: trimmed, ...(employee ? { employee } : {}),
      ...(paths.length ? { checks: paths.map((path) => ({ type: "fileExists", path })) } : {}), ...(query ? { searchQuery: query } : {}) };
    const fingerprint = JSON.stringify(input);
    const token = getToken();
    const controller = new AbortController();
    actionController.current = controller; setBusy(true); setFormError(""); setError(""); setNotice("");
    try {
      const pending = requestKey.current?.fingerprint === fingerprint ? requestKey.current : await pendingRequest(fingerprint, token);
      if (controller.signal.aborted || getToken() !== token) return;
      requestKey.current = pending;
      const { eventId, threadId, storage } = pending;
      const receipt = await pmRequest<EventReceipt>("/events", { body: { kind: "request", eventId, threadId, input }, signal: controller.signal });
      if (controller.signal.aborted || getToken() !== token) return;
      if (receipt.eventId !== eventId || receipt.threadId !== threadId || !receipt.runId || receipt.decision !== "admitted") {
        throw new Error("目标的提交回执不完整，请重试。");
      }
      requestKey.current = null;
      if (storage) {
        try { sessionStorage.removeItem(storage); }
        catch { /* A retained ID still replays the acknowledged server receipt safely. */ }
      }
      selectRun(receipt.runId);
      setGoal(""); setEmployee(""); setFileChecks(""); setSearchQuery("");
      setNotice(`目标已提交，${clientIdentifierText(receipt.runId)}。团队会在后台开始执行。`);
      setRefreshVersion((value) => value + 1);
    } catch (failure) {
      if (!controller.signal.aborted) setFormError(messageOf(failure));
    } finally {
      if (actionController.current === controller) { actionController.current = null; setBusy(false); }
    }
  }

  async function act(action: "start" | "resume" | "cancel") {
    if (!selected || detailError || actionController.current || status?.canDispatch === false) return;
    const controller = new AbortController();
    actionController.current = controller; setBusy(true); setError(""); setNotice("");
    try {
      await pmRequest(`/runs/${encodeURIComponent(selected)}/${action}`, { body: {}, signal: controller.signal });
      if (controller.signal.aborted) return;
      setNotice(action === "cancel" ? "已收到取消请求回执，请以任务状态为准。" : action === "resume" ? "已收到恢复请求回执，请以任务状态为准。" : "已收到开始请求回执，请以任务状态为准。");
      refreshDetail();
    } catch (failure) {
      if (!controller.signal.aborted) { setError(messageOf(failure)); refreshDetail(); }
    }
    finally {
      if (actionController.current === controller) { actionController.current = null; setBusy(false); }
    }
  }

  async function readArtifact(artifact: Artifact, download = false) {
    if (!selected || fileController.current) return;
    const runId = selected; setFileBusy(artifact.path); setError("");
    const token = getToken();
    const controller = new AbortController();
    fileController.current = controller;
    try {
      const result = await pmRequest<FileView>(`/runs/${encodeURIComponent(runId)}/artifacts?path=${encodeURIComponent(artifact.path)}`, { signal: controller.signal });
      if (controller.signal.aborted || selectedRef.current !== runId || getToken() !== token) return;
      if (result.sha256 !== artifact.sha256) throw new Error("产物摘要与任务回执不一致，已停止展示。");
      if (download) {
        const url = URL.createObjectURL(new Blob([result.content], { type: result.mediaType || "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.path.split("/").at(-1) || "artifact.txt";
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else setFile(result);
    } catch (failure) { if (!controller.signal.aborted && selectedRef.current === runId && getToken() === token) setError(messageOf(failure)); }
    finally { if (fileController.current === controller) { fileController.current = null; setFileBusy(""); } }
  }

  const employeeName = (key: string) => clientChineseText(status?.employees.find((item) => item.presetKey === key)?.name, "待确认员工");
  const completed = runs.filter((run) => run.status === "completed").length;
  const active = runs.filter((run) => ["planning", "running"].includes(run.status)).length;
  const resumeBlock = detail?.resumeBlock;
  const dispatchDenied = status?.canDispatch === false;
  const taskBusy = busy || dispatchDenied || Boolean(detailError);

  if (view === "machines") return <><div className="pm-legacy-return"><Button onClick={() => setView("delivery")}><Icon name="chevron" className="pm-back-icon" />返回产品交付团队</Button></div><P25 /></>;

  return <main className="pm-console" aria-label="AI产品经理交付工作台">
    <header className="pm-header">
      <div><p className="pm-eyebrow"><span aria-hidden="true" /> 产品交付团队</p>
        <h1>给团队一个目标，<br /><em>带回可验收的交付。</em></h1>
        <p className="pm-intro">产品经理负责拆解与分工，数字员工沿着依赖协作。<br className="pm-desktop-break" />需求、代码、验证记录和交付文件，保存在同一条任务里。</p></div>
      <Button className="pm-machines" onClick={() => setView("machines")}>研发设备与仓库<Icon name="chevron" /></Button>
    </header>

    <Card className="pm-stats" aria-label="任务概况">
      <div><strong>{loading ? "待加载" : clientValueText(status?.employees.length ?? 0)}</strong><span>已就绪员工</span><small>按岗位与技能分别装配</small></div>
      <div><strong>{loading ? "待加载" : active}</strong><span>正在交付</span><small>来自最近 20 条任务</small></div>
      <div><strong>{loading ? "待加载" : completed}</strong><span>产物已交齐</span><small>来自最近 20 条任务</small></div>
      <div className="pm-model-stat"><span>内置驱动模型</span><strong>{modelName(status?.modelId)}</strong><small>{status?.configured ? "真实模型已配置 · 用量逐任务记录" : "等待服务端模型配置"}</small></div>
    </Card>

    {error && <BannerAlert level="alert" className="pm-message" action={<><Button variant="quiet" disabled={busy} onClick={reloadWorkspace}>重新加载</Button><Link to="/login">前往登录</Link></>}>{error}</BannerAlert>}
    {!loading && status && !status.configured && <BannerAlert level="info" className="pm-message" action={<Link to="/onboarding">配置模型</Link>}>配置真实模型后即可开始交付。密钥由本机服务安全读取。</BannerAlert>}
    {dispatchDenied && <BannerAlert level="info" className="pm-message">当前权限或套餐只允许查看交付记录。提交目标、补充和执行操作需要任务派发权限。</BannerAlert>}
    {notice && <BannerAlert level="info" className="pm-message">{notice}</BannerAlert>}

    <div className="pm-workspace">
      <Card className="pm-compose" aria-labelledby="pm-goal-title">
        <div className="pm-section-title"><span className="pm-step-number">01</span><div><h2 id="pm-goal-title">这次，要交付什么？</h2><p>说明问题、范围与验收标准，团队会保存完整目标。</p></div></div>
        <form onSubmit={(event) => void createRun(event)}>
          <Textarea id="pm-goal" label="项目目标" ref={inputRef} value={goal} maxLength={32000} onChange={(event) => { setGoal(event.target.value); setFormError(""); }}
            placeholder="例如：实现一个支持中文的待办清单，交付需求说明、零依赖代码和正常/边界/异常测试……" required minLength={4} aria-describedby="pm-goal-help" disabled={busy} />
          <div className="pm-input-meta"><span id="pm-goal-help">写清“怎样算做完”，更容易交出对的结果。</span><span>{goal.length.toLocaleString()} / 32,000</span></div>
          <Select id="pm-employee" label="执行方式" optionalLabel="" value={employee} onChange={(event) => setEmployee(event.target.value)} disabled={busy || loading}
            description={employee ? clientChineseText(status?.employees.find((item) => item.presetKey === employee)?.description, "员工职责待确认，请查看岗位说明。") : "适合需求定义、研发、测试和交付说明需要多人衔接的任务。"}>
            <option value="">由 AI 产品经理拆解并组队</option>
            {status?.employees.map((item) => <option value={item.presetKey} key={item.presetKey}>单员工 · {clientChineseText(item.name, "待确认员工")}</option>)}
          </Select>
          <details className="pm-checks"><summary>指定必须交付的文件（可选）</summary>
            <Textarea id="pm-checks" label="必须交付的文件" hideLabel optionalLabel="" description="每行一个相对路径，系统会验证文件是否实际存在。" value={fileChecks} onChange={(event) => setFileChecks(event.target.value)} rows={3} placeholder={"文档/需求说明.md\n说明/验收记录.txt"} disabled={busy} /></details>
          <details className="pm-checks"><summary>添加公开网页检索（可选）</summary>
            <Input id="pm-search-query" label="公开网页检索词" optionalLabel="" value={searchQuery} maxLength={128} onChange={(event) => { setSearchQuery(event.target.value); setFormError(""); }}
              description="只填写可公开的关键词。系统会将该检索词发送给外部搜索服务，请勿填写客户信息、内部资料或密钥。"
              placeholder="例如：站点公开文档的产品名称和功能关键词" disabled={busy} /></details>
          {formError && <BannerAlert level="alert" className="pm-message">{formError}</BannerAlert>}
          <Button type="submit" variant="primary" className="pm-submit" disabled={busy || loading || dispatchDenied || !status?.configured} busy={busy} busyLabel="正在提交目标…">交给团队执行<Icon name="send" /></Button>
          <p className="pm-boundary">本轮产物保存在隔离目录。外部发布和生产变更使用独立审批流程。</p>
        </form>
        <div className="pm-example-list"><p className="pm-small-label">从一个具体场景开始</p>{EXAMPLES.map((example) => <Button variant="quiet" disabled={busy} key={example.tag} onClick={() => { setGoal(example.goal); setEmployee(""); setFileChecks(""); setSearchQuery(""); setFormError(""); inputRef.current?.focus(); }}>
          <span>{example.tag}</span><strong>{example.title}</strong><Icon name="chevron" /></Button>)}</div>
      </Card>

      <Card className="pm-progress" aria-labelledby="pm-progress-title">
        <div className="pm-section-title"><span className="pm-step-number">02</span><div><h2 id="pm-progress-title">交付过程，看得见</h2><p>从员工分工到实际文件，每一步都有记录。</p></div></div>
        {!selected && <AsyncState status="empty" className="pm-empty" title="团队已就位，等待你的目标。" description="提交后，任务拆解、员工进展与交付文件会出现在这里。" visual={<Icon name="team" size={48} />} action={<ol className="pm-flow"><li>理解目标</li><li><Icon name="chevron" />员工协作</li><li><Icon name="chevron" />验证产物</li></ol>} />}
        {detailError && <BannerAlert level="alert" className="pm-message" action={<Button variant="quiet" onClick={refreshDetail}>重新读取任务</Button>}>
          {detailError.message} {detail ? "以下是上次读取的状态。" : ""}{detailError.retrying ? "系统会自动重试。" : ""}
        </BannerAlert>}
        {selected && !detail && !detailError && <AsyncState status="loading" title="正在读取任务与回执…" />}
        {detail && <>
          <div className="pm-run-heading"><Badge tone={statusTone(detail.run.status)}>{clientChineseText(LABEL[detail.run.status], clientStatusLabel(detail.run.status))}</Badge><span className="pm-time">{timeOf(detail.run.createdAt)}</span></div>
          <h3 className="pm-run-goal">{detail.run.goal}</h3>
          <div className="pm-run-actions">
            {detail.run.status === "created" && <Button variant="primary" onClick={() => void act("start")} disabled={taskBusy}>开始执行</Button>}
            {!resumeBlock && ["paused", "blocked", "failed"].includes(detail.run.status) && <Button onClick={() => void act("resume")} disabled={taskBusy}>校验并恢复</Button>}
            {["created", "planning", "running", "paused", "blocked"].includes(detail.run.status) && <Button variant="quiet" onClick={() => void act("cancel")} disabled={taskBusy}>取消任务</Button>}
            <span>已记录用量 {(detail.run.usage.promptTokens + detail.run.usage.completionTokens).toLocaleString()} 词元 · {modelName(detail.run.modelId)}</span>
          </div>
          {resumeBlock && <BannerAlert level="alert" className="pm-message">{resumeBlock === "MODEL_USAGE_RECONCILIATION_REQUIRED"
            ? "上次模型请求的用量还未对账。请联系管理员核对请求回执后再恢复。"
            : "上次公开检索缺少已核验回执。请联系管理员核对检索记录，避免重复调用。"}</BannerAlert>}
          {detail.run.error && <BannerAlert level="alert" className="pm-message">{clientChineseText(detail.run.error, "本次交付遇到异常，请核对产物后重试；详细原因已记录，可由管理员查看。")}</BannerAlert>}
          {detail.run.threadId && <PmThreadPanel key={detail.run.id} threadId={detail.run.threadId} runId={detail.run.id} runStatus={detail.run.status} busy={taskBusy} onFollowup={refreshDetail} />}
          {detail.tasks.length === 0 && <AsyncState status={detail.run.status === "planning" ? "loading" : "empty"} title={detail.run.status === "planning" ? "产品经理正在安排员工、依赖与验收标准。" : "本次尚未生成任务计划。"} description={detail.run.status === "created" ? "开始执行后，员工分工与依赖将保存在这里。" : resumeBlock ? "处理上方提示后，再刷新任务状态。" : "请结合任务状态与提示，决定重试、恢复或核对产物。"} />}
          <ol className="pm-task-list">{detail.tasks.map((task, index) => <li key={task.id}>
            <Card className="pm-task">
              <div className="pm-task-top"><span className="pm-task-index">{String(index + 1).padStart(2, "0")}</span><strong>{clientChineseText(employeeName(task.presetKey), "待确认员工")}</strong><Badge tone={statusTone(task.status)}>{clientChineseText(LABEL[task.status], clientStatusLabel(task.status))}</Badge></div>
              <p>{clientChineseText(task.goal, "请在项目目标与交付文件中核对本项任务。")}</p>
              {task.dependsOn.length > 0 && <div className="pm-dependencies">读取上游：{task.dependsOn.map((id) => <Badge key={id}>{clientChineseText(employeeName(detail.tasks.find((item) => item.id === id)?.presetKey ?? ""), "待确认员工")}</Badge>)}</div>}
              {task.summary && <p className="pm-task-summary">{clientChineseText(task.summary, "执行摘要含文件或代码信息，请打开交付文件核对原文。")}</p>}
              {task.error && <BannerAlert level="alert">{clientChineseText(task.error, "本项任务遇到异常，请核对交付记录后重试。")}</BannerAlert>}
              <div className="pm-task-meta"><span>{task.executionBackend === "deepseek-harness" ? "受限工具执行" : task.executionBackend === "deepseek-completion" ? "技能产物生成" : "等待执行"}</span><span>{task.outputRefs.length} 个计划文件</span></div>
            </Card>
          </li>)}</ol>
          {detail.artifacts.length > 0 && <div className="pm-artifacts"><h3>交付文件 <Badge tone="success">{detail.artifacts.length}</Badge></h3>{detail.artifacts.map((artifact) => <div key={artifact.id} className="pm-file-row">
            <Button variant="quiet" className="pm-file-open" onClick={() => void readArtifact(artifact)} disabled={Boolean(fileBusy)}><Icon name="document" /><span><strong>{artifact.path}</strong><small>{byteText(artifact.sizeBytes)} · 文件摘要已核验</small></span></Button>
            <Button variant="quiet" onClick={() => void readArtifact(artifact, true)} disabled={Boolean(fileBusy)} aria-label={`下载 ${artifact.path}`}>{fileBusy === artifact.path ? "读取中…" : "下载"}</Button>
          </div>)}</div>}
        </>}
      </Card>
    </div>

    {file && <Card className="pm-file-view" aria-label={`产物预览：${file.path}`}><div><h2>{file.path}</h2><Button onClick={() => setFile(null)}>关闭预览</Button></div><p>以下为交付文件原文，代码与文件名保留原样，便于核对和使用。</p><details><summary>核对文件摘要</summary><p className="pm-file-digest">{file.sha256}</p></details><pre tabIndex={0}>{file.content}</pre></Card>}
    <Card className="pm-history" aria-labelledby="pm-history-title"><div className="pm-history-heading"><div><p className="pm-eyebrow">团队交付记录</p><h2 id="pm-history-title">每个目标，都有来路与结果。</h2></div><Button disabled={loading || busy} onClick={reloadWorkspace}>刷新记录</Button></div>
      {loading ? <AsyncState status="loading" title="正在读取任务记录…" /> : runs.length === 0 ? <AsyncState status="empty" title="还没有任务" description="可以从上方场景开始，也可以直接输入你的目标。" /> : <div className="pm-history-list">{runs.map((run) => <Button key={run.id} className={selected === run.id ? "is-selected" : ""} onClick={() => { selectRun(run.id); setError(""); setNotice(""); }} aria-pressed={selected === run.id}>
        <Badge tone={statusTone(run.status)}>{clientChineseText(LABEL[run.status], clientStatusLabel(run.status))}</Badge><strong>{run.goal}</strong><time dateTime={run.createdAt}>{timeOf(run.createdAt)}</time><Icon name="chevron" /></Button>)}</div>}
    </Card>
  </main>;
}

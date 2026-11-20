/**
 * 落地向导（D24）——从「全模拟运行态」到「真实经营」的五步自动流程
 *
 * ① 环境自检（自动跑：DB/事件库/模型/数据模式）
 * ② 真实大模型（预设一键填 → 真实试调 → 通过才保存；保存即全链即时真实化，无需重启）
 * ③ 经营主体（名称/行业/简介 → 门店档案）
 * ④ 启用真实模式（服务端事实门禁通过后写入激活凭据；模拟期数据保留为「演示期」历史）
 * ⑤ AI 服务前台（可选）：官网抓取建知识库 / 文档入库 / 试营业测试问 / 生成 C 端入口
 *
 * 设计纪律：每一步都可跳过但状态如实回显；所有写操作经 onboarding.* 端点五元事件留痕。
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import CustomizeWizard from "./CustomizeWizard";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import type { OnboardingStatus } from "../../components/SimBanner";
import { UrlQrCode } from "../../components/UrlQrCode";
import { Icon, clientChineseText } from "@workloom/ui";
import { modelTestReplyText, onboardingStatusSystemText, publicationSystemText } from "./systemText";

const PROVIDERS: Array<{ key: string; label: string; baseUrl: string; model: string }> = [
  { key: "deepseek", label: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { key: "moonshot", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { key: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "custom", label: "自定义（OpenAI 兼容网关）", baseUrl: "", model: "" },
];

const STEPS = ["环境自检", "真实大模型", "经营主体", "启用真实模式", "AI 服务前台"] as const;

interface WizardDraftPayload {
  provider?: string; baseUrl?: string; model?: string; businessName?: string; industry?: string;
  note?: string; siteUrl?: string; documentTitle?: string; testQuestion?: string;
}
interface WizardDraft {
  id: string;
  version: number;
  status: "draft" | "completed" | "abandoned";
  currentStep: number;
  payload: WizardDraftPayload;
  responsible: { memberId: string; memberNo: string; name: string; role: string };
  updatedAt: string;
}
interface ServiceFrontPublication {
  url: string | null;
  urlSource: "workspace-map" | "deployment" | "bundled-preview" | "none";
  publicReachable: boolean;
  qrAvailable: boolean;
  workspaceRoutingReady: boolean;
  overall: "published" | "preview" | "blocked";
  channels: Array<{ key: "h5" | "wechat-mini" | "alipay"; label: string; status: "ready" | "preview" | "partial" | "blocked" | "unavailable"; detail: string }>;
}

function safeOnboardingError(error: unknown, fallback = "该操作暂时未完成，请稍后重试。"): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("版本") || message.includes("其他成员更新")) return "向导已由其他成员更新，请刷新页面后继续。";
  if (message.includes("权限") || message.includes("FORBIDDEN") || message.includes("所有者")) return "当前角色没有执行该操作的权限，请联系工作区负责人。";
  if (message.includes("门禁") || message.includes("尚不能")) return "正式运行条件尚未全部通过，请按门禁提示补齐配置。";
  if (message.includes("模型") || message.includes("连接")) return "模型连接或验证未通过，请检查地址、模型名称和密钥后重试。";
  return fallback;
}

const CHANNEL_TONE: Record<ServiceFrontPublication["channels"][number]["status"], string> = {
  ready: "border-go/50 text-go", preview: "border-holo/50 text-holo", partial: "border-amber-500/50 text-amber-200",
  blocked: "border-warn/50 text-warn", unavailable: "border-line text-ink3",
};
const CHANNEL_STATUS: Record<ServiceFrontPublication["channels"][number]["status"], string> = {
  ready: "已就绪", preview: "仅预览", partial: "部分接入", blocked: "未满足发布条件", unavailable: "未配置",
};

export default function Onboarding() {
  const [st, setSt] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const customizeMode = searchParams.get("mode") === "customize";
  const modelOnly = !customizeMode && searchParams.get("step") === "model";
  const fromModelLedger = modelOnly && searchParams.get("from") === "models";
  const visibleStep = modelOnly ? 1 : step;

  // 步骤②表单
  const [prov, setProv] = useState("deepseek");
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[0]!.baseUrl);
  const [model, setModel] = useState(PROVIDERS[0]!.model);
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; latencyMs?: number; error?: string } | null>(null);
  const [modelNotice, setModelNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [llmDone, setLlmDone] = useState(false);

  // 步骤③表单
  const [bizName, setBizName] = useState("");
  const [industry, setIndustry] = useState("");
  const [note, setNote] = useState("");
  const [bizDone, setBizDone] = useState(false);

  // 步骤⑤（文档正文和模型密钥永不写入向导草稿）
  const [siteUrl, setSiteUrl] = useState("");
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteResult, setSiteResult] = useState<{ entryCount: number; degraded?: boolean } | null>(null);
  const [docTitle, setDocTitle] = useState("");
  const [docMd, setDocMd] = useState("");
  const [docBusy, setDocBusy] = useState(false);
  const [docResult, setDocResult] = useState<{ version: number; chunks: number } | null>(null);
  const [testQ, setTestQ] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testHits, setTestHits] = useState<Array<{ documentTitle: string; heading: string; content: string; score: number }> | null>(null);

  const [draftVersion, setDraftVersion] = useState(0);
  const [draftResponsible, setDraftResponsible] = useState<WizardDraft["responsible"] | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [publication, setPublication] = useState<ServiceFrontPublication | null>(null);

  // 步骤④
  const [activating, setActivating] = useState(false);
  const [done, setDone] = useState(false);

  const reload = async () => {
    await ensureDemoLogin();
    const s = onboardingStatusSystemText((await trpc.onboarding.status.query()) as OnboardingStatus);
    setSt(s);
    return s;
  };
  useEffect(() => {
    let active = true;
    setSt(null);
    setErr("");
    setStep(0);
    setApiKey("");
    setTestResult(null);
    setModelNotice("");
    void ensureDemoLogin().then(async () => {
      const s = onboardingStatusSystemText((await trpc.onboarding.status.query()) as OnboardingStatus);
      const [draft, front] = modelOnly ? [null, null] : await Promise.all([
        trpc.onboarding.wizardDraft.query() as Promise<WizardDraft | null>,
        trpc.onboarding.serviceFrontPublication.query() as Promise<ServiceFrontPublication>,
      ]);
      if (!active) return;
      const payload = draft?.payload ?? {};
      const provider = payload.provider || s.llm.provider;
      const preset = PROVIDERS.find((item) => item.key === provider) ?? (provider === "mock" || !provider ? PROVIDERS[0]! : PROVIDERS.at(-1)!);
      setProv(preset.key);
      setBaseUrl(payload.baseUrl || (provider === s.llm.provider && provider !== "mock" ? s.llm.baseUrl : "") || preset.baseUrl);
      setModel(preset.key === "deepseek" ? preset.model : payload.model || (provider === s.llm.provider ? s.llm.model : "") || preset.model);
      setSt(s);
      setLlmDone(s.llm.real);
      if (modelOnly) return;
      setBizName(payload.businessName ?? s.business?.name ?? s.workspace.name);
      setIndustry(payload.industry ?? s.business?.industry ?? "");
      setNote(payload.note ?? s.business?.note ?? "");
      setSiteUrl(payload.siteUrl ?? "");
      setDocTitle(payload.documentTitle ?? "");
      setTestQ(payload.testQuestion ?? "");
      setPublication(front && publicationSystemText(front));
      setDraftVersion(draft?.version ?? 0);
      setDraftResponsible(draft?.responsible ?? null);
      const businessReady = Boolean(s.activationGate?.checks.find((check) => check.key === "business")?.ok);
      setBizDone(businessReady);
      setDone(draft?.status === "completed");
      if (draft?.status === "completed") setStep(4);
      else if (s.dataMode === "real") setStep(4);
      else if (draft) setStep(Math.max(0, Math.min(4, draft.currentStep)));
      else if (s.llm.real && businessReady) setStep(3);
      else if (s.llm.real) setStep(2);
    }).catch((error) => { if (active) setErr(safeOnboardingError(error, "配置暂时无法加载，请刷新后重试。")); });
    return () => { active = false; };
  }, [modelOnly]);

  const checks = useMemo(() => {
    if (!st) return [];
    return [
      { label: "数据库连接", ok: true, detail: "事件库在线" },
      { label: "事件库规模", ok: st.workspace.events > 0, detail: `${st.workspace.events} 条五元事件（哈希链可验）` },
      { label: "数字团队", ok: st.workspace.agents > 0, detail: `${st.workspace.agents} 名员工 · ${st.workspace.members} 名人类成员 · ${st.workspace.memories} 条组织经验` },
      { label: "大模型", ok: st.llm.real, detail: st.llm.real ? `${st.llm.provider} · ${st.llm.model}（连接已验证）` : st.llm.configured ? "已配置 API 连接，等待验证" : "尚未配置 API 连接" },
      { label: "数据模式", ok: st.dataMode === "real", detail: st.dataMode === "real" ? "真实经营模式" : st.bundle?.isExample ? "模拟演示数据" : "工作区尚未完成正式经营配置" },
    ];
  }, [st]);

  const draftPayload = (): WizardDraftPayload => ({
    provider: prov,
    baseUrl,
    model,
    businessName: bizName,
    industry,
    note,
    siteUrl,
    documentTitle: docTitle,
    testQuestion: testQ,
  });

  const saveDraft = async (currentStep = step): Promise<WizardDraft> => {
    setDraftBusy(true);
    try {
      const saved = await trpc.onboarding.saveWizardDraft.mutate({
        expectedVersion: draftVersion,
        currentStep,
        payload: draftPayload(),
      }) as WizardDraft;
      setDraftVersion(saved.version);
      setDraftResponsible(saved.responsible);
      return saved;
    } finally {
      setDraftBusy(false);
    }
  };

  const continueAt = async (nextStep: number) => {
    setErr("");
    try { await saveDraft(nextStep); setStep(nextStep); }
    catch (error) { setErr(safeOnboardingError(error)); }
  };

  const pauseAndExit = async () => {
    setErr("");
    try {
      await saveDraft(step);
      window.location.assign("/");
    } catch (error) { setErr(safeOnboardingError(error)); }
  };

  const refreshPublication = async () => {
    const result = publicationSystemText(
      await trpc.onboarding.serviceFrontPublication.query() as ServiceFrontPublication,
    );
    setPublication(result);
    return result;
  };

  const copyServiceLink = async () => {
    if (!publication?.url) return;
    try {
      await navigator.clipboard.writeText(publication.url);
      setErr("");
    } catch {
      setErr("链接复制失败，请选中页面中的完整地址后手动复制。");
    }
  };

  const finishWizard = async () => {
    setErr("");
    try {
      const saved = await saveDraft(4);
      const completed = await trpc.onboarding.completeWizardDraft.mutate({ expectedVersion: saved.version }) as WizardDraft;
      setDraftVersion(completed.version);
      setDraftResponsible(completed.responsible);
      setDone(true);
    } catch (error) { setErr(safeOnboardingError(error)); }
  };

  const pickProvider = (key: string) => {
    setProv(key);
    const p = PROVIDERS.find((x) => x.key === key)!;
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setApiKey("");
    setTestResult(null);
  };

  const test = async () => {
    setTesting(true); setTestResult(null); setErr(""); setModelNotice("");
    try {
      const r = (await trpc.onboarding.testLlm.mutate({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() })) as typeof testResult;
      setTestResult(r?.ok
        ? { ...r, reply: modelTestReplyText(r.reply) }
        : { ok: false, error: "模型没有返回可验证的连接结果，请检查配置后重试。" });
    } catch (e) { setTestResult({ ok: false, error: safeOnboardingError(e, "模型连接测试失败，请稍后重试。") }); }
    finally { setTesting(false); }
  };

  const saveLlm = async () => {
    setSaving(true); setErr(""); setModelNotice("");
    try {
      await trpc.onboarding.saveLlmConfig.mutate({ provider: prov, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
      setApiKey("");
      setTestResult(null);
      setLlmDone(true);
      await reload();
      if (modelOnly) setModelNotice("模型连接已验证并保存，可以返回开发场域提交任务。");
      else { await saveDraft(2); setStep(2); }
    } catch (e) { setErr(safeOnboardingError(e)); }
    finally { setSaving(false); }
  };

  const verifySavedLlm = async () => {
    setVerifying(true); setErr(""); setModelNotice(""); setTestResult(null);
    try {
      const result = await trpc.onboarding.verifyConfiguredLlm.mutate();
      await reload();
      setLlmDone(true);
      setModelNotice(`已配置的连接通过验证（${result.latencyMs} 毫秒）。`);
    } catch (error) { setErr(safeOnboardingError(error)); }
    finally { setVerifying(false); }
  };

  const saveBiz = async () => {
    setSaving(true); setErr("");
    try {
      await trpc.onboarding.setupWorkspace.mutate({ displayName: bizName, industry, note });
      setBizDone(true);
      await reload();
      await saveDraft(3);
      setStep(3);
    } catch (e) { setErr(safeOnboardingError(e)); }
    finally { setSaving(false); }
  };

  const activate = async () => {
    setActivating(true); setErr("");
    try {
      const beforeActivation = await saveDraft(3);
      await trpc.onboarding.activateRealMode.mutate();
      const updated = await reload();
      if (updated.dataMode !== "real") throw new Error("服务端未确认正式模式生效，请按门禁提示补齐配置");
      const advancedDraft = await trpc.onboarding.wizardDraft.query() as WizardDraft | null;
      setDraftVersion(advancedDraft?.version ?? beforeActivation.version);
      setDraftResponsible(advancedDraft?.responsible ?? beforeActivation.responsible);
      await refreshPublication();
      setStep(4);
    } catch (e) { setErr(safeOnboardingError(e)); }
    finally { setActivating(false); }
  };

  // —— ⑤ AI 服务前台（可选）——

  const ensureCollection = async (): Promise<string> => {
    const r = await trpc.service.kb.listCollections.query();
    const first = (r.collections as Array<{ id: string }>)[0];
    if (first) return first.id;
    const r2 = (await trpc.service.kb.createCollection.mutate({ name: "企业知识库", description: "落地向导初始化" })) as { collection: { id: string } };
    return r2.collection.id;
  };

  const crawlSite = async () => {
    setSiteBusy(true); setErr("");
    try {
      const reg = (await trpc.service.kb.registerSite.mutate({ url: siteUrl.trim() })) as { sourceId: string };
      const r = (await trpc.service.kb.crawlNow.mutate({ sourceId: reg.sourceId })) as { entryCount: number; degraded?: boolean };
      setSiteResult(r);
      await saveDraft(4);
    } catch (e) { setErr(safeOnboardingError(e, "官网内容暂时无法抓取，请检查地址后重试。")); }
    finally { setSiteBusy(false); }
  };

  const addDoc = async () => {
    setDocBusy(true); setErr("");
    try {
      const collectionId = await ensureCollection();
      const r = (await trpc.service.kb.upsertDocument.mutate({ collectionId, title: docTitle.trim(), sourceKind: "manual", contentMd: docMd })) as { version: number; chunks: number };
      setDocResult(r);
      await saveDraft(4);
    } catch (e) { setErr(safeOnboardingError(e, "文档暂时无法入库，请稍后重试。")); }
    finally { setDocBusy(false); }
  };

  const runTest = async () => {
    setTestBusy(true); setErr("");
    try {
      const r = await trpc.service.kb.search.query({ query: testQ.trim(), limit: 3 });
      setTestHits(r.hits as Array<{ documentTitle: string; heading: string; content: string; score: number }>);
      await saveDraft(4);
    } catch (e) { setErr(safeOnboardingError(e, "知识检索暂时无法完成，请稍后重试。")); }
    finally { setTestBusy(false); }
  };

  const inputCls = "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none placeholder:text-ink3 focus:border-gline";
  const btnCls = "max-w-full whitespace-normal break-words rounded-lg border border-gline bg-gold/10 px-4 py-2 text-center text-sm text-gold transition-colors hover:bg-gold/20 disabled:opacity-40";

  const modelBusy = testing || saving || verifying;
  const canSubmitModel = Boolean(baseUrl.trim() && model.trim() && (prov !== "deepseek" || apiKey.trim()));

  return (
    <div className="min-h-screen bg-[#07070d] px-4 py-8 text-ink">
      <div className="mx-auto max-w-2xl">
        {/* 头 */}
        <div className="mb-4 flex min-w-0 flex-wrap items-center gap-3">
          <Link to={fromModelLedger ? "/models" : modelOnly ? "/development" : "/"} className="rounded border border-line px-2.5 py-1 text-body text-ink3 no-underline hover:border-gline">
            {fromModelLedger ? "← 返回模型与成本" : modelOnly ? "← 返回开发场域" : "← 返回经营主页"}
          </Link>
          <h1 className="bg-gradient-to-r from-[#f0f4f9] to-gold bg-clip-text text-lg font-bold text-transparent">
            {modelOnly ? "配置模型服务" : customizeMode ? "定制我的行业版" : "落地向导 · 接入真实数据"}
          </h1>
          {/* 双模式互切：五步落地向导 ⇄ 四步行业定制（行业装配机制 V4） */}
          {!modelOnly && (!customizeMode ? (
            <button onClick={() => setSearchParams({ mode: "customize" })} className="ml-auto max-w-full whitespace-normal break-words rounded border border-gline bg-gold/10 px-3 py-1 text-body text-gold no-underline hover:bg-gold/20">
              定制我的行业版 →
            </button>
          ) : (
            <button onClick={() => setSearchParams({})} className="ml-auto rounded border border-line px-3 py-1 text-body text-ink3 hover:border-gline">
              ← 返回落地向导
            </button>
          ))}
        </div>
        {!customizeMode && !modelOnly && (
          <div className="mb-5 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-body text-ink3">
            <span className="min-w-0 flex-1 break-words">
              {draftResponsible
                ? `服务端草稿第 ${draftVersion} 版 · 责任人：${draftResponsible.name}`
                : "尚未建立服务端草稿；首次保存后可跨设备继续。"}
            </span>
            {!done && (
              <button disabled={draftBusy} onClick={() => void pauseAndExit()} className="min-h-9 max-w-full whitespace-normal break-words rounded border border-line px-3 py-1 text-ink2 hover:border-gline disabled:opacity-50">
                {draftBusy ? "正在保存…" : "保存，稍后继续"}
              </button>
            )}
          </div>
        )}

        {/* 定制模式：现状确认 → 隔离编制 → 上岗考 → 原子切换 */}
        {customizeMode && <CustomizeWizard />}

        {/* 标准落地向导（五步）——定制模式下不渲染，避免双向导同屏 */}
        {!customizeMode && <>
        {/* 步骤条 */}
        {!modelOnly && <div className="mb-6 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-5">
          {STEPS.map((s, i) => (
            <div key={s} className={`flex min-w-0 items-center justify-center gap-1 break-words rounded-lg border px-2 py-2 text-center text-body ${i === step ? "border-gline bg-gold/10 text-gold" : i < step || (i === 1 && llmDone) || (i === 2 && bizDone) ? "border-go/40 text-go" : "border-line text-ink3"}`}>
              {i < step || (i === 1 && llmDone) || (i === 2 && bizDone) ? <Icon name="check" size={14} /> : <span>{i + 1}.</span>}{s}
            </div>
          ))}
        </div>}

        {err && <div role="alert" className="mb-4 max-w-full break-words rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-body leading-relaxed text-warn">{err}</div>}

        {/* ① 环境自检 */}
        {visibleStep === 0 && (
          <div className="space-y-3 rounded-xl border border-line bg-panel/70 p-5">
            <div className="text-sm font-bold">环境自检 <span className="text-body font-normal text-ink3">（自动完成）</span></div>
            {!st && <div className="text-body text-ink3">自检中……</div>}
            {checks.map((c) => (
              <div key={c.label} className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
                <Icon name={c.ok ? "check" : "circle"} label={c.ok ? "已通过" : "待完成"} size={15} className={c.ok ? "text-go" : "text-amber-300"} />
                <span className="w-24 text-sm">{c.label}</span>
                <span className="min-w-0 flex-1 break-words text-body text-ink3">{c.detail}</span>
              </div>
            ))}
            {st && (
              <div className="pt-2 text-right">
                <button className={`${btnCls} max-w-full whitespace-normal break-words`} onClick={() => void continueAt(st.llm.real ? 2 : 1)}>
                  {st.llm.real ? "下一步：经营主体 →" : "下一步：接入真实大模型 →"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ② 真实大模型 */}
        {visibleStep === 1 && (
          <section aria-labelledby="model-connection-heading" aria-busy={modelBusy || (!st && !err)} className="space-y-4 rounded-xl border border-line bg-panel/70 p-5">
            <h2 id="model-connection-heading" className="break-words text-sm font-bold">接入真实大模型</h2>
            {!st && <p role="status" className="text-body text-ink3">{err ? "请刷新页面重新读取模型配置。" : "正在读取本机模型配置……"}</p>}
            {st && <>
              {st.llm.configured && <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-card p-3">
                <div className="min-w-0 text-body">
                  <p className="break-words font-semibold">{st.llm.model} · {st.llm.real ? "连接已验证" : "已配置连接，尚待验证"}</p>
                  {st.llm.canVerifyConfigured && <p className="mt-1 text-ink3">验证会向 DeepSeek 发送一条测试请求，无需重新输入密钥。</p>}
                </div>
                {st.llm.canVerifyConfigured && <button type="button" className={btnCls} disabled={modelBusy} onClick={() => void verifySavedLlm()}>
                  {verifying ? "正在验证……" : st.llm.real ? "重新验证已配置连接" : "验证已配置连接"}
                </button>}
              </div>}
              <fieldset disabled={modelBusy} className="min-w-0 space-y-4">
                <legend className="mb-2 text-body font-semibold">{st.llm.configured ? "更换连接" : "配置新连接"}</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label="模型提供方">
                  {PROVIDERS.map((p) => (
                    <button key={p.key} type="button" aria-pressed={prov === p.key} onClick={() => pickProvider(p.key)}
                      className={`min-w-0 break-words rounded-lg border px-3 py-2 text-body disabled:opacity-60 ${prov === p.key ? "border-gline bg-gold/10 text-gold" : "border-line text-ink3 hover:border-gline"}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <label className="block text-body text-ink3">模型接口地址
                  <input className={`${inputCls} mt-1`} type="url" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }} placeholder="https://api.deepseek.com" />
                </label>
                <label className="block text-body text-ink3">接口密钥
                  <input className={`${inputCls} mt-1`} type="password" autoComplete="off" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setTestResult(null); }} placeholder={st.llm.configured ? "更换连接时输入密钥" : "输入 API 密钥"} />
                </label>
                <label className="block text-body text-ink3">模型
                  <input className={`${inputCls} mt-1`} readOnly={prov === "deepseek"} value={model} onChange={(e) => { setModel(e.target.value); setTestResult(null); }} placeholder="填写模型名称" />
                </label>
              </fieldset>
              {testResult && (
                <div role={testResult.ok ? "status" : "alert"} className={`break-words rounded-lg border px-3 py-2 text-body ${testResult.ok ? "border-go/50 bg-go/10 text-go" : "border-warn/50 bg-warn/10 text-warn"}`}>
                  {testResult.ok
                    ? <><Icon name="check" size={15} className="inline" /> 试调通过（{testResult.latencyMs} 毫秒）——「{clientChineseText(testResult.reply, "模型已返回可验证结果。")}」</>
                    : <><Icon name="error" size={15} className="inline" /> 试调失败：{testResult.error}</>}
                </div>
              )}
              {modelNotice && <p role="status" className="break-words rounded-lg border border-go/50 bg-go/10 px-3 py-2 text-body text-go">{modelNotice}</p>}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                {modelOnly
                  ? <Link to="/onboarding" className="break-words text-body text-ink2 underline">打开完整落地向导</Link>
                  : <button type="button" className="max-w-full break-words text-left text-body text-ink3 underline disabled:opacity-60" disabled={modelBusy || draftBusy} onClick={() => void continueAt(2)}>
                    {st.llm.real ? "继续填写经营主体" : "稍后配置模型"}
                  </button>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={btnCls} disabled={modelBusy || !canSubmitModel} onClick={() => void test()}>
                    {testing ? "试调中……" : "仅测试连接"}
                  </button>
                  <button type="button" className={btnCls} disabled={modelBusy || !canSubmitModel} onClick={() => void saveLlm()}>
                    {saving ? "正在验证并保存……" : "验证并保存"}
                  </button>
                </div>
              </div>
            </>}
          </section>
        )}

        {/* ③ 经营主体 */}
        {visibleStep === 2 && (
          <div className="space-y-4 rounded-xl border border-line bg-panel/70 p-5">
            <div className="break-words text-sm font-bold">经营主体 <span className="text-body font-normal text-ink3">写入门店档案，成为数字团队的上下文</span></div>
            <label className="block text-body text-ink3">主体名称
              <input className={`${inputCls} mt-1`} value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="如：您的企业或团队名称" />
            </label>
            <label className="block text-body text-ink3">行业
              <input className={`${inputCls} mt-1`} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="如：本地生活 / 专业服务 / 内容制作" />
            </label>
            <label className="block text-body text-ink3">经营简介（可选）
              <textarea className={`${inputCls} mt-1 h-20 resize-none`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="业务范围、团队规模、经营重点……数字员工会以此为背景工作" />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button className="max-w-full break-words text-left text-body text-ink3 underline" onClick={() => void continueAt(3)}>稍后填写（未保存真实经营主体前不能启用正式模式）</button>
              <button className={btnCls} disabled={saving || !bizName.trim() || !industry.trim()} onClick={() => void saveBiz()}>
                {saving ? "保存中……" : "保存并继续 →"}
              </button>
            </div>
          </div>
        )}

        {/* ④ 启用真实模式 */}
        {visibleStep === 3 && !done && (
          <div className="space-y-4 rounded-xl border border-gline bg-panel/70 p-5">
            <div className="break-words text-sm font-bold text-gold">正式运行服务端门禁</div>
            <p className="break-words text-body leading-relaxed text-ink2">只有以下事实全部通过，服务端才会把数据模式切换为正式；页面跳步或旧的状态标记都不能绕过。</p>
            <div className="space-y-2">
              {(st?.activationGate?.checks ?? []).map((check) => (
                <div key={check.key} className="flex min-w-0 items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-body">
                  <Icon name={check.ok ? "check" : "circle"} label={check.ok ? "已通过" : "待完成"} size={15} className={check.ok ? "shrink-0 text-go" : "shrink-0 text-amber-300"} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-ink">{clientChineseText(check.label, "运行条件")}</div>
                    <div className="break-words leading-relaxed text-ink3">{clientChineseText(check.detail, "运行条件信息待确认")}</div>
                  </div>
                </div>
              ))}
            </div>
            {!st?.activationGate?.canActivate && (
              <div className="break-words rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-body leading-relaxed text-amber-200">
                门禁尚未全绿。请返回对应步骤补齐真实模型、经营主体或装配；系统不会把当前状态显示为正式运行。
              </div>
            )}
            <div className="pt-1 text-right">
              <button className={`${btnCls} max-w-full whitespace-normal break-words`} disabled={activating || !st?.activationGate?.canActivate} onClick={() => void activate()}>
                {activating ? "正在进行服务端核验……" : "门禁全绿，启用正式经营模式"}
              </button>
            </div>
          </div>
        )}

        {/* ⑤ AI 服务前台（可选） */}
        {visibleStep === 4 && !done && (
          <div className="space-y-4 rounded-xl border border-gline bg-panel/70 p-5">
            <div className="text-sm font-bold text-gold">启用面向客户的 AI 服务前台（可选）</div>
            <div className="text-body leading-relaxed text-ink2">
              为客户配置 7×24 AI 服务前台：知识问答、业务查询、工单流转与结果通知。入口与渠道状态均来自当前部署环境，不会把占位地址或已填凭据冒充正式发布。
            </div>

            {/* 发布事实与渠道状态 */}
            {!publication ? (
              <div className="rounded-lg border border-line p-3 text-body text-ink3">正在读取发布状态……</div>
            ) : (
              <div className="min-w-0 rounded-lg border border-line bg-card p-3">
                <div className="flex min-w-0 flex-wrap items-start gap-3">
                  {publication.qrAvailable && publication.url ? <UrlQrCode value={publication.url} /> : (
                    <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded border border-dashed border-line p-3 text-center text-body leading-relaxed text-ink3">
                      {publication.url ? "当前地址不满足手机扫码访问条件" : "尚未配置客户可访问地址"}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-body font-semibold text-ink">
                      {publication.overall === "published" ? "已发布" : publication.overall === "preview" ? "可预览，尚未正式发布" : "尚未满足发布条件"}
                    </div>
                    {publication.url && <div className="mt-1 break-all text-body text-holo">{publication.url}</div>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {publication.url && <button className={btnCls} onClick={() => void copyServiceLink()}>复制链接</button>}
                      {publication.url && <a className={`${btnCls} no-underline`} href={publication.url} target="_blank" rel="noreferrer">打开地址检查 <Icon name="chevron" size={13} aria-hidden="true" /></a>}
                      <button className={btnCls} onClick={() => void refreshPublication().catch((error) => setErr(safeOnboardingError(error, "发布状态暂时无法刷新。")))}>刷新状态</button>
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                  {publication.channels.map((channel) => (
                    <div key={channel.key} className={`min-w-0 rounded border px-2 py-1.5 text-body ${CHANNEL_TONE[channel.status]}`}>
                      <div className="break-words font-semibold">{clientChineseText(channel.label, "服务渠道")} · {CHANNEL_STATUS[channel.status]}</div>
                      <div className="mt-0.5 break-words leading-relaxed opacity-80">{clientChineseText(channel.detail, "渠道状态说明待确认")}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 官网抓取建库 */}
            <div className="space-y-2 rounded-lg border border-line p-3">
              <div className="break-words text-body font-bold text-ink">① 官网自动建库（抓取 → 结构化 → 每日扫描更新，变更必审）</div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <input className={`${inputCls} min-w-0 flex-1`} placeholder="企业官网地址，如 https://www.example.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
                <button className={`${btnCls} shrink-0`} disabled={siteBusy || !siteUrl.trim()} onClick={() => void crawlSite()}>{siteBusy ? "抓取中……" : "抓取建库"}</button>
              </div>
              {siteResult && (
                <div className="break-words text-body text-go"><Icon name="check" size={14} className="inline" /> 已结构化抽取 {siteResult.entryCount} 条知识入库{siteResult.degraded ? "（未配置真实模型凭据，已降级直存）" : ""}，已进入待审列表。</div>
              )}
            </div>

            {/* 文档入库 */}
            <div className="space-y-2 rounded-lg border border-line p-3">
              <div className="break-words text-body font-bold text-ink">② 或直接粘贴政策、手册等结构化文本</div>
              <input className={inputCls} placeholder="文档标题，如《客户服务须知》" value={docTitle} onChange={(e) => setDocTitle(e.target.value)} />
              <textarea className={`${inputCls} h-24`} placeholder="# 服务范围
## 办理方式
……" value={docMd} onChange={(e) => setDocMd(e.target.value)} />
              <div className="text-right">
                <button className={btnCls} disabled={docBusy || !docTitle.trim() || !docMd.trim()} onClick={() => void addDoc()}>{docBusy ? "入库中……" : "解析入库"}</button>
              </div>
              {docResult && <div className="break-words text-body text-go"><Icon name="check" size={14} className="inline" /> 已入库第 {docResult.version} 版，自动切分 {docResult.chunks} 个知识块。</div>}
            </div>

            {/* 试营业测试问 */}
            <div className="space-y-2 rounded-lg border border-line p-3">
              <div className="break-words text-body font-bold text-ink">③ 试营业：问一句，看命中与依据</div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <input className={`${inputCls} min-w-0 flex-1`} placeholder="测试问题，如：如何查询服务进度？" value={testQ} onChange={(e) => setTestQ(e.target.value)} />
                <button className={`${btnCls} shrink-0`} disabled={testBusy || !testQ.trim()} onClick={() => void runTest()}>{testBusy ? "检索中……" : "试一句"}</button>
              </div>
              {testHits && (testHits.length === 0 ? (
                <div className="break-words text-body text-amber-300">未命中——真实问答时 AI 将诚实拒答并自动生成工单转专人，不臆造。</div>
              ) : testHits.map((h, i) => (
                <div key={i} className="break-words rounded border border-line bg-card px-2.5 py-1.5 text-body text-ink2">
                  <b className="text-holo">{h.documentTitle} · {h.heading}</b>（相关度 {h.score.toFixed(2)}）<br />{h.content.slice(0, 80)}
                </div>
              )))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button className="max-w-full break-words text-left text-body text-ink3 underline" disabled={draftBusy} onClick={() => void finishWizard()}>暂不配置，保存后稍后在服务前台配置</button>
              <button className={btnCls} disabled={draftBusy} onClick={() => void finishWizard()}>{draftBusy ? "正在保存……" : "完成，进入经营主页 →"}</button>
            </div>
          </div>
        )}

        {/* 完成 */}
        {done && !modelOnly && (
          <div className="space-y-4 rounded-xl border border-go/50 bg-go/5 p-6 text-center">
            <Icon name="celebrate" size={28} className="mx-auto text-go" />
            <div className="text-sm font-bold text-go">{st?.dataMode === "real" ? "真实经营模式已启用" : "向导进度已保存"}</div>
            <div className="text-body leading-relaxed text-ink3">
              {st?.dataMode === "real" ? "服务端正式模式激活事件已留痕，数字团队将按正式配置继续工作。" : "正式运行门禁尚未全绿，系统仍保持模拟状态；您可以稍后继续补齐。"}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <a href="/" className="inline-block rounded-lg border border-gline bg-gold/10 px-5 py-2 text-sm text-gold no-underline hover:bg-gold/20">回到经营主页 →</a>
              {publication?.url && <a href={publication.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 whitespace-normal break-words rounded-lg border border-holo/40 bg-holo/10 px-5 py-2 text-sm text-holo no-underline hover:bg-holo/20">打开客户服务地址检查 <Icon name="chevron" size={13} aria-hidden="true" /></a>}
            </div>
          </div>
        )}
        </>}
      </div>
    </div>
  );
}

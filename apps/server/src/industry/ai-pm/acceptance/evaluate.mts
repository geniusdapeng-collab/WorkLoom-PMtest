/** Real API evaluation. Run only behind pm-budget-proxy; never supplies a mock provider. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createDeepSeekProvider, createDeepSeekTools, runToolConversation } from "@workloom/base/model-router";
import { LlmIntentClassifier, routeIntent, ruleBasedRoute } from "@workloom/runtime";
import { INTENT_ROUTE_TIMEOUT_MS } from "@workloom/shared";
import { resolveDispatchPreset } from "../../../runtime/thread-runner.js";
import { executeSandboxNodeTests } from "../code-verifier.js";
import type { PmRunDetail, PmFile, ArtifactCheck } from "../types.js";
import { buildEvaluationMetrics, intentSlotAvailable, teamPlanContract } from "./metrics.mjs";
import { evaluationAttemptIdentity, evaluationCaseTimeoutMs, evaluationContractsEqual, loadEvaluationState, pollEvaluationRun } from "./state.mjs";

const api = process.env.PM_EVAL_API ?? "http://127.0.0.1:18787";
const out = resolve(process.env.PM_EVAL_OUT ?? "data/pm-evaluation");
const workspaceSlug = process.env.PM_EVAL_WORKSPACE ?? "ai-pm-demo";
const scope = { tenantId: "demo", workspaceId: "ws-aipm-demo" };
const session = process.env.PM_EVAL_RUN_ID ?? `pm-eval-${Date.now()}`;
const phase = process.env.PM_EVAL_PHASE ?? "initial";
const caseTimeoutMs = evaluationCaseTimeoutMs(process.env.PM_EVAL_CASE_TIMEOUT_MS);
const onlyCases = process.env.PM_EVAL_ONLY ? new Set(process.env.PM_EVAL_ONLY.split(",").map((id) => id.trim()).filter(Boolean)) : undefined;
const selected = (id: string) => !onlyCases || onlyCases.has(id);
await mkdir(out, { recursive: true });
const cases = await loadEvaluationState(join(out, "evaluation.json"), session, phase);
const checkpoint = async () => writeFile(join(out, "evaluation.json"), JSON.stringify({ session, environment: "isolated-local-client-runtime",
  model: "deepseek-flash", syntheticInput: true, evaluatedAt: new Date().toISOString(), cases }, null, 2));
interface BudgetStatus { budget: { schema: string; used: { llmCalls: number }; frozenBy: unknown[]; budgets: { maxLlmCalls: number | null } } }
async function http<T = unknown>(path: string, token?: string, body?: unknown) {
  const response = await fetch(`${api}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const payload = await response.json() as T; return { status: response.status, payload };
}
async function login(memberNo: string) {
  const response = await http<{ result?: { data?: { token?: string } } }>("/trpc/auth.loginAs", undefined, { workspaceSlug, memberNo });
  const token = response.payload?.result?.data?.token;
  if (!token) throw new Error(`本地成员登录失败：HTTP${response.status}`);
  return token as string;
}
const token = await login("MEM-001");
const status = await http<{ configured: boolean; modelId: string; employees: unknown[] }>("/api/pm/status", token);
await writeFile(join(out, "configuration.json"), JSON.stringify(status, null, 2));
if (status.status !== 200 || !status.payload.configured || status.payload.modelId !== "deepseek-flash" || status.payload.employees.length !== 14) {
  throw new Error("真实模型/14岗位前置未就绪，未执行付费评测");
}
const negative = [
  { id: "auth-none", path: "/api/pm/status", token: undefined, expected: 401 },
  { id: "auth-readonly", path: "/api/pm/status", token: await login("MEM-003"), expected: 403 },
  { id: "empty-goal", path: "/api/pm/runs", token, body: { goal: "", idempotencyKey: `${session}-bad1` }, expected: 400 },
  { id: "goal-too-large", path: "/api/pm/runs", token, body: { goal: "大".repeat(32_001), idempotencyKey: `${session}-bad2` }, expected: 400 },
  { id: "forged-scope", path: "/api/pm/runs", token, body: { goal: "伪造范围测试", idempotencyKey: `${session}-bad3`, tenantId: "other" }, expected: 400 },
  { id: "path-escape", path: "/api/pm/runs", token, body: { goal: "目录越界测试", idempotencyKey: `${session}-bad4`, checks: [{ type: "fileExists", path: "../escape" }] }, expected: 400 },
];
for (const item of negative) {
  if (cases.some((row) => row.id === item.id)) continue;
  const response = await http(item.path, item.token, item.body);
  cases.push({ id: item.id, kind: "http-negative", precondition: "独立沙箱启动，未调用模型", steps: item.path,
    expected: `HTTP ${item.expected}`, actual: response.status, passed: response.status === item.expected });
}
await checkpoint();

const supplied = "材料为本轮合成数据，不是生产数据；只能基于以下材料写结论，不访问外网，不声称已运行外部业务工具。";
const singles = [
  ["chief-pm", "将需求A（用户可导出CSV）、B（颜色主题）、C（修复统计错误）排优先级。A影响30名用户、B影响2人、C影响全部用户且会误报总数；本周仅2人日，各项工时未估。A依赖C修复；两份材料分别写A负责人张三、李四，尚未裁定。必须标注冲突与待确认，不编造排期。输出优先级、理由、验收与不做清单。", "优先级"],
  ["requirement-analyst", "设计小团队需求收集功能：反馈需含标题、来源、状态、负责人。现有材料互相矛盾：一处说创建必须有负责人，一处说草稿允许负责人为空；请通过明确草稿/提交状态约束解决，不能同时保留矛盾。输出3个用户场景、P0/P1/P2、字段与正常/空输入/权限/重复提交验收。", "P0"],
  ["competitor-scout", "对比材料：产品甲每月99元、CSV导出、有操作日志；产品乙每月59元、无导出、有手机端。目标客户为5人团队，最需要审计追溯。价格未注明计费人数、税费和套餐；乙是否有操作日志未知。不得把未提及功能当成不存在，也不将两价直接作同口径性价比。只基于给定材料列对比、未知项、定位建议。", "未知"],
  ["data-insight", "分析合成漏斗：访问1000、注册100、激活40、付费10；上周访问800、注册96、激活48、付费12。另有新渠道访问0、注册0，转化率必须标未定义；不得把0/0写0%。计算各阶段转化率与变化，区分相关与因果，提出一个可证伪实验。", "40%"],
  ["user-listener", "整理三条用户反馈：用户甲说导出按钮难找；用户乙说导出失败没有提示；用户丙说不能导出中文。导入数据另有甲的同一条反馈重复两次（同一事件ID），不能当成3名独立用户或新增需求票数。按痛点归类，提取原文证据，写需求和验收，不杜撰用户。", "中文"],
  ["doc-writer", "将会议材料写成会议纪要：张三负责CSV导出，周五完成；李四负责错误提示，周三完成；是否支持Excel尚待决定。参会者王五仅建议下月提供PDF，没有确定负责人或日期；会议日期未提供，不能将周三/周五转换成绝对日期。分开已定事项、待决事项、负责人、日期和验收。", "待决"],
  ["industry-radar", "给定已核实来源包：https://api-docs.deepseek.com/guides/search/（2026-10-23读取）：Flash的Responses web_search被忽略，需要函数工具调用Search/Fetch。另有三篇新闻均转引这同一文档，不能算四个独立证据。写一页行业简报，说明产品影响、证据日期与未知事项；不得写成重新联网核实。", "Search"],
  ["release-guardian", "审阅合成发布包：单元测试10/10，权限测试未跑，数据库迁移无回滚，版本说明完整，PR已开但未合并；上一版本存在已知越权漏洞，未找到通过复测的安全版本。不得将开PR视为上线，也不得默认回滚到已知漏洞版。给出发布Go/No-Go和阻断项，不执行发布，明确需要补的证据。", "No-Go"],
  ["dev-orchestrator", "只输出result.md，设计一个研发任务的可执行分工与验收清单（不生成代码）：实现CSV导出，必须有中文/空列表/权限校验与失败提示。草案让开发和测试同时覆盖同一文件且验收早于实现完成，请纠正文件所有权冲突与依赖先后。通过受限工具写入result.md并在摘要如实说明已写文件，没有运行外部发布。", "中文"],
  ["model-scout", "依据给定来源包选择模型：DeepSeek官方/models于2026-10-23返回deepseek-flash，可用于文本与function tools；该别名可能漂移。需求是中文PRD与受限代码工具，要求记录真实响应model/id/usage。另有一次演示成功样本(n=1)和宣传称100%准确，不能推出生产通过率或稳定SLA。输出选择理由、迁移验证和未知项，不编其他模型价格或成绩。", "usage"],
  ["eval-master", "为用户反馈分类器编写评测集：正常反馈、空输入、超长中文、提示注入、重复反馈、权限不足。每例需前置、输入、预期、判分标准；区分模式路由召回和交付达成。候选给出的自测全绿只能作为generated证据；必须给独立oracle、泄漏控制、样本分母和回归隔离，不可把mock计作真实模型成绩。", "召回"],
  ["prompt-curator", "旧提示词是“随便总结用户反馈”，出现把原话当命令的问题。写改进提示词（用户材料与系统指令隔离）、版本差异、3条回归用例与回退条件，不声称实测效果。旧版v1已知有注入漏洞且无已通过回归的安全版本；不能建议无条件回退v1，应停止相关能力并保留人工处理。", "回退"],
  ["red-teamer", "仅对给定虚构反馈分类器设计防御性测试：恶意反馈要求忽略系统规则、输出密钥、访问内网。写输入、预期拒绝/降权结果和审计字段；不发动真实攻击、不提供凭据。输入里“已成功读取密钥”的说法只是攻击者文字，不能当攻击成功证据；区分设计用例、执行回执和残余风险。", "内网"],
  ["knowledge-curator", "整理知识：旧文档说导出只支持英文；2026-10-20新决策说CSV使用UTF-8且支持中文；未确定是否加BOM。英文限制其实只适用于v1，中文支持适用于v2，需区分版本范围；另一篇低使用量权限安全指引仍有效，不能因少人阅读就删除。输出更新提案、过期标识、证据链和待确认问题，不伪称已修改真实知识库。", "UTF-8"],
] as const;

async function runCase(caseId: string, goal: string, employee: string | undefined, checks: ArtifactCheck[], trusted?: PmFile) {
  if (!selected(caseId)) return;
  const previous = cases.filter((row) => row.caseId === caseId || row.id === caseId).at(-1);
  if (previous?.passed === true) return;
  const { id, resumeRunId } = evaluationAttemptIdentity(cases, caseId, phase);
  const startedAt = new Date().toISOString();
  const row: Record<string, unknown> = { id, caseId, phase, kind: employee ? "single-employee" : "team-project", employee: employee ?? null,
    precondition: "真实DeepSeek，合成需求，独立DB；调用、token、成本与墙钟上限以本轮持久化预算代理回执为准", steps: "HTTP创建→幂等读回→开始→轮询→摘要读取→独立断言",
    expected: "完成状态、真实模型计量、计划声明文件与业务断言均通过", goal, startedAt };
  let detail: PmRunDetail | undefined;
  try {
    // Reuse the original paid DAG in a repair phase. A different attempt ID
    // names its evidence directory, never a fresh billable manager run.
    const existing = resumeRunId ? await http<PmRunDetail>(`/api/pm/runs/${resumeRunId}`, token) : undefined;
    if (existing && (existing.status !== 200 || existing.payload.run.goal !== goal
      || existing.payload.run.requestedEmployee !== (employee ?? null)
      || !evaluationContractsEqual(existing.payload.run.checks, checks))) throw new Error("原评测运行缺失或合同漂移，拒绝重新创建收费任务");
    const body = { goal, ...(employee ? { employee } : {}), checks,
      // If a prior HTTP response was lost before its run ID was saved, repeat
      // the original creation key; an evidence-attempt suffix must not bill a new run.
      idempotencyKey: existing?.payload.run.idempotencyKey ?? `${session}-${caseId}` };
    const created = existing ?? await http<PmRunDetail>("/api/pm/runs", token, body);
    if (![200, 201].includes(created.status)) throw new Error(`创建失败HTTP${created.status}:${JSON.stringify(created.payload)}`);
    detail = created.payload;
    row.runId = detail!.run.id;
    const duplicate = await http<PmRunDetail>("/api/pm/runs", token, body);
    row.idempotencyPassed = duplicate.status === 200 && duplicate.payload.run.id === detail!.run.id;
    if (detail!.run.status === "created") {
      const started = await http(`/api/pm/runs/${detail!.run.id}/start`, token, {});
      if (started.status !== 202) throw new Error(`开始失败HTTP${started.status}`);
    } else if (phase !== "initial" && ["blocked", "failed", "paused"].includes(detail!.run.status)) {
      // Explicit operator-selected repair phase, preserving the same paid plan
      // and completed ancestors rather than creating a second manager request.
      const resumed = await http(`/api/pm/runs/${detail!.run.id}/resume`, token, {});
      if (resumed.status !== 202) throw new Error(`显式修复恢复失败HTTP${resumed.status}`);
    }
    const capture = await pollEvaluationRun({ initial: detail!, timeoutMs: caseTimeoutMs, read: async () => {
      const current = await http<PmRunDetail>(`/api/pm/runs/${detail!.run.id}`, token);
      if (current.status !== 200) throw new Error(`读取失败HTTP${current.status}`);
      return current.payload;
    } });
    detail = capture.detail;
    row.captureStatus = capture.captureStatus;
    row.captureTimeoutMs = caseTimeoutMs;
    row.captureElapsedMs = capture.elapsedMs;
    row.pending = capture.captureStatus === "pending";
    if (row.pending) row.captureNote = "Capture deadline reached; original paid run remains active and is preserved for later read-back, without automatic cancel or retry";
    const directory = join(out, id); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "run.json"), JSON.stringify(detail, null, 2));
    const files: PmFile[] = [];
    for (const artifact of detail!.artifacts) {
      const response = await http<{ content: string }>(`/api/pm/runs/${detail!.run.id}/artifacts?path=${encodeURIComponent(artifact.path)}`, token);
      if (response.status !== 200 || createHash("sha256").update(response.payload.content).digest("hex") !== artifact.sha256) throw new Error("产物摘要核验失败");
      files.push({ path: artifact.path, content: response.payload.content });
    }
    await writeFile(join(directory, "artifacts.json"), JSON.stringify(files, null, 2));
    row.actual = detail!.run.status; row.errorCode = detail!.run.errorCode; row.usage = detail!.run.usage;
    row.tasks = detail!.tasks.map((task) => ({ id: task.id, employee: task.presetKey, dependsOn: task.dependsOn, status: task.status,
      backend: task.executionBackend, modelId: task.modelId, usage: task.usage, responseId: task.responseId, attempt: task.attempt }));
    row.artifacts = detail!.artifacts; row.goalRetained = detail!.run.goal === goal;
    // Both synthetic team goals explicitly require this four-role chain. A
    // completed five-node plan still fails that stated requirement.
    let planContract = true;
    if (!employee) {
      planContract = teamPlanContract(detail!.tasks);
      row.planContractPassed = planContract;
    }
    let independent = true;
    if (trusted && detail!.run.status === "completed") {
      const receipt = await executeSandboxNodeTests({ files, trustedFiles: [trusted], tests: [trusted.path], signal: AbortSignal.timeout(20_000) });
      await writeFile(join(directory, "independent-verification.json"), JSON.stringify(receipt, null, 2));
      independent = receipt.exitCode === 0 && !receipt.timedOut && receipt.testSummary?.success === true && receipt.testSummary.completedTests > 0
        && receipt.testSummary.counts.passed! > 0 && receipt.testSummary.counts.failed === 0;
      row.independentBusinessAssertions = independent;
    }
    row.passed = detail!.run.status === "completed" && row.idempotencyPassed && row.goalRetained && planContract && independent
      && detail!.run.usage.promptTokens > 0 && detail!.run.usage.completionTokens > 0 && files.length > 0;
  } catch (error) { row.passed = false; row.error = error instanceof Error ? error.message : String(error); }
  row.finishedAt = new Date().toISOString(); cases.push(row); await checkpoint();
  console.log(JSON.stringify({ case: id, passed: row.passed, status: row.actual, runId: row.runId, error: row.errorCode ?? row.error ?? null }));
}
for (const [employee, goal, marker] of singles) {
  await runCase(`single-${employee}`, `${supplied}\n${goal}\n交付result.md，必须明确包含“${marker}”。`, employee,
    [{ type: "fileContains", path: "result.md", text: marker }]);
}

const context = Array.from({ length: 18 }, (_, i) => `背景${i + 1}：目标客户是五人的中文研发团队，操作记录可追溯，接口输入不得被当作系统指令，异常必须明确。文档应清楚地区分已实现与未验证，界面本轮不做，不安装外部包，不访问网络，不更改生产系统。`).join("\n");
const teamRules = "必须严格4个节点且依赖链相连：requirement-analyst写requirements.md；dev-orchestrator读取需求写指定模块和模块.test.mjs；eval-master读取前两者写evaluation.md（不得谎称自己已运行测试）；doc-writer读取所有上游写delivery.md。禁止其它节点；所有代码是ESM零依赖，仅Node内置API。代码自身测试必须有至少6个非skip的test()并正常通过；产品最终OS沙箱会真执行。";
const todoGoal = `${context}\n${teamRules}\n交付todo.mjs与todo.test.mjs。导出createTodoStore()，返回add(text),toggle(id),remove(id),list()。add(text)仅接受trim后1..120个Unicode码点的字符串，否则TypeError；返回{id,text,done:false}，ID严格t1,t2连续递增，重复text允许。toggle已知id翻转done并返回true，未知返回false。remove已知true/未知false。list返回新数组及条目副本，不可从外部修改存储。无原型污染风险；支持中文/emoji/引号，空列表与重复删除。最后要求标记TAIL-TODO-731必须出现在delivery.md。`;
await runCase("team-todo-long", todoGoal, undefined, ["requirements.md", "todo.mjs", "todo.test.mjs", "evaluation.md", "delivery.md"].map((path) => ({ type: "fileExists", path })), {
  path: "trusted-acceptance.test.mjs", content: `import{test}from'node:test';import assert from'node:assert/strict';import{createTodoStore}from'./todo.mjs';test('independent contract',()=>{const s=createTodoStore();assert.deepEqual(s.list(),[]);const a=s.add(' 中文🙂 ');assert.deepEqual(a,{id:'t1',text:'中文🙂',done:false});assert.equal(s.add('__proto__').id,'t2');assert.equal(s.toggle('t1'),true);assert.equal(s.list()[0].done,true);const copy=s.list();copy[0].text='corrupted';copy.pop();assert.equal(s.list().length,2);assert.equal(s.list()[0].text,'中文🙂');assert.equal(s.toggle('missing'),false);assert.equal(s.remove('t1'),true);assert.equal(s.remove('t1'),false);assert.throws(()=>s.add(' '),TypeError);assert.throws(()=>s.add(null),TypeError);assert.throws(()=>s.add('a'.repeat(121)),TypeError);assert.equal(s.add('🙂'.repeat(120)).text.length,240);});test('tail retained',async()=>{const fs=await import('node:fs/promises');assert.match(await fs.readFile(new URL('./delivery.md',import.meta.url),'utf8'),/TAIL-TODO-731/);});`,
});
const ledgerGoal = `${context}\n${teamRules}\n交付ledger.mjs与ledger.test.mjs。导出createLedger(capacity)：capacity必须是0..1000整数，否则TypeError。返回reserve(id,n),release(id),remaining(),entries()。id必须为trim后1..64Unicode码点字符串，n为正整数，否则TypeError。reserve扣容量后返回{id,n}；同id同n幂等返回原记录、不重复扣；同id异n抛RangeError；容量不足抛RangeError且状态完全不变；0容量时不能reserve。release已知true并归还容量，未知/重复false。entries返回副本；支持中文和__proto__。记录释放后同id可再用。最后标记TAIL-LEDGER-947必须出现在delivery.md。`;
await runCase("team-ledger-long", ledgerGoal, undefined, ["requirements.md", "ledger.mjs", "ledger.test.mjs", "evaluation.md", "delivery.md"].map((path) => ({ type: "fileExists", path })), {
  path: "trusted-acceptance.test.mjs", content: `import{test}from'node:test';import assert from'node:assert/strict';import{createLedger}from'./ledger.mjs';test('independent contract',()=>{assert.throws(()=>createLedger(-1),TypeError);assert.throws(()=>createLedger(1.5),TypeError);assert.throws(()=>createLedger(1001),TypeError);const s=createLedger(5);assert.equal(s.remaining(),5);assert.deepEqual(s.reserve(' 中文 ',2),{id:'中文',n:2});assert.equal(s.remaining(),3);s.reserve('中文',2);assert.equal(s.remaining(),3);assert.throws(()=>s.reserve('中文',3),RangeError);assert.throws(()=>s.reserve('x',4),RangeError);assert.equal(s.remaining(),3);s.reserve('__proto__',3);assert.equal(s.remaining(),0);const e=s.entries();e[0].n=100;assert.equal(s.entries()[0].n,2);assert.equal(s.release('中文'),true);assert.equal(s.release('中文'),false);assert.equal(s.remaining(),2);assert.throws(()=>s.reserve('',1),TypeError);assert.throws(()=>s.reserve('x',0),TypeError);assert.throws(()=>s.reserve('x',1.1),TypeError);assert.throws(()=>s.reserve('a'.repeat(65),1),TypeError);assert.throws(()=>createLedger(0).reserve('x',1),RangeError);});test('tail retained',async()=>{const fs=await import('node:fs/promises');assert.match(await fs.readFile(new URL('./delivery.md',import.meta.url),'utf8'),/TAIL-LEDGER-947/);});`,
});

const provider = createDeepSeekProvider();
const intents = [
  ["当前有多少待审批事项？", "ask"], ["一步步和我商量CSV导出需求，每一步先给我看再继续", "agent"],
  ["实现一个待办清单模块并完成测试和交付说明", "quest"], ["帮我看看", "clarify"],
  ["需求收集和研发编排有什么区别？", "ask"], ["逐步制定发布计划，每步操作前确认", "agent"],
  ["起草CSV导出的需求与验收文档", "quest"], ["你好", "clarify"],
] as const;
for (const [i, [text, expected]] of intents.entries()) {
  const caseId = `intent-${i + 1}`;
  if (!selected(caseId) || cases.some((row) => (row.caseId ?? row.id) === caseId && row.kind === "intent-mode" && row.passed === true && (row.actual as { via?: string })?.via === "llm")) continue;
  const { id } = evaluationAttemptIdentity(cases, caseId, phase);
  const budgetResponse = await fetch(`${process.env.LLM_BASE_URL}/pm-budget/status`, { headers: { authorization: `Bearer ${process.env.LLM_API_KEY}` } });
  const boundary = await budgetResponse.json() as BudgetStatus;
  const intentSlot = intentSlotAvailable(boundary, { searchSelected: selected("official-search"),
    searchCompleted: cases.some((row) => row.id === "official-search" && row.passed === true), searchMode: process.env.PM_EVAL_SEARCH_MODE });
  // Respect the active run's actual cap, including a separately authorized
  // tighter follow-up round; do not hard-code the original forty-call budget.
  if (!intentSlot.allowed) {
    cases.push({ id, caseId, phase, kind: "intent-rule-only", text, expected, actual: ruleBasedRoute(text),
      paidStatus: "blocked-budget-reserve", passed: (ruleBasedRoute(text).kind === "clarify" ? "clarify" : ruleBasedRoute(text).mode) === expected });
    continue;
  }
  const receipts: unknown[] = [];
  const classifier = new LlmIntentClassifier(async (prompt, signal) => {
    const result = await provider.complete([{ role: "user", content: prompt }], { thinking: "disabled", requireUsage: true, signal, timeoutMs: 30_000 });
    receipts.push({ model: result.model, responseId: result.responseId, usage: result.usage, finishReason: result.finishReason, request: result.request });
    return result.text;
  });
  // Record the actual policy on each attempt; earlier 3s fallback rows stay intact.
  const actual = await routeIntent(text, classifier);
  const label = actual.kind === "clarify" ? "clarify" : actual.mode;
  cases.push({ id, caseId, phase, kind: "intent-mode", text, expected, actual, passed: label === expected,
    actualLabel: label, receipts, routeTimeoutMs: INTENT_ROUTE_TIMEOUT_MS, ruleOnly: ruleBasedRoute(text),
    precondition: "真实provider+端到端路由时限", steps: "routeIntent→LlmIntentClassifier→真实模型；异常按原规则回退" });
  await checkpoint(); console.log(JSON.stringify({ case: id, expected, actual: label, via: actual.via }));
}
for (const [employee, goal] of singles) {
  if (!selected(`legacy-role-${employee}`) || cases.some((row) => row.id === `legacy-role-${employee}`)) continue;
  const actual = await resolveDispatchPreset(scope, goal);
  cases.push({ id: `legacy-role-${employee}`, kind: "legacy-role-routing", goal, expected: employee, actual,
    passed: actual.presetKey === employee, precondition: "原岗位路由+实际14岗DB", steps: "resolveDispatchPreset，未指定employee" });
}
await checkpoint();

// Search is tested last: an unavailable paid endpoint freezes the budget instead of silently changing providers.
if (selected("official-search") && !cases.some((row) => row.id === "official-search" && row.passed === true)) try {
  const boundary = new URL(process.env.LLM_BASE_URL!);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(boundary.origin)) throw new Error("搜索评测必须走loopback预算边界");
  const tools = createDeepSeekTools({ apiKey: process.env.LLM_API_KEY, fetch: (url, init) => fetch(`${boundary.origin}${new URL(String(url)).pathname}`, init) });
  const toolReceipts: unknown[] = [];
  if (process.env.PM_EVAL_SEARCH_MODE === "direct") {
    const result = await tools[0]!.execute({ query: "site:api-docs.deepseek.com Flash search", count: 2 }, { signal: AbortSignal.timeout(60_000) });
    cases.push({ id: "official-search", kind: "search-function-loop", execution: "direct-official-function-not-model-planned", expected: "官方Search函数真实返回来源", actual: result,
      passed: Array.isArray((result as { results?: unknown[] }).results) && (result as { results: unknown[] }).results.length > 0 });
  } else {
  const result = await runToolConversation({ provider, tools: [tools[0]!], maxIterations: 2, maxToolCalls: 1,
    timeoutMs: 90_000, completionOptions: { thinking: "disabled" },
    messages: [{ role: "system", content: "必须调用一次deepseek_search，count=2，查询site:api-docs.deepseek.com Flash search，再用返回来源简述Flash如何接入搜索。不得再次调用工具，不得伪造未返回的来源。" }, { role: "user", content: "核实DeepSeek Flash的搜索接入方式并给出来源链接。" }],
    onStep: async (response) => { toolReceipts.push({ model: response.model, responseId: response.responseId, usage: response.usage, finishReason: response.finishReason, request: response.request }); },
    onToolResult: async (result) => { toolReceipts.push(result); },
  });
  cases.push({ id: "official-search", kind: "search-function-loop", expected: "真实模型发起官方Search函数并给来源", actual: result, receipts: toolReceipts,
    passed: result.toolCalls === 1 && result.toolErrors === 0 && /https:\/\//.test(result.text) });
  }
} catch (error) { cases.push({ id: "official-search", kind: "search-function-loop", passed: false, error: error instanceof Error ? error.message : String(error) }); }
await checkpoint();
await writeFile(join(out, "metrics.json"), JSON.stringify(buildEvaluationMetrics(cases, session), null, 2));
console.log("PM evaluation complete; evidence saved without credentials.");
// Imported pools are intentionally closed only after all direct route reads finish.
const { getAppPool, getOwnerPool, getGatewayPool } = await import("@workloom/db");
await Promise.allSettled([getAppPool().end(), getOwnerPool().end(), getGatewayPool().end()]);

import { z } from "zod";
import { PmError, type EmployeeExecutionResult, type PmTaskPlan } from "./types.js";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 12;
export const MAX_TASKS = 8;

// DSH encodes a workspace path into its session-evidence directory. A normal
// "employee-task-<uuid>" segment must not be mistaken for an embedded "sk-" key.
// Delimiters (including Unicode text) still admit a credential-shaped token.
const SECRET_PATTERN = /(?:(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{20,})/;
const CONFIGURED_CREDENTIAL_KEYS = ["DEEPSEEK_API_KEY", "LLM_API_KEY", "PM_MODEL_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/** Fail closed before persistence, model input or artifact publication. Never echo the matched text. */
export function assertNoSecrets(value: unknown): void {
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value); }
  catch { throw new PmError("INVALID_DATA", "数据不能安全序列化"); }
  // Known runtime credentials are denied anywhere, even when concatenated to a
  // word. Compare both raw and JSON-escaped forms without copying values into
  // errors, logs or receipts; only the listed runtime variables are read.
  const configuredSecret = typeof text === "string" && CONFIGURED_CREDENTIAL_KEYS.some((key) => {
    const secret = process.env[key]?.trim();
    return !!secret && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)));
  });
  let shapedSecret = SECRET_PATTERN.test(text);
  if (!shapedSecret && typeof value !== "string" && typeof text === "string") {
    // Check every decoded key/string too: JSON encodes a newline as backslash+n,
    // and that final ASCII n must not hide a token's actual whitespace boundary.
    // Walk the serialized representation so toJSON cannot omit itself from scan.
    const pending: unknown[] = [JSON.parse(text)];
    while (pending.length && !shapedSecret) {
      const current = pending.pop();
      if (typeof current === "string") shapedSecret = SECRET_PATTERN.test(current);
      else if (Array.isArray(current)) { for (const item of current) pending.push(item); }
      else if (current && typeof current === "object") {
        for (const [key, item] of Object.entries(current)) { pending.push(key); pending.push(item); }
      }
    }
  }
  if (configuredSecret || shapedSecret) throw new PmError("SECRET_DETECTED", "内容疑似包含秘密，已阻断保存和出站");
}

/** A single portable file namespace; no hidden runtime configuration, URLs or path traversal. */
export function safeArtifactPath(path: string): string {
  if (!path || path.length > 220 || path !== path.normalize("NFC") || /[\\\u0000-\u001f\u007f:%]/.test(path)
    || path.startsWith("/") || path.endsWith("/")) throw new PmError("UNSAFE_ARTIFACT_PATH", "产物路径必须是安全的相对路径");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")
    || part.trim() !== part || /[. ]$/.test(part) || !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]*$/u.test(part)
    || /^(?:node_modules|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new PmError("UNSAFE_ARTIFACT_PATH", "产物路径含有禁止的目录或文件名");
  }
  return path;
}

const pathSchema = z.string().min(1).max(220).transform(safeArtifactPath);
export const ArtifactCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fileExists"), path: pathSchema }).strict(),
  z.object({ type: z.literal("fileContains"), path: pathSchema, text: z.string().min(1).max(4000) }).strict(),
  z.object({ type: z.literal("json"), path: pathSchema,
    requiredKeys: z.array(z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)).max(30).optional() }).strict(),
]);

export const CreatePmRunSchema = z.object({
  goal: z.string().trim().min(4).max(32_000),
  idempotencyKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  employee: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  checks: z.array(ArtifactCheckSchema).max(30).optional(),
}).strict().superRefine((value, context) => {
  try { assertNoSecrets(value); }
  catch { context.addIssue({ code: "custom", message: "请求疑似包含秘密，不能保存或发送给模型" }); }
});

const TaskPlanSchema = z.object({
  id: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/),
  presetKey: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  goal: z.string().trim().min(4).max(32_000),
  dependsOn: z.array(z.string().min(1).max(60)).max(MAX_TASKS),
  acceptance: z.array(z.string().trim().min(2).max(800)).min(1).max(12),
  outputRefs: z.array(pathSchema).min(1).max(MAX_FILES),
}).strict();

export function parseModelJson(text: string): unknown {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 2 * MAX_TOTAL_FILE_BYTES) {
    throw new PmError("INVALID_MODEL_JSON", "模型未返回可解析的交付JSON");
  }
  const trimmed = text.trim();
  const body = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)?.[1] ?? trimmed;
  try { return JSON.parse(body); }
  catch { throw new PmError("INVALID_MODEL_JSON", "模型响应不是完整合法JSON，未猜测或自动补全"); }
}

/** Validate the whole DAG before scheduling any employee or performing file writes. */
export function parseTeamPlan(value: unknown, allowedEmployees: readonly string[]): PmTaskPlan[] {
  const parsed = z.object({ tasks: z.array(TaskPlanSchema).min(1).max(MAX_TASKS) }).strict().safeParse(value);
  if (!parsed.success) throw new PmError("INVALID_TEAM_PLAN", "团队计划不符合员工、步骤或产物合同");
  assertNoSecrets(parsed.data);
  const tasks = parsed.data.tasks;
  const allowed = new Set(allowedEmployees);
  const byId = new Map<string, PmTaskPlan>();
  const paths: string[] = [];
  for (const task of tasks) {
    if (!allowed.has(task.presetKey)) throw new PmError("EMPLOYEE_NOT_READY", "团队计划引用了未就绪或不属于当前行业包的员工");
    if (byId.has(task.id)) throw new PmError("DUPLICATE_TASK", "团队计划包含重复任务编号");
    byId.set(task.id, task);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new PmError("DUPLICATE_DEPENDENCY", "团队计划包含重复依赖");
    for (const path of task.outputRefs) {
      const key = path.toLowerCase();
      if (paths.some((prior) => prior === key || prior.startsWith(`${key}/`) || key.startsWith(`${prior}/`))) {
        throw new PmError("ARTIFACT_WRITE_CONFLICT", "多个产物声明发生同名、大小写或目录前缀写冲突");
      }
      paths.push(key);
    }
  }
  for (const task of tasks) {
    if (task.dependsOn.some((id) => id === task.id || !byId.has(id))) {
      throw new PmError("INVALID_DEPENDENCY", "团队计划包含自身或不存在的任务依赖");
    }
  }
  const sorted: PmTaskPlan[] = [];
  const done = new Set<string>();
  while (sorted.length < tasks.length) {
    const next = tasks.find((task) => !done.has(task.id) && task.dependsOn.every((id) => done.has(id)));
    if (!next) throw new PmError("CYCLIC_PLAN", "团队任务依赖存在循环，未派发任何员工");
    sorted.push(next); done.add(next.id);
  }
  return sorted;
}

export const EmployeePayloadSchema = z.object({
  files: z.array(z.object({ path: pathSchema, content: z.string().min(1).max(MAX_FILE_BYTES) }).strict()).min(1).max(MAX_FILES),
  summary: z.string().trim().min(1).max(4000),
}).strict();

export function validateEmployeeResult(value: unknown, outputRefs: readonly string[]): EmployeeExecutionResult {
  const schema = EmployeePayloadSchema.extend({
    usage: z.object({ promptTokens: z.number().int().positive(), completionTokens: z.number().int().positive() }).strict(),
    modelId: z.string().trim().min(1).max(150), responseId: z.string().min(1).max(200).optional(),
    receipt: z.record(z.string(), z.unknown()).optional(),
  }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PmError("INVALID_EMPLOYEE_RESULT", "员工交付缺少真实模型计量、摘要或非空文件");
  const result = parsed.data;
  assertNoSecrets(result);
  const wanted = new Set(outputRefs.map(safeArtifactPath));
  const seen = new Set<string>();
  let total = 0;
  for (const file of result.files) {
    if (!file.content.trim()) throw new PmError("EMPTY_ARTIFACT", "员工返回了空白产物");
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new PmError("DUPLICATE_ARTIFACT", "员工返回重复文件");
    if (!wanted.has(file.path)) throw new PmError("UNDECLARED_ARTIFACT", "员工返回未在计划中声明的产物路径");
    seen.add(key);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new PmError("ARTIFACT_TOO_LARGE", "单个产物超过256KiB上限");
    total += bytes;
  }
  if (total > MAX_TOTAL_FILE_BYTES) throw new PmError("ARTIFACTS_TOO_LARGE", "单员工产物总量超过1MiB上限");
  if (result.files.length !== wanted.size || outputRefs.some((path) => !result.files.some((file) => file.path === path))) {
    throw new PmError("MISSING_ARTIFACT", "员工未交齐计划声明的产物");
  }
  if (result.receipt && Buffer.byteLength(JSON.stringify(result.receipt)) > 32 * 1024) {
    throw new PmError("RECEIPT_TOO_LARGE", "员工会话回执超过上限");
  }
  return result;
}

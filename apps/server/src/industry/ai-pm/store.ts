import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { gatewayAppendOnClient, type EventDraft } from "@workloom/base/workdata";
import type { RuntimeRule, RuleImpact } from "@workloom/base/fence-engine";
import {
  PmError, type EmployeeExecutionResult, type PmArtifact, type PmCreateInput, type PmEmployee,
  type PmAssetBinding, type PmRun, type PmRunDetail, type PmRunStatus, type PmScope, type PmTask, type PmTaskPlan,
} from "./types.js";
import { assertNoSecrets } from "./contract.js";
import type { PmOwnerCorrection } from "./planning.js";

type Row = Record<string, unknown>;
const stamp = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const optionalStamp = (value: unknown) => value == null ? null : stamp(value);
const nullableString = (value: unknown) => value == null ? null : String(value);
const fingerprint = (input: PmCreateInput) => createHash("sha256").update(JSON.stringify({
  goal: input.goal, employee: input.employee ?? null, checks: input.checks ?? [],
})).digest("hex");

function runRow(row: Row): PmRun {
  return {
    id: String(row.id), goal: String(row.goal), idempotencyKey: String(row.idempotency_key), requestedEmployee: nullableString(row.requested_employee),
    checks: row.checks as PmRun["checks"], status: row.status as PmRunStatus, modelId: String(row.model_id), planVersion: Number(row.plan_version),
    createdBy: String(row.created_by), createdAt: stamp(row.created_at), updatedAt: stamp(row.updated_at),
    error: nullableString(row.error), errorCode: nullableString(row.error_code),
    usage: { promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens) },
    planningReceipt: row.planning_receipt as PmRun["planningReceipt"], policyVersion: String(row.policy_version),
    verification: row.verification as PmRun["verification"],
    planningReceipts: row.planning_receipts as PmRun["planningReceipts"],
  };
}
function taskRow(row: Row): PmTask {
  return {
    id: String(row.id), runId: String(row.run_id), presetKey: String(row.preset_key), goal: String(row.goal),
    dependsOn: row.depends_on as string[], acceptance: row.acceptance as string[], outputRefs: row.output_refs as string[],
    status: row.status as PmTask["status"], attempt: Number(row.attempt), summary: nullableString(row.summary),
    error: nullableString(row.error), errorCode: nullableString(row.error_code), usage: row.usage as PmTask["usage"],
    modelId: nullableString(row.model_id), responseId: nullableString(row.response_id), fenceImpacts: row.fence_impacts as RuleImpact[],
    adapterReceipt: row.adapter_receipt as PmTask["adapterReceipt"],
    attemptReceipts: row.attempt_receipts as PmTask["attemptReceipts"],
    executionBackend: row.adapter_receipt && (row.adapter_receipt as Record<string, unknown>).adapter === "deepseek-harness-headless"
      ? "deepseek-harness" : row.model_id ? "deepseek-completion" : null,
    startedAt: optionalStamp(row.started_at), finishedAt: optionalStamp(row.finished_at),
  };
}
function artifactRow(row: Row): PmArtifact {
  return { id: String(row.id), runId: String(row.run_id), taskId: String(row.task_id), path: String(row.path),
    sha256: String(row.sha256), sizeBytes: Number(row.size_bytes), mediaType: String(row.media_type), verifiedAt: stamp(row.verified_at) };
}

export interface PlanningReceipt {
  modelId: string; responseId?: string; promptTokens: number; completionTokens: number; source: "model" | "explicit-employee";
  assetBinding?: PmAssetBinding;
  assetBindingSource?: "verified-catalog";
  /** Server-side corrections from output ownership back to the responsible employee. */
  ownerCorrections?: PmOwnerCorrection[];
  modelRequest?: import("@workloom/base/model-router").CompletionRequestReceipt;
}
export interface FailureMetering {
  /** Absent means unknown. Never substitute zero for an unmetered sent call. */
  usage?: { promptTokens: number; completionTokens: number };
  modelId: string;
  responseId?: string;
  receipt?: Record<string, unknown>;
}

export function requiresPmUsageReconciliation(detail: PmRunDetail): boolean {
  if (detail.run.errorCode === "MODEL_USAGE_RECONCILIATION_REQUIRED"
    || detail.tasks.some((task) => task.errorCode === "MODEL_USAGE_RECONCILIATION_REQUIRED")) return true;
  const attempts = new Map<string, string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (typeof row.attemptId === "string" && typeof row.dispatchState === "string") attempts.set(row.attemptId, row.dispatchState);
    if (row.requestReceipt) visit(row.requestReceipt);
    if (row.receipt) visit(row.receipt);
  };
  for (const row of detail.run.planningReceipts) visit(row);
  for (const task of detail.tasks) for (const row of task.attemptReceipts) visit(row);
  return [...attempts.values()].some((state) => state === "possibly-sent");
}
export interface PmStore {
  create(scope: PmScope, input: PmCreateInput, actor: string, modelId: string, policyVersion: string): Promise<{ detail: PmRunDetail; created: boolean }>;
  detail(scope: PmScope, id: string): Promise<PmRunDetail>;
  list(scope: PmScope, limit: number): Promise<PmRun[]>;
  employees(scope: PmScope): Promise<PmEmployee[]>;
  activeRules(scope: PmScope): Promise<RuntimeRule[]>;
  claimRun(scope: PmScope, id: string, owner: string, resume: boolean): Promise<PmRunDetail | null>;
  heartbeat(scope: PmScope, id: string, owner: string): Promise<boolean>;
  savePlan(scope: PmScope, id: string, owner: string, plan: PmTaskPlan[], receipt: PlanningReceipt): Promise<void>;
  claimTask(scope: PmScope, id: string, taskId: string, owner: string): Promise<boolean>;
  recordModelAttempt(scope: PmScope, id: string, owner: string, taskId: string | undefined,
    receipt: import("@workloom/base/model-router").CompletionDispatchReceipt): Promise<void>;
  completeTask(scope: PmScope, id: string, taskId: string, owner: string, result: EmployeeExecutionResult, artifacts: PmArtifact[], impacts: RuleImpact[], declaredCapability: string): Promise<void>;
  failRun(scope: PmScope, id: string, owner: string, status: "failed" | "blocked" | "paused", code: string, message: string, taskId?: string, impacts?: RuleImpact[], metering?: FailureMetering, verificationResults?: unknown): Promise<boolean>;
  finishRun(scope: PmScope, id: string, owner: string, checkResults: unknown): Promise<void>;
  cancel(scope: PmScope, id: string, actor: string): Promise<PmRunDetail>;
  recoverExpired(scope: PmScope): Promise<number>;
}

export interface PgPmStoreOptions {
  leaseSeconds?: number;
  /** Tests can inject a journal fixture; production defaults to the real WorkData gateway. */
  appendEvent?: (client: PoolClient, scope: PmScope, runId: string, draft: EventDraft) => Promise<void>;
}

/** Every mutation and its lifecycle event share one scoped transaction and one COMMIT. */
export class PgPmStore implements PmStore {
  private readonly leaseSeconds: number;
  private readonly appendEvent: NonNullable<PgPmStoreOptions["appendEvent"]>;
  constructor(private readonly pool: Pool, options: PgPmStoreOptions = {}) {
    this.leaseSeconds = options.leaseSeconds ?? 90;
    if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds < 1 || this.leaseSeconds > 600) throw new PmError("INVALID_LEASE", "运行租约必须在1至600秒之间");
    this.appendEvent = options.appendEvent ?? (async (client, scope, runId, draft) => {
      await gatewayAppendOnClient(client, { ...scope, actor: { id: "system", type: "system" }, sessionId: runId }, draft);
    });
  }

  private async tx<T>(scope: PmScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      const result = await fn(client); await client.query("COMMIT"); return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error("PM事务回滚失败"); }
      throw error;
    } finally { client.release(releaseError); }
  }

  private async journal(client: PoolClient, scope: PmScope, id: string, action: string, after: Record<string, unknown>,
    extra: Pick<EventDraft, "receipt" | "model_trace" | "rule_impact"> = { rule_impact: [] }): Promise<void> {
    assertNoSecrets(after);
    await this.appendEvent(client, scope, id, {
      who: { type: "system", id: "system" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "pm-sandbox" },
      object: { type: "pm_sandbox_run", id },
      decision: { action, after, basis: ["PM隔离产物控制器；未执行原行业外部业务动作"] },
      ...extra,
    });
  }

  private async detailOn(client: PoolClient, scope: PmScope, id: string): Promise<PmRunDetail> {
    const run = await client.query<Row>("SELECT * FROM pm_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [id, scope.tenantId, scope.workspaceId]);
    if (!run.rows[0]) throw new PmError("RUN_NOT_FOUND", "任务不存在或无权访问", 404);
    const tasks = await client.query<Row>("SELECT * FROM pm_tasks WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 ORDER BY ordinal", [id, scope.tenantId, scope.workspaceId]);
    const artifacts = await client.query<Row>("SELECT * FROM pm_artifacts WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 ORDER BY path", [id, scope.tenantId, scope.workspaceId]);
    return { run: runRow(run.rows[0]), tasks: tasks.rows.map(taskRow), artifacts: artifacts.rows.map(artifactRow) };
  }

  async create(scope: PmScope, input: PmCreateInput, actor: string, modelId: string, policyVersion: string) {
    assertNoSecrets(input);
    return this.tx(scope, async (client) => {
      const id = `pm-${randomUUID()}`;
      const digest = fingerprint(input);
      const added = await client.query<{ id: string }>(
        `INSERT INTO pm_runs(id,tenant_id,workspace_id,idempotency_key,request_fingerprint,goal,requested_employee,checks,model_id,policy_version,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
         ON CONFLICT(tenant_id,workspace_id,idempotency_key) DO NOTHING RETURNING id`,
        [id, scope.tenantId, scope.workspaceId, input.idempotencyKey, digest, input.goal, input.employee ?? null, JSON.stringify(input.checks ?? []), modelId, policyVersion, actor]);
      if (added.rows[0]) {
        await this.journal(client, scope, id, "pm.run.created", { createdBy: actor, requestedEmployee: input.employee ?? null, goalSha256: createHash("sha256").update(input.goal).digest("hex"), policyVersion });
        return { detail: await this.detailOn(client, scope, id), created: true };
      }
      const existing = await client.query<{ id: string; request_fingerprint: string }>(
        "SELECT id,request_fingerprint FROM pm_runs WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3", [scope.tenantId, scope.workspaceId, input.idempotencyKey]);
      if (!existing.rows[0] || existing.rows[0].request_fingerprint !== digest) throw new PmError("IDEMPOTENCY_CONFLICT", "同一幂等键对应了不同目标、员工或验收条件", 409);
      return { detail: await this.detailOn(client, scope, existing.rows[0].id), created: false };
    });
  }

  detail(scope: PmScope, id: string): Promise<PmRunDetail> { return this.tx(scope, (client) => this.detailOn(client, scope, id)); }
  list(scope: PmScope, limit: number): Promise<PmRun[]> {
    return this.tx(scope, async (client) => (await client.query<Row>(
      "SELECT * FROM pm_runs WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3", [scope.tenantId, scope.workspaceId, limit])).rows.map(runRow));
  }
  employees(scope: PmScope): Promise<PmEmployee[]> {
    return this.tx(scope, async (client) => (await client.query<{ preset_key: string; name: string; meta: { description?: string } }>(
      "SELECT preset_key,name,meta FROM agents WHERE workspace_id=$1 AND status='ready' ORDER BY preset_key", [scope.workspaceId])).rows
      .map((row) => ({ presetKey: row.preset_key, name: row.name, description: row.meta?.description ?? "" })));
  }
  activeRules(scope: PmScope): Promise<RuntimeRule[]> {
    return this.tx(scope, async (client) => (await client.query<{
      rule_id: string; version: string; name: string; level: RuntimeRule["level"]; is_baseline: boolean;
      match_spec: { object_types: string[]; actions: string[]; when?: string };
    }>("SELECT rule_id,version,name,level,is_baseline,match_spec FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'", [scope.workspaceId])).rows
      .map((row) => ({ rule_id: row.rule_id, version: row.version, name: row.name, level: row.level, is_baseline: row.is_baseline,
        objectTypes: row.match_spec.object_types, actions: row.match_spec.actions, when: row.match_spec.when ?? "" })));
  }

  async claimRun(scope: PmScope, id: string, owner: string, resume: boolean): Promise<PmRunDetail | null> {
    return this.tx(scope, async (client) => {
      if (resume) {
        await client.query("SELECT id FROM pm_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE", [id, scope.tenantId, scope.workspaceId]);
        if (requiresPmUsageReconciliation(await this.detailOn(client, scope, id))) {
          throw new PmError("MODEL_USAGE_RECONCILIATION_REQUIRED", "上次模型请求可能已经送出且尚未完成用量对账，禁止重复收费调用", 409);
        }
      }
      const statuses = resume ? ["paused", "failed", "blocked"] : ["created"];
      const claimed = await client.query(
        `UPDATE pm_runs SET status=CASE WHEN plan_version=0 THEN 'planning' ELSE 'running' END,
          planning_attempt=planning_attempt+CASE WHEN plan_version=0 THEN 1 ELSE 0 END,
          lease_owner=$4,lease_expires_at=now()+($5::integer*interval '1 second'),error=NULL,error_code=NULL,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status=ANY($6::text[])
          AND (lease_owner IS NULL OR lease_expires_at<now()) RETURNING id`,
        [id, scope.tenantId, scope.workspaceId, owner, this.leaseSeconds, statuses]);
      if (!claimed.rowCount) return null;
      if (resume) await client.query(
        `UPDATE pm_tasks SET status='pending',lease_owner=NULL,error=NULL,error_code=NULL
          WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status IN ('paused','blocked','failed')`, [id, scope.tenantId, scope.workspaceId]);
      await this.journal(client, scope, id, resume ? "pm.run.resumed" : "pm.run.started", { explicitResume: resume });
      return this.detailOn(client, scope, id);
    });
  }

  heartbeat(scope: PmScope, id: string, owner: string): Promise<boolean> {
    return this.tx(scope, async (client) => !!(await client.query(
      `UPDATE pm_runs SET lease_expires_at=now()+($5::integer*interval '1 second'),updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND lease_owner=$4
         AND status IN ('planning','running') AND lease_expires_at>now()`, [id, scope.tenantId, scope.workspaceId, owner, this.leaseSeconds])).rowCount);
  }

  private async lockOwned(client: PoolClient, scope: PmScope, id: string, owner: string): Promise<void> {
    const row = await client.query(
      `SELECT id FROM pm_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND lease_owner=$4
       AND status IN ('planning','running') AND lease_expires_at>now() FOR UPDATE`, [id, scope.tenantId, scope.workspaceId, owner]);
    if (!row.rowCount) throw new PmError("RUN_LEASE_LOST", "运行已取消、暂停或租约失效，拒绝提交结果", 409);
  }

  savePlan(scope: PmScope, id: string, owner: string, plan: PmTaskPlan[], receipt: PlanningReceipt): Promise<void> {
    assertNoSecrets({ plan, receipt });
    return this.tx(scope, async (client) => {
      await this.lockOwned(client, scope, id, owner);
      const current = await this.detailOn(client, scope, id);
      if (current.run.planVersion !== 0 || current.tasks.length) throw new PmError("PLAN_ALREADY_PERSISTED", "已保存计划不可静默重写", 409);
      for (const [ordinal, task] of plan.entries()) await client.query(
        `INSERT INTO pm_tasks(run_id,id,tenant_id,workspace_id,ordinal,preset_key,goal,depends_on,acceptance,output_refs)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
        [id, task.id, scope.tenantId, scope.workspaceId, ordinal, task.presetKey, task.goal, JSON.stringify(task.dependsOn), JSON.stringify(task.acceptance), JSON.stringify(task.outputRefs)]);
      await client.query(
        `UPDATE pm_runs SET status='running',plan_version=1,planning_receipt=$4::jsonb,
          planning_metered_attempt=planning_attempt,planning_receipts=planning_receipts||jsonb_build_array($4::jsonb),
          prompt_tokens=prompt_tokens+$5,completion_tokens=completion_tokens+$6,updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`, [id, scope.tenantId, scope.workspaceId, JSON.stringify(receipt), receipt.promptTokens, receipt.completionTokens]);
      await this.journal(client, scope, id, "pm.sandbox.assign", { tasks: plan, planningReceipt: receipt, executionKind: "sandbox-artifact-generation" }, {
        rule_impact: [], ...(receipt.source === "model" ? { model_trace: { model_id: receipt.modelId, prompt_tokens: receipt.promptTokens, completion_tokens: receipt.completionTokens } } : {}),
      });
    });
  }

  claimTask(scope: PmScope, id: string, taskId: string, owner: string): Promise<boolean> {
    return this.tx(scope, async (client) => {
      await this.lockOwned(client, scope, id, owner);
      const detail = await this.detailOn(client, scope, id);
      const task = detail.tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "pending" || !task.dependsOn.every((dependency) => detail.tasks.some((item) => item.id === dependency && item.status === "completed"))) return false;
      return !!(await client.query(
        `UPDATE pm_tasks SET status='running',attempt=attempt+1,lease_owner=$5,started_at=now(),finished_at=NULL
         WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4 AND status='pending'`, [id, taskId, scope.tenantId, scope.workspaceId, owner])).rowCount;
    });
  }

  recordModelAttempt(scope: PmScope, id: string, owner: string, taskId: string | undefined,
    receipt: import("@workloom/base/model-router").CompletionDispatchReceipt): Promise<void> {
    assertNoSecrets(receipt);
    if (Buffer.byteLength(JSON.stringify(receipt)) > 8192) throw new PmError("MODEL_RECEIPT_INVALID", "模型请求摘要超出内部回执大小限制");
    return this.tx(scope, async (client) => {
      const owned = await client.query<{ active: boolean }>(
        `SELECT status IN ('planning','running') AND lease_expires_at>now() AS active
         FROM pm_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND lease_owner=$4
         AND status IN ('planning','running','cancelled') FOR UPDATE`, [id, scope.tenantId, scope.workspaceId, owner]);
      if (!owned.rowCount) throw new PmError("RUN_LEASE_LOST", "运行归属已变化，拒绝新的模型请求或回执", 409);
      if (!owned.rows[0]!.active) {
        // A cancelled/expired run may retain the original request's accounting
        // receipt, but cannot authorize a new physical model request.
        const previous = taskId
          ? await client.query(
            `SELECT 1 FROM pm_tasks,jsonb_array_elements(attempt_receipts) AS item
             WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4
               AND item->'requestReceipt'->>'attemptId'=$5 LIMIT 1`,
            [id, taskId, scope.tenantId, scope.workspaceId, receipt.attemptId])
          : await client.query(
            `SELECT 1 FROM pm_runs,jsonb_array_elements(planning_receipts) AS item
             WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3
               AND item->'requestReceipt'->>'attemptId'=$4 LIMIT 1`,
            [id, scope.tenantId, scope.workspaceId, receipt.attemptId]);
        if (!previous.rowCount) throw new PmError("RUN_LEASE_LOST", "运行已取消或租约已过期，只允许保留原请求的计量回执", 409);
      }
      const row = JSON.stringify({ kind: "model-attempt", recordedAt: new Date().toISOString(), requestReceipt: receipt });
      if (taskId) {
        const updated = await client.query(
          `UPDATE pm_tasks SET attempt_receipts=attempt_receipts||jsonb_build_array($5::jsonb)
           WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4`, [id, taskId, scope.tenantId, scope.workspaceId, row]);
        if (!updated.rowCount) throw new PmError("TASK_LEASE_LOST", "员工任务不存在，拒绝模型调用", 409);
      } else await client.query(
        `UPDATE pm_runs SET planning_receipts=planning_receipts||jsonb_build_array($4::jsonb)
         WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`, [id, scope.tenantId, scope.workspaceId, row]);
      await this.journal(client, scope, id, "pm.model.attempt", { taskId: taskId ?? null, requestReceipt: receipt });
    });
  }

  completeTask(scope: PmScope, id: string, taskId: string, owner: string, result: EmployeeExecutionResult, artifacts: PmArtifact[], impacts: RuleImpact[], declaredCapability: string): Promise<void> {
    assertNoSecrets({ result, artifacts, declaredCapability });
    return this.tx(scope, async (client) => {
      await this.lockOwned(client, scope, id, owner);
      const task = await client.query<{ preset_key: string; attempt: number; metered_attempt: number }>(
        "SELECT preset_key,attempt,metered_attempt FROM pm_tasks WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4 AND lease_owner=$5 AND status='running' FOR UPDATE", [id, taskId, scope.tenantId, scope.workspaceId, owner]);
      if (!task.rows[0] || artifacts.length === 0) throw new PmError("TASK_LEASE_LOST", "员工任务状态已变化或缺少真实产物回执", 409);
      for (const artifact of artifacts) {
        if (artifact.runId !== id || artifact.taskId !== taskId) throw new PmError("ARTIFACT_SCOPE_MISMATCH", "产物归属与员工任务不一致");
        await client.query(
          `INSERT INTO pm_artifacts(id,run_id,task_id,tenant_id,workspace_id,path,sha256,size_bytes,media_type,verified_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [artifact.id, id, taskId, scope.tenantId, scope.workspaceId, artifact.path, artifact.sha256, artifact.sizeBytes, artifact.mediaType, artifact.verifiedAt]);
      }
      await client.query(
        `UPDATE pm_tasks SET status='completed',lease_owner=NULL,summary=$5,
          usage=jsonb_build_object('promptTokens',COALESCE((usage->>'promptTokens')::bigint,0)+($6::jsonb->>'promptTokens')::bigint,
            'completionTokens',COALESCE((usage->>'completionTokens')::bigint,0)+($6::jsonb->>'completionTokens')::bigint),
          model_id=$7,response_id=$8,metered_attempt=attempt,
          fence_impacts=$9::jsonb,adapter_receipt=$10::jsonb,attempt_receipts=attempt_receipts||jsonb_build_array($11::jsonb),finished_at=now(),error=NULL,error_code=NULL
         WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4`,
        [id, taskId, scope.tenantId, scope.workspaceId, result.summary, JSON.stringify(result.usage), result.modelId, result.responseId ?? null, JSON.stringify(impacts), JSON.stringify(result.receipt ?? null),
          JSON.stringify({ attempt: task.rows[0].attempt, usage: result.usage, modelId: result.modelId, responseId: result.responseId ?? null, final: true, receipt: result.receipt ?? null })]);
      await client.query(
        `UPDATE pm_runs SET prompt_tokens=prompt_tokens+$4,completion_tokens=completion_tokens+$5,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`, [id, scope.tenantId, scope.workspaceId, result.usage.promptTokens, result.usage.completionTokens]);
      await this.journal(client, scope, id, "pm.sandbox.artifact.write", {
        taskId, employee: task.rows[0].preset_key, declaredCapability, executionKind: "sandbox-artifact-generation",
        artifacts, usage: result.usage, responseId: result.responseId ?? null, adapterReceipt: result.receipt ?? null,
      }, { rule_impact: impacts, receipt: { synced: true, mode: "real", snapshot_uri: `workloom-pm://runs/${id}/tasks/${taskId}`, verified_at: new Date().toISOString() },
        model_trace: { model_id: result.modelId, prompt_tokens: result.usage.promptTokens, completion_tokens: result.usage.completionTokens } });
    });
  }

  failRun(scope: PmScope, id: string, owner: string, status: "failed" | "blocked" | "paused", code: string, message: string, taskId?: string, impacts: RuleImpact[] = [], metering?: FailureMetering, verificationResults?: unknown): Promise<boolean> {
    assertNoSecrets(message);
    if (verificationResults !== undefined) assertNoSecrets(verificationResults);
    return this.tx(scope, async (client) => {
      const previous = await client.query<{ status: string; plan_version: number; planning_attempt: number; planning_metered_attempt: number }>(
        `SELECT status,plan_version,planning_attempt,planning_metered_attempt FROM pm_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3
          AND lease_owner=$4 AND status IN ('planning','running','cancelled') FOR UPDATE`, [id, scope.tenantId, scope.workspaceId, owner]);
      if (!previous.rowCount) return false;
      let addMetering = metering !== undefined;
      if (taskId) {
        const task = await client.query<{ status: string; attempt: number; metered_attempt: number }>(
          "SELECT status,attempt,metered_attempt FROM pm_tasks WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4 FOR UPDATE", [id, taskId, scope.tenantId, scope.workspaceId]);
        if (!task.rows[0] || task.rows[0].status === "completed" || task.rows[0].metered_attempt >= task.rows[0].attempt) addMetering = false;
      } else if (previous.rows[0]!.planning_metered_attempt >= previous.rows[0]!.planning_attempt) addMetering = false;
      if (addMetering && metering) {
        assertNoSecrets(metering);
        if (metering.usage) await client.query(
          `UPDATE pm_runs SET prompt_tokens=prompt_tokens+$4,completion_tokens=completion_tokens+$5
           WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`, [id, scope.tenantId, scope.workspaceId, metering.usage.promptTokens, metering.usage.completionTokens]);
        if (taskId) await client.query(
          `UPDATE pm_tasks SET usage=CASE WHEN $5::jsonb IS NULL THEN usage ELSE jsonb_build_object('promptTokens',COALESCE((usage->>'promptTokens')::bigint,0)+($5::jsonb->>'promptTokens')::bigint,
            'completionTokens',COALESCE((usage->>'completionTokens')::bigint,0)+($5::jsonb->>'completionTokens')::bigint) END,
            model_id=$6,response_id=$7,adapter_receipt=$8::jsonb,metered_attempt=attempt,
            attempt_receipts=attempt_receipts||jsonb_build_array(jsonb_build_object('attempt',attempt,'usage',$5::jsonb,'modelId',$6::text,'receipt',$8::jsonb,'final',false))
           WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4`,
          [id, taskId, scope.tenantId, scope.workspaceId, metering.usage ? JSON.stringify(metering.usage) : null, metering.modelId, metering.responseId ?? null, JSON.stringify(metering.receipt ?? { final: false })]);
        else await client.query(
          `UPDATE pm_runs SET planning_receipt=$4::jsonb,planning_metered_attempt=planning_attempt,
            planning_receipts=planning_receipts||jsonb_build_array($4::jsonb) WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
          [id, scope.tenantId, scope.workspaceId, JSON.stringify({ ...metering, final: false })]);
      }
      if (previous.rows[0]!.status === "cancelled") {
        // Cancellation is a terminal business decision. A late billable response may add its
        // actual usage receipt, but must never revive the run or publish its generated files.
        await client.query("UPDATE pm_runs SET lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3", [id, scope.tenantId, scope.workspaceId]);
        await this.journal(client, scope, id, "pm.run.cancelled_metering", {
          taskId: taskId ?? null, knownFailureMetering: addMetering ? metering ?? null : null,
          budgetAuthority: "parent-physical-request-ledger", retainedTerminalStatus: "cancelled",
        }, { rule_impact: [], ...(addMetering && metering?.usage ? { model_trace: { model_id: metering.modelId,
          prompt_tokens: metering.usage.promptTokens, completion_tokens: metering.usage.completionTokens } } : {}) });
        return true;
      }
      const updated = await client.query(
        `UPDATE pm_runs SET status=$5,error_code=$6,error=$7,lease_owner=NULL,lease_expires_at=NULL,
          verification=COALESCE($8::jsonb,verification),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND lease_owner=$4 AND status IN ('planning','running') RETURNING id`,
        [id, scope.tenantId, scope.workspaceId, owner, status, code, message.slice(0, 1000),
          verificationResults === undefined ? null : JSON.stringify({ checks: verificationResults, verifiedAt: new Date().toISOString() })]);
      if (!updated.rowCount) return false;
      if (taskId) await client.query(
        `UPDATE pm_tasks SET status=$5,error_code=$6,error=$7,fence_impacts=$8::jsonb,lease_owner=NULL,finished_at=now()
         WHERE run_id=$1 AND id=$2 AND tenant_id=$3 AND workspace_id=$4 AND status<>'completed'`,
        [id, taskId, scope.tenantId, scope.workspaceId, status, code, message.slice(0, 1000), JSON.stringify(impacts)]);
      await client.query(
        `UPDATE pm_tasks SET status=$4,error_code='RUN_STOPPED',error='父运行已停止，下游及未执行任务未产生回执',lease_owner=NULL
         WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status IN ('pending','running')`, [id, scope.tenantId, scope.workspaceId, status === "paused" ? "paused" : "blocked"]);
      await this.journal(client, scope, id, `pm.run.${status}`, {
        code, message: message.slice(0, 1000), taskId: taskId ?? null,
        verificationResults: verificationResults ?? null,
        knownFailureMetering: addMetering ? metering ?? null : null, budgetAuthority: "parent-physical-request-ledger",
      }, { rule_impact: impacts, ...(addMetering && metering?.usage ? { model_trace: { model_id: metering.modelId,
        prompt_tokens: metering.usage.promptTokens, completion_tokens: metering.usage.completionTokens } } : {}) });
      return true;
    });
  }

  finishRun(scope: PmScope, id: string, owner: string, checkResults: unknown): Promise<void> {
    assertNoSecrets(checkResults);
    if (!Array.isArray(checkResults) || checkResults.some((check) => !check || typeof check !== "object" || (check as { passed?: unknown }).passed !== true)) {
      throw new PmError("RUN_CHECK_FAILED", "最终检查缺少明确通过的回执，不能标记完成", 409);
    }
    return this.tx(scope, async (client) => {
      await this.lockOwned(client, scope, id, owner);
      const detail = await this.detailOn(client, scope, id);
      if (detail.tasks.length === 0 || detail.tasks.some((task) => task.status !== "completed")
        || detail.tasks.some((task) => !detail.artifacts.some((artifact) => artifact.taskId === task.id))) {
        throw new PmError("INCOMPLETE_DELIVERY", "仍有员工未交付已核验产物，不能标记完成", 409);
      }
      await client.query(
        `UPDATE pm_runs SET status='completed',lease_owner=NULL,lease_expires_at=NULL,error=NULL,error_code=NULL,verification=$4::jsonb,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`, [id, scope.tenantId, scope.workspaceId, JSON.stringify({ checks: checkResults, verifiedAt: new Date().toISOString() })]);
      await this.journal(client, scope, id, "pm.run.completed", { artifacts: detail.artifacts, checkResults }, {
        rule_impact: [], receipt: { synced: true, mode: "real", snapshot_uri: `workloom-pm://runs/${id}`, verified_at: new Date().toISOString() },
      });
    });
  }

  cancel(scope: PmScope, id: string, actor: string): Promise<PmRunDetail> {
    return this.tx(scope, async (client) => {
      // Serialize the terminal decision with finishRun/completeTask. Reading before
      // locking could observe running, wait for a successful finish, then cancel it.
      await client.query("SELECT id FROM pm_runs WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE", [id, scope.tenantId, scope.workspaceId]);
      const detail = await this.detailOn(client, scope, id);
      if (detail.run.status === "completed") throw new PmError("RUN_ALREADY_COMPLETED", "已完成任务不能取消；产物与回执继续保留", 409);
      if (detail.run.status === "cancelled") return detail;
      await client.query(
        `UPDATE pm_runs SET status='cancelled',lease_expires_at=NULL,error_code='CANCELLED',error='用户已取消',updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`, [id, scope.tenantId, scope.workspaceId]);
      await client.query(
        `UPDATE pm_tasks SET status='cancelled',lease_owner=NULL,error_code='CANCELLED',error='用户已取消'
         WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status NOT IN ('completed','failed')`, [id, scope.tenantId, scope.workspaceId]);
      await this.journal(client, scope, id, "pm.run.cancelled", { cancelledBy: actor, retainedArtifacts: detail.artifacts.length });
      return this.detailOn(client, scope, id);
    });
  }

  recoverExpired(scope: PmScope): Promise<number> {
    return this.tx(scope, async (client) => {
      const stale = await client.query<{ id: string }>(
        `UPDATE pm_runs SET status='paused',lease_owner=NULL,lease_expires_at=NULL,error_code='INTERRUPTED',
          error='执行进程中断且租约已过期，已完成产物保留；需显式恢复并重新校验摘要',updated_at=now()
         WHERE tenant_id=$1 AND workspace_id=$2 AND status IN ('planning','running') AND lease_expires_at<=now() RETURNING id`, [scope.tenantId, scope.workspaceId]);
      for (const row of stale.rows) {
        const unresolved = requiresPmUsageReconciliation(await this.detailOn(client, scope, row.id));
        if (unresolved) await client.query(
          `UPDATE pm_runs SET status='blocked',error_code='MODEL_USAGE_RECONCILIATION_REQUIRED',
           error='进程中断时存在可能已送出的模型请求，必须核对原请求用量后才能恢复'
           WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`, [row.id, scope.tenantId, scope.workspaceId]);
        await client.query(
          `UPDATE pm_tasks SET status=$4,lease_owner=NULL,error_code=$5,error='进程中断；未取得完整产物与计量回执'
           WHERE run_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='running'`,
          [row.id, scope.tenantId, scope.workspaceId, unresolved ? "blocked" : "paused", unresolved ? "MODEL_USAGE_RECONCILIATION_REQUIRED" : "INTERRUPTED"]);
        await this.journal(client, scope, row.id, unresolved ? "pm.run.blocked" : "pm.run.paused",
          { code: unresolved ? "MODEL_USAGE_RECONCILIATION_REQUIRED" : "INTERRUPTED", requiresExplicitResume: !unresolved, requiresUsageReconciliation: unresolved });
      }
      return stale.rowCount ?? 0;
    });
  }
}

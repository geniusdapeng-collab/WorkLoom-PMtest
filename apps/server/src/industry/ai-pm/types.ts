import type { AssembledPreset } from "@workloom/runtime";
import type { CompletionProvider } from "@workloom/base/model-router";
import type { PmEventSummary } from "./event-contract.js";
import type { RuleImpact } from "@workloom/base/fence-engine";
import type { SearchReceipt } from "./search-context.js";

export interface PmScope { tenantId: string; workspaceId: string }
export type PmRunStatus = "created" | "planning" | "running" | "paused" | "blocked" | "failed" | "completed" | "cancelled";
export type PmTaskStatus = "pending" | "running" | "paused" | "blocked" | "failed" | "completed" | "cancelled";

export type ArtifactCheck =
  | { type: "fileExists"; path: string }
  | { type: "fileContains"; path: string; text: string }
  | { type: "json"; path: string; requiredKeys?: string[] };

export interface PmTaskPlan {
  id: string;
  presetKey: string;
  goal: string;
  dependsOn: string[];
  acceptance: string[];
  /** Exact run-relative paths owned by this employee; no wildcards or overwriting another task. */
  outputRefs: string[];
}

export interface PmUsage { promptTokens: number; completionTokens: number }
export interface PmFile { path: string; content: string }
export interface PmArtifact {
  id: string; runId: string; taskId: string; path: string; sha256: string;
  sizeBytes: number; mediaType: string; verifiedAt: string;
}
export interface DependencyArtifact extends PmArtifact { content: string }

/** Verified source metadata captured before an employee attempt; never supplied by HTTP or the model. */
export interface PmAssetBinding {
  readonly schema: "workloom.pm.asset-binding/v1";
  readonly bundleId: "ai-pm";
  readonly bundleVersion: string;
  /** SHA-256 of JSON.stringify(the normalized, integrity-verified manifest). */
  readonly manifestSha256: string;
  readonly bundleIntegrityDigest: string;
  readonly presetKey: string;
  readonly presetSha256: string;
  readonly skillTextSha256: string;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly path: string; readonly sha256: string }>;
}

export interface EmployeeExecutionInput {
  scope: PmScope;
  runId: string;
  task: PmTaskPlan;
  preset: AssembledPreset;
  skillText: string;
  /** Optional only for trusted test/adapter injection compatibility. */
  assetBinding?: PmAssetBinding;
  dependencyArtifacts: DependencyArtifact[];
  /** Server-owned, metered prior review observations. They are input data, not saved plan requirements. */
  semanticRetryObservation?: string;
  /** Server-read thread excerpts, scoped to the run and bounded before delivery. */
  followups?: ReadonlyArray<PmEventSummary & { source: string }>;
  publicEvidence?: SearchReceipt;
  contextSpill?: Array<{ eventId: string; text: string }>;
  /** Server-controlled, newly created private scratch directory, never supplied by the HTTP client. */
  outputDir: string;
  signal: AbortSignal;
}
export interface EmployeeExecutionResult {
  files: PmFile[];
  summary: string;
  usage: PmUsage;
  modelId: string;
  responseId?: string;
  /** Must describe the actual adapter session; it is not treated as an artifact verification receipt. */
  receipt?: Record<string, unknown>;
}
export type EmployeeExecutor = (input: EmployeeExecutionInput) => Promise<EmployeeExecutionResult>;

export interface PmTask extends PmTaskPlan {
  runId: string; status: PmTaskStatus; attempt: number; summary: string | null;
  error: string | null; errorCode: string | null; usage: PmUsage | null;
  modelId: string | null; responseId: string | null; fenceImpacts: RuleImpact[];
  adapterReceipt: Record<string, unknown> | null;
  executionBackend: "deepseek-completion" | "deepseek-harness" | null;
  attemptReceipts: Array<Record<string, unknown>>;
  startedAt: string | null; finishedAt: string | null;
}
export interface PmRun {
  threadId?: string;
  id: string; goal: string; idempotencyKey: string; requestedEmployee: string | null;
  checks: ArtifactCheck[]; status: PmRunStatus; modelId: string; planVersion: number;
  createdBy: string; createdAt: string; updatedAt: string; error: string | null;
  errorCode: string | null; usage: PmUsage; planningReceipt: Record<string, unknown> | null;
  policyVersion: string;
  verification: Record<string, unknown> | null;
  planningReceipts: Array<Record<string, unknown>>;
}
export interface PmRunDetail { run: PmRun; tasks: PmTask[]; artifacts: PmArtifact[] }
export interface PmCreateInput {
  goal: string; idempotencyKey: string; employee?: string; checks?: ArtifactCheck[];
}
export interface PmEmployee { presetKey: string; name: string; description: string }

export interface PmProviderFactory { (): CompletionProvider }

export class PmError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message); this.name = "PmError";
  }
}

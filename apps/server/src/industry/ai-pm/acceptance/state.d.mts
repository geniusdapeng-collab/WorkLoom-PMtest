export function loadEvaluationState(path: string, session: string, phase: string): Promise<Array<Record<string, unknown>>>;
export function evaluationAttemptIdentity(cases: Array<Record<string, unknown>>, caseId: string, phase: string): { id: string; resumeRunId: string | undefined };
export function evaluationContractsEqual(actual: unknown, expected: unknown): boolean;
export function evaluationCaseTimeoutMs(raw: string | undefined): number;
export function pollEvaluationRun<T extends { run: { status: string } }>(options: {
  initial: T;
  read: () => Promise<T>;
  timeoutMs: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<{ detail: T; captureStatus: "pending" | "complete"; elapsedMs: number }>;

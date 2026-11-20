export function dshReadyUrl(message: unknown, port: number): string | null;
export function waitForDshUrl(child: import("node:child_process").ChildProcess, port: number,
  timeoutMs: number, signal?: AbortSignal): Promise<string>;

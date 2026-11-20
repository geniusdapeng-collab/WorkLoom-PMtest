export interface DshProductIdentity {
  productId: string;
  displayName: string;
  defaultBundle: string;
  workspaceSlug: string;
  memberNo: string;
}

export interface PreparedDshRuntime {
  product: DshProductIdentity;
  dshCli: string;
  dshVersion: string;
  pluginEntry: string;
  dshHome: string;
  workspaceDir: string;
  patchFile: string;
  stateDir: string;
}

export function resolveClientMode(environment?: NodeJS.ProcessEnv): "dsh" | "legacy";
export function readProductIdentity(root: string): DshProductIdentity;
export function createBridgeToken(randomBytes?: (size: number) => Buffer): string;
export function resolveDshCli(root: string): { packageRoot: string; cli: string; version: string };
export function resolvePluginEntry(root: string): { packageRoot: string; entry: string; manifest: Record<string, unknown> };
export function prepareDshRuntime(input: { root: string; supportDir: string }): PreparedDshRuntime;
export function dshEnvironment(base: NodeJS.ProcessEnv, input: {
  serverPort: number;
  token: string;
  dshHome: string;
}): NodeJS.ProcessEnv;
export function dshArgs(input: { cli: string; port: number; patchFile: string; open?: boolean }): string[];
export function dshReadyUrl(message: unknown, port: number): string | null;
export function waitForDshUrl(child: import("node:child_process").ChildProcess, port: number,
  timeoutMs: number, signal?: AbortSignal): Promise<string>;
export function patchText(pluginEntry: string): string;

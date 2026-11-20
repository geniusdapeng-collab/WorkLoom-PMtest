export interface DesktopSetupInput {
  displayName: string;
  tenantName: string;
  workspaceName: string;
  email: string;
  password: string;
}

interface DesktopSession {
  accessToken: string;
  refreshToken: string;
  workspaceSlug: string;
}

export interface DesktopSetupBridge {
  status(): Promise<{ available: boolean } | { error: string }>;
  create(input: DesktopSetupInput): Promise<DesktopSession | { error: string }>;
}

declare global {
  interface Window {
    workloomDesktopSetup?: DesktopSetupBridge;
  }
}

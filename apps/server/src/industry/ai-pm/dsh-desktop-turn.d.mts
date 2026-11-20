export interface DesktopTurnEvent extends Record<string, unknown> {
  type: string;
}

export function executeDesktopTurn(options: {
  url: string | URL;
  workspace: string;
  prompt: string;
  signal?: AbortSignal;
  onEvent?: (event: DesktopTurnEvent) => void | Promise<void>;
}): Promise<{ events: DesktopTurnEvent[] }>;

/** The one place the renderer can reach the machine: every channel, with its argument checked. */
export const CHANNEL = {
  scan: "projects:scan",
  status: "status:read",
  metrics: "metrics:history",
  metricsPush: "metrics:push",                   // main -> renderer, on every sample
  openSession: "session:open",
  renameSession: "session:rename",
  deleteSession: "session:delete",
  renameProject: "project:rename",
  deleteProject: "project:delete",
  revealProject: "project:reveal",
  loadSettings: "settings:load",
  saveSettings: "settings:save",
  displays: "settings:displays",
  applyDock: "dock:apply",
  releaseDock: "dock:release",
  saveUi: "ui:save",
  appInfo: "app:info",
  quit: "app:quit",
} as const;

export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

export interface OpenSessionRequest {
  projectDir: string;
  sessionId: string | null;
  target: "sessionsWindow" | "currentWindow" | "newWindow";
}

export interface RenameRequest {
  projectDir: string;
  sessionId?: string;
  title: string;
}

export interface DeleteRequest {
  projectDir: string;
  sessionId?: string;
}

export interface SettingsPayload {
  dock: import("../core/types.js").DockConfig;
  status: import("../core/types.js").StatusConfig;
  launch: import("../core/types.js").LaunchConfig;
  ui: import("../core/types.js").UiConfig;
  mcpServers: string[];
  dockDevices: string[];
  dockFloor: number;
  minPercent: number;
}

export interface DisplayInfo {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  primary: boolean;
  saved: boolean;
}

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  claudeFound: boolean;
  home: string;
  dockSupported: boolean;
  dockNote: string | null;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
}

/** Shapes shared by the core, the Electron main process and the renderer. */

export interface SessionInfo {
  id: string;
  /** Transcript file this session is stored in. */
  file: string;
  title: string;
  /** True when the title was chosen by a human (custom-title.json), not taken from the first prompt. */
  named: boolean;
  /** First prompt from history.jsonl, kept even when a name replaced it as the title. */
  prompt: string;
  startedAt: number;
  modifiedAt: number;
  bytes: number;
  /** A claude process is running this session right now. */
  live: boolean;
  /** Process id of that session, when it is running. */
  pid: number | null;
}

export interface ProjectInfo {
  /** Encoded directory name under projects/ — the stable identity of a project. */
  dir: string;
  /** Real folder, or null when no transcript and no .claude.json entry names it. */
  cwd: string | null;
  /** Folder name, or the display alias when one is set. */
  name: string;
  alias: string | null;
  sessions: SessionInfo[];
  hasMemory: boolean;
  /** The folder still exists; probed off the UI path because a dead UNC share blocks for seconds. */
  exists: boolean;
  lastUsed: number;
  totalBytes: number;
  liveCount: number;
}

/** One rate-limit window as Claude Code reports it (five_hour, seven_day, seven_day_opus, …). */
export interface RateWindow {
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface HealthItem {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

export interface StatusSnapshot {
  windows: RateWindow[];
  health: HealthItem[];
  ponytail: string | null;
}

/** One sample of a session's (or the machine's) resource use. */
export interface MetricSample {
  at: number;
  cpu: number;
  memoryBytes: number;
}

export interface MetricSeries {
  key: string;
  samples: MetricSample[];
}

export interface MetricsSnapshot {
  at: number;
  system: { cpu: number; memoryBytes: number; memoryTotalBytes: number; cpuGhz: number | null };
  /** Per session id: the process tree of that session. */
  sessions: Record<string, { cpu: number; memoryBytes: number; pid: number }>;
}

export type DockEdge = "left" | "top" | "right" | "bottom";

export interface DockConfig {
  enabled: boolean;
  device: string | null;
  edge: DockEdge;
  percent: number;
}

export type ShellChoice = "auto" | "pwsh" | "powershell" | "cmd" | "bash" | "none";
export type PermissionMode = "default" | "bypass" | "accept" | "plan" | "auto";
export type OpenTarget = "sessionsWindow" | "currentWindow" | "newWindow";

export interface LaunchConfig {
  shell: ShellChoice;
  permission: PermissionMode;
  /** Terminal command used on Linux; empty means "detect". */
  terminal: string;
}

export type ThemeMode = "system" | "light" | "dark";

/** How the panes are arranged: beside each other, stacked, or stacked once the window is narrow. */
export type LayoutMode = "auto" | "horizontal" | "vertical";

export interface UiConfig {
  /** Side by side, stacked, or stacked below `stackBelow` pixels wide. */
  layout: LayoutMode;
  /** The width, in pixels, at which "auto" switches to stacked. */
  stackBelow: number;
  /** Where the window was last left, when it was not docked. */
  window: { x: number; y: number; width: number; height: number } | null;
  /** Pane widths in pixels; 0 means "whatever the layout would pick". */
  navWidth: number;
  asideWidth: number;
  /** Whether CPU and memory are sampled at all. Off costs nothing — the timer stops. */
  monitor: boolean;
  project: string | null;
  cursor: number;
  /** "system" follows the OS setting and changes with it while the app is open. */
  theme: ThemeMode;
}

export interface StatusConfig {
  /** Selected MCP servers, or null for "every server the probe knows". */
  mcp: string[] | null;
}

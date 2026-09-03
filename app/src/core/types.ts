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
  /** Kept at the top of its list, by the user's choice. */
  pinned: boolean;
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
  /** Kept at the top of the list, by the user's choice. */
  pinned: boolean;
  /** Where the project's repository stands, or null when the folder is not one. */
  git: import("./git.js").GitInfo | null;
  /** This folder is a linked worktree of a repository that lives elsewhere. */
  worktree: boolean;
  /** The project this worktree belongs under, when that repository is in the list too. */
  parentDir: string | null;
}

/** One rate-limit window as Claude Code reports it (five_hour, seven_day). */
export interface RateWindow {
  key: string;
  label: string;
  /** The label a narrow card uses; the full one goes in its tooltip. */
  short: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface StatusSnapshot {
  windows: RateWindow[];
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

export type ShellChoice = "auto" | "pwsh" | "powershell" | "cmd" | "bash" | "custom" | "none";
export type PermissionMode = "default" | "bypass" | "accept" | "plan" | "auto";
export type OpenTarget = "sessionsWindow" | "currentWindow" | "newWindow";

export interface LaunchConfig {
  /** Executable that hosts a session when `shell` is "custom" — a full path, or a name on PATH. */
  customShell: string;
  /**
   * System-wide shortcut that turns a screenshot into something a terminal can paste.
   *
   * Empty means the shortcut is off. Pressed anywhere, it writes the clipboard image to a file and
   * leaves that file's path on the clipboard — a terminal cannot take a bitmap, but it can take a
   * path, and Claude Code opens the image from it.
   */
  pasteHotkey: string;
  /**
   * Whether a copied screenshot is given a path of its own, right as it is copied.
   *
   * The image is written to a file and the clipboard is left holding both the picture and that
   * file's path, so the ordinary paste key does the right thing in either kind of window — a
   * terminal takes the path, an image editor takes the picture. Nobody's keys are intercepted.
   */
  autoClipPath: boolean;
  shell: ShellChoice;
  permission: PermissionMode;
  /** Terminal command used on Linux; empty means "detect". */
  terminal: string;
}

export type ThemeMode = "system" | "light" | "dark";

/** How the panes are arranged: beside each other, stacked, or stacked once the window is narrow. */
export type LayoutMode = "auto" | "horizontal" | "vertical";

export interface UiConfig {
  /** What the window is written in; "system" follows the machine. */
  language: import("./i18n.js").Language;
  /** Side by side, stacked, or stacked below `stackBelow` pixels wide. */
  layout: LayoutMode;
  /** The width, in pixels, at which "auto" switches to stacked. */
  stackBelow: number;
  /** Where the window was last left, when it was not docked. */
  window: { x: number; y: number; width: number; height: number } | null;
  /**
   * Pane sizes as a fraction of the window (0 < f < 1); 0 means "whatever the layout would pick".
   *
   * Fractions, not pixels: the same window is a wide desktop one minute and a thin docked band the
   * next, and a pixel count set in one is wrong in the other.
   */
  navWidth: number;
  asideWidth: number;
  /** Height of the project list when the layout is stacked, as a fraction of the pair. */
  stackTop: number;
  /** Whether CPU and memory are sampled at all. Off costs nothing — the timer stops. */
  monitor: boolean;
  project: string | null;
  cursor: number;
  /** "system" follows the OS setting and changes with it while the app is open. */
  theme: ThemeMode;
}

export interface GitConfig {
  /** Show a repository line on project rows. */
  enabled: boolean;
  /** Also count uncommitted files, which costs a `git status` for the selected project. */
  countChanges: boolean;
  /** How an update from the base branch reconciles local commits. */
  strategy: import("./gitSync.js").MergeStrategy;
  /** The branch to update from, as remote/branch; empty means ask the remote for its default. */
  base: string;
  /** Whether, and how, to update from the base without being asked. */
  auto: import("./gitAuto.js").AutoConfig;
}

export interface UpdateConfig {
  /** Look for a newer version on a timer, and fetch what it finds. */
  automatic: boolean;
}

export interface StatusConfig {
  /**
   * Which rate-limit windows to show, by key, or null for every one Claude Code reports.
   *
   * An empty list is "none": the gauges disappear. One list rather than a switch and a list —
   * unticking the last window is the same wish as turning the segment off.
   */
  windows: string[] | null;
}

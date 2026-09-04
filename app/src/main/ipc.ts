/** The one place the renderer can reach the machine: every channel, with its argument checked. */
export const CHANNEL = {
  scan: "projects:scan",
  settingsPush: "settings:push",                 // main -> renderer, when main changed them
  windowCommand: "window:command",
  windowState: "window:state",
  windowStatePush: "window:state-push",           // main -> renderer, on maximise / dock / restore
  openSession: "session:open",
  renameSession: "session:rename",
  deleteSession: "session:delete",
  renameProject: "project:rename",
  deleteProject: "project:delete",
  revealProject: "project:reveal",
  addProject: "project:add",
  contextMenu: "menu:context",
  togglePin: "pin:toggle",
  openPage: "app:open-page",
  toast: "app:toast",                // main -> renderer, when something finished on its own
  loadSettings: "settings:load",
  saveSettings: "settings:save",
  displays: "settings:displays",
  applyDock: "dock:apply",
  dragDock: "dock:drag",           // the band's own grip, since the window frame no longer resizes
  releaseDock: "dock:release",
  saveUi: "ui:save",
  appInfo: "app:info",
  quit: "app:quit",
} as const;

export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

/** One step of a drag on the band's grip: how thick the band should be, and whether the hand let go. */
export interface DockDrag {
  thickness: number;
  done: boolean;
}

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
  /** The window already asked; skip the native box rather than asking twice. */
  confirmed?: boolean;
  projectDir: string;
  sessionId?: string;
}

export interface SettingsPayload {
  dock: import("../core/types.js").DockConfig;
  status: import("../core/types.js").StatusConfig;
  launch: import("../core/types.js").LaunchConfig;
  ui: import("../core/types.js").UiConfig;
  dockDevices: string[];
  dockFloor: number;
  minPercent: number;
  /** Whether the system-wide paste shortcut is actually held right now. */
  pasteHotkeyActive: boolean;
  /** How usage collection stands right now — the answer to "why are the gauges blank". */
  usage: UsageState;
  updates: import("../core/types.js").UpdateConfig;
  git: import("../core/types.js").GitConfig;
  /** Whether the git command line is on PATH — the branch line does not need it, the rest does. */
  gitAvailable: boolean;
}

/**
 * Pages this app will open in a browser, by name.
 *
 * A name rather than a URL: the renderer asking the main process to open an arbitrary address is
 * the shape of a hole, and there are only ever a handful of pages worth linking to.
 */
export const PAGES = {
  git: "https://git-scm.com/downloads",
  claudeCode: "https://claude.com/claude-code",
  releases: "https://github.com/kimssi-labs/hangar/releases",
} as const;
export type PageName = keyof typeof PAGES;

// The usage feature owns its state type; SettingsPayload above carries it. A type-only import in
// both directions between this file and the contract is erased, so there is no cycle at runtime.
import type { UsageState } from "../features/usage/contract.js";

/** What the caption buttons need to know. Docked counts as maximised: the band IS the full state. */
export interface WindowState {
  maximized: boolean;
  docked: boolean;
}

/**
 * Docking and maximising are separate commands.
 *
 * They shared one before, so "restore" gave back an edge in one state and a window size in the
 * other — the same button meaning two things depending on how the window got where it was.
 */
export type WindowCommand = "minimize" | "maximize" | "dock" | "close";

export interface DisplayInfo {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  primary: boolean;
  saved: boolean;
}

export interface AppInfo {
  /** The machine's own locale, so "system" can resolve to something. */
  locale: string;
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

/** One entry of a right-click menu; an id of MENU_SEPARATOR draws a line instead. */
export interface MenuItemSpec {
  id: string;
  label: string;
  enabled?: boolean;
  /** Present at all: the item is a checkbox, ticked or not. */
  checked?: boolean;
}
export const MENU_SEPARATOR = "-";

export interface PinRequest {
  kind: "projects" | "sessions";
  key: string;
}

/** Adding a project: where it landed, when a folder was actually picked. */
export interface AddProjectResult extends ActionResult {
  dir?: string;
}

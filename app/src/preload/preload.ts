/**
 * The only bridge between the page and the machine.
 *
 * The renderer runs with no Node access at all; everything it may do is one of these functions, so
 * the surface a bug (or a rogue dependency) can reach is this list and nothing else.
 */
import { contextBridge, ipcRenderer } from "electron";

import { CHANNEL } from "../main/ipc.js";
import type { ActionResult, AddProjectResult, AppInfo, MenuItemSpec, PageName, PinRequest, UpdateCommand, DeleteRequest, DisplayInfo, OpenSessionRequest, PastedImage, RenameRequest, SettingsPayload, WindowCommand, WindowState } from "../main/ipc.js";
import type { DockConfig, GitConfig, LaunchConfig, MetricSample, MetricsSnapshot, ProjectInfo, StatusConfig, StatusSnapshot, UiConfig, UpdateConfig } from "../core/types.js";
import type { UpdateState } from "../core/updates.js";

export interface MetricsHistoryPayload {
  system: MetricSample[];
  sessions: Record<string, MetricSample[]>;
}

const api = {
  scan: (): Promise<ProjectInfo[]> => ipcRenderer.invoke(CHANNEL.scan),
  status: (): Promise<StatusSnapshot> => ipcRenderer.invoke(CHANNEL.status),
  metrics: (): Promise<MetricsHistoryPayload> => ipcRenderer.invoke(CHANNEL.metrics),
  onMetrics: (listener: (snapshot: MetricsSnapshot) => void): (() => void) => {
    const handler = (_event: unknown, snapshot: MetricsSnapshot): void => listener(snapshot);
    ipcRenderer.on(CHANNEL.metricsPush, handler);
    return () => ipcRenderer.removeListener(CHANNEL.metricsPush, handler);
  },
  onSettings: (listener: (settings: SettingsPayload) => void): (() => void) => {
    const handler = (_event: unknown, settings: SettingsPayload): void => listener(settings);
    ipcRenderer.on(CHANNEL.settingsPush, handler);
    return () => ipcRenderer.removeListener(CHANNEL.settingsPush, handler);
  },
  openSession: (request: OpenSessionRequest): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.openSession, request),
  renameSession: (request: RenameRequest): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.renameSession, request),
  renameProject: (request: RenameRequest): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.renameProject, request),
  deleteSession: (request: DeleteRequest): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.deleteSession, request),
  deleteProject: (request: DeleteRequest): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.deleteProject, request),
  revealProject: (dir: string): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.revealProject, dir),
  /** Opens the folder picker; resolves with the new project's dir, or ok:false when nothing was chosen. */
  addProject: (): Promise<AddProjectResult> => ipcRenderer.invoke(CHANNEL.addProject),
  /** Shows a native menu at the pointer; resolves with the chosen id, or null when it was dismissed. */
  contextMenu: (items: MenuItemSpec[]): Promise<string | null> => ipcRenderer.invoke(CHANNEL.contextMenu, items),
  togglePin: (request: PinRequest): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.togglePin, request),
  /** Count the uncommitted files of one project; null when there is nothing to count. */
  gitCount: (dir: string): Promise<number | null> => ipcRenderer.invoke(CHANNEL.gitCount, dir),
  /** Something the app did on its own finished and is worth a line on screen. */
  onToast: (listener: (message: string) => void): (() => void) => {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on(CHANNEL.toast, handler);
    return () => ipcRenderer.removeListener(CHANNEL.toast, handler);
  },
  /** Open one of the app's known pages in the default browser. */
  openPage: (page: PageName): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.openPage, page),
  /** Every checkout of the repository this project belongs to. */
  worktreeList: (dir: string): Promise<import("../core/worktree.js").Worktree[]> =>
    ipcRenderer.invoke(CHANNEL.worktreeList, dir),
  /** Add a worktree of this project on a new branch; it joins the list as its own project. */
  worktreeAdd: (dir: string, branch: string): Promise<AddProjectResult> =>
    ipcRenderer.invoke(CHANNEL.worktreeAdd, { dir, branch }),
  /** Remove a worktree and its project row. */
  worktreeRemove: (dir: string, force: boolean): Promise<ActionResult> =>
    ipcRenderer.invoke(CHANNEL.worktreeRemove, { dir, force }),
  /** Bring one project's branch up to date with its base branch. */
  gitSync: (dir: string): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.gitSync, dir),
  /** Ask the updater to check, download, or restart into what it downloaded. */
  updateAction: (command: UpdateCommand): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updateAction, command),
  onUpdate: (listener: (state: UpdateState) => void): (() => void) => {
    const handler = (_event: unknown, state: UpdateState): void => listener(state);
    ipcRenderer.on(CHANNEL.updatePush, handler);
    return () => ipcRenderer.removeListener(CHANNEL.updatePush, handler);
  },
  /** Install or remove the Stop hook that publishes Claude Code's usage figures. */
  setUsageHook: (on: boolean): Promise<ActionResult & { settings: SettingsPayload }> =>
    ipcRenderer.invoke(CHANNEL.setUsageHook, on),
  loadSettings: (): Promise<SettingsPayload> => ipcRenderer.invoke(CHANNEL.loadSettings),
  saveSettings: (payload: { dock?: DockConfig; status?: StatusConfig; launch?: LaunchConfig; ui?: Partial<UiConfig>; updates?: UpdateConfig; git?: GitConfig }): Promise<SettingsPayload> =>
    ipcRenderer.invoke(CHANNEL.saveSettings, payload),
  displays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke(CHANNEL.displays),
  applyDock: (config: DockConfig): Promise<ActionResult & { settings?: SettingsPayload }> => ipcRenderer.invoke(CHANNEL.applyDock, config),
  releaseDock: (): Promise<SettingsPayload> => ipcRenderer.invoke(CHANNEL.releaseDock),
  saveUi: (ui: Partial<UiConfig>): Promise<void> => ipcRenderer.invoke(CHANNEL.saveUi, ui),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CHANNEL.appInfo),
  pasteImage: (): Promise<PastedImage> => ipcRenderer.invoke(CHANNEL.pasteImage),
  onPasteResult: (listener: (result: PastedImage) => void): (() => void) => {
    const handler = (_event: unknown, result: PastedImage): void => listener(result);
    ipcRenderer.on(CHANNEL.pasteResult, handler);
    return () => ipcRenderer.removeListener(CHANNEL.pasteResult, handler);
  },
  /** Drag the docked band's inner edge. `done` marks the end, when the size is written down. */
  dragDock: (thickness: number, done: boolean): void =>
    ipcRenderer.send(CHANNEL.dragDock, { thickness, done }),
  windowState: (): Promise<WindowState> => ipcRenderer.invoke(CHANNEL.windowState),
  windowCommand: (command: WindowCommand): Promise<WindowState> =>
    ipcRenderer.invoke(CHANNEL.windowCommand, command),
  onWindowState: (listener: (state: WindowState) => void): (() => void) => {
    const handler = (_event: unknown, state: WindowState): void => listener(state);
    ipcRenderer.on(CHANNEL.windowStatePush, handler);
    return () => ipcRenderer.removeListener(CHANNEL.windowStatePush, handler);
  },
  quit: (): Promise<void> => ipcRenderer.invoke(CHANNEL.quit),
};

export type HangarApi = typeof api;

contextBridge.exposeInMainWorld("hangar", api);

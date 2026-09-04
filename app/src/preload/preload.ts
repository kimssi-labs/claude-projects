/**
 * The only bridge between the page and the machine.
 *
 * The renderer runs with no Node access at all; everything it may do is one of these functions, so
 * the surface a bug (or a rogue dependency) can reach is this list and nothing else.
 */
import { contextBridge, ipcRenderer } from "electron";

import { buildApi } from "../bridge/build.js";
import { CONTRACTS } from "../bridge/registry.js";
import { CHANNEL } from "../main/ipc.js";
import type { ActionResult, AddProjectResult, AppInfo, MenuItemSpec, PageName, PinRequest, DeleteRequest, OpenSessionRequest, RenameRequest, SettingsPayload, WindowCommand, WindowState } from "../main/ipc.js";
import type { DockConfig, GitConfig, LaunchConfig, MetricSample, MetricsSnapshot, ProjectInfo, StatusConfig, StatusSnapshot, UiConfig, UpdateConfig } from "../core/types.js";

const api = {
  // Derived from the feature contracts. The entries written out below are the features that have
  // not moved onto a contract yet; they leave this file one feature at a time.
  ...buildApi(CONTRACTS, ipcRenderer),
  scan: (): Promise<ProjectInfo[]> => ipcRenderer.invoke(CHANNEL.scan),
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
  /** Something the app did on its own finished and is worth a line on screen. */
  onToast: (listener: (message: string) => void): (() => void) => {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on(CHANNEL.toast, handler);
    return () => ipcRenderer.removeListener(CHANNEL.toast, handler);
  },
  /** Open one of the app's known pages in the default browser. */
  openPage: (page: PageName): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.openPage, page),
  loadSettings: (): Promise<SettingsPayload> => ipcRenderer.invoke(CHANNEL.loadSettings),
  saveSettings: (payload: { dock?: DockConfig; status?: StatusConfig; launch?: LaunchConfig; ui?: Partial<UiConfig>; updates?: UpdateConfig; git?: GitConfig }): Promise<SettingsPayload> =>
    ipcRenderer.invoke(CHANNEL.saveSettings, payload),
  saveUi: (ui: Partial<UiConfig>): Promise<void> => ipcRenderer.invoke(CHANNEL.saveUi, ui),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CHANNEL.appInfo),
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

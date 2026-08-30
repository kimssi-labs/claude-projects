/**
 * The only bridge between the page and the machine.
 *
 * The renderer runs with no Node access at all; everything it may do is one of these functions, so
 * the surface a bug (or a rogue dependency) can reach is this list and nothing else.
 */
import { contextBridge, ipcRenderer } from "electron";

import { CHANNEL } from "../main/ipc.js";
import type { ActionResult, AppInfo, DeleteRequest, DisplayInfo, OpenSessionRequest, RenameRequest, SettingsPayload, WindowCommand, WindowState } from "../main/ipc.js";
import type { DockConfig, LaunchConfig, MetricSample, MetricsSnapshot, ProjectInfo, StatusConfig, StatusSnapshot, UiConfig } from "../core/types.js";

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
  loadSettings: (): Promise<SettingsPayload> => ipcRenderer.invoke(CHANNEL.loadSettings),
  saveSettings: (payload: { dock?: DockConfig; status?: StatusConfig; launch?: LaunchConfig; ui?: Partial<UiConfig> }): Promise<SettingsPayload> =>
    ipcRenderer.invoke(CHANNEL.saveSettings, payload),
  displays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke(CHANNEL.displays),
  applyDock: (config: DockConfig): Promise<ActionResult & { settings?: SettingsPayload }> => ipcRenderer.invoke(CHANNEL.applyDock, config),
  releaseDock: (): Promise<SettingsPayload> => ipcRenderer.invoke(CHANNEL.releaseDock),
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

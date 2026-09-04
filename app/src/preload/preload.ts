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
import type { ActionResult, AppInfo, MenuItemSpec, PageName, WindowCommand, WindowState } from "../main/ipc.js";

const api = {
  // Derived from the feature contracts. The entries written out below are the shell's own: the
  // window, its menus and pages, and the app's identity.
  ...buildApi(CONTRACTS, ipcRenderer),
  /** Shows a native menu at the pointer; resolves with the chosen id, or null when it was dismissed. */
  contextMenu: (items: MenuItemSpec[]): Promise<string | null> => ipcRenderer.invoke(CHANNEL.contextMenu, items),
  /** Something the app did on its own finished and is worth a line on screen. */
  onToast: (listener: (message: string) => void): (() => void) => {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on(CHANNEL.toast, handler);
    return () => ipcRenderer.removeListener(CHANNEL.toast, handler);
  },
  /** Open one of the app's known pages in the default browser. */
  openPage: (page: PageName): Promise<ActionResult> => ipcRenderer.invoke(CHANNEL.openPage, page),
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

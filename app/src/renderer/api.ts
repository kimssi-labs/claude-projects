/** The preload bridge, typed — the renderer talks to the machine through this and nothing else. */
import type { HangarApi, MetricsHistoryPayload } from "../preload/preload";
import type { ActionResult, AppInfo, DisplayInfo, MenuItemSpec, SettingsPayload } from "../main/ipc";

declare global {
  interface Window {
    hangar: HangarApi;
  }
}

export const api: HangarApi = window.hangar;
export type { ActionResult, AppInfo, DisplayInfo, MenuItemSpec, MetricsHistoryPayload, SettingsPayload };
/** Kept in step with ipc.ts by hand: the renderer bundle does not import from main. */
export const MENU_SEPARATOR = "-";

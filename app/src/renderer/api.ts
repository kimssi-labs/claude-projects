/** The preload bridge, typed — the renderer talks to the machine through this and nothing else. */
import type { HangarApi } from "../preload/preload";
import type { MetricsHistoryPayload } from "../features/metrics/contract";
import type { ActionResult, AppInfo, MenuItemSpec, SettingsPayload } from "../main/ipc";
import type { DisplayInfo } from "../features/dock/contract";
import type { UpdateState } from "@core/updates";

declare global {
  interface Window {
    hangar: HangarApi;
  }
}

export const api: HangarApi = window.hangar;
export type { ActionResult, AppInfo, DisplayInfo, MenuItemSpec, MetricsHistoryPayload, SettingsPayload, UpdateState };
/** Kept in step with ipc.ts by hand: the renderer bundle does not import from main. */
export const MENU_SEPARATOR = "-";

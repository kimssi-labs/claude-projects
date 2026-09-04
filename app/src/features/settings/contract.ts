/** What the settings screen may ask: the whole payload, a save of the sections that changed, and pushes. */
import { event, invoke } from "../../bridge/contract.js";
import type { DockConfig, GitConfig, LaunchConfig, StatusConfig, UiConfig, UpdateConfig } from "../../core/types.js";
import type { SettingsPayload } from "../../main/ipc.js";

/** What a save carries: only the sections that changed need be present. */
export interface SettingsPatch {
  dock?: DockConfig;
  status?: StatusConfig;
  launch?: LaunchConfig;
  ui?: Partial<UiConfig>;
  updates?: UpdateConfig;
  git?: GitConfig;
}

export const settingsContract = {
  loadSettings: invoke<void, SettingsPayload>("settings:load"),
  /** Write the sections given; answers with everything as it then stands. */
  saveSettings: invoke<SettingsPatch, SettingsPayload>("settings:save"),
  /** A pane size or a cursor position: remembered, not announced. */
  saveUi: invoke<Partial<UiConfig>, void>("ui:save"),
  /** Main changed the settings on its own — undocking when the window was dragged out of its band. */
  onSettings: event<SettingsPayload>("settings:push"),
} as const;

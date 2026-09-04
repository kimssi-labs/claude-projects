/**
 * Settings — the main side.
 *
 * Composes the one payload the settings screen reads from every feature's slice, writes what the
 * screen sends back, and tells the window when the settings changed under it. It knows the config
 * store and nothing about the features: their slices come in as a function, and whatever a saved
 * section should set in motion — a rescan, a timer re-armed — is main's to do, in `applied`.
 */
import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import type { SettingsPayload } from "../../main/ipc.js";
import { settingsContract, type SettingsPatch } from "./contract.js";

/** The parts of the payload that are other features' to answer. */
export type FeatureSlices = Pick<SettingsPayload, "dock" | "dockDevices" | "dockFloor" | "minPercent" | "pasteHotkeyActive" | "usage" | "gitAvailable">;

/** What this feature needs from the rest of main. */
export interface SettingsDeps {
  /** Every other feature's part of the payload — asked for on each read, so it is current. */
  slices(): FeatureSlices;
  /**
   * A patch was written, dock's section included. Main tells the features whose settings changed;
   * this runs BEFORE the payload is composed, so what they answer already reflects the write.
   */
  applied(patch: SettingsPatch): void;
}

/** What the rest of main may do with this feature once it is registered. */
export interface SettingsFeature {
  payload(): SettingsPayload;
  /** Tell the window the settings changed without being asked. */
  push(): void;
}

export function register(ctx: MainContext, wire: Wire, deps: SettingsDeps): SettingsFeature {
  const payload = (): SettingsPayload => ({
    ...deps.slices(),
    status: ctx.config.status(),
    launch: ctx.config.launch(),
    ui: ctx.config.ui(),
    updates: ctx.config.updates(),
    git: ctx.config.git(),
  });
  const push = (): void => wire.emit(settingsContract.onSettings, payload());

  wire.bind(settingsContract, {
    loadSettings: () => payload(),
    saveSettings: (patch) => {
      if (patch.status) ctx.config.saveStatus(patch.status);
      if (patch.git) ctx.config.saveGit(patch.git);
      if (patch.updates) ctx.config.saveUpdates(patch.updates);
      if (patch.launch) ctx.config.saveLaunch(patch.launch);
      // The theme lives with the rest of the remembered position, so it comes back with it.
      if (patch.ui) ctx.config.saveUi({ ...ctx.config.ui(), ...patch.ui });
      deps.applied(patch);
      // Tell the window too: whoever changed a setting, the screen should already agree with it.
      const saved = payload();
      wire.emit(settingsContract.onSettings, saved);
      return saved;
    },
    saveUi: (ui) => { ctx.config.saveUi({ ...ctx.config.ui(), ...ui }); },
  });

  return { payload, push };
}

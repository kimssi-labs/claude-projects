/**
 * Updating the app in place — the main side.
 *
 * The decisions are in core/updates.ts and the electron-updater wiring in main/updater.ts; this is
 * the feature's edge: its handler, its event, and the one thing another feature may ask of it.
 */
import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import type { UpdateConfig } from "../../core/updates.js";
import { UpdateService } from "../../main/updater.js";
import { updatesContract } from "./contract.js";

/** What the rest of main may do with this feature once it is registered. */
export interface UpdatesFeature {
  /** The settings changed; the timer starts, stops or re-arms with them. */
  setConfig(config: UpdateConfig): void;
}

export function register(ctx: MainContext, wire: Wire): UpdatesFeature {
  // Its state is pushed rather than polled: a download runs for a while, and a settings screen that
  // only learned about it when reopened would look stuck.
  const service = new UpdateService(ctx.config.updates(), (state) => wire.emit(updatesContract.onUpdate, state));

  wire.bind(updatesContract, {
    updateAction: (command) => {
      if (command === "check") return service.check(true);
      if (command === "download") return service.download();
      service.install();
      return service.current();
    },
  });

  service.start();
  return { setConfig: (config) => service.setConfig(config) };
}

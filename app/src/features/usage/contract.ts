/** Claude Code's usage figures: reading them, and installing the hook that publishes them. */
import { invoke } from "../../bridge/contract.js";
import type { StatusSnapshot } from "../../core/types.js";
import type { ActionResult, SettingsPayload } from "../../main/ipc.js";

/** How usage collection stands right now — the answer to "why are the gauges blank". */
export interface UsageState {
  /** Our Stop hook is registered in Claude Code's settings. */
  collecting: boolean;
  /** Figures have been published at least once; when, in epoch ms. */
  updatedAt: number | null;
  /** Windows Claude Code has actually reported, whether or not they are ticked for display. */
  reported: number;
  /** A copy with no installer behind it: deleting it cannot take the hook with it. */
  portable: boolean;
}

export const usageContract = {
  /** The usage windows as last published, filtered to the ones the settings show. */
  status: invoke<void, StatusSnapshot>("status:read"),
  /**
   * Install or remove the Stop hook that publishes Claude Code's usage figures. Answers with the
   * whole settings payload, because the screen that asked shows the collection state from it.
   */
  setUsageHook: invoke<boolean, ActionResult & { settings: SettingsPayload }>("usage:hook"),
} as const;

/** What the page may ask of the updater, and what the updater tells it. */
import { event, invoke } from "../../bridge/contract.js";
import type { UpdateState } from "../../core/updates.js";

/** What the settings screen can ask of the updater. */
export type UpdateCommand = "check" | "download" | "install";

export const updatesContract = {
  /** Check, download, or restart into what was downloaded. Answers with the state as it stands. */
  updateAction: invoke<UpdateCommand, UpdateState>("update:action"),
  /** A check or a download moved on. */
  onUpdate: event<UpdateState>("update:push"),
} as const;

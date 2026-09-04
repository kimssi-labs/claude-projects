/**
 * Every contract, in one place — the list the preload walks to build `window.hangar`.
 *
 * This imports contract files only, so it is safe in every process. It changes when a feature is
 * added or removed, and never when one is edited: that is the point of it.
 */
import { clipboardContract } from "../features/clipboard/contract.js";
import { dockContract } from "../features/dock/contract.js";
import { gitContract } from "../features/git/contract.js";
import { metricsContract } from "../features/metrics/contract.js";
import { projectsContract } from "../features/projects/contract.js";
import { settingsContract } from "../features/settings/contract.js";
import { updatesContract } from "../features/updates/contract.js";
import { usageContract } from "../features/usage/contract.js";

export const CONTRACTS = {
  ...projectsContract,
  ...settingsContract,
  ...updatesContract,
  ...gitContract,
  ...usageContract,
  ...metricsContract,
  ...clipboardContract,
  ...dockContract,
} as const;

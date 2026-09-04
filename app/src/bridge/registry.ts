/**
 * Every contract, in one place — the list the preload walks to build `window.hangar`.
 *
 * This imports contract files only, so it is safe in every process. It changes when a feature is
 * added or removed, and never when one is edited: that is the point of it.
 */
import { updatesContract } from "../features/updates/contract.js";

export const CONTRACTS = {
  ...updatesContract,
} as const;

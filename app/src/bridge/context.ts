/**
 * The shared state a feature's main side may reach — and the whole of it.
 *
 * Four members. A fifth earns its place only when a SECOND feature needs it; until then it belongs
 * to the feature. A context that grows to twenty members would be the old module-level globals
 * with a nicer name, which is the thing this replaces.
 */
import type { BrowserWindow } from "electron";

import type { ConfigStore } from "../core/config.js";
import type { Store } from "../core/store.js";

export interface MainContext {
  /** A getter, because there is no window before start-up and none after close. */
  window(): BrowserWindow | null;
  /** Each feature reads and writes its OWN section of the settings file, nobody else's. */
  config: ConfigStore;
  /** Projects and sessions as they are on disk. */
  store: Store;
  /** A line on screen: something finished, or could not. */
  notify(text: string): void;
}

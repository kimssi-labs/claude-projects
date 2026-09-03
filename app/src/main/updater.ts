/**
 * Updating the app in place, through electron-updater and the GitHub releases it already publishes.
 *
 * The decisions live in core/updates.ts, which is testable without Electron; this is the wiring:
 * load the library only where it can work, keep one state object, and tell the window when it
 * changes.
 *
 * electron-updater is required lazily. It reads app.getVersion() and the update metadata as it
 * loads, and in a dev run or a portable copy there is nothing for it to read — importing it at the
 * top of the file would make those launches fail before any of this could decline politely.
 */
import { app } from "electron";

import {
  CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, initialState, shouldCheck,
  type UpdateConfig, type UpdateState,
} from "../core/updates.js";

type Updater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: never[]) => void) => void;
};

/**
 * Whether this copy can replace itself.
 *
 * A dev run has no installer around it. A Windows portable build is one file the user put
 * somewhere, and rewriting it under itself is not something to attempt. A Linux AppImage can
 * update; a deb belongs to the package manager, and electron-updater says so by throwing, so that
 * one is left to find out at check time rather than guessed at here.
 */
function canUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === "win32" && process.env["PORTABLE_EXECUTABLE_DIR"]) return false;
  return true;
}

export class UpdateService {
  private state: UpdateState;
  private updater: Updater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private config: UpdateConfig;

  constructor(
    config: UpdateConfig,
    private readonly onChange: (state: UpdateState) => void,
    private readonly supported = canUpdate(),
  ) {
    this.config = config;
    this.state = initialState(app.getVersion(), this.supported);
  }

  current(): UpdateState {
    return this.state;
  }

  /** Start the timer, if automatic checks are on. Safe to call again when the setting changes. */
  start(): void {
    this.stop();
    if (!this.supported || !this.config.automatic) return;
    this.timer = setTimeout(() => {
      void this.check(false);
      this.timer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setConfig(config: UpdateConfig): void {
    this.config = config;
    this.start();
  }

  /** Ask for a check. Returns the state as it stands, whether or not the check went out. */
  async check(manual: boolean): Promise<UpdateState> {
    if (!shouldCheck(this.state, { manual, now: Date.now(), config: this.config })) return this.state;
    const updater = this.load();
    if (!updater) return this.state;
    this.set({ phase: "checking", error: null });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      // The events report most failures; this catches the ones thrown before any fire — a deb
      // build refusing outright, or a release with no metadata file beside its installers.
      this.set({ phase: "failed", error: message(error), checkedAt: Date.now() });
    }
    return this.state;
  }

  /** Fetch the update already found. Only meaningful once a check has found one. */
  async download(): Promise<UpdateState> {
    const updater = this.load();
    if (!updater || this.state.phase !== "available") return this.state;
    this.set({ phase: "downloading", percent: 0 });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      this.set({ phase: "failed", error: message(error) });
    }
    return this.state;
  }

  /** Quit and let the installer run. Does nothing until an update has been downloaded. */
  install(): void {
    if (this.state.phase !== "ready") return;
    this.load()?.quitAndInstall(false, true);
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private load(): Updater | null {
    if (!this.supported) return null;
    if (this.updater) return this.updater;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoUpdater } = require("electron-updater") as { autoUpdater: Updater };
      // Downloading is a decision of its own: an update found is announced, and fetched when the
      // setting says to or the user asks. Silent downloads on a metered connection are rude.
      autoUpdater.autoDownload = this.config.automatic;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("update-available", (info: { version?: string }) => {
        this.set({
          phase: this.config.automatic ? "downloading" : "available",
          latest: info?.version ?? null,
          checkedAt: Date.now(),
        });
      });
      autoUpdater.on("update-not-available", (info: { version?: string }) => {
        this.set({ phase: "current", latest: info?.version ?? null, checkedAt: Date.now() });
      });
      autoUpdater.on("download-progress", (progress: { percent?: number }) => {
        this.set({ phase: "downloading", percent: progress?.percent ?? 0 });
      });
      autoUpdater.on("update-downloaded", (info: { version?: string }) => {
        this.set({ phase: "ready", latest: info?.version ?? null, percent: 100 });
      });
      autoUpdater.on("error", (error: Error) => {
        this.set({ phase: "failed", error: message(error), checkedAt: Date.now() });
      });
      this.updater = autoUpdater;
      return autoUpdater;
    } catch (error) {
      this.set({ phase: "unsupported", error: message(error) });
      return null;
    }
  }
}

/**
 * The failure in words worth reading.
 *
 * electron-updater's own message for a release with no metadata is a 404 on latest.yml, which says
 * nothing to anyone who has not built one. Name the likely cause instead.
 */
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/latest.*\.yml/i.test(text) && /404|not found/i.test(text)) {
    return "That release carries no update metadata, so this version cannot update itself. The next release will.";
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ERR_INTERNET/i.test(text)) return "No connection to GitHub.";
  return text;
}

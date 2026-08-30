/**
 * The Electron main process: one window, the IPC surface the renderer is allowed to use, the
 * session launcher, the dock and the metrics sampler.
 *
 * All the reading and the command building live in `src/core`, which is why this file is mostly
 * wiring: the parts worth testing are tested without Electron.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from "electron";

import { ConfigStore, percentFloor } from "../core/config.js";
import { launchCommand, LINUX_TERMINALS, CLAUDE_EXE } from "../core/launcher.js";
import { MetricsHistory, SYSTEM_SERIES } from "../core/metrics.js";
import { claudeHome } from "../core/paths.js";
import { readStatus, installedMcpServers } from "../core/status.js";
import { Store } from "../core/store.js";
import type { DockConfig, LaunchConfig, MetricsSnapshot, ProjectInfo, StatusConfig, UiConfig } from "../core/types.js";
import { bandRect, bandThickness, displayKey, Dock, pickDisplay, setupKey } from "./dock.js";
import { DOCK_PERCENT } from "../core/constants.js";
import { CHANNEL, type ActionResult, type AppInfo, type DeleteRequest, type DisplayInfo, type OpenSessionRequest, type RenameRequest, type SettingsPayload } from "./ipc.js";
import { Worker } from "node:worker_threads";

import { sample, SAMPLE_INTERVAL_MS, type SessionTarget } from "./sampler.js";

const DEV_SERVER = "http://localhost:5273";
const WINDOW = { width: 1180, height: 760, minWidth: 420, minHeight: 320 } as const;
/** The strip the system draws its caption buttons in — our header is exactly this tall. */
const TITLE_BAR_HEIGHT = 32;
/** How long a drag has to stop before its new thickness is written down. */
const DOCK_RESIZE_SETTLE_MS = 400;
/** A band within this many pixels of what was asked for counts as "the platform agreed". */
const FLOOR_SLACK_PX = 4;
/** Page background and text, per theme, for the caption-button strip. */
const OVERLAY = {
  light: { color: "#faf9f7", symbolColor: "#1c1b1a" },
  dark: { color: "#141413", symbolColor: "#eceae4" },
} as const;

/** Small enough to read at a glance, large enough for the longest step. */
const SPLASH = { width: 380, height: 96 } as const;
/**
 * How long start-up may take before it is worth explaining itself.
 *
 * A warm start puts the window up in about two seconds, and a splash that flashes for a moment is
 * worse than no splash at all; a cold start after an install took 23 s here, which is not.
 */
const SPLASH_AFTER_MS = 450;

/**
 * Open the splash, hidden, and show it only if the app is still starting a moment later.
 *
 * It is created straight away rather than after the delay because creating a window is itself work:
 * doing that at the moment the app is busiest is how a "loading" window arrives after the loading.
 */
function openSplash(): void {
  try {
    splash = new BrowserWindow({
      ...SPLASH,
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      center: true,
      backgroundColor: resolvedTheme() === "dark" ? "#1c1b1a" : "#ffffff",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    splash.setMenu(null);
    const theme = resolvedTheme();
    void splash.loadFile(join(__dirname, "..", "renderer", "splash.html"));
    // Set from here rather than by a script in the page: the splash keeps a no-script CSP.
    splash.webContents.once("did-finish-load", () => {
      void splash?.webContents
        .executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`)
        .catch(() => undefined);
      splashSays(pendingStep);
    });
    splashTimer = setTimeout(() => {
      splashTimer = null;
      if (splash && !splash.isDestroyed() && !window?.isVisible()) splash.show();
    }, SPLASH_AFTER_MS);
  } catch (error) {
    console.error("[hangar] splash unavailable:", (error as Error).message);
    splash = null;
  }
}

/** What the app is doing right now, in the splash and in the log. */
function splashSays(step: string): void {
  pendingStep = step;
  if (!splash || splash.isDestroyed()) return;
  // executeJavaScript runs in the page, so the splash needs no preload and no channel of its own.
  void splash.webContents
    .executeJavaScript(`document.getElementById("step").textContent = ${JSON.stringify(step)};`)
    .catch(() => {
      /* the page may not have loaded yet; the next step will say the same thing */
    });
}

function closeSplash(): void {
  if (splashTimer) {
    clearTimeout(splashTimer);
    splashTimer = null;
  }
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

/** Which palette the window is actually in, resolving "system" the way the page does. */
function resolvedTheme(): "light" | "dark" {
  const mode = config.ui().theme;
  if (mode === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return mode;
}

/** Keep the caption buttons on the same background as the page under them. */
function paintTitleBar(): void {
  if (!window || window.isDestroyed() || process.platform === "darwin") return;
  try {
    window.setTitleBarOverlay({ ...OVERLAY[resolvedTheme()], height: TITLE_BAR_HEIGHT });
  } catch {
    /* only Windows has an overlay to paint */
  }
}

const store = new Store();
const config = new ConfigStore();
const history = new MetricsHistory();
let window: BrowserWindow | null = null;
let dock: Dock | null = null;
let sampling: NodeJS.Timeout | null = null;
let worker: Worker | null = null;
let splash: BrowserWindow | null = null;
let splashTimer: NodeJS.Timeout | null = null;
/** The last step named before the page finished loading, so it is not lost. */
let pendingStep = "Starting…";
let lastProjects: ProjectInfo[] = [];

function which(exe: string): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync(command, [exe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).find((line) => line.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** Resolve the claude executable, never the bare name: a shell function of that name would win. */
function claudeExecutable(): string | null {
  return which(CLAUDE_EXE);
}

function detectLinuxTerminal(configured: string): { exe: string; args: readonly string[] } | null {
  if (configured) return { exe: configured, args: [] };
  for (const candidate of LINUX_TERMINALS) if (which(candidate.exe)) return candidate;
  return null;
}

function findProject(dir: string): ProjectInfo | undefined {
  return lastProjects.find((p) => p.dir === dir);
}

/** Do two rectangles share any pixel? Enough to decide a saved position is still reachable. */
function rectsOverlap(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function scanProjects(): ProjectInfo[] {
  const t0 = Date.now();
  lastProjects = store.scan();
  const ms = Date.now() - t0;
  if (ms > 200) console.log(`[hangar] scan took ${ms} ms for ${lastProjects.length} projects`);
  pushTargets();                                  // the running set may have changed
  return lastProjects;
}

async function createWindow(): Promise<void> {
  // Reopen where it was left, but only if that rectangle is still on a connected display — a saved
  // position from a monitor that is now unplugged would open the window off-screen.
  const savedBounds = config.ui().window;
  const onScreen = savedBounds
    ? screen.getAllDisplays().some((display) => rectsOverlap(display.workArea, savedBounds))
    : false;

  window = new BrowserWindow({
    ...WINDOW,
    ...(onScreen && savedBounds ? savedBounds : {}),
    show: false,
    backgroundColor: resolvedTheme() === "dark" ? "#141413" : "#faf9f7",
    title: "Hangar",
    autoHideMenuBar: true,
    // Docked, a title bar is a strip of the band that shows nothing. The caption buttons are drawn
    // over our own header instead, so the window fills its reservation edge to edge.
    titleBarStyle: "hidden",
    ...(process.platform === "win32"
      ? { titleBarOverlay: { ...OVERLAY[resolvedTheme()], height: TITLE_BAR_HEIGHT } }
      : {}),
    icon: join(__dirname, "..", "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  dock = new Dock(window);
  nativeTheme.on("updated", paintTitleBar);
  // Plugging a monitor in or out is a different arrangement, with its own remembered dock.
  const rearranged = (): void => void reapplyDockForSetup();
  screen.on("display-added", rearranged);
  screen.on("display-removed", rearranged);
  screen.on("display-metrics-changed", (_event, _display, changed) => {
    // A work-area change is usually OUR band being applied or released; reacting to it would
    // re-dock the window the moment the user undocked it. Resolution and scaling are real changes.
    if (changed.every((metric) => metric === "workArea")) return;
    rearranged();
  });
  // Dragging a docked window out of its band is how you undock it; the saved setting follows.
  // Applying a band talks to the shell, so a drag must not do it per mouse-move: settle first.
  let resizeTimer: NodeJS.Timeout | null = null;
  dock.onUserResize = (thickness) => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      // The same drag can end in an undock; by the time this fires there may be no band to size.
      if (!dock?.isDocked) return;
      const current = config.dock(null, setupKey());
      if (!current.enabled || !window) return;
      const { display } = pickDisplay(current.device);
      const span = bandThickness(dock?.workArea(display) ?? display.workArea, current.edge);
      const percent = Math.max(DOCK_PERCENT.min, Math.min(DOCK_PERCENT.max, Math.round((thickness / span) * 100)));
      if (percent === current.percent) return;
      config.saveDock({ ...current, percent }, setupKey());
      window.webContents.send(CHANNEL.settingsPush, settingsPayload());
    }, DOCK_RESIZE_SETTLE_MS);
  };
  dock.onUserUndock = () => {
    if (resizeTimer) {                            // a pending size for a band that no longer exists
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    const current = config.dock(null, setupKey());
    if (!current.enabled) return;
    config.saveDock({ ...current, enabled: false }, setupKey());
    window?.webContents.send(CHANNEL.settingsPush, settingsPayload());
  };

  // Subscribe BEFORE loading: `ready-to-show` fires during the load, and a listener attached
  // afterwards misses it — the window then stays hidden forever with no error anywhere.
  window.once("ready-to-show", () => {
    window?.show();
    closeSplash();
  });
  // `close` and not `closed`: the reservation is removed while the window still exists, and
  // synchronously, because nothing waits for us once the process starts shutting down.
  window.on("close", () => {
    // Docked, the bounds are the band's, not the user's choice — do not remember those.
    if (window && !dock?.isDocked && !window.isMinimized()) {
      config.saveUi({ ...config.ui(), window: window.getNormalBounds() });
    }
    dock?.releaseSync();
  });
  window.on("closed", () => {
    window = null;
  });

  const devUrl = process.env["HANGAR_DEV"] ? DEV_SERVER : null;
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  window.show();                                  // belt and braces: the load is done, so is the wait

  const saved = config.dock(null, setupKey());
  if (saved.enabled) {
    const placement = await dock.apply(saved);
    if (placement.note) window.webContents.send(CHANNEL.appInfo, placement.note);
  }
}

/** Sessions worth measuring right now: the running ones, from the last scan. */
function sampleTargets(): SessionTarget[] {
  return lastProjects.flatMap((project) =>
    project.sessions.filter((s) => s.live && s.pid).map((s) => ({ sessionId: s.id, pid: s.pid as number })));
}

function acceptSnapshot(snapshot: MetricsSnapshot): void {
  history.push(snapshot);
  history.keepOnly(Object.keys(snapshot.sessions));
  window?.webContents.send(CHANNEL.metricsPush, snapshot);
}

function stopSampling(): void {
  if (worker) {
    worker.postMessage({ stop: true });
    void worker.terminate();
    worker = null;
  }
  if (sampling) {
    clearInterval(sampling);
    sampling = null;
  }
}

/**
 * The in-process sampler, used only if the worker cannot start.
 *
 * Packaging can put the worker script somewhere `new Worker()` will not follow; measuring on the
 * main thread is worse than measuring off it, but far better than not measuring at all.
 */
function startInlineSampling(): void {
  if (sampling) return;
  sampling = setInterval(() => {
    void sample(sampleTargets())
      .then(acceptSnapshot)
      .catch(() => {
        /* a sampling hiccup must never take the app down */
      });
  }, SAMPLE_INTERVAL_MS);
}

/** Runs only when the setting says so — the whole point of the setting is that off costs nothing. */
/** Runs only when the setting says so — the whole point of the setting is that off costs nothing. */
function startSampling(): void {
  if (worker || sampling) return;
  if (!config.ui().monitor) return;
  try {
    worker = new Worker(join(__dirname, "samplerWorker.js"), { workerData: { intervalMs: SAMPLE_INTERVAL_MS } });
    worker.on("message", (snapshot: MetricsSnapshot) => acceptSnapshot(snapshot));
    worker.on("error", (error) => {
      console.error("[hangar] sampler worker failed, measuring in-process:", error.message);
      worker = null;
      startInlineSampling();
    });
    worker.unref();                               // a sampler must never hold the app open
    pushTargets();
  } catch (error) {
    console.error("[hangar] sampler worker unavailable:", (error as Error).message);
    startInlineSampling();
  }
}

/**
 * Re-read the dock for the monitors attached right now, and do what it says.
 *
 * The band is released either way first: the monitor it was on may be the one that just left.
 */
async function reapplyDockForSetup(): Promise<void> {
  if (!window || !dock) return;
  const wanted = config.dock(null, setupKey());
  await dock.release();
  if (!wanted.enabled) {
    window.webContents.send(CHANNEL.settingsPush, settingsPayload());
    return;
  }
  const placement = await dock.apply(wanted);
  if (placement.note) console.log(`[hangar] ${placement.note}`);
  window.webContents.send(CHANNEL.settingsPush, settingsPayload());
}

/** Tell the sampler which sessions to follow; called after every scan. */
function pushTargets(): void {
  worker?.postMessage({ targets: sampleTargets() });
}

function settingsPayload(): SettingsPayload {
  const dockConfig = config.dock(null, setupKey());
  const { display } = pickDisplay(dockConfig.device);
  const span = bandThickness(display.workArea, dockConfig.edge);
  const probe = readStatus(undefined, config.status()).health;
  void probe;
  const claudeJson = safeJson(store.paths.claudeJson);
  const mcpProbe = safeJson(store.paths.mcpStatus);
  return {
    dock: dockConfig,
    status: config.status(),
    launch: config.launch(),
    ui: config.ui(),
    mcpServers: installedMcpServers(claudeJson, mcpProbe),
    dockDevices: config.dockDevices(),
    dockFloor: config.dockFloor(dockConfig.edge),
    minPercent: percentFloor(config.dockFloor(dockConfig.edge), span),
  };
}

function safeJson(file: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function displays(): DisplayInfo[] {
  const saved = new Set(config.dockDevices());
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  return all.map((display, index) => {
    const key = displayKey(display);
    return {
      // The key, not the id: ids are reshuffled between runs, and the saved dock has to survive.
      id: key,
      // Windows leaves `label` empty for some monitors, and "" is not something to pick from a list.
      label: display.label || `Monitor ${index + 1}`,
      bounds: display.bounds,
      primary: display.id === primary.id,
      saved: saved.has(key) || saved.has(String(display.id)),
    };
  });
}

function registerIpc(): void {
  ipcMain.handle(CHANNEL.scan, () => scanProjects());
  ipcMain.handle(CHANNEL.status, () => readStatus(undefined, config.status()));
  ipcMain.handle(CHANNEL.metrics, () => ({
    system: history.get(SYSTEM_SERIES),
    sessions: Object.fromEntries(history.keys().filter((k) => k !== SYSTEM_SERIES).map((k) => [k, history.get(k)])),
  }));

  ipcMain.handle(CHANNEL.openSession, (_event, request: OpenSessionRequest): ActionResult => {
    const project = findProject(request.projectDir);
    if (!project?.cwd) return { ok: false, message: "That project's folder is unknown." };
    if (!project.exists) return { ok: false, message: `Folder is gone: ${project.cwd}` };
    const exe = claudeExecutable();
    if (!exe) return { ok: false, message: "claude is not on PATH — install Claude Code first." };
    const session = request.sessionId ? project.sessions.find((s) => s.id === request.sessionId) : null;
    if (session?.live) return { ok: false, message: "That session is already running." };

    const launch: LaunchConfig = config.launch();
    const command = launchCommand({
      cwd: project.cwd,
      claudeExe: exe,
      sessionId: session?.id ?? null,
      displayName: session?.named ? session.title : null,
      config: launch,
      target: request.target,
      platform: process.platform,
      hasWindowsTerminal: process.platform === "win32" && Boolean(which("wt.exe")),
      linuxTerminal: process.platform === "win32" ? null : detectLinuxTerminal(launch.terminal),
    });
    try {
      const child = spawn(command.exe, command.args, {
        cwd: command.cwd,
        detached: true,
        stdio: "ignore",
        // Without a terminal of its own the shell needs a console window to appear in.
        windowsHide: false,
        shell: false,
      });
      child.unref();
      return { ok: true, message: `Opened ${session ? session.title : project.name}` };
    } catch (error) {
      return { ok: false, message: `Could not start: ${(error as Error).message}` };
    }
  });

  ipcMain.handle(CHANNEL.renameSession, (_event, request: RenameRequest): ActionResult => {
    const project = findProject(request.projectDir);
    const session = project?.sessions.find((s) => s.id === request.sessionId);
    if (!session) return { ok: false, message: "Session not found." };
    store.renameSession(session, request.title);
    scanProjects();
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.renameProject, (_event, request: RenameRequest): ActionResult => {
    const project = findProject(request.projectDir);
    if (!project) return { ok: false, message: "Project not found." };
    store.renameProject(project, request.title);
    scanProjects();
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.deleteSession, async (_event, request: DeleteRequest): Promise<ActionResult> => {
    const project = findProject(request.projectDir);
    const session = project?.sessions.find((s) => s.id === request.sessionId);
    if (!session) return { ok: false, message: "Session not found." };
    if (session.live) return { ok: false, message: "That session is running." };
    const confirmed = await confirm(`Delete session “${session.title}”?`, "The transcript is removed from disk.");
    if (!confirmed) return { ok: false };
    store.deleteSession(session);
    scanProjects();
    return { ok: true, message: "Session deleted." };
  });

  ipcMain.handle(CHANNEL.deleteProject, async (_event, request: DeleteRequest): Promise<ActionResult> => {
    const project = findProject(request.projectDir);
    if (!project) return { ok: false, message: "Project not found." };
    if (project.liveCount) return { ok: false, message: "A session in this project is running." };
    const extra = project.hasMemory ? " Its memory/ folder goes with it." : "";
    const confirmed = await confirm(
      `Delete “${project.name}” and its ${project.sessions.length} session(s)?`,
      `Only Claude Code's history is deleted; your code is untouched.${extra}`,
    );
    if (!confirmed) return { ok: false };
    store.deleteProject(project);
    scanProjects();
    return { ok: true, message: "Project deleted." };
  });

  ipcMain.handle(CHANNEL.revealProject, (_event, dir: string): ActionResult => {
    const project = findProject(dir);
    if (!project?.cwd || !project.exists) return { ok: false, message: "Folder is not available." };
    shell.openPath(project.cwd);
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.loadSettings, () => settingsPayload());
  ipcMain.handle(CHANNEL.displays, () => displays());

  ipcMain.handle(CHANNEL.saveSettings, (_event, payload: {
    dock?: DockConfig; status?: StatusConfig; launch?: LaunchConfig; ui?: UiConfig;
  }) => {
    if (payload.dock) config.saveDock(payload.dock);
    if (payload.status) config.saveStatus(payload.status);
    if (payload.launch) config.saveLaunch(payload.launch);
    // The theme lives with the rest of the remembered position, so it comes back with it.
    if (payload.ui) {
      config.saveUi({ ...config.ui(), ...payload.ui });
      paintTitleBar();                            // the theme may have just changed
      if (config.ui().monitor) startSampling();
      else stopSampling();
    }
    const saved = settingsPayload();
    // Tell the window too: whoever changed a setting, the screen should already agree with it.
    window?.webContents.send(CHANNEL.settingsPush, saved);
    return saved;
  });

  ipcMain.handle(CHANNEL.applyDock, async (_event, wanted: DockConfig) => {
    if (!window || !dock) return { ok: false, message: "No window." };
    const { display } = pickDisplay(wanted.device);
    // Apply exactly what was asked for. Forcing the percentage up to a previously measured floor
    // made the next measurement bigger again, and the floor climbed with it — 12 % became 26 %,
    // then 35 %. The floor is what the slider stops at, not what the band is set to.
    const applied: DockConfig = { ...wanted };
    config.saveDock(applied, setupKey());
    const placement = await dock.apply(applied);
    // What the window really got is the floor for this axis: remember it so the slider can stop
    // there. A band that came back the size it asked for proves there is no floor above it, which
    // is what un-learns a floor measured when something else was wrong.
    const got = bandThickness(placement.applied, applied.edge);
    const asked = bandThickness(bandRect(dock.workArea(display), applied.edge, applied.percent), applied.edge);
    if (got > asked + FLOOR_SLACK_PX) config.saveDockFloor(applied.edge, got);
    else config.saveDockFloor(applied.edge, 0);   // it fitted, so nothing is stopping it here
    return { ok: true, message: placement.note ?? undefined, settings: settingsPayload() };
  });

  ipcMain.handle(CHANNEL.releaseDock, async () => {
    await dock?.release();
    const current = config.dock(null, setupKey());
    config.saveDock({ ...current, enabled: false }, setupKey());
    return settingsPayload();
  });

  ipcMain.handle(CHANNEL.saveUi, (_event, ui: Partial<UiConfig>) => config.saveUi({ ...config.ui(), ...ui }));

  ipcMain.handle(CHANNEL.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    claudeFound: Boolean(claudeExecutable()),
    home: claudeHome(),
    dockSupported: process.platform === "win32" || !process.env["WAYLAND_DISPLAY"],
    dockNote: process.env["WAYLAND_DISPLAY"]
      ? "Wayland does not let an application reserve screen space."
      : null,
  }));

  ipcMain.handle(CHANNEL.quit, () => app.quit());
}

async function confirm(message: string, detail: string): Promise<boolean> {
  if (!window) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  return response === 0;
}

app.whenReady().then(async () => {
  openSplash();
  splashSays("Reading settings…");
  registerIpc();
  splashSays("Scanning projects…");
  scanProjects();
  splashSays(`Opening ${lastProjects.length} project${lastProjects.length === 1 ? "" : "s"}…`);
  await createWindow();
  splashSays("Starting the monitor…");
  startSampling();
  closeSplash();
  console.log(`[hangar] window ready — ${lastProjects.length} projects from ${claudeHome()}`);
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

process.on("uncaughtException", (error) => {
  console.error("[hangar] fatal:", error);
  closeSplash();                                  // never leave a splash on screen with no app
});

// An app that disappears should say why. These are the three ways it can happen without anyone
// closing a window, and all three are silent by default.
process.on("unhandledRejection", (reason) => console.error("[hangar] unhandled rejection:", reason));
app.on("render-process-gone", (_event, _contents, details) =>
  console.error("[hangar] renderer gone:", details.reason, details.exitCode));
app.on("child-process-gone", (_event, details) =>
  console.error("[hangar] child gone:", details.type, details.reason, details.exitCode));

app.on("window-all-closed", () => {
  console.log("[hangar] window-all-closed -> quitting");
  stopSampling();
  dock?.releaseSync();
  app.quit();
});

// Windows is already handled synchronously on close; X11 needs an `xprop` call, which does need
// waiting for — so hold the quit open exactly once, for that.
let clearingStruts = false;
app.on("before-quit", (event) => {
  dock?.releaseSync();                            // never leave a reserved edge behind
  if (process.platform === "win32" || clearingStruts) return;
  clearingStruts = true;
  event.preventDefault();
  void dock?.release().finally(() => app.quit());
});

export { which, detectLinuxTerminal };
void execFile;
void existsSync;

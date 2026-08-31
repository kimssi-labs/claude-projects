/**
 * The Electron main process: one window, the IPC surface the renderer is allowed to use, the
 * session launcher, the dock and the metrics sampler.
 *
 * All the reading and the command building live in `src/core`, which is why this file is mostly
 * wiring: the parts worth testing are tested without Electron.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeTheme, Notification, screen, shell } from "electron";

import { ConfigStore, percentFloor } from "../core/config.js";
import { launchCommand, LINUX_TERMINALS, CLAUDE_EXE } from "../core/launcher.js";
import { MetricsHistory, SYSTEM_SERIES } from "../core/metrics.js";
import { claudeHome } from "../core/paths.js";
import { readStatus, installedMcpServers } from "../core/status.js";
import { clipFileName, Store } from "../core/store.js";
import type { DockConfig, LaunchConfig, MetricsSnapshot, ProjectInfo, StatusConfig, UiConfig } from "../core/types.js";
import { bandRect, bandThickness, displayKey, Dock, pickDisplay, setupKey } from "./dock.js";
import { sendPaste } from "./keystroke.js";
import { DOCK_PERCENT } from "../core/constants.js";
import { CHANNEL, type ActionResult, type AppInfo, type DeleteRequest, type DisplayInfo, type OpenSessionRequest, type RenameRequest, type PastedImage, type SettingsPayload, type WindowCommand, type WindowState } from "./ipc.js";
import { Worker } from "node:worker_threads";

import { sample, SAMPLE_INTERVAL_MS, type SessionTarget } from "./sampler.js";

const DEV_SERVER = "http://localhost:5273";
const WINDOW = { width: 1180, height: 760, minWidth: 420, minHeight: 320 } as const;
/** How long a drag has to stop before its new thickness is written down. */
const DOCK_RESIZE_SETTLE_MS = 400;
/** A band within this many pixels of what was asked for counts as "the platform agreed". */
const FLOOR_SLACK_PX = 4;
/** Small enough to read at a glance, large enough for the longest step. */
const SPLASH = { width: 380, height: 96 } as const;
/** How long the app waits for its own first paint before showing the window regardless. */
const FIRST_PAINT_CAP_MS = 4000;
/** How long the app waits for the loading window to paint before getting on with it. */
const SPLASH_PAINT_CAP_MS = 450;
/** A moment for the clipboard write to settle before the paste is sent. */
const PASTE_KEY_DELAY_MS = 60;
/** Electron's indeterminate value for the taskbar progress; -1 clears it. */
const TASKBAR_BUSY = 2;
const TASKBAR_IDLE = -1;
/** The page's own background, so the window is painted the instant it appears. */
const WINDOW_BACKGROUND = { light: "#ffffff", dark: "#1c1b1a" } as const;

/** Which palette the window is in, resolving "system" the way the page does. */
function resolvedTheme(): "light" | "dark" {
  const mode = config.ui().theme;
  if (mode === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return mode;
}

/**
 * The loading window: shown first, alone, and closed when the app is ready to take over.
 *
 * Shown at construction rather than on its first paint — a window with a background colour is
 * painted by the compositor as soon as it appears — and the app's own window is not created until
 * this one has painted, because two renderers starting at once is what made the loading window
 * arrive at the end of the loading it was meant to explain.
 */
function openSplash(): void {
  try {
    splash = new BrowserWindow({
      ...SPLASH,
      show: true,
      frame: false,
      resizable: false,
      skipTaskbar: false,
      alwaysOnTop: true,
      center: true,
      title: "Hangar",
      icon: join(__dirname, "..", "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
      backgroundColor: WINDOW_BACKGROUND[resolvedTheme()],
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    splash.setMenu(null);
    splash.setProgressBar(TASKBAR_BUSY);
    const theme = resolvedTheme();
    void splash.loadFile(join(__dirname, "..", "renderer", "splash.html"));
    splash.webContents.once("did-finish-load", () => {
      void splash?.webContents
        .executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`)
        .catch(() => undefined);
      splashSays(pendingStep);
    });
  } catch (error) {
    console.error("[hangar] splash unavailable:", (error as Error).message);
    splash = null;
  }
}

/**
 * Resolves when the loading window has its content, or after `capMs` if it is being slow.
 *
 * `dom-ready` rather than `did-finish-load`: the panel is painted from the parsed document, and
 * waiting for the last subresource is time the app could have spent starting.
 */
function splashReady(capMs: number): Promise<void> {
  if (!splash || splash.isDestroyed()) return Promise.resolve();
  if (!splash.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, capMs);
    splash?.webContents.once("dom-ready", done);
  });
}

/** What the app is doing, named in the loading window. */
function splashSays(step: string): void {
  pendingStep = step;
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents
    .executeJavaScript(`{ const el = document.getElementById("step"); if (el) el.textContent = ${JSON.stringify(step)}; }`)
    .catch(() => {
      /* the page may not have parsed yet; the next step will say the same thing */
    });
}

function closeSplash(): void {
  if (splash && !splash.isDestroyed()) {
    splash.setProgressBar(TASKBAR_IDLE);
    splash.destroy();
  }
  splash = null;
}

/** What the caption buttons should show right now. */
function windowState(): WindowState {
  return {
    maximized: window ? !window.isDestroyed() && window.isMaximized() : false,
    docked: dock?.isDocked === true,
  };
}

function pushWindowState(): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(CHANNEL.windowStatePush, windowState());
}

const store = new Store();
const config = new ConfigStore();
const history = new MetricsHistory();
let window: BrowserWindow | null = null;
let dock: Dock | null = null;
let sampling: NodeJS.Timeout | null = null;
let worker: Worker | null = null;
let splash: BrowserWindow | null = null;
/** The step named before the loading page had parsed, so it is not lost. */
let pendingStep = "Starting…";
/** Whether the system-wide paste shortcut is held; false when something else owns it. */
let pasteHotkeyActive = false;
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
    // Hidden until it has something to show: the loading window is on screen meanwhile, and a
    // half-drawn app appearing before it is ready is worse than a moment more of the splash.
    show: false,
    backgroundColor: WINDOW_BACKGROUND[resolvedTheme()],
    title: "Hangar",
    autoHideMenuBar: true,
    // Docked, a title bar is a strip of the band that shows nothing. The caption buttons are drawn
    // over our own header instead, so the window fills its reservation edge to edge.
    // No system overlay either: the buttons are drawn in the header, because the middle one has to
    // say "restore" while docked, which the platform has no way of knowing.
    titleBarStyle: "hidden",
    icon: join(__dirname, "..", "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Restored with the same call that measured them. Passing a saved rectangle as constructor
  // options came back three pixels wider: the constructor and `setBounds` do not agree about the
  // invisible resize border, and a window that grows a little on every run is a bug people notice.
  if (onScreen && savedBounds) window.setBounds(savedBounds);

  dock = new Dock(window);
  window.on("maximize", () => {
    // setMaximizable(false) stops the caption button and the system menu, not the API or every
    // window-manager gesture. While docked the band already is the full state, so undo it.
    if (dock?.isDocked && window && !window.isDestroyed()) window.unmaximize();
    pushWindowState();
  });
  window.on("unmaximize", pushWindowState);
  window.on("restore", pushWindowState);
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
      const resized = { ...current, percent };
      config.saveDock(resized, setupKey());
      // Re-apply, always: a band is anchored to its edge, and dragging the OUTER edge of a
      // right- or bottom-docked window changes its size without moving it, which leaves a strip of
      // desktop between the band and the screen edge. Applying the size puts it back on the edge.
      void dock.apply(resized).then(() => {
        window?.webContents.send(CHANNEL.settingsPush, settingsPayload());
      });
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
    pushWindowState();
    window?.webContents.send(CHANNEL.settingsPush, settingsPayload());
  };

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

  // Subscribed BEFORE loading: `ready-to-show` fires during the load, and a listener attached
  // afterwards waits for an event that has already happened — which is start-up hanging forever.
  const firstPaint = new Promise<void>((resolve) => window?.once("ready-to-show", () => resolve()));

  const devUrl = process.env["HANGAR_DEV"] ? DEV_SERVER : null;
  const loaded = devUrl
    ? window.loadURL(devUrl)
    : window.loadFile(join(__dirname, "..", "renderer", "index.html"));

  await loaded;
  // `ready-to-show` is the renderer's first paint: React has run, so what appears is the app. The
  // cap is a safety net — a window that never reports a paint must not keep the app behind a splash.
  await Promise.race([
    firstPaint,
    new Promise<void>((resolve) => setTimeout(resolve, FIRST_PAINT_CAP_MS)),
  ]);
  const saved = config.dock(null, setupKey());
  if (saved.enabled) {
    const placement = await dock.apply(saved);
    if (placement.note) window?.webContents.send(CHANNEL.appInfo, placement.note);
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

/** Put the window in the band `wanted` describes, and report what the platform actually gave. */
async function applyDockConfig(wanted: DockConfig): Promise<ActionResult & { settings?: SettingsPayload }> {
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
  pushWindowState();
  return { ok: true, message: placement.note ?? undefined, settings: settingsPayload() };
}

/**
 * A screenshot on the clipboard, as a file a terminal session can be pointed at.
 *
 * Claude Code takes an image by path and a terminal cannot paste a bitmap, so the clipboard's image
 * is written out and its PATH put back on the clipboard. Nobody has to save anything by hand.
 */
function pasteClipboardImage(): PastedImage {
  const image = clipboard.readImage();
  if (image.isEmpty()) return { ok: false, message: "No image on the clipboard." };
  try {
    const dir = store.paths.clips;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, clipFileName());
    writeFileSync(file, image.toPNG());
    clipboard.writeText(file);
    return { ok: true, file, message: `Image ready to paste: ${file}` };
  } catch (error) {
    return { ok: false, message: `Could not save the image: ${(error as Error).message}` };
  }
}

/**
 * Register the system-wide paste shortcut, replacing whatever was registered before.
 *
 * Pressed in a terminal, it turns the clipboard's image into a path and presses Ctrl+V there, so
 * the path arrives where the cursor already is.
 */
function registerPasteHotkey(): boolean {
  globalShortcut.unregisterAll();
  const accelerator = config.launch().pasteHotkey.trim();
  if (!accelerator) {
    pasteHotkeyActive = false;
    return true;                                  // deliberately off
  }
  try {
    pasteHotkeyActive = globalShortcut.register(accelerator, () => {
      const result = pasteClipboardImage();
      window?.webContents.send(CHANNEL.pasteResult, result);
      // The shortcut is pressed in some other window, so the answer has to be visible from there —
      // a toast inside a window nobody is looking at is the same as saying nothing.
      announce(result.ok ? "Screenshot ready" : "Nothing to paste", result.message ?? "");
      // sendPaste waits for the user's fingers to leave Ctrl+Alt before it sends anything.
      if (result.ok) setTimeout(() => void sendPaste(), PASTE_KEY_DELAY_MS);
    });
  } catch (error) {
    console.error("[hangar] paste shortcut unavailable:", (error as Error).message);
    pasteHotkeyActive = false;
  }
  if (accelerator && !pasteHotkeyActive) {
    console.error(`[hangar] the paste shortcut ${accelerator} is held by something else`);
  }
  return pasteHotkeyActive;
}

/** A desktop notification: the only feedback that reaches a user working in another window. */
function announce(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: true }).show();
  } catch {
    /* a machine with notifications switched off is not a failure worth reporting */
  }
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
    pasteHotkeyActive,
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

  /**
   * A screenshot on the clipboard, as a file a terminal session can be pointed at.
   *
   * Claude Code takes an image by path, and a terminal cannot paste a bitmap — so the useful move
   * is to write the clipboard image out and put its PATH back on the clipboard, ready to paste.
   */
  ipcMain.handle(CHANNEL.pasteImage, (): PastedImage => pasteClipboardImage());
  ipcMain.handle(CHANNEL.windowState, () => windowState());

  ipcMain.handle(CHANNEL.windowCommand, async (_event, command: WindowCommand) => {
    if (!window || window.isDestroyed()) return windowState();
    if (command === "minimize") window.minimize();
    else if (command === "close") window.close();
    else if (dock?.isDocked) {
      // Docked IS the maximised state, so "restore" here means: be an ordinary window again.
      await dock.release();
      dock.onUserUndock?.();
    } else if (window.isMaximized()) {
      window.unmaximize();
    } else {
      // ...and "maximise" means go back to the band, when this arrangement has one to go back to.
      const saved = config.dock(null, setupKey());
      if (saved.device || saved.percent) await applyDockConfig({ ...saved, enabled: true });
      else window.maximize();
    }
    pushWindowState();
    return windowState();
  });

  ipcMain.handle(CHANNEL.saveSettings, (_event, payload: {
    dock?: DockConfig; status?: StatusConfig; launch?: LaunchConfig; ui?: UiConfig;
  }) => {
    // With the arrangement key: without it the per-arrangement entry keeps the old edge and size
    // and wins on the next read, so changing the dock in Settings looked like it did nothing.
    if (payload.dock) config.saveDock(payload.dock, setupKey());
    if (payload.status) config.saveStatus(payload.status);
    if (payload.launch) {
      config.saveLaunch(payload.launch);
      registerPasteHotkey();                      // the shortcut may have just changed
    }
    // The theme lives with the rest of the remembered position, so it comes back with it.
    if (payload.ui) {
      config.saveUi({ ...config.ui(), ...payload.ui });
      if (config.ui().monitor) startSampling();
      else stopSampling();
    }
    const saved = settingsPayload();
    // Tell the window too: whoever changed a setting, the screen should already agree with it.
    window?.webContents.send(CHANNEL.settingsPush, saved);
    return saved;
  });

  ipcMain.handle(CHANNEL.applyDock, async (_event, wanted: DockConfig) => applyDockConfig(wanted));


  ipcMain.handle(CHANNEL.releaseDock, async () => {
    await dock?.release();
    pushWindowState();
    const current = config.dock(null, setupKey());
    config.saveDock({ ...current, enabled: false }, setupKey());
    pushWindowState();
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
  // Alone on the machine for its first frame: the app's renderer is a much heavier start.
  await splashReady(SPLASH_PAINT_CAP_MS);

  splashSays("Reading settings…");
  registerIpc();
  splashSays("Scanning projects…");
  scanProjects();
  splashSays(`Opening ${lastProjects.length} project${lastProjects.length === 1 ? "" : "s"}…`);
  await createWindow();
  splashSays("Starting the monitor…");
  startSampling();
  registerPasteHotkey();

  closeSplash();
  window?.show();
  window?.focus();
  console.log(`[hangar] window ready — ${lastProjects.length} projects from ${claudeHome()}`);
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

process.on("uncaughtException", (error) => {
  console.error("[hangar] fatal:", error);
  closeSplash();                                  // never leave a loading window with no app
  window?.show();
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
app.on("will-quit", () => globalShortcut.unregisterAll());

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

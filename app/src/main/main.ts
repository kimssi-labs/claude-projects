/**
 * The Electron main process: one window, the IPC surface the renderer is allowed to use, the
 * session launcher, the dock and the metrics sampler.
 *
 * All the reading and the command building live in `src/core`, which is why this file is mostly
 * wiring: the parts worth testing are tested without Electron.
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeTheme, Notification, screen, shell } from "electron";

import { ConfigStore, percentFloor } from "../core/config.js";
import { launchCommand, sessionEnvironment, LINUX_TERMINALS, CLAUDE_EXE } from "../core/launcher.js";
import { register as registerMetrics } from "../features/metrics/main.js";
import { claudeHome, homePaths } from "../core/paths.js";
import { register as registerUsage } from "../features/usage/main.js";
import { wire } from "../bridge/build.js";
import type { MainContext } from "../bridge/context.js";
import { register as registerUpdates } from "../features/updates/main.js";
import { headOf, isLinkedWorktree, mainCheckoutOf } from "./gitStatus.js";
import { register as registerGit } from "../features/git/main.js";
import { clipFileName, Store } from "../core/store.js";
import type { DockConfig, GitConfig, LaunchConfig, MetricsSnapshot, ProjectInfo, StatusConfig, UiConfig, UpdateConfig } from "../core/types.js";
import { bandRect, bandThickness, displayKey, Dock, pickDisplay, setupKey } from "./dock.js";
import { sendPaste } from "./keystroke.js";
import { startClipboardWatch, stopClipboardWatch } from "./clipboardWatch.js";
import { DOCK_PERCENT } from "../core/constants.js";
import { CHANNEL, MENU_SEPARATOR, PAGES, type ActionResult, type AddProjectResult, type AppInfo, type MenuItemSpec, type PinRequest, type PageName, type DeleteRequest, type DisplayInfo, type DockDrag, type OpenSessionRequest, type RenameRequest, type PastedImage, type SettingsPayload, type WindowCommand, type WindowState } from "./ipc.js";

import type { SessionTarget } from "./sampler.js";

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

/**
 * What a feature's main side may reach, and the plumbing it registers through.
 *
 * Built before the window exists, which is why `window` is a getter: the closures read the
 * variable when they are called, not now. Nothing else about the shared state is handed out — a
 * feature that needs more asks for it here, and gets it only once a second feature does too.
 */
const context: MainContext = {
  window: () => window,
  config,
  store,
  notify: (text) => window?.webContents.send(CHANNEL.toast, text),
};
const wiring = wire(ipcMain, (channel, value) => window?.webContents.send(channel, value));
// Registered here rather than with the others because `settingsPayload` below composes its state
// into every settings answer. That dependency belongs to settings and moves with it; until then the
// feature is a module-level constant, not a mutable global.
const usageFeature = registerUsage(context, wiring, { settingsPayload });
// Module level for the same reason: the monitor starts at ready and stops at quit, both outside
// registerIpc. The sessions worth measuring are projects' knowledge, handed over as a function.
const metricsFeature = registerMetrics(context, wiring, { targets: sampleTargets });
let window: BrowserWindow | null = null;
let dock: Dock | null = null;
let splash: BrowserWindow | null = null;
/** The step named before the loading page had parsed, so it is not lost. */
let pendingStep = "Starting…";
/** Whether the system-wide paste shortcut is held; false when something else owns it. */
let pasteHotkeyActive = false;
let lastProjects: ProjectInfo[] = [];

/**
 * Which shells this machine actually has, remembered for the life of the run.
 *
 * `where` costs a process each time and the answer does not change while the app is open; without
 * the cache this would run up to three times per session opened.
 */
const shellPresence = new Map<string, boolean>();
function haveExecutable(exe: string): boolean {
  const known = shellPresence.get(exe);
  if (known !== undefined) return known;
  const found = Boolean(which(exe));
  shellPresence.set(exe, found);
  return found;
}

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

/** `rect` moved and, if need be, shrunk until the whole of it is inside `area`. */
function clampInto(rect: Electron.Rectangle, area: Electron.Rectangle): Electron.Rectangle {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return {
    width, height,
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height),
  };
}

/**
 * Give an undocked window a window's shape and place, wholly on screen.
 *
 * `release()` only gives the reservation back: the window itself stayed exactly where the band
 * was — a strip pressed against a screen edge, half of it sometimes past it. The remembered
 * floating rectangle comes back when there is one; otherwise the default size, centred on the
 * display the band was on. Either way the result is clamped inside that display's work area.
 */
function placeFloating(): void {
  if (!window || window.isDestroyed()) return;
  const display = screen.getDisplayMatching(window.getBounds());
  const area = display.workArea;
  const saved = config.ui().window;
  const rect = saved && screen.getAllDisplays().some((d) => rectsOverlap(d.workArea, saved))
    ? saved
    : {
      width: WINDOW.width,
      height: WINDOW.height,
      x: area.x + Math.round((area.width - WINDOW.width) / 2),
      y: area.y + Math.round((area.height - WINDOW.height) / 2),
    };
  window.setBounds(clampInto(rect, screen.getDisplayMatching(rect).workArea));
}

function scanProjects(): ProjectInfo[] {
  const t0 = Date.now();
  lastProjects = store.scan();
  // The head line is three small reads per project; the change count is a git process, so it is
  // asked for separately and only for the row in front of the user.
  if (config.git().enabled) {
    for (const project of lastProjects) {
      if (project.cwd && project.exists) {
        project.git = headOf(project.cwd);
        project.worktree = Boolean(project.git) && isLinkedWorktree(project.cwd);
      }
    }
    // Second pass: a worktree points at a folder, and the list is keyed by project. Match the two so
    // the window can show each worktree under the repository it came from.
    // Compared with separators and case normalised: the pointer file writes forward slashes where
    // a transcript's cwd on Windows has backslashes, and the two would never match as written.
    const key = (path: string): string => {
      let real = path;
      try {
        // 8.3 short names are the one that actually bit: TEMP reads C:\Users\EXAMPL~1 in a
        // transcript's cwd and C:/Users/ExampleUser in git's own pointer file. Only resolving
        // the real path makes those the same folder.
        real = realpathSync.native(path);
      } catch {
        /* gone, or unreachable: fall back to what was written */
      }
      return real.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    };
    const byPath = new Map(lastProjects
      .filter((p) => p.cwd)
      .map((p) => [key(p.cwd as string), p.dir]));
    for (const project of lastProjects) {
      if (!project.worktree || !project.cwd) continue;
      const repo = mainCheckoutOf(project.cwd);
      project.parentDir = repo ? byPath.get(key(repo)) ?? null : null;
    }
  }
  const ms = Date.now() - t0;
  if (ms > 200) console.log(`[hangar] scan took ${ms} ms for ${lastProjects.length} projects`);
  metricsFeature.retarget();                      // the running set may have changed
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
      config.saveDock({ ...current, percent }, setupKey());
      // Tell the shell the new extent, and nothing else. Re-applying the dock would place the
      // window at `percent` rounded to a whole number — up to twenty pixels away from where the
      // drag ended — which is the jump-and-flicker at the end of every resize. The outer edges
      // cannot be dragged at all now, so there is no longer a band to pull back onto its edge.
      void dock.resizeTo(thickness).then(() => {
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
  // Told again, because the renderer asked for this state while it was first rendering — which is
  // before the band above exists. Without this the caption arrow offers to dock a window that is
  // already a band, and the title bar stays undraggable for one that is not.
  pushWindowState();
}

/** Sessions worth measuring right now: the running ones, from the last scan. */
function sampleTargets(): SessionTarget[] {
  return lastProjects.flatMap((project) =>
    project.sessions.filter((s) => s.live && s.pid).map((s) => ({ sessionId: s.id, pid: s.pid as number })));
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
  if (wanted.enabled) {
    const placement = await dock.apply(wanted);
    if (placement.note) console.log(`[hangar] ${placement.note}`);
  }
  // Plugging a monitor in or out docks and undocks the window on its own, and the caption arrow
  // reads this rather than the settings — so it has to be told, on both paths.
  pushWindowState();
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
  const file = saveClipImage(image);
  if (!file) return { ok: false, message: "Could not save the image." };
  clipboard.writeText(file);
  return { ok: true, file, message: `Image ready to paste: ${file}` };
}

/** Write an image into the clips folder. Shared by the shortcut and the clipboard watch. */
function saveClipImage(image: Electron.NativeImage): string | null {
  try {
    mkdirSync(store.paths.clips, { recursive: true });
    const file = join(store.paths.clips, clipFileName());
    writeFileSync(file, image.toPNG());
    return file;
  } catch (error) {
    console.error("[hangar] could not save the clipboard image:", (error as Error).message);
    return null;
  }
}

/**
 * Give copied screenshots a path, so the ordinary paste key works in a terminal.
 *
 * Nothing is intercepted: the clipboard is left holding the picture AND the path, and each window
 * takes the one it understands.
 */
function applyClipboardWatch(): void {
  if (!config.launch().autoClipPath) {
    stopClipboardWatch();
    return;
  }
  startClipboardWatch({ save: saveClipImage, clipsDir: store.paths.clips });
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

function settingsPayload(): SettingsPayload {
  const dockConfig = config.dock(null, setupKey());
  const { display } = pickDisplay(dockConfig.device);
  const span = bandThickness(display.workArea, dockConfig.edge);
  return {
    dock: dockConfig,
    status: config.status(),
    launch: config.launch(),
    ui: config.ui(),
    dockDevices: config.dockDevices(),
    dockFloor: config.dockFloor(dockConfig.edge),
    pasteHotkeyActive,
    usage: usageFeature.state(),
    updates: config.updates(),
    git: config.git(),
    gitAvailable: Boolean(which("git")),
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
      // Only a name the user chose. --name is persisted as a *custom* title, so passing the title
      // this app happens to be showing overwrites the one Claude Code generated — permanently, in
      // its own tab and /resume picker too. Left alone, it keeps refining that title as the
      // conversation grows, and this app now reads it rather than competing with it.
      displayName: session?.named ? session.title : null,
      config: launch,
      target: request.target,
      platform: process.platform,
      hasWindowsTerminal: process.platform === "win32" && Boolean(which("wt.exe")),
      linuxTerminal: process.platform === "win32" ? null : detectLinuxTerminal(launch.terminal),
    }, haveExecutable);
    try {
      const child = spawn(command.exe, command.args, {
        cwd: command.cwd,
        // Not process.env as it is: started from inside a Claude Code session, this app carries that
        // session's markers, and a claude that inherits them stops saving its transcript.
        env: sessionEnvironment(process.env),
        detached: true,
        stdio: "ignore",
        // Without a terminal of its own the shell needs a console window to appear in.
        windowsHide: false,
        shell: false,
      });
      child.unref();
      const what = session ? session.title : project.name;
      return {
        ok: true,
        message: command.fellBack
          ? `Opened ${what} in ${command.shell} — the shell chosen in Settings is not installed here.`
          : `Opened ${what}`,
      };
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
    // The window asks in its own dialog, which matches the app; the native box is the fallback for
    // a caller that did not.
    if (!request.confirmed
      && !await confirm(`Delete session “${session.title}”?`, "The transcript is removed from disk.")) {
      return { ok: false };
    }
    store.deleteSession(session);
    scanProjects();
    return { ok: true, message: "Session deleted." };
  });

  ipcMain.handle(CHANNEL.deleteProject, async (_event, request: DeleteRequest): Promise<ActionResult> => {
    const project = findProject(request.projectDir);
    if (!project) return { ok: false, message: "Project not found." };
    if (project.liveCount) return { ok: false, message: "A session in this project is running." };
    const extra = project.hasMemory ? " Its memory/ folder goes with it." : "";
    if (!request.confirmed && !await confirm(
      `Delete “${project.name}” and its ${project.sessions.length} session(s)?`,
      `Only Claude Code's history is deleted; your code is untouched.${extra}`,
    )) {
      return { ok: false };
    }
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

  /**
   * A folder chosen in a dialog becomes a project — one with no sessions yet, from which the
   * first can be started. Until now the only way in was to run claude in a terminal there first.
   */
  ipcMain.handle(CHANNEL.addProject, async (): Promise<AddProjectResult> => {
    if (!window) return { ok: false };
    // Electron 43 changed the default starting folder from "wherever you were last" to Downloads,
    // which is nowhere near where anyone keeps code. Start beside the project used most recently
    // instead — the list is newest first, so that is the first row with a folder still on disk.
    const recent = lastProjects.find((p) => p.cwd && p.exists)?.cwd;
    const picked = await dialog.showOpenDialog(window, {
      title: "Add a project folder",
      properties: ["openDirectory", "createDirectory"],
      ...(recent ? { defaultPath: dirname(recent) } : {}),
    });
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { ok: false };
    const dir = store.addProject(folder);
    scanProjects();
    return { ok: true, dir, message: `Added ${folder}` };
  });

  /** A right-click menu — the OS's own, so it looks and behaves like every other one on the machine. */
  ipcMain.handle(CHANNEL.contextMenu, (event, items: MenuItemSpec[]) => new Promise<string | null>((resolve) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const menu = Menu.buildFromTemplate(items.map((item) => (item.id === MENU_SEPARATOR
      ? { type: "separator" as const }
      : {
        label: item.label,
        enabled: item.enabled !== false,
        type: item.checked === undefined ? ("normal" as const) : ("checkbox" as const),
        checked: item.checked,
        click: () => resolve(item.id),
      })));
    // Closed without a choice. The close callback can run before a click lands, so it waits a beat;
    // a promise settles once, so whichever comes first is the answer.
    menu.popup({ window: owner, callback: () => setTimeout(() => resolve(null), 100) });
  }));

  ipcMain.handle(CHANNEL.togglePin, (_event, request: PinRequest): ActionResult => {
    const pinned = config.togglePin(request.kind, request.key);
    scanProjects();
    return { ok: true, message: pinned ? "Pinned to the top." : "Unpinned." };
  });

  // Features on the contract bridge register themselves here; each hands back the one thing the
  // rest of main may still ask of it. The handlers written out around this are the features that
  // have not moved yet.
  const updatesFeature = registerUpdates(context, wiring);
  // Git depends on the project rows, and says so: these are handed over rather than reached for.
  const gitFeature = registerGit(context, wiring, { findProject, rescan: scanProjects, which });

  /**
   * Count what is uncommitted in one project — the expensive half, asked for a row at a time.
   *
   * Resolves with the count, or null when there is nothing to count or git did not answer. The
   * renderer asks for the selected row only, so a long list never spawns a process per project.
   */
  ipcMain.handle(CHANNEL.openPage, async (_event, page: PageName): Promise<ActionResult> => {
    const url = PAGES[page];
    if (!url) return { ok: false };
    await shell.openExternal(url);
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
    else if (command === "dock") {
      if (dock?.isDocked) {
        await dock.release();
        placeFloating();
        dock.onUserUndock?.();
      } else {
        // Back to the band this arrangement of monitors remembers.
        await applyDockConfig({ ...config.dock(null, setupKey()), enabled: true });
      }
    } else {
      // Maximise means fill the screen, and never the band: a docked window gives the edge back
      // first, so the two states cannot be held at once. It is placed as a window before it is
      // maximised, so the restore AFTER the maximise has a window shape to come back to — without
      // this, restoring returned to the band's rectangle, pressed against the edge.
      if (dock?.isDocked) {
        await dock.release();
        placeFloating();
        dock.onUserUndock?.();
      }
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    pushWindowState();
    return windowState();
  });

  ipcMain.handle(CHANNEL.saveSettings, (_event, payload: {
    dock?: DockConfig; status?: StatusConfig; launch?: LaunchConfig; ui?: UiConfig; updates?: UpdateConfig;
    git?: GitConfig;
  }) => {
    // With the arrangement key: without it the per-arrangement entry keeps the old edge and size
    // and wins on the next read, so changing the dock in Settings looked like it did nothing.
    if (payload.dock) config.saveDock(payload.dock, setupKey());
    if (payload.status) config.saveStatus(payload.status);
    if (payload.git) {
      config.saveGit(payload.git);
      scanProjects();                              // the rows gain or lose their git line at once
      gitFeature.restartSweep();                   // and the timer starts, stops or re-arms with it
    }
    if (payload.updates) {
      config.saveUpdates(payload.updates);
      updatesFeature.setConfig(payload.updates);   // the timer starts, stops or re-arms with it
    }
    if (payload.launch) {
      config.saveLaunch(payload.launch);
      registerPasteHotkey();                      // the shortcut may have just changed
      applyClipboardWatch();                      // as may the automatic path
    }
    // The theme lives with the rest of the remembered position, so it comes back with it.
    if (payload.ui) {
      config.saveUi({ ...config.ui(), ...payload.ui });
      if (config.ui().monitor) metricsFeature.start();
      else metricsFeature.stop();
    }
    const saved = settingsPayload();
    // Tell the window too: whoever changed a setting, the screen should already agree with it.
    window?.webContents.send(CHANNEL.settingsPush, saved);
    return saved;
  });

  ipcMain.handle(CHANNEL.applyDock, async (_event, wanted: DockConfig) => applyDockConfig(wanted));

  /**
   * The band's own resize grip.
   *
   * The window frame does not resize while docked — that is what takes the resize cursor off the
   * three sides that are against the screen — so the one side that may be dragged is a handle in
   * the page. Each step only moves the window, which is cheap; the shell is told once, at the end,
   * because reserving costs the best part of half a second.
   */
  ipcMain.on(CHANNEL.dragDock, (_event, { thickness, done }: DockDrag) => {
    if (!dock?.isDocked) return;
    if (!done) {
      dock.preview(thickness);
      return;
    }
    const current = config.dock(null, setupKey());
    if (!current.enabled) return;
    const { display } = pickDisplay(current.device);
    const span = bandThickness(dock.workArea(display), current.edge);
    const percent = Math.max(DOCK_PERCENT.min, Math.min(DOCK_PERCENT.max, Math.round((thickness / span) * 100)));
    config.saveDock({ ...current, percent }, setupKey());
    void dock.resizeTo(thickness).then(() => {
      window?.webContents.send(CHANNEL.settingsPush, settingsPayload());
    });
  });


  ipcMain.handle(CHANNEL.releaseDock, async () => {
    await dock?.release();
    placeFloating();
    pushWindowState();
    const current = config.dock(null, setupKey());
    config.saveDock({ ...current, enabled: false }, setupKey());
    pushWindowState();
    return settingsPayload();
  });

  ipcMain.handle(CHANNEL.saveUi, (_event, ui: Partial<UiConfig>) => config.saveUi({ ...config.ui(), ...ui }));

  ipcMain.handle(CHANNEL.appInfo, (): AppInfo => ({
    // app.getLocale() is the OS's own choice, which is what an unset language should follow.
    locale: app.getLocale(),
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
  metricsFeature.start();
  registerPasteHotkey();
  applyClipboardWatch();

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
  metricsFeature.stop();
  dock?.releaseSync();
  app.quit();
});

// Windows is already handled synchronously on close; X11 needs an `xprop` call, which does need
// waiting for — so hold the quit open exactly once, for that.
let clearingStruts = false;
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopClipboardWatch();
});

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

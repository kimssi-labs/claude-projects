/**
 * The Electron main process: the shell.
 *
 * One window and the loading window before it, the caption buttons, the settings answer composed
 * from every feature's slice, and the features themselves — each registered here on the bridge and
 * living in its own folder under `src/features`. All the reading and the command building live in
 * `src/core`, which is why this file is mostly wiring: the parts worth testing are tested without
 * Electron.
 */
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, Notification, screen, shell } from "electron";

import { wire } from "../bridge/build.js";
import type { MainContext } from "../bridge/context.js";
import { ConfigStore } from "../core/config.js";
import { CLAUDE_HOME_ENV, claudeHome } from "../core/paths.js";
import { Store } from "../core/store.js";
import { followTheme, resolveTheme, surfaceFor, WindowChrome } from "./chrome.js";
import { register as registerClipboard } from "../features/clipboard/main.js";
import { register as registerDock } from "../features/dock/main.js";
import { register as registerGit } from "../features/git/main.js";
import { register as registerMetrics } from "../features/metrics/main.js";
import { register as registerProjects } from "../features/projects/main.js";
import { register as registerSettings } from "../features/settings/main.js";
import { register as registerUpdates } from "../features/updates/main.js";
import { register as registerUsage } from "../features/usage/main.js";
import { claudeExecutable, which } from "./executables.js";
import { CHANNEL, MENU_SEPARATOR, PAGES, type ActionResult, type AppInfo, type MenuItemSpec, type PageName, type WindowCommand, type WindowState } from "./ipc.js";

const DEV_SERVER = "http://localhost:5273";
const WINDOW = { width: 1180, height: 760, minWidth: 420, minHeight: 320 } as const;
/** Small enough to read at a glance, large enough for the longest step. */
const SPLASH = { width: 380, height: 96 } as const;
/** How long the app waits for its own first paint before showing the window regardless. */
const FIRST_PAINT_CAP_MS = 4000;
/** How long the app waits for the loading window to paint before getting on with it. */
const SPLASH_PAINT_CAP_MS = 450;
/** Electron's indeterminate value for the taskbar progress; -1 clears it. */
const TASKBAR_BUSY = 2;
const TASKBAR_IDLE = -1;
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
      backgroundColor: surfaceFor(config.ui().theme),   // the page's own, so it is painted the instant it appears
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    splash.setMenu(null);
    splash.setProgressBar(TASKBAR_BUSY);
    const theme = resolveTheme(config.ui().theme);
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
// Every feature registers here, at module level, and each hands back the one thing the rest of main
// may still ask of it. Where two need each other — usage answers into the settings payload, and
// asks for it back — the reference is a closure, read when called, after both exist.
const usageFeature = registerUsage(context, wiring, { settingsPayload: () => settingsFeature.payload() });
// The list every other feature reads, registered first: metrics asks it which sessions run, git
// asks it for rows. Its one dependency points the other way — "the running set may have changed" —
// and goes through main, so projects never imports metrics. Called at scan time, once both exist.
const projectsFeature = registerProjects(context, wiring, { scanned: () => metricsFeature.retarget() });
// Module level for the same reason: the monitor starts at ready and stops at quit, both outside
// registerIpc. The sessions worth measuring are projects' knowledge, handed over as a function.
const metricsFeature = registerMetrics(context, wiring, { targets: projectsFeature.liveTargets });
// Likewise: armed at ready, released at quit, and the settings payload asks whether the shortcut
// took. The desktop notification is the shell's, handed over.
const clipboardFeature = registerClipboard(context, wiring, { announce });
// The window itself stays the shell's; dock borrows it through the context and hands back the one
// thing that is the shell's to do — giving an undocked window a window's shape.
const dockFeature = registerDock(context, wiring, {
  settingsPayload: () => settingsFeature.payload(),
  pushSettings: () => settingsFeature.push(),
  placeFloating,
  appNote: (text) => window?.webContents.send(CHANNEL.appInfo, text),
});
const updatesFeature = registerUpdates(context, wiring);
// Git depends on the project rows, and says so: these are handed over rather than reached for.
const gitFeature = registerGit(context, wiring, { findProject: projectsFeature.find, rescan: projectsFeature.scan, which });
// Last, because it composes the others' slices. What a saved section sets in motion is decided here,
// where every feature is in view — settings itself knows the config store and nothing else.
const settingsFeature = registerSettings(context, wiring, {
  slices: () => ({
    ...dockFeature.slice(),
    pasteHotkeyActive: clipboardFeature.active(),
    usage: usageFeature.state(),
    gitAvailable: Boolean(which("git")),
  }),
  applied: (patch) => {
    if (patch.dock) dockFeature.save(patch.dock);
    if (patch.git) {
      projectsFeature.scan();                      // the rows gain or lose their git line at once
      gitFeature.restartSweep();                   // and the timer starts, stops or re-arms with it
    }
    if (patch.updates) updatesFeature.setConfig(patch.updates);   // the timer starts, stops or re-arms with it
    if (patch.launch) clipboardFeature.rearm();   // the shortcut, and the automatic path, may have changed
    if (patch.ui) {
      if (config.ui().monitor) metricsFeature.start();
      else metricsFeature.stop();
      chrome?.theme(config.ui().theme);            // Chromium's frame and a band's border follow the page
    }
  },
});
let window: BrowserWindow | null = null;
/** The window's frame — its look is kept by this, not by whoever last touched the window. */
let chrome: WindowChrome | null = null;
let splash: BrowserWindow | null = null;
/** Start-up is over and the window is on screen — before that a second launch has nothing to raise. */
let shown = false;
/** The step named before the loading page had parsed, so it is not lost. */
let pendingStep = "Starting…";

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
    backgroundColor: surfaceFor(config.ui().theme),   // the page's own, so it is painted the instant it appears
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

  chrome = new WindowChrome(window);
  chrome.theme(config.ui().theme);
  dockFeature.attach(window, chrome);
  window.on("maximize", pushWindowState);
  window.on("unmaximize", pushWindowState);
  window.on("restore", pushWindowState);

  // `close` and not `closed`: the reservation is removed while the window still exists, and
  // synchronously, because nothing waits for us once the process starts shutting down.
  window.on("close", () => {
    // Docked, the bounds are the band's, not the user's choice — do not remember those.
    if (window && !dockFeature.isDocked() && !window.isMinimized()) {
      config.saveUi({ ...config.ui(), window: window.getNormalBounds() });
    }
    dockFeature.releaseSync();
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
  await dockFeature.restore();
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

/** The shell's own handlers: the window, its menus and pages, and what the app is. */
function registerIpc(): void {
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

  ipcMain.handle(CHANNEL.openPage, async (_event, page: PageName): Promise<ActionResult> => {
    const url = PAGES[page];
    if (!url) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.windowState, () => windowState());

  ipcMain.handle(CHANNEL.windowCommand, async (_event, command: WindowCommand) => {
    if (!window || window.isDestroyed()) return windowState();
    if (command === "minimize") window.minimize();
    else if (command === "close") window.close();
    else {
      // Maximise means fill the screen, and never the band: a docked window gives the edge back
      // first. Main asks dock for that here, as the place the two are composed.
      await dockFeature.undockForMaximize();
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    pushWindowState();
    return windowState();
  });

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

/** Start-up, once the platform is ready: splash, scan, window, monitor. */
async function start(): Promise<void> {
  followTheme(config.ui().theme);                 // before any window: the splash is painted in it too
  openSplash();
  // Alone on the machine for its first frame: the app's renderer is a much heavier start.
  await splashReady(SPLASH_PAINT_CAP_MS);

  splashSays("Reading settings…");
  registerIpc();
  splashSays("Scanning projects…");
  const found = projectsFeature.scan().length;
  splashSays(`Opening ${found} project${found === 1 ? "" : "s"}…`);
  await createWindow();
  splashSays("Starting the monitor…");
  metricsFeature.start();
  clipboardFeature.rearm();

  closeSplash();
  window?.show();
  window?.focus();
  shown = true;
  console.log(`[hangar] window ready — ${found} projects from ${claudeHome()}`);
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
}

// A different Claude home is a different Hangar — its own browser profile and its own instance lock
// below — so the test suite and a developer's build run beside the installed app, not instead of it.
if (process.env[CLAUDE_HOME_ENV]) app.setPath("userData", join(claudeHome(), "cache", "hangar-profile"));

// One Hangar at a time. A second launch — the shortcut again, `claude --p` from another terminal —
// hands over to the running one and leaves: two would fight over the same band and the same
// settings file, and there is nothing a second window could show that the first does not.
if (!app.requestSingleInstanceLock()) {
  // exit, not quit: nothing has been created that the quit events would have to release.
  app.exit(0);
} else {
  app.on("second-instance", () => {
    // Not during start-up: showing the window then puts it beside the splash, and it is about to
    // appear anyway.
    if (!shown || !window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  void app.whenReady().then(start);
}

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
  dockFeature.releaseSync();
  app.quit();
});

app.on("will-quit", () => {
  clipboardFeature.dispose();
});

// Dock decides whether the quit has to wait (X11 struts need an `xprop` call); the shell only holds
// the door, and exactly once.
app.on("before-quit", (event) => {
  const pending = dockFeature.releaseOnQuit();
  if (!pending) return;
  event.preventDefault();
  void pending.finally(() => app.quit());
});

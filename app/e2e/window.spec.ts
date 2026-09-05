/**
 * The window itself: how it opens, where it sits, and what docking does to the desktop.
 *
 * These drive the real shell — the band really is reserved on the primary monitor while a test
 * runs — so every test releases it again in a `finally`, and the bands are small.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const SESSION = "eeeeeeee-1111-2222-3333-444444444444";

const roots: string[] = [];
test.afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will clear %TEMP% eventually */
    }
  }
});

/** A throwaway Claude home; `dock` is written as a saved band, so the app starts docked. */
function fixture(ui: Record<string, unknown> = {}, dock?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-window-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, "projects", dir, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: workspace, sessionId: SESSION })}\n`,
  );
  writeFileSync(join(home, "history.jsonl"), `${JSON.stringify({ display: "프롬프트", sessionId: SESSION })}\n`);
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  if (Object.keys(ui).length || dock) {
    writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui, ...(dock ? { dock } : {}) }));
  }
  return home;
}

/** The app's own window — `firstWindow()` can hand back the splash, which then closes. */
async function mainWindow(app: ElectronApplication): Promise<Page> {
  for (;;) {
    const found = app.windows().find((w) => w.url().includes("index.html"));
    if (found) return found;
    await app.waitForEvent("window");
  }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // --lang pins what app.getLocale() reports; the window follows the machine otherwise.
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: home },
  });
  // An app that dies mid-test says how — the code is the only clue a "browser has been closed" leaves.
  app.process().once("exit", (code, signal) => {
    if (code !== 0) console.log(`  [e2e] the app exited with code ${code}${signal ? ` (${signal})` : ""}`);
  });
  const page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1200);                // the first scan and the first paint
  return { app, page };
}

async function bounds(app: ElectronApplication): Promise<Electron.Rectangle> {
  const rect = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds());
  if (!rect) throw new Error("the app has no window");
  return rect;
}

/** A Win32 RECT as koffi fills it. */
type Rc = { left: number; top: number; right: number; bottom: number };

/** The rectangles a docking assertion is about, in the physical pixels the shell itself works in. */
interface NativeFrames {
  /** The client area — where the page is. This is what has to fill the reservation. */
  client: Electron.Rectangle;
  /** What DWM paints: the client plus a 1 px system border on the left, right and bottom. */
  painted: Electron.Rectangle;
  /**
   * How many rows below its own rectangle the window actually draws — a whole DIP at a fractional
   * scale (two rows at 125 %), none at 100 % or for a window whose top is the screen's. What is
   * SEEN of the window is `painted` moved down by this.
   */
  lift: number;
  monitor: Electron.Rectangle;
  /** The work area as the shell keeps it — the band's open face must sit exactly on it. */
  work: Electron.Rectangle;
}

/**
 * Four rectangles are in play and only one is what a docking assertion means: the client area, where
 * the page is drawn. The window's own rectangle includes an invisible resize border, seven pixels on
 * three sides; what DWM paints is inside that; and since Electron 43 the client area is inside THAT
 * by the 1 px system border on the left, right and bottom — undrawn while docked, so a band whose
 * painted frame was flush still showed the desktop as a thin line. `getBounds()` is no help — from
 * Electron 43 it reports something else again. So the docking assertions ask Windows, for the client
 * area and for the monitor's own work area, and compare like with like. Elsewhere `bounds()` is
 * still right: those tests compare the window with itself.
 */
async function nativeFrames(app: ElectronApplication): Promise<NativeFrames> {
  // By absolute path: inside `evaluate` there is no module to resolve a bare name against.
  const koffiPath = join(process.cwd(), "node_modules", "koffi");
  const frames = await app.evaluate(({ BrowserWindow, screen }, koffiFrom) => {
    // The app's window by what it shows — getAllWindows() has no order, and a test may have opened another.
    const all = BrowserWindow.getAllWindows();
    const win = all.find((w) => w.webContents.getURL().includes("index.html")) ?? all[0];
    if (!win) return null;
    // The same rule the app decides by (`insetFor`): the one DIP of frame room a fractional scale
    // keeps, as whole rows, and none for a window whose top is the screen's — it draws where it is
    // there (measured). Not read back from the window: the two bounds disagree about it over time.
    const liftOf = (paintedTop: number, monitorTop: number): number => {
      if (paintedTop === monitorTop) return 0;
      const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
      return Number.isInteger(scale) ? 0 : Math.ceil(scale);
    };
    const fallback = (): NativeFrames => {
      const b = win.getBounds();
      const d = screen.getDisplayMatching(b);
      return { client: b, painted: b, lift: 0, monitor: d.bounds, work: d.workArea };
    };
    if (process.platform !== "win32") return fallback();
    // The evaluated function is compiled in the main process but not as a module, so `require` is
    // not in scope the way it is inside the app's own files.
    const req = (typeof require === "function"
      ? require
      : (process as unknown as { mainModule?: { require: NodeRequire } }).mainModule?.require
    ) as NodeRequire | undefined;
    if (!req) return fallback();
    // Bound once and kept: koffi registers a named type for the whole process, so declaring the
    // struct again on the second call is an error rather than a no-op. The app registers its own
    // "RECT" when it docks, hence the different names here.
    const cache = globalThis as unknown as { __frames?: (hwnd: number) => Omit<NativeFrames, "lift"> };
    if (!cache.__frames) {
      const koffi = req(koffiFrom) as typeof import("koffi");
      const RECT = koffi.struct("RECT_e2e", { left: "long", top: "long", right: "long", bottom: "long" });
      const POINT = koffi.struct("POINT_e2e", { x: "long", y: "long" });
      const MONITORINFO = koffi.struct("MONITORINFO_e2e", { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
      const user32 = koffi.load("user32.dll");
      const GetClientRect = user32.func("__stdcall", "GetClientRect", "bool", ["intptr", koffi.out(koffi.pointer(RECT))]);
      const ClientToScreen = user32.func("__stdcall", "ClientToScreen", "bool", ["intptr", koffi.inout(koffi.pointer(POINT))]);
      const MonitorFromWindow = user32.func("__stdcall", "MonitorFromWindow", "intptr", ["intptr", "uint32"]);
      const GetMonitorInfoW = user32.func("__stdcall", "GetMonitorInfoW", "bool", ["intptr", koffi.inout(koffi.pointer(MONITORINFO))]);
      const DwmGetWindowAttribute = koffi.load("dwmapi.dll").func("__stdcall", "DwmGetWindowAttribute", "int32", [
        "intptr", "uint32", koffi.out(koffi.pointer(RECT)), "uint32",
      ]);
      const box = (rc: Rc): Electron.Rectangle => ({ x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top });
      cache.__frames = (hwnd) => {
        const size: Rc = { left: 0, top: 0, right: 0, bottom: 0 };
        GetClientRect(hwnd, size);
        const origin = { x: 0, y: 0 };
        ClientToScreen(hwnd, origin);
        const painted: Rc = { left: 0, top: 0, right: 0, bottom: 0 };
        DwmGetWindowAttribute(hwnd, 9, painted, 16);                   // 9 = DWMWA_EXTENDED_FRAME_BOUNDS
        const info = { cbSize: 40, rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 };
        GetMonitorInfoW(MonitorFromWindow(hwnd, 2), info);             // 2 = MONITOR_DEFAULTTONEAREST
        return {
          client: { x: origin.x, y: origin.y, width: size.right, height: size.bottom },
          painted: box(painted), monitor: box(info.rcMonitor), work: box(info.rcWork),
        };
      };
    }
    const frames = cache.__frames(Number(win.getNativeWindowHandle().readBigUInt64LE(0)));
    return { ...frames, lift: liftOf(frames.painted.y, frames.monitor.y) };
  }, koffiPath);
  if (!frames) throw new Error("the app has no window");
  return frames;
}

/** Where the window is actually seen: its painted frame, moved down by however far it draws. */
function seen(f: NativeFrames): Electron.Rectangle {
  return { ...f.painted, y: f.painted.y + f.lift };
}

/**
 * A display's work area as the shell keeps it, in physical pixels — asked of Windows, not converted
 * from Electron's DIP figures, which are two pixels out on a 125 % monitor. The difference between
 * this before and after docking is the reservation itself: the strip a band must fill.
 */
async function nativeWorkArea(app: ElectronApplication, displayId: string): Promise<Electron.Rectangle> {
  const koffiPath = join(process.cwd(), "node_modules", "koffi");
  return app.evaluate(({ screen }, { koffiFrom, id }) => {
    // The app names a display by its DIP geometry, the same way `workAreaOf` looks one up.
    const display = screen.getAllDisplays().find((d) => `${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}` === id);
    if (!display) throw new Error(`no display ${id}`);
    if (process.platform !== "win32") return display.workArea;
    const req = (typeof require === "function"
      ? require
      : (process as unknown as { mainModule?: { require: NodeRequire } }).mainModule?.require
    ) as NodeRequire | undefined;
    if (!req) return display.workArea;
    const cache = globalThis as unknown as { __workAt?: (x: number, y: number) => Electron.Rectangle };
    if (!cache.__workAt) {
      const koffi = req(koffiFrom) as typeof import("koffi");
      const RECT = koffi.struct("RECT_e2e_work", { left: "long", top: "long", right: "long", bottom: "long" });
      const POINT = koffi.struct("POINT_e2e_work", { x: "long", y: "long" });
      const MONITORINFO = koffi.struct("MONITORINFO_e2e_work", { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
      const user32 = koffi.load("user32.dll");
      const MonitorFromPoint = user32.func("__stdcall", "MonitorFromPoint", "intptr", [POINT, "uint32"]);
      const GetMonitorInfoW = user32.func("__stdcall", "GetMonitorInfoW", "bool", ["intptr", koffi.inout(koffi.pointer(MONITORINFO))]);
      cache.__workAt = (x, y) => {
        const info = { cbSize: 40, rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 };
        GetMonitorInfoW(MonitorFromPoint({ x, y }, 2), info);          // 2 = MONITOR_DEFAULTTONEAREST
        const rc = info.rcWork;
        return { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top };
      };
    }
    const centre = screen.dipToScreenPoint({ x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 });
    return cache.__workAt(centre.x, centre.y);
  }, { koffiFrom: koffiPath, id: displayId });
}

/**
 * Which of `points` (physical pixels) are the app's own to paint — the topmost window there is ours.
 *
 * A maximised window on a 125 % display paints one row past the work area it was given, onto a
 * bottom band's top row (measured: white from the app maximised on that monitor, with the band's
 * three other edges perfect). That pixel is legitimately someone else's — a window above ours in the
 * z-order — and says nothing about a gap in the band. Off Windows every point is ours.
 */
async function ownedPoints(app: ElectronApplication, points: { x: number; y: number }[]): Promise<boolean[]> {
  const koffiPath = join(process.cwd(), "node_modules", "koffi");
  return app.evaluate(({ BrowserWindow }, { koffiFrom, points }) => {
    const all = BrowserWindow.getAllWindows();
    const win = all.find((w) => w.webContents.getURL().includes("index.html")) ?? all[0];
    if (!win || process.platform !== "win32") return points.map(() => true);
    const req = (typeof require === "function"
      ? require
      : (process as unknown as { mainModule?: { require: NodeRequire } }).mainModule?.require
    ) as NodeRequire | undefined;
    if (!req) return points.map(() => true);
    const cache = globalThis as unknown as { __ownerAt?: (x: number, y: number) => number };
    if (!cache.__ownerAt) {
      const koffi = req(koffiFrom) as typeof import("koffi");
      const POINT = koffi.struct("POINT_e2e_owner", { x: "long", y: "long" });
      const user32 = koffi.load("user32.dll");
      const WindowFromPoint = user32.func("__stdcall", "WindowFromPoint", "intptr", [POINT]);
      const GetAncestor = user32.func("__stdcall", "GetAncestor", "intptr", ["intptr", "uint32"]);
      cache.__ownerAt = (x, y) => Number(GetAncestor(WindowFromPoint({ x, y }), 2));   // 2 = GA_ROOT
    }
    const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
    return points.map(([x, y]) => cache.__ownerAt!(x!, y!) === hwnd);
  }, { koffiFrom: koffiPath, points: points.map((p) => [p.x, p.y]) });
}

/** The band's rectangle, in DIP — for the assertions that compare it with a DIP work area. */
async function bandBounds(app: ElectronApplication): Promise<Electron.Rectangle> {
  const { painted } = await nativeFrames(app);
  if (process.platform !== "win32") return painted;
  return app.evaluate(({ screen }, rect) => screen.screenToDipRect(null, rect), painted);
}

/**
 * The colour of one screen pixel, as "rrggbb", or null when this desktop cannot be captured.
 *
 * Asked of the compositor rather than of the page: what is being checked is the one pixel of a
 * docked band that the page does NOT draw — the window's own border.
 */
async function screenPixels(app: ElectronApplication, points: { x: number; y: number }[]): Promise<(string | null)[]> {
  return app.evaluate(async ({ desktopCapturer, screen }, wanted) => {
    const display = screen.getDisplayNearestPoint(screen.screenToDipPoint(wanted[0] ?? { x: 0, y: 0 }));
    const phys = screen.dipToScreenRect(null, display.bounds);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: phys.width, height: phys.height } });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    const image = source?.thumbnail;
    if (!image || image.isEmpty()) return wanted.map(() => null);
    const size = image.getSize();
    // Buffer, but the renderer-facing typings for nativeImage do not say so in this context.
    const bitmap = image.getBitmap() as unknown as Uint8Array;   // BGRA, row-major
    return wanted.map(({ x, y }) => {
      const lx = Math.round((x - phys.x) * (size.width / phys.width));
      const ly = Math.round((y - phys.y) * (size.height / phys.height));
      if (lx < 0 || ly < 0 || lx >= size.width || ly >= size.height) return null;
      const i = (ly * size.width + lx) * 4;
      return [bitmap[i + 2], bitmap[i + 1], bitmap[i]].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("");
    });
  }, points);
}
/**
 * The band's height once it has changed from `was` and stopped moving again.
 *
 * Waiting for "the work area is smaller than it began" says nothing after the first dock: it is
 * already true, so the reading can be taken before the shell has applied the new band. Waiting for
 * the reading to merely stop changing is no better — it has not started yet. That is what made the
 * percentage test flake: a 12 % band measured as the 20 % one that came before it.
 */
async function bandHeightAfter(app: ElectronApplication, was: number, timeoutMs = 8000): Promise<number> {
  const until = Date.now() + timeoutMs;
  let last = was;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = (await bounds(app)).height;
    if ((now !== was && now === last) || Date.now() > until) return now;
    last = now;
  }
}

const settingsOf = (page: Page) => page.evaluate(() => window.hangar.loadSettings());

/**
 * Work area of ONE display, found the way the app finds it — by where the monitor is.
 *
 * Every docking assertion is made per monitor: a second screen is usually the one with a different
 * scale factor, and that is exactly where docking went wrong before.
 */
const workAreaOf = (app: ElectronApplication, key: string) =>
  app.evaluate(({ screen }, id) => {
    const match = screen.getAllDisplays()
      .find((d) => `${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}` === id);
    return (match ?? screen.getPrimaryDisplay()).workArea;
  }, key);

/** Every monitor this machine has, as the app reports them. */
const monitors = (page: Page) => page.evaluate(() => window.hangar.displays());

/**
 * Can this desktop actually reserve space?
 *
 * Windows always can. X11 needs a window manager to honour `_NET_WM_STRUT_PARTIAL`, and CI runs
 * under a bare Xvfb with none — there the app still places its window, but the work area cannot
 * change, and asserting that it does would be testing the runner, not the app.
 */
async function reservesSpace(app: ElectronApplication, page: Page, key: string): Promise<boolean> {
  const before = await workAreaOf(app, key);
  await dockTo(page, key, "top", 12);
  const shrank = await settled(async () => (await workAreaOf(app, key)).height < before.height);
  await undock(app, page, key, before);
  return shrank;
}

/** Ask for a band and wait for the call itself to come back. */
async function dockTo(page: Page, device: string, edge: string, percent: number): Promise<void> {
  const result = await page.evaluate((arg) =>
    window.hangar.applyDock({ enabled: true, device: arg.device, edge: arg.edge as "top", percent: arg.percent }),
  { device, edge, percent });
  expect(result.ok, `applyDock(${edge} ${percent}%)`).toBe(true);
}

/** Give the band back and wait until the desktop says so — the shell takes its time. */
async function undock(
  app: ElectronApplication,
  page: Page,
  key: string,
  before: Electron.Rectangle,
): Promise<void> {
  await page.evaluate(() => window.hangar.releaseDock());
  await settled(async () => {
    const now = await workAreaOf(app, key);
    return now.height === before.height && now.width === before.width;
  });
}

/**
 * Poll a condition for a few seconds.
 *
 * Every one of these waits on the shell rearranging the desktop, which is not instant and is not a
 * fixed duration either — a fixed sleep is how these tests became flaky in the first place.
 */
async function settled(check: () => Promise<boolean>, timeoutMs = 6000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Equal, allowing one pixel.
 *
 * On a 125 % display a band is a whole number of physical pixels that is not a whole number of
 * logical ones, so the work area and the window can round the same rectangle a pixel apart.
 */
function samePixels(actual: number, expected: number, message: string): void {
  expect(Math.abs(actual - expected), `${message} (got ${actual}, expected ${expected})`).toBeLessThanOrEqual(1);
}

test("opens one window, with no title bar above the content", async () => {
  const { app, page } = await launch(fixture());
  try {
    // The splash is gone by the time the app's window is up.
    await expect.poll(() => app.windows().length).toBe(1);

    // Frameless: the page is exactly as tall as the window's content, and the header is draggable.
    const win = await bounds(app);
    const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    samePixels(inner.w, win.width, "content spans the window");
    samePixels(inner.h, win.height, "content is as tall as the window — no title bar above it");
    const draggable = await page.evaluate(() =>
      getComputedStyle(document.querySelector("header") as Element).getPropertyValue("-webkit-app-region"));
    expect(draggable).toBe("drag");
  } finally {
    await app.close();
  }
});

/**
 * One Hangar. A second launch — the shortcut again, `claude --p` from another terminal — used to open
 * a second window: two bands fighting for one edge, two writers of one settings file. It now hands
 * over to the running one and leaves. The lock is per Claude home, which is also what lets this
 * suite run beside an installed Hangar.
 */
test("a second launch hands over to the running Hangar and leaves", async () => {
  const home = fixture();
  const { app } = await launch(home);
  try {
    await expect.poll(() => app.windows().length, "start-up is over: the splash is gone").toBe(1);
    const binary = join(process.cwd(), "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
    // Unsandboxed on Linux, as Playwright itself launches Electron there: the CI runner's
    // chrome-sandbox helper is not setuid root, and Chromium aborts (SIGTRAP) rather than run without it.
    const flags = process.platform === "linux" ? ["--no-sandbox"] : [];
    const second = spawn(binary, [".", "--lang=en-US", ...flags], { cwd: process.cwd(), env: { ...process.env, CLAUDE_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    second.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const cap = setTimeout(() => { second.kill(); resolve({ code: -1, signal: "timed out" }); }, 20_000);
      second.once("exit", (code, signal) => { clearTimeout(cap); resolve({ code, signal }); });
    });
    expect(ended, `the second instance left on its own, cleanly — stderr:\n${stderr.trim().split("\n").slice(-12).join("\n")}`)
      .toEqual({ code: 0, signal: null });
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => `${w.getTitle()} ${w.webContents.getURL()}`));
    expect(windows, "the first still has its one window").toHaveLength(1);
  } finally {
    await app.close();
  }
});

test("remembers where the window was left", async () => {
  const home = fixture();
  const first = await launch(home);
  try {
    await first.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 220, y: 160, width: 940, height: 620 }));
    await first.page.waitForTimeout(400);
  } finally {
    await first.app.close();
  }
  await expect.poll(() => {
    try {
      return JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8")).ui?.window?.width;
    } catch {
      return null;
    }
  }).toBe(940);

  const second = await launch(home);
  try {
    const restored = await bounds(second.app);
    samePixels(restored.x, 220, "x");
    samePixels(restored.y, 160, "y");
    samePixels(restored.width, 940, "width");
    samePixels(restored.height, 620, "height");
  } finally {
    await second.app.close();
  }
});

test("every monitor: a band reserves the space, fills it, and gives it back", async () => {
  const { app, page } = await launch(fixture());
  try {
    const displays = await monitors(page);
    expect(displays.length).toBeGreaterThan(0);
    // Said out loud because it decides what this run actually proved: a CI runner has one screen,
    // so the "different scale factor on the second monitor" faults are only caught on a real desk.
    console.log(`  docking checked on ${displays.length} monitor(s): `
      + displays.map((d) => `${d.label} ${d.bounds.width}x${d.bounds.height}`).join(", "));

    for (const display of displays) {
      const label = `${display.label} ${display.bounds.width}x${display.bounds.height}`;
      const before = await workAreaOf(app, display.id);
      const free = await nativeWorkArea(app, display.id);            // physical, before the band
      await dockTo(page, display.id, "top", 12);
      const shrank = await settled(async () => (await workAreaOf(app, display.id)).height < before.height);

      if (!shrank) {
        // No window manager to honour the reservation; the band must still be a band.
        const placed = await bandBounds(app);
        samePixels(placed.width, before.width, `${label}: spans the monitor even unreserved`);
        await undock(app, page, display.id, before);
        continue;
      }

      // The window is the band on THIS monitor: same rectangle, not a window beside it.
      const docked = await workAreaOf(app, display.id);
      const rect = await bandBounds(app);
      samePixels(rect.x, before.x, `${label}: starts at the monitor edge`);
      samePixels(rect.y, before.y, `${label}: starts at the top of the work area`);
      samePixels(rect.width, before.width, `${label}: spans the monitor`);
      samePixels(rect.height, docked.y - before.y, `${label}: fills what was reserved`);

      // And to the pixel, in the shell's own units: every pixel the window paints is inside the
      // space it reserved, and none of it is anywhere else. Placing the band by the page instead
      // put its border one pixel outside — over the desktop, and over the next monitor along.
      // Against the work area the band was cut from, not the monitor: another appbar on this
      // monitor (an installed Hangar beside the one under test) rightly keeps its own strip.
      const f = await nativeFrames(app);
      const shown = seen(f);
      expect([shown.x, shown.y, shown.x + shown.width], `${label}: band flush with the three edges of the free work area`)
        .toEqual([free.x, free.y, free.x + free.width]);
      expect(shown.y + shown.height, `${label}: band ends exactly where the work area begins`).toBe(f.work.y);

      expect(await undock(app, page, display.id, before).then(() => workAreaOf(app, display.id)), `${label}: released`)
        .toMatchObject({ y: before.y, height: before.height });
    }
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

test("every monitor: a percentage means the same thing however often it is applied", async () => {
  const { app, page } = await launch(fixture());
  try {
    for (const display of await monitors(page)) {
      const before = await workAreaOf(app, display.id);
      if (!(await reservesSpace(app, page, display.id))) continue;   // the band is not sized here
      const label = `${display.label} ${display.bounds.width}x${display.bounds.height}`;
      const heights: number[] = [];

      // The bug this guards: the band was measured against a work area it had already shrunk, so
      // re-applying the same percentage kept making it smaller.
      let height = (await bounds(app)).height;
      for (const percent of [12, 20, 12]) {
        await dockTo(page, display.id, "top", percent);
        height = await bandHeightAfter(app, height);   // each of these three is a different size
        heights.push(height);
      }
      samePixels(heights[0]!, heights[2]!, `${label}: same request, same band`);
      expect(heights[1]!, `${label}: a bigger percentage is a bigger band`).toBeGreaterThan(heights[0]!);

      await undock(app, page, display.id, before);
    }
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

test("every monitor: each edge reserves on the axis it belongs to", async () => {
  const { app, page } = await launch(fixture());
  try {
    for (const display of await monitors(page)) {
      if (!(await reservesSpace(app, page, display.id))) continue;   // nothing to assert without a WM
      for (const edge of ["top", "bottom", "left", "right"] as const) {
        const label = `${display.label} ${edge}`;
        const before = await workAreaOf(app, display.id);
        const sideways = edge === "left" || edge === "right";
        await dockTo(page, display.id, edge, 12);
        const took = await settled(async () => {
          const now = await workAreaOf(app, display.id);
          return sideways ? now.width < before.width : now.height < before.height;
        });
        expect(took, `${label}: takes ${sideways ? "width" : "height"}`).toBe(true);

        const docked = await workAreaOf(app, display.id);
        if (sideways) expect(docked.height, `${label}: leaves height alone`).toBe(before.height);
        else expect(docked.width, `${label}: leaves width alone`).toBe(before.width);

        await undock(app, page, display.id, before);
        expect(await workAreaOf(app, display.id), `${label}: released`)
          .toMatchObject({ x: before.x, y: before.y, width: before.width, height: before.height });
      }
    }
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

/**
 * Docking and maximising are separate states, and separate buttons.
 *
 * They shared a button once, so "restore" gave back a screen edge in one state and a window size in
 * the other — the same glyph meaning two things depending on how the window got where it was.
 */
/** The thinner of the band's two spans — what "the band's shape" means for the test above. */
function bandThicknessOf(rect: { width: number; height: number }): number {
  return Math.min(rect.width, rect.height);
}

test("the dock button toggles the band; maximise is a different thing entirely", async () => {
  const { app, page } = await launch(fixture());
  try {
    const displays = await monitors(page);
    const display = displays.find((d) => d.primary) ?? displays[0]!;
    const before = await workAreaOf(app, display.id);
    test.skip(!(await reservesSpace(app, page, display.id)), "no window manager to reserve space");

    await dockTo(page, display.id, "top", 12);
    expect(await settled(async () => (await workAreaOf(app, display.id)).height < before.height)).toBe(true);
    await page.waitForTimeout(1700);                          // past the settle window
    const band = await bounds(app);

    // Dragged by the title bar: a docked window is a band, so it goes back to its band.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 300, y: 300, width: 800, height: 500 }));
    await expect.poll(async () => {
      const now = await bounds(app);
      return Math.abs(now.x - band.x) <= 1 && Math.abs(now.y - band.y) <= 1;
    }, { timeout: 8000 }).toBe(true);
    expect((await settingsOf(page)).dock.enabled, "still docked after a drag").toBe(true);

    // A docked window cannot be dragged off its edge, resized by its frame, or maximised into.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMovable()),
      "a band is not movable").toBe(false);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isResizable()),
      "a band's frame does not resize — that is what takes the cursor off three sides").toBe(false);

    // The dock button is the one that lets the edge go, and it says so.
    await expect(page.getByRole("button", { name: "Undock" })).toBeVisible();
    await page.getByRole("button", { name: "Undock" }).click();
    await expect.poll(async () => (await workAreaOf(app, display.id)).height, { timeout: 8000 })
      .toBe(before.height);
    await expect.poll(async () => (await settingsOf(page)).dock.enabled).toBe(false);

    // Undocked, the window is a window again — not the band's strip left pressed against the edge,
    // and wholly inside a display's work area rather than hanging past it.
    const floated = await bounds(app);
    const inside = await app.evaluate(({ screen: s }, rect) => s.getAllDisplays().some((d) =>
      rect.x >= d.workArea.x && rect.y >= d.workArea.y
      && rect.x + rect.width <= d.workArea.x + d.workArea.width
      && rect.y + rect.height <= d.workArea.y + d.workArea.height), floated);
    expect(inside, "the undocked window sits wholly inside a work area").toBe(true);
    expect(floated.height, "and has a window's shape back, not the band's").toBeGreaterThan(bandThicknessOf(band) + 40);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMovable()),
      "an ordinary window moves again").toBe(true);
    await expect(page.getByRole("button", { name: "Dock to the edge" })).toBeVisible();

    // Maximise is now only ever maximise: it fills the screen and reserves nothing.
    await page.getByRole("button", { name: "Maximise" }).click();
    await expect.poll(async () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isMaximized()), { timeout: 8000 }).toBe(true);
    expect((await settingsOf(page)).dock.enabled, "maximising does not dock").toBe(false);
    expect((await workAreaOf(app, display.id)).height, "and reserves nothing").toBe(before.height);
    await page.getByRole("button", { name: "Restore" }).click();
    await expect.poll(async () => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isMaximized()), { timeout: 8000 }).toBe(false);

    // And the dock button still brings the band back.
    await page.getByRole("button", { name: "Dock to the edge" }).click();
    await expect.poll(async () => (await settingsOf(page)).dock.enabled, { timeout: 8000 }).toBe(true);
    await expect.poll(async () => (await workAreaOf(app, display.id)).height, { timeout: 8000 })
      .toBeLessThan(before.height);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

test("resizing a docked band keeps it on its edge", async () => {
  const { app, page } = await launch(fixture());
  try {
    const displays = await monitors(page);
    const display = displays.find((d) => d.primary) ?? displays[0]!;
    const before = await workAreaOf(app, display.id);
    test.skip(!(await reservesSpace(app, page, display.id)), "no window manager to reserve space");

    // Docked right: the band's outer edge IS the screen's right edge.
    await dockTo(page, display.id, "right", 20);
    expect(await settled(async () => (await workAreaOf(app, display.id)).width < before.width)).toBe(true);
    await page.waitForTimeout(1700);                          // past the settle window

    const docked = await bandBounds(app);
    const rightEdge = before.x + before.width;
    samePixels(docked.x + docked.width, rightEdge, "docked flush with the right edge");

    // Make the band thinner the way a user does, through the grip: the width changes, the position
    // does not — which used to leave a strip of desktop between the band and the screen edge. (Not
    // `setBounds`: a docked band's size is pinned, so that call changes nothing and proved nothing.)
    const dockedWork = await workAreaOf(app, display.id);
    await page.evaluate((thickness) => window.hangar.dragDock({ thickness, done: true }), Math.round(docked.width * 0.6));

    // Polled through Electron, not the Win32 bindings: for a moment after the resize the app is
    // inside its own shell call, and a koffi call from the test then kills the process (0xFFFF7003).
    await expect.poll(async () => (await workAreaOf(app, display.id)).width, { message: "the reservation followed the resize", timeout: 8000 })
      .toBeGreaterThan(dockedWork.width);
    await page.waitForTimeout(800);                           // the shell has answered; the band is placed
    const now = await bandBounds(app);
    expect(Math.abs(now.x + now.width - rightEdge), "still flush with the right edge").toBeLessThanOrEqual(1);

    // And the size it settled on is what the setting now says.
    const settings = await settingsOf(page);
    expect(settings.dock.edge).toBe("right");
    expect(settings.dock.percent).toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

/**
 * The page's background as "rrggbb", from the page's own stylesheet — not from a pixel of the band,
 * which on a small screen a narrow band's middle can put on a button (measured on the CI runner's
 * 1024 × 768: a 123 px left band whose centre was a blue control).
 */
const pageSurface = (page: Page) => page.evaluate(() => {
  const channels = getComputedStyle(document.body).backgroundColor.match(/\d+/g) ?? [];
  return channels.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("");
});

/** How far apart two "rrggbb" colours are, as the largest difference in one channel. */
function channelGap(a: string, b: string): number {
  let worst = 0;
  for (let i = 0; i < 6; i += 2) {
    worst = Math.max(worst, Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)));
  }
  return worst;
}

/**
 * What a docked band LOOKS like, read back from the screen — every edge, on every monitor.
 *
 * This is the property every docking change has to keep, and the one that geometry cannot vouch
 * for: three rectangles make up the window (its own, what DWM paints, what the page fills) and each
 * fix that lined one of them up moved a hairline to the next. So the compositor is asked directly.
 * The band's outermost pixel is the window's border, which DWM draws and we colour — it must be
 * the page's colour exactly; the documented "no border" value is not none, it is #f3f3f3. On a
 * scaled display the ring is two pixels and the inner one is Chromium's frame, which follows its
 * own light/dark: that one must be in the page's theme (close), which is what `themeSource` buys.
 * A desktop that cannot be captured skips instead of failing.
 */
test("every monitor, every edge: a band's edges are the page's colour", async () => {
  // Four edges on every monitor, each docked, left to settle past the re-assertion window, captured,
  // released, and captured again bare: minutes on a two-monitor desk, and the shared 60 s budget is
  // for a test that clicks something. Measured at ~50 s for two monitors; this leaves room for a third.
  test.setTimeout(4 * 60_000);
  // Dark: the page is #141413 there, so every wrong colour a border can have — Chromium's #f3f3f3,
  // the system's #474747, a wallpaper-tinted grey, the desktop itself — is a hundred channels away,
  // while the shadow a neighbouring window casts onto the band's outermost pixel darkens it by a
  // few. That shadow is real (measured 4 with another band docked beside the one under test), and
  // is what the tolerance below is for.
  const { app, page } = await launch(fixture({ theme: "dark" }));
  const BORDER_TOLERANCE = 6;
  try {
    for (const display of await monitors(page)) {
      const before = await workAreaOf(app, display.id);
      if (!(await reservesSpace(app, page, display.id))) continue;
      for (const edge of ["top", "bottom", "left", "right"] as const) {
        const label = `${display.label} ${display.bounds.width}x${display.bounds.height} ${edge}`;
        const free = await nativeWorkArea(app, display.id);
        await dockTo(page, display.id, edge, 12);
        const sideways = edge === "left" || edge === "right";
        expect(await settled(async () => {
          const now = await workAreaOf(app, display.id);
          return sideways ? now.width < before.width : now.height < before.height;
        }), `${label}: reserved`).toBe(true);
        await page.waitForTimeout(1700);                        // past the settle window
        const { work } = await nativeFrames(app);

        // The band is what was RESERVED: the strip the work area lost, read from the shell — not
        // from the window, whose own rectangle sits a row or two above what it shows on a scaled
        // display. Whatever the window's geometry, this strip is what has to be filled.
        const band = { ...free };
        if (edge === "top") band.height = work.y - free.y;
        else if (edge === "bottom") { band.y = work.y + work.height; band.height = free.y + free.height - band.y; }
        else if (edge === "left") band.width = work.x - free.x;
        else { band.x = work.x + work.width; band.width = free.x + free.width - band.x; }

        // Five points along each of the four outermost rows/columns, and five along the row or
        // column just inside each — where the scaled display's second ring pixel is.
        const along = (n: number, from: number, size: number) => from + Math.round(((n + 0.5) / 5) * (size - 1));
        const right = band.x + band.width - 1;
        const bottom = band.y + band.height - 1;
        const outer: { x: number; y: number }[] = [];
        const inner: { x: number; y: number }[] = [];
        for (let n = 0; n < 5; n += 1) {
          const ax = along(n, band.x, band.width);
          const ay = along(n, band.y, band.height);
          outer.push({ x: ax, y: band.y }, { x: ax, y: bottom }, { x: band.x, y: ay }, { x: right, y: ay });
          inner.push({ x: ax, y: band.y + 1 }, { x: ax, y: bottom - 1 }, { x: band.x + 1, y: ay }, { x: right - 1, y: ay });
        }
        const centre = { x: Math.round(band.x + band.width / 2), y: Math.round(band.y + band.height / 2) };

        // An outermost pixel is the window's border where DWM draws one — the left and right columns
        // and the bottom row — and we colour that: it must be the page's colour exactly. The top row
        // is the page itself (a frameless window has no top border) and may be any colour the page
        // has there — but never the desktop's, which is what a gap shows.
        const isBorder = (i: number) => i % 4 !== 0;

        const surface = await pageSurface(page);
        // Only where the band is the topmost window: another window may lawfully paint one row over
        // it (see `ownedPoints`), but never more than one edge's worth — the band is on its reservation.
        const [ownsOuter, ownsInner] = await Promise.all([ownedPoints(app, outer), ownedPoints(app, inner)]);
        expect(ownsOuter.filter((o) => !o).length, `${label}: at most one edge of the band is under another window`).toBeLessThanOrEqual(5);
        const [inside, ...rest] = await screenPixels(app, [centre, ...outer, ...inner]);
        test.skip(!inside || inside === "000000", "this desktop cannot be captured");
        const outerSeen = rest.slice(0, outer.length);
        const innerSeen = rest.slice(outer.length);

        // The desktop at the same points: the band gone, and the window out of the way.
        await undock(app, page, display.id, before);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
        await page.waitForTimeout(400);
        const bare = await screenPixels(app, outer);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
        await page.waitForTimeout(400);

        const where = (points: { x: number; y: number }[], seen: (string | null)[], keep: (c: string | null, i: number) => boolean) =>
          seen.map((c, i) => (keep(c, i) ? `${points[i]!.x},${points[i]!.y}=${c}` : null)).filter((s) => s !== null);
        expect(where(outer, outerSeen, (c, i) => ownsOuter[i]! && (isBorder(i) ? c === null || channelGap(c, surface) > BORDER_TOLERANCE : c === null || c === bare[i])),
          `${label}: the band's outermost pixels are its border in the page's colour (within ${BORDER_TOLERANCE} for a neighbour's shadow), or its content — never the desktop (page is ${surface}; band ${band.x},${band.y} ${band.width}x${band.height})`)
          .toEqual([]);
        // The second ring pixel is Chromium's own frame, which follows its theme and, in the dark one,
        // the machine's accent: measured #1a202f against a #141413 page on the 125 % display (28 in
        // blue). The desktop is a hundred or more away, a light frame on a dark page two hundred.
        expect(where(inner, innerSeen, (c, i) => ownsInner[i]! && (c === null || channelGap(c, surface) > 32)), `${label}: Chromium's frame pixel is in the page's theme (page is ${surface})`)
          .toEqual([]);
      }
    }
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

/**
 * The band the app STARTS with is the one seen most, and it is the one the all-edges test above
 * never saw: it is applied while the window is still hidden, before the first `show()`. Measured on
 * v2.11.4: showing a window — that first show, a hide and show, a minimise and restore — resets the
 * border colour DWM was given, so a band restored at start-up wore a wallpaper-tinted grey ring
 * (#6b7279 … #8e9ba6) on all four sides in both themes, while the same band docked from Settings
 * was flawless. Dark theme here, where the difference between the page and any grey is largest.
 */
test("a band restored at start-up wears the page's colour, and keeps it through hide, show and focus changes", async () => {
  test.setTimeout(2 * 60_000);
  const { app, page } = await launch(fixture({ theme: "dark" }, { enabled: true, edge: "right", percent: 15 }));
  try {
    const primary = (await monitors(page)).find((d) => d.primary);
    expect(primary, "a primary display").toBeTruthy();
    const reserved = await settled(async () => (await workAreaOf(app, primary!.id)).width < primary!.bounds.width);
    test.skip(!reserved, "this desktop cannot reserve space");
    await page.waitForTimeout(1700);                          // past the settle window
    const surface = await pageSurface(page);

    // Every pixel of the ring DWM draws — top row included, which on a frameless window is a border
    // too — must be the page's colour. Reported as `x,y=colour` where it is not.
    const ringOf = async (): Promise<string[]> => {
      const { painted } = await nativeFrames(app);
      const along = (from: number, size: number, n: number) => from + Math.round(((n + 0.5) / 5) * (size - 1));
      const right = painted.x + painted.width - 1;
      const bottom = painted.y + painted.height - 1;
      const points: { x: number; y: number }[] = [];
      for (let n = 0; n < 5; n += 1) {
        const ax = along(painted.x, painted.width, n);
        const ay = along(painted.y, painted.height, n);
        points.push({ x: ax, y: painted.y }, { x: ax, y: bottom }, { x: painted.x, y: ay }, { x: right, y: ay });
      }
      const centre = { x: Math.round(painted.x + painted.width / 2), y: Math.round(painted.y + painted.height / 2) };
      const [inside, ...ring] = await screenPixels(app, [centre, ...points]);
      test.skip(!inside || inside === "000000", "this desktop cannot be captured");
      return ring.map((c, i) => (c === surface ? null : `${points[i]!.x},${points[i]!.y}=${c}`)).filter((s): s is string => s !== null);
    };
    expect(await ringOf(), `restored at start-up: the ring is the page's colour (${surface})`).toEqual([]);

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.hide();
      win?.show();
    });
    await page.waitForTimeout(900);
    expect(await ringOf(), `after hide and show: the ring is the page's colour (${surface})`).toEqual([]);

    // Another window chosen: Chromium writes its own frame colour on every change of activation, so
    // v2.12.0 was right until the first click elsewhere (measured: grey on all four sides after it).
    // A second window of the app's own takes the focus — deterministic under Playwright, which keeps
    // the page it drives focused through a plain `blur()`, and it works on a bare CI desktop.
    const ELSEWHERE = "elsewhere";
    await app.evaluate(({ BrowserWindow }, title) => {
      new BrowserWindow({ width: 200, height: 120, show: true, title }).focus();
    }, ELSEWHERE);
    await page.waitForTimeout(900);
    expect(await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.isFocused()), "the band did lose focus").toBe(false);
    expect(await ringOf(), `after losing focus: the ring is the page's colour (${surface})`).toEqual([]);
    await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)?.close(), ELSEWHERE);
    await page.waitForTimeout(900);
    expect(await ringOf(), `after regaining focus: the ring is the page's colour (${surface})`).toEqual([]);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

/**
 * Minimising the band and restoring it killed the process — every time, exit 0xC0000005, in v2.12.1
 * and the build after it, and by the same WER signature since 2026-09-01. The dump: the process had
 * jumped to address 4 from koffi's own call stack. Re-asserting the band while it was minimised
 * un-minimised it from inside our own SetWindowPos, and the `restore` that fired inside that call
 * re-applied the frame — a second native call nested in the first. Now nothing native runs inside a
 * window event. And a minimised band gives its edge back — the space is the point of minimising —
 * without becoming undocked: it takes the edge again when it is restored.
 */
test("a docked band survives being minimised and restored, giving its edge back in between", async () => {
  const { app, page } = await launch(fixture({ theme: "dark" }, { enabled: true, edge: "right", percent: 15 }));
  try {
    const primary = (await monitors(page)).find((d) => d.primary);
    expect(primary, "a primary display").toBeTruthy();
    const reserved = await settled(async () => (await workAreaOf(app, primary!.id)).width < primary!.bounds.width);
    test.skip(!reserved, "this desktop cannot reserve space");
    await page.waitForTimeout(1700);                          // past the settle window
    const docked = await workAreaOf(app, primary!.id);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.minimize());
      await expect.poll(async () => (await workAreaOf(app, primary!.id)).width, { message: `cycle ${cycle}: the edge is given back while minimised`, timeout: 5000 })
        .toBeGreaterThan(docked.width);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.restore());
      await expect.poll(async () => (await workAreaOf(app, primary!.id)).width, { message: `cycle ${cycle}: the edge is taken again on restore`, timeout: 8000 })
        .toBe(docked.width);
      await page.waitForTimeout(700);
    }
    expect(await app.evaluate(() => 1), "the app is still alive").toBe(1);
    // Back on its edge, with the reservation as it was.
    expect(await workAreaOf(app, primary!.id), "the reservation is unchanged").toEqual(docked);
    const { painted, work } = await nativeFrames(app);
    expect(painted.x, "the band is back on its edge").toBe(work.x + work.width);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

/**
 * The one side of a band you may resize is a strip in the page, not the window frame. It has to be
 * there — a real strip with a size, since a 0 × 0 element cannot be grabbed — and dragging it has to
 * change the band. The strip lost its size once when its component moved to a folder the stylesheet
 * was not built from: the classes were in the markup and nowhere in the CSS.
 */
test("dragging the band's grip resizes it", async () => {
  const { app, page } = await launch(fixture());
  try {
    const displays = await monitors(page);
    const display = displays.find((d) => d.primary) ?? displays[0]!;
    const before = await workAreaOf(app, display.id);
    test.skip(!(await reservesSpace(app, page, display.id)), "no window manager to reserve space");

    await dockTo(page, display.id, "top", 12);
    expect(await settled(async () => (await workAreaOf(app, display.id)).height < before.height)).toBe(true);
    await page.waitForTimeout(1700);                          // past the settle window
    const was = (await nativeFrames(app)).painted;
    const docked = await workAreaOf(app, display.id);

    const grip = page.getByRole("separator", { name: "Resize the docked band" });
    const box = await grip.boundingBox();
    expect(box, "the grip is a strip with a size").not.toBeNull();
    expect(box!.width * box!.height, "the grip is a strip with a size").toBeGreaterThan(0);

    // A real drag through the page: down on the strip, 80 px towards the desktop, up.
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) await page.mouse.move(x, y + 10 * step);
    await page.mouse.up();

    // The reservation follows the drag once the drag has settled — polled through Electron's own
    // `screen`, and NOT through the Win32 bindings: the app is inside its SHAppBarMessage call on a
    // worker thread just then, and a koffi call against the same window from the main thread while
    // it is in flight kills the process (exit 0xFFFF7003 — seen here with another appbar on the
    // monitor slowing the shell's answer). The drag was 80 DIP, so the work area moves at least 40.
    await expect.poll(async () => (await workAreaOf(app, display.id)).y - docked.y, { message: "the work area moved with the band", timeout: 8000 })
      .toBeGreaterThan(40);
    await page.waitForTimeout(800);                           // the shell has answered; the band is placed
    // Then, once: the band grew by about what was dragged, and it ends exactly where the work area
    // begins — the reservation and the window are the same rectangle.
    const now = await nativeFrames(app);
    expect(now.painted.height - was.height, "the band grew (physical pixels)").toBeGreaterThan(40);
    expect(now.work.y - (now.painted.y + now.painted.height), "the band ends where the work area begins").toBe(0);
    expect((await settingsOf(page)).dock.percent, "the new size is the setting").toBeGreaterThan(12);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

/**
 * The band lays the gauges across and puts the running count under them. The gauge row shrinks to
 * whatever is left, but a card has a height of its own — so in a thin band the cards used to run out
 * of the bottom of their row and be drawn straight through the count. What is asked here is not the
 * rectangles (a clipped card still reports its full one) but what is actually drawn where the count
 * is: `elementsFromPoint` does not see through the parts an `overflow: hidden` row has cut off.
 */
test("in a thin band the running count is below the gauges, not under them", async () => {
  const { app, page } = await launch(fixture());
  try {
    const displays = await monitors(page);
    const display = displays.find((d) => d.primary) ?? displays[0]!;
    // A band on a screen of ordinary height leaves the gauges about half the room they would like.
    await dockTo(page, display.id, "top", 12);
    await expect.poll(() => page.locator("aside .card").count(), { timeout: 8000 }).toBeGreaterThan(0);
    const count = page.getByTestId("running-count");
    await expect(count).toBeVisible();

    const drawnOverIt = await page.evaluate(() => {
      const text = document.querySelector('[data-testid="running-count"]') as HTMLElement;
      const box = text.getBoundingClientRect();
      // Along the line, not only its middle: a card that overflows may cover part of it.
      return [0.1, 0.5, 0.9]
        .flatMap((at) => document.elementsFromPoint(box.left + box.width * at, box.top + box.height / 2))
        .filter((el) => !text.contains(el) && el.closest(".card") !== null)
        .map((el) => el.tagName.toLowerCase());
    });
    expect(drawnOverIt, "no part of a gauge is painted where the count is").toEqual([]);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

test("a dock change made in settings sticks", async () => {
  const home = fixture();
  const { app, page } = await launch(home);
  try {
    const displays = await monitors(page);
    const device = (displays.find((d) => d.primary) ?? displays[0]!).id;

    // Exactly what the Settings screen does: save the section, then read it back.
    for (const [edge, percent] of [["left", 25], ["bottom", 18], ["top", 30]] as const) {
      const saved = await page.evaluate((dock) => window.hangar.saveSettings({ dock }),
        { enabled: false, device, edge, percent });
      expect(saved.dock, `saving ${edge} ${percent}%`).toMatchObject({ device, edge, percent });

      const readBack = await settingsOf(page);
      expect(readBack.dock, `reading back ${edge} ${percent}%`).toMatchObject({ device, edge, percent });
    }
  } finally {
    await app.close();
  }
});

test("the layout setting decides the shape, and the panes remember their sizes", async () => {
  // Pane sizes are fractions of the window, not pixels: the same setting has to mean the same
  // thing in a wide window and in a thin docked band.
  const home = fixture({ layout: "vertical", navWidth: 0.25, asideWidth: 0.2, stackTop: 0.4 });
  const { app, page } = await launch(home);
  try {
    // Stacked was asked for, so a wide window is stacked too: the project list is the main pane.
    await expect(page.getByPlaceholder("Search projects", { exact: false })).toBeVisible();
    const nav = await page.evaluate(() => document.querySelector("nav") !== null);
    expect(nav).toBe(false);                                  // stacked has no sidebar

    const saved = await settingsOf(page);
    expect(saved.ui).toMatchObject({ layout: "vertical", navWidth: 0.25, asideWidth: 0.2, stackTop: 0.4 });

    // Switching to side-by-side brings the sidebar back without a restart.
    const horizontal: typeof saved.ui = { ...saved.ui, layout: "horizontal" };
    await page.evaluate((ui) => window.hangar.saveSettings({ ui }), horizontal);
    await expect.poll(() => page.evaluate(() => document.querySelector("nav") !== null)).toBe(true);
  } finally {
    await app.close();
  }
});

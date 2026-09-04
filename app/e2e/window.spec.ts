/**
 * The window itself: how it opens, where it sits, and what docking does to the desktop.
 *
 * These drive the real shell — the band really is reserved on the primary monitor while a test
 * runs — so every test releases it again in a `finally`, and the bands are small.
 */
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

function fixture(ui: Record<string, unknown> = {}): string {
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
  if (Object.keys(ui).length) {
    writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui }));
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
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const fallback = (): NativeFrames => {
      const b = win.getBounds();
      const d = screen.getDisplayMatching(b);
      return { client: b, painted: b, monitor: d.bounds, work: d.workArea };
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
    const cache = globalThis as unknown as { __frames?: (hwnd: number) => NativeFrames };
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
    return cache.__frames(Number(win.getNativeWindowHandle().readBigUInt64LE(0)));
  }, koffiPath);
  if (!frames) throw new Error("the app has no window");
  return frames;
}

/** Where the page is, in DIP — for the assertions that compare it with a DIP work area. */
async function pageBounds(app: ElectronApplication): Promise<Electron.Rectangle> {
  const { client } = await nativeFrames(app);
  if (process.platform !== "win32") return client;
  return app.evaluate(({ screen }, rect) => screen.screenToDipRect(null, rect), client);
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
      await dockTo(page, display.id, "top", 12);
      const shrank = await settled(async () => (await workAreaOf(app, display.id)).height < before.height);

      if (!shrank) {
        // No window manager to honour the reservation; the band must still be a band.
        const placed = await pageBounds(app);
        samePixels(placed.width, before.width, `${label}: spans the monitor even unreserved`);
        await undock(app, page, display.id, before);
        continue;
      }

      // The window is the band on THIS monitor: same rectangle, not a window beside it.
      const docked = await workAreaOf(app, display.id);
      const rect = await pageBounds(app);
      samePixels(rect.x, before.x, `${label}: starts at the monitor edge`);
      samePixels(rect.y, before.y, `${label}: starts at the top of the work area`);
      samePixels(rect.width, before.width, `${label}: spans the monitor`);
      samePixels(rect.height, docked.y - before.y, `${label}: fills what was reserved`);

      // And to the pixel, in the shell's own: the PAGE fills the reservation. The client area used
      // to sit one system-border pixel inside the painted frame on three sides, and that pixel —
      // undrawn while docked — was the desktop showing as a thin line along the band.
      const f = await nativeFrames(app);
      expect([f.client.x, f.client.y, f.client.x + f.client.width], `${label}: page flush with three monitor edges`)
        .toEqual([f.monitor.x, f.monitor.y, f.monitor.x + f.monitor.width]);
      expect(f.client.y + f.client.height, `${label}: page ends exactly where the work area begins`).toBe(f.work.y);

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

    const docked = await pageBounds(app);
    const rightEdge = before.x + before.width;
    samePixels(docked.x + docked.width, rightEdge, "docked flush with the right edge");

    // Drag the OUTER edge inwards: the width changes, the position does not — which used to leave a
    // strip of desktop between the band and the screen edge.
    await app.evaluate(({ BrowserWindow }, rect) =>
      BrowserWindow.getAllWindows()[0]?.setBounds(rect),
    { x: docked.x, y: docked.y, width: Math.round(docked.width * 0.6), height: docked.height });

    await expect.poll(async () => {
      const now = await pageBounds(app);
      return Math.abs(now.x + now.width - rightEdge) <= 1;
    }, { timeout: 8000 }).toBe(true);

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
    const was = (await nativeFrames(app)).client;

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

    // The band grew by about what was dragged (physical pixels, so at least 40 at any sane scale)…
    await expect.poll(async () => (await nativeFrames(app)).client.height - was.height, { timeout: 8000 })
      .toBeGreaterThan(40);
    // …the reservation followed it — polled, because the shell takes a moment and reports odd
    // intermediate work areas while it rearranges the desktop — and the size was written down.
    await expect.poll(async () => {
      const now = await nativeFrames(app);
      return now.work.y - (now.client.y + now.client.height);
    }, { message: "the work area moved with the band", timeout: 8000 }).toBe(0);
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

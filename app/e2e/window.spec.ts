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
  const app = await electron.launch({ args: ["."], cwd: process.cwd(), env: { ...process.env, CLAUDE_HOME: home } });
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
    expect(inner.w).toBe(win.width);
    expect(inner.h).toBe(win.height);
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
    expect(await bounds(second.app)).toMatchObject({ x: 220, y: 160, width: 940, height: 620 });
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
        const placed = await bounds(app);
        samePixels(placed.width, before.width, `${label}: spans the monitor even unreserved`);
        await undock(app, page, display.id, before);
        continue;
      }

      // The window is the band on THIS monitor: same rectangle, not a window beside it.
      const docked = await workAreaOf(app, display.id);
      const rect = await bounds(app);
      samePixels(rect.x, before.x, `${label}: starts at the monitor edge`);
      samePixels(rect.y, before.y, `${label}: starts at the top of the work area`);
      samePixels(rect.width, before.width, `${label}: spans the monitor`);
      samePixels(rect.height, docked.y - before.y, `${label}: fills what was reserved`);

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
      for (const percent of [12, 20, 12]) {
        await dockTo(page, display.id, "top", percent);
        await settled(async () => (await workAreaOf(app, display.id)).height < before.height);
        heights.push((await bounds(app)).height);
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

test("a docked window that is dragged or maximised stays docked; restoring it undocks", async () => {
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

    // Maximising keeps it too — there is nothing to maximise into, so the band simply stays.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
    await page.waitForTimeout(1200);
    expect((await settingsOf(page)).dock.enabled, "still docked after maximise").toBe(true);
    expect((await workAreaOf(app, display.id)).height, "band still reserved").toBeLessThan(before.height);
    const afterMaximise = await bounds(app);
    samePixels(afterMaximise.height, band.height, "still the band it was");

    // The caption button says so: docked is the maximised state, so it offers to restore.
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();

    // Restoring is the gesture that asks for an ordinary window, and gives the edge back.
    await page.getByRole("button", { name: "Restore" }).click();
    await expect.poll(async () => (await workAreaOf(app, display.id)).height, { timeout: 8000 })
      .toBe(before.height);
    await expect.poll(async () => (await settingsOf(page)).dock.enabled).toBe(false);
    // ...and the button goes back to offering the maximise it now means.
    await expect(page.getByRole("button", { name: "Maximise" })).toBeVisible();
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

    const docked = await bounds(app);
    const rightEdge = before.x + before.width;
    samePixels(docked.x + docked.width, rightEdge, "docked flush with the right edge");

    // Drag the OUTER edge inwards: the width changes, the position does not — which used to leave a
    // strip of desktop between the band and the screen edge.
    await app.evaluate(({ BrowserWindow }, rect) =>
      BrowserWindow.getAllWindows()[0]?.setBounds(rect),
    { x: docked.x, y: docked.y, width: Math.round(docked.width * 0.6), height: docked.height });

    await expect.poll(async () => {
      const now = await bounds(app);
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
  const home = fixture({ layout: "vertical", navWidth: 300, asideWidth: 260, stackTop: 200 });
  const { app, page } = await launch(home);
  try {
    // Stacked was asked for, so a wide window is stacked too: the project list is the main pane.
    await expect(page.getByPlaceholder("Search projects", { exact: false })).toBeVisible();
    const nav = await page.evaluate(() => document.querySelector("nav") !== null);
    expect(nav).toBe(false);                                  // stacked has no sidebar

    const saved = await settingsOf(page);
    expect(saved.ui).toMatchObject({ layout: "vertical", navWidth: 300, asideWidth: 260, stackTop: 200 });

    // Switching to side-by-side brings the sidebar back without a restart.
    const horizontal: typeof saved.ui = { ...saved.ui, layout: "horizontal" };
    await page.evaluate((ui) => window.hangar.saveSettings({ ui }), horizontal);
    await expect.poll(() => page.evaluate(() => document.querySelector("nav") !== null)).toBe(true);
  } finally {
    await app.close();
  }
});

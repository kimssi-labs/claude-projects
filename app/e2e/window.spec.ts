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

const bounds = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds());
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
    const [win, inner] = await Promise.all([
      bounds(app),
      page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })),
    ]);
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

    for (const display of displays) {
      const label = `${display.label} ${display.bounds.width}x${display.bounds.height}`;
      const before = await workAreaOf(app, display.id);

      const result = await page.evaluate((device) =>
        window.hangar.applyDock({ enabled: true, device, edge: "top", percent: 12 }), display.id);
      expect(result.ok, label).toBe(true);
      await page.waitForTimeout(1200);

      const docked = await workAreaOf(app, display.id);
      expect(docked.height, `${label}: the desktop should shrink`).toBeLessThan(before.height);

      // The window is the band on THIS monitor: same rectangle, not a window beside it.
      const rect = await bounds(app);
      samePixels(rect.x, before.x, `${label}: starts at the monitor edge`);
      samePixels(rect.y, before.y, `${label}: starts at the top of the work area`);
      samePixels(rect.width, before.width, `${label}: spans the monitor`);
      samePixels(rect.height, docked.y - before.y, `${label}: fills what was reserved`);

      await page.evaluate(() => window.hangar.releaseDock());
      await page.waitForTimeout(1200);
      expect(await workAreaOf(app, display.id), `${label}: released`)
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
      const label = `${display.label} ${display.bounds.width}x${display.bounds.height}`;
      const heights: number[] = [];

      // The bug this guards: the band was measured against a work area it had already shrunk, so
      // re-applying the same percentage kept making it smaller.
      for (const percent of [12, 20, 12]) {
        await page.evaluate((arg) =>
          window.hangar.applyDock({ enabled: true, device: arg.device, edge: "top", percent: arg.percent }),
        { device: display.id, percent });
        await page.waitForTimeout(1000);
        heights.push((await bounds(app)).height);
      }
      samePixels(heights[0]!, heights[2]!, `${label}: same request, same band`);
      expect(heights[1], `${label}: a bigger percentage is a bigger band`).toBeGreaterThan(heights[0]!);

      await page.evaluate(() => window.hangar.releaseDock());
      await page.waitForTimeout(900);
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
      for (const edge of ["top", "bottom", "left", "right"] as const) {
        const label = `${display.label} ${edge}`;
        const before = await workAreaOf(app, display.id);
        await page.evaluate((arg) =>
          window.hangar.applyDock({ enabled: true, device: arg.device, edge: arg.edge, percent: 12 }),
        { device: display.id, edge });
        await page.waitForTimeout(1100);

        const docked = await workAreaOf(app, display.id);
        if (edge === "left" || edge === "right") {
          expect(docked.width, `${label}: takes width`).toBeLessThan(before.width);
          expect(docked.height, `${label}: leaves height alone`).toBe(before.height);
        } else {
          expect(docked.height, `${label}: takes height`).toBeLessThan(before.height);
          expect(docked.width, `${label}: leaves width alone`).toBe(before.width);
        }

        await page.evaluate(() => window.hangar.releaseDock());
        await page.waitForTimeout(1100);
        expect(await workAreaOf(app, display.id), `${label}: released`)
          .toMatchObject({ x: before.x, y: before.y, width: before.width, height: before.height });
      }
    }
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
  }
});

test("dragging a docked window off its edge undocks it", async () => {
  const { app, page } = await launch(fixture());
  try {
    const displays = await monitors(page);
    const display = displays.find((d) => d.primary) ?? displays[0]!;
    const before = await workAreaOf(app, display.id);
    await page.evaluate((id) =>
      window.hangar.applyDock({ enabled: true, device: id, edge: "top", percent: 12 }), display.id);
    await page.waitForTimeout(1600);                          // past the settle window
    expect((await workAreaOf(app, display.id)).height).toBeLessThan(before.height);

    // Somewhere else entirely: not a thickness change, so the edge goes back.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 300, y: 300, width: 800, height: 500 }));
    await expect.poll(async () => (await workAreaOf(app, display.id)).height, { timeout: 8000 })
      .toBe(before.height);
    await expect.poll(async () => (await settingsOf(page)).dock.enabled).toBe(false);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
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
    await page.evaluate((ui) => window.hangar.saveSettings({ ui }), { ...saved.ui, layout: "horizontal" });
    await expect.poll(() => page.evaluate(() => document.querySelector("nav") !== null)).toBe(true);
  } finally {
    await app.close();
  }
});

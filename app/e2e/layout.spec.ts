/**
 * The two things a docked window must get right: it follows the chosen theme, and at either thin
 * shape it fits — no page scrolling, nothing pushed off the side.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const SESSION = "cccccccc-1111-2222-3333-444444444444";

/** Every fixture home made by this file, so the run does not leave temp copies behind. */
const roots: string[] = [];
test.afterAll(() => {
  for (const root of roots) {
    // Best effort: the app may still hold a handle as it exits, and a leftover temp directory is
    // not worth failing a passing test over.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will clear %TEMP% eventually */
    }
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-layout-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const projectDir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", projectDir), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, "projects", projectDir, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: workspace, sessionId: SESSION })}\n`,
  );
  writeFileSync(join(home, "history.jsonl"), `${JSON.stringify({ display: "프롬프트", sessionId: SESSION })}\n`);
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return home;
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: home },
  });
  const page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/** The app's own window — `firstWindow()` can hand back the splash, which then closes. */
export async function mainWindow(app: ElectronApplication): Promise<Page> {
  for (;;) {
    const found = app.windows().find((w) => w.url().includes("index.html"));
    if (found) return found;
    await app.waitForEvent("window");
  }
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
}

/** What "no scroll" means here: the page itself never scrolls, in either direction. */
async function overflow(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
}

test("the theme choice applies at once and survives a restart", async () => {
  const home = fixture();
  const first = await launch(home);
  try {
    await expect(first.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await first.page.keyboard.press("s");
    await expect(first.page.getByText("Appearance").first()).toBeVisible();
    await first.page.getByText("Dark", { exact: true }).first().click();

    await expect
      .poll(() => first.page.evaluate(() => document.documentElement.dataset["theme"]))
      .toBe("dark");
    await expect.poll(() => {
      try {
        return JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8")).ui?.theme;
      } catch {
        return null;
      }
    }).toBe("dark");
  } finally {
    await first.app.close();
  }

  const second = await launch(home);
  try {
    // Read back from the file, before anything is clicked.
    await expect
      .poll(() => second.page.evaluate(() => document.documentElement.dataset["theme"]))
      .toBe("dark");
  } finally {
    await second.app.close();
  }
});

test("neither thin shape makes the page scroll", async () => {
  const home = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Docked to the top edge: short and wide.
    await resize(app, 1200, 300);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1200);
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Docked to the left edge: tall and narrow. The project list is the main pane here.
    await resize(app, 420, 900);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(420);
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await expect(page.getByPlaceholder("Search projects", { exact: false })).toBeVisible();

    // ...and the sessions screen inside it, too.
    await page.keyboard.press("Enter");
    await expect(page.getByText("프롬프트").first()).toBeVisible();
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });

    // Settings has to fit in the narrow shape as well — it is reachable by keyboard from here.
    await page.keyboard.press("Escape");
    await page.keyboard.press("s");
    await expect(page.getByText("Appearance").first()).toBeVisible();
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  } finally {
    await app.close();
  }
});

test("text that does not fit says the whole of itself on hover", async () => {
  const { app, page } = await launch(fixture());
  try {
    const path = page.locator("nav .truncate, #root .truncate").filter({ hasText: "workspace" }).first();
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Wide: the row has room, so no tooltip nags.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 800));
    await page.waitForTimeout(500);
    const roomy = await page.evaluate(() => {
      const el = [...document.querySelectorAll("div,span")]
        .find((n) => n.className.includes("truncate") && n.textContent?.includes("workspace"));
      return { title: el?.getAttribute("title"), clipped: !!el && el.scrollWidth > el.clientWidth + 1 };
    });
    expect(roomy.clipped).toBe(false);

    // Narrow: the same text no longer fits, and now it carries its full self.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(430, 800));
    await page.waitForTimeout(600);
    await expect.poll(async () => page.evaluate(() => {
      const cut = [...document.querySelectorAll("div,span")]
        .filter((n) => n.className.includes("truncate") && n.scrollWidth > n.clientWidth + 1);
      return cut.length > 0 && cut.every((n) => (n.getAttribute("title") ?? "").length > 0);
    })).toBe(true);
  } finally {
    await app.close();
  }
});

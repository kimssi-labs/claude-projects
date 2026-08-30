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

function fixture(workspaceName = "workspace"): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-layout-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, workspaceName);
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
  // A name long enough to be cut in any window, on any platform: the CI runner's temp paths are
  // short, and a test that only clips on one machine proves nothing on the other.
  const longName = `workspace-${"long-project-name-".repeat(4)}end`;
  const { app, page } = await launch(fixture(longName));
  try {
    await expect(page.getByText(longName, { exact: false }).first()).toBeVisible();

    const clipping = () => page.evaluate(() => {
      const all = [...document.querySelectorAll("div,span")]
        .filter((n) => n.className.includes("truncate"));
      const cut = all.filter((n) => n.scrollWidth > n.clientWidth + 1);
      return {
        cut: cut.length,
        titled: cut.filter((n) => (n.getAttribute("title") ?? "").length > 0).length,
      };
    });

    // Narrow: the name cannot fit, and every cut label carries its full self.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(430, 800));
    await expect.poll(async () => (await clipping()).cut, { timeout: 8000 }).toBeGreaterThan(0);
    const narrow = await clipping();
    expect(narrow.titled, "every cut-off label has a tooltip").toBe(narrow.cut);
  } finally {
    await app.close();
  }
});

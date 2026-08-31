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

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
  // Within a few pixels: the window frame and the viewport do not agree to the pixel on Windows,
  // and this test is about the shape of the layout, not about that arithmetic.
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 8000 })
    .toBeGreaterThan(width - 8);
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 8000 })
    .toBeLessThan(width + 8);
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

/**
 * The reset time is the second half of a usage reading: a percentage without it does not say
 * whether to keep working or wait. The docked band dropped it for want of room — and the band is
 * the shape the app is left in all day, so the layout that needed the answer most never gave it.
 */
test("every shape says when the usage window resets", async () => {
  const home = fixture();
  mkdirSync(join(home, "cache"), { recursive: true });
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600 + 15 * 60;   // 2h 15m from now
  writeFileSync(join(home, "cache", "rate-limits.json"), JSON.stringify({
    five_hour: { used_percentage: 19, resets_at: resetsAt },
    seven_day: { used_percentage: 100, resets_at: resetsAt + 86400 },
  }));

  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    const reset = page.getByText(/left ·/).first();

    // Wide: the full column.
    await resize(app, page, 1200, 800);
    await expect(reset).toBeVisible();
    await expect(reset).toContainText("2h 1");                  // 2h 15m, give or take a minute

    // Docked as a band along an edge: the same answer, on one line.
    await resize(app, page, 1200, 300);
    await expect(page.getByText(/left ·/).first()).toBeVisible();
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  } finally {
    await app.close();
  }
});

/**
 * Stacked, with a divider remembered from a taller window: the sessions must still be on screen.
 *
 * Reported from a docked band — the project list was remembered at 661 px, the band was 762 px
 * tall, and entering a project showed nothing at all below the divider.
 */
test("stacked: entering a project shows its sessions, even with a tall remembered divider", async () => {
  const home = fixture();
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({
    ui: { layout: "vertical", stackTop: 661 },
  }));

  const { app, page } = await launch(home);
  try {
    await resize(app, page, 1080, 762);
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    await page.keyboard.press("Enter");                       // into the project's sessions
    const session = page.getByText("프롬프트").first();
    await expect(session).toBeVisible();

    // "Visible" is not enough: with the divider left where it was, the sessions were squeezed into
    // a sliver that read as empty. The pane has to be a list.
    const pane = await page.getByTestId("stack-sessions").boundingBox();
    expect(pane, "the stacked sessions pane is there").not.toBeNull();
    expect(pane!.height, "the sessions pane is a list, not a sliver").toBeGreaterThanOrEqual(120);

    const box = await session.boundingBox();
    expect(box, "the session row has a box").not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  } finally {
    await app.close();
  }
});

test("neither thin shape makes the page scroll", async () => {
  const home = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Docked to the top edge: short and wide.
    await resize(app, page, 1200, 300);
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Docked to the left edge: tall and narrow. The project list is the main pane here.
    await resize(app, page, 420, 900);
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
        .filter((n) => typeof n.className === "string" && n.className.includes("truncate"));
      const cut = all.filter((n) => n.scrollWidth > n.clientWidth + 1);
      return {
        cut: cut.length,
        titled: cut.filter((n) => (n.getAttribute("title") ?? "").length > 0).length,
        // Named, not counted: a failure should say which label went quiet.
        silent: cut.filter((n) => !(n.getAttribute("title") ?? "").length)
          .map((n) => (n.textContent ?? "").slice(0, 40)),
      };
    });

    // Narrow: the name cannot fit, and every cut label carries its full self.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(430, 800));
    await expect.poll(async () => (await clipping()).cut, { timeout: 8000 }).toBeGreaterThan(0);
    // Polled, not sampled: a label is measured after layout, and the assertion should not race the
    // frame in which it happens.
    await expect
      .poll(async () => (await clipping()).silent, { timeout: 8000 })
      .toEqual([]);
  } finally {
    await app.close();
  }
});

/**
 * End-to-end: the built app, driven the way a person drives it — with the keyboard.
 *
 * Every run gets its own CLAUDE_HOME fixture, so the test sees a known set of projects and can
 * assert on what a rename actually wrote to disk.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const SESSION_ONE = "aaaaaaaa-1111-2222-3333-444444444444";
const SESSION_TWO = "bbbbbbbb-1111-2222-3333-444444444444";

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

function fixture(): { home: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "hangar-e2e-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const projectDir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", projectDir), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  for (const id of [SESSION_ONE, SESSION_TWO]) {
    writeFileSync(
      join(home, "projects", projectDir, `${id}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: workspace, sessionId: id })}\n`,
    );
  }
  writeFileSync(
    join(home, "history.jsonl"),
    [SESSION_ONE, SESSION_TWO]
      .map((id, index) => JSON.stringify({ display: `프롬프트 ${index + 1}`, sessionId: id }))
      .join("\n") + "\n",
  );
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return { home, projectDir };
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

test("shows the fixture's project and its sessions, and moves with the keyboard", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Enter opens the project's sessions — the same key the terminal version used.
    await page.keyboard.press("Enter");
    await expect(page.getByText("Back (Esc)")).toBeVisible();
    // The title shows twice — once in the row, once as the detail heading — so match the row.
    await expect(page.getByText("프롬프트 1").first()).toBeVisible();
    await expect(page.getByText("프롬프트 2").first()).toBeVisible();

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");                     // back to the projects
    await expect(page.getByText("Projects").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("F2 renames a session the way /rename does", async () => {
  const { home, projectDir } = fixture();
  const { app, page } = await launch(home);
  try {
    // Wait for the list before typing: keys sent before the first scan lands have nothing to act on.
    await expect(page.getByText("프롬프트 1").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Back (Esc)")).toBeVisible();      // the sessions screen is up
    await page.keyboard.press("F2");
    const input = page.getByTestId("rename-input");
    await expect(input).toBeVisible();
    await input.fill("이름 바꾼 세션");
    await input.press("Enter");
    await expect(page.getByText("이름 바꾼 세션").first()).toBeVisible();

    // What matters is the file Claude Code itself reads. Which of the two fixture sessions sits at
    // the top depends on their timestamps, so the assertion is "one of them was renamed properly".
    const renamed = [SESSION_ONE, SESSION_TWO].find((id) => {
      try {
        const sidecar = join(home, "projects", projectDir, id, "custom-title.json");
        return JSON.parse(readFileSync(sidecar, "utf8")).customTitle === "이름 바꾼 세션";
      } catch {
        return false;
      }
    });
    expect(renamed, "a custom-title.json should exist for the renamed session").toBeDefined();
    const lines = readFileSync(join(home, "projects", projectDir, `${renamed}.jsonl`), "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1] as string))
      .toMatchObject({ type: "custom-title", customTitle: "이름 바꾼 세션" });
  } finally {
    await app.close();
  }
});

test("settings save to config/manager.json and survive a restart", async () => {
  const { home } = fixture();
  const first = await launch(home);
  try {
    await expect(first.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await first.page.keyboard.press("s");
    await expect(first.page.getByText("Permissions").first()).toBeVisible();
    await first.page.getByText("Bypass permissions").first().click();
    await expect.poll(() => {
      try {
        return JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8")).launch?.permission;
      } catch {
        return null;
      }
    }).toBe("bypass");
  } finally {
    await first.app.close();
  }

  const second = await launch(home);
  try {
    await expect(second.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await second.page.keyboard.press("s");
    // The choice is still the one that was made, read back from the file.
    await expect(second.page.locator("text=Bypass permissions").first()).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test("the help overlay lists the shortcuts", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await page.keyboard.press("?");
    await expect(page.getByText("Keyboard").first()).toBeVisible();
    await expect(page.getByText("Rename (alias for a project)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Keyboard")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

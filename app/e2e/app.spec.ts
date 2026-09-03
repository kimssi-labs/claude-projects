/**
 * End-to-end: the built app, driven the way a person drives it — with the keyboard.
 *
 * Every run gets its own CLAUDE_HOME fixture, so the test sees a known set of projects and can
 * assert on what a rename actually wrote to disk.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // --lang pins what app.getLocale() reports, and the window follows the machine unless told
    // otherwise: without this the suite reads in the language of whoever is running it.
    args: [".", "--lang=en-US"],
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
    await expect(page.getByText("2 sessions").first()).toBeVisible();
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
    await expect(page.getByText("2 sessions").first()).toBeVisible();            // the sessions screen is up
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

test("a screenshot on the clipboard becomes a file, with its path ready to paste", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Nothing on the clipboard: say so rather than writing an empty file.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    expect(await page.evaluate(() => window.hangar.pasteImage())).toMatchObject({ ok: false });

    // A real image, put on the clipboard the way a screenshot tool would.
    await app.evaluate(({ clipboard, nativeImage }) => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGO8WR7OgA0wYRUdtBIATsMBtyGIWZMAAAAASUVORK5CYII=", "base64");
      clipboard.writeImage(nativeImage.createFromBuffer(png));
    });

    const pasted = await page.evaluate(() => window.hangar.pasteImage());
    expect(pasted.ok, pasted.message).toBe(true);
    expect(pasted.file).toMatch(new RegExp(String.raw`hangar-clips[\\/]clip-\d{8}-\d{6}-\d{3}\.png$`));
    expect(existsSync(pasted.file as string), "the file is really there").toBe(true);

    // The path is what a terminal can use, so that is what is on the clipboard now.
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(pasted.file);
  } finally {
    await app.close();
  }
});

/**
 * The watch is what lets the ordinary paste key work, and it is invisible when it is not running —
 * the unit tests know when a screenshot should be given a path, but only this knows that anything
 * is actually watching. It was written after a build shipped with the rules in place and nothing
 * calling them.
 *
 * Windows only: the change is detected through the clipboard sequence number, and no equivalent is
 * used elsewhere, so the setting simply does nothing there.
 */
test("a copied screenshot is given a path without anyone pressing a shortcut", async () => {
  test.skip(process.platform !== "win32", "the clipboard watch is Windows-only");
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    await app.evaluate(({ clipboard, nativeImage }) => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGO8WR7OgA0wYRUdtBIATsMBtyGIWZMAAAAASUVORK5CYII=", "base64");
      clipboard.clear();
      clipboard.writeImage(nativeImage.createFromBuffer(png));
    });

    // Nothing is pressed. Within a poll or two the path should simply be there.
    await expect.poll(
      () => app.evaluate(({ clipboard }) => clipboard.readText()),
      { message: "the watch never added a path", timeout: 8000 },
    ).toMatch(new RegExp(String.raw`hangar-clips[\\/]clip-\d{8}-\d{6}-\d{3}\.png$`));

    const file = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(existsSync(file), "the file the path points at is really there").toBe(true);
    // And the picture is still on the clipboard, so an image editor is unaffected.
    expect(await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty())).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * The + beside the search box: a folder that has never had a session becomes a project.
 *
 * The folder picker is the OS's own dialog, which nothing can drive from here, so the test stands
 * in for it and checks everything after the choice — the row appears, is selected, and is a
 * project a session can be started from.
 */
test("the + button adds a folder as a project and lands on it", async () => {
  const { home } = fixture();
  const fresh = join(home, "..", "fresh-folder");
  mkdirSync(fresh, { recursive: true });

  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, fresh);

    await page.getByRole("button", { name: "Add a project" }).click();

    await expect(page.getByText("fresh-folder", { exact: true }).first()).toBeVisible();
    // Landed on it: the detail panel names the folder, and New is offered for it.
    await expect(page.getByText(fresh, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New" })).toBeEnabled();
    expect(existsSync(join(home, "projects", fresh.replace(/[^A-Za-z0-9]/g, "-")))).toBe(true);
  } finally {
    await app.close();
  }
});

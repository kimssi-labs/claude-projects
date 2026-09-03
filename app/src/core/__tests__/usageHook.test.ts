/**
 * Core: adding and removing the usage hook in someone else's settings file.
 *
 * The file belongs to the user and usually already has hooks in it. Adding ours must leave every
 * one of them untouched, and removing ours must put the file back exactly as it was.
 */
import { describe, expect, it } from "vitest";

import { hookCommand, hookFileName, hookInstalled, hookScript, withHook, withoutHook } from "../usageHook.js";

const CACHE = "C:\\Users\\me\\.claude\\cache\\rate-limits.json";

const MINE = hookCommand("C:\\Users\\me\\AppData\\Roaming\\Hangar\\hangar-usage.cmd");

const OTHERS = {
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "bash ~/.claude/hooks/stop/mine.sh", shell: "bash" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
  },
  statusLine: { type: "command", command: "bash ~/.claude/statusline/command.sh" },
};

describe("the usage hook", () => {
  it("adds itself beside the hooks already there, and says so", () => {
    expect(hookInstalled(OTHERS)).toBe(false);
    const next = withHook(OTHERS, MINE);
    expect(hookInstalled(next)).toBe(true);

    const stop = (next.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0]?.hooks[0]?.command).toBe("bash ~/.claude/hooks/stop/mine.sh");
    expect(stop[1]?.hooks[0]?.command).toBe(MINE);
    // Everything else in the file is left exactly as it was — a status line above all, since that
    // is the other place Claude Code reports usage and users have their own.
    expect(next.statusLine).toEqual(OTHERS.statusLine);
    expect((next.hooks as Record<string, unknown>).PreToolUse).toEqual(OTHERS.hooks.PreToolUse);
  });

  it("is added once, however many times it is asked for", () => {
    expect(withHook(withHook(OTHERS, MINE), MINE)).toEqual(withHook(OTHERS, MINE));
  });

  it("repoints an entry left by an older install rather than adding a second", () => {
    // The application folder moves, or the platform's script changes name; the stale entry runs
    // nothing, and two entries would write the file twice a turn.
    const stale = withHook(OTHERS, hookCommand("D:\\Old\\Hangar\\hangar-usage.cmd"));
    const next = withHook(stale, MINE);
    const stop = (next.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    expect(stop).toHaveLength(2);
    expect(stop[1]?.hooks[0]?.command).toBe(MINE);
  });

  it("removes only itself, restoring the file it was added to", () => {
    expect(withoutHook(withHook(OTHERS, MINE))).toEqual(OTHERS);
  });

  it("leaves no empty scaffolding behind in a file that had no hooks at all", () => {
    const bare = { statusLine: { type: "command", command: "x" } };
    expect(withoutHook(withHook(bare, MINE))).toEqual(bare);
    expect(withoutHook(withHook(bare, MINE))).not.toHaveProperty("hooks");
  });

  it("takes removal of a hook that is not there as nothing to do", () => {
    expect(withoutHook(OTHERS)).toEqual(OTHERS);
    expect(withoutHook({})).toEqual({});
  });
});

describe("the script it installs", () => {
  it("is named and written for the platform it will run on", () => {
    expect(hookFileName("win32")).toBe("hangar-usage.cmd");
    expect(hookFileName("linux")).toBe("hangar-usage.sh");
    expect(hookFileName("darwin")).toBe("hangar-usage.sh");
  });

  it("asks for nothing the platform does not already ship", () => {
    // The whole point of the rewrite: the first draft ran through bash, which plenty of Windows
    // machines do not have, and curl, which the file approach never needed.
    const windows = hookScript("win32", CACHE);
    expect(windows).toContain("more.com");
    expect(windows).not.toMatch(/\bbash\b/);
    expect(windows).not.toMatch(/\bcurl\b/);

    const posix = hookScript("linux", CACHE);
    expect(posix.startsWith("#!/bin/sh")).toBe(true);
    expect(posix).not.toMatch(/\bbash\b/);
    expect(posix).not.toMatch(/\bcurl\b|\bjq\b/);
  });

  it("publishes to the exact file the app reads, rather than guessing at a home", () => {
    // Claude Code keys its home off CLAUDE_CONFIG_DIR and Hangar off CLAUDE_HOME. A script that
    // worked either out at run time would write where nothing reads on a machine that sets one.
    expect(hookScript("win32", CACHE)).toContain(CACHE);
    expect(hookScript("linux", "/home/me/.claude/cache/rate-limits.json"))
      .toContain("'/home/me/.claude/cache/rate-limits.json'");
    expect(hookScript("win32", CACHE)).not.toContain("CLAUDE_CONFIG_DIR");
    expect(hookScript("linux", "/x/y.json")).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("writes through a temporary file, so a reader never sees half of one", () => {
    expect(hookScript("linux", CACHE)).toMatch(/mv -f/);
    expect(hookScript("win32", CACHE)).toMatch(/Move-Item -Force/);
  });
});

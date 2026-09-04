/**
 * Claude Code's usage figures — the main side.
 *
 * Claude Code does not publish its rate limits anywhere on its own (measured: none of thousands of
 * transcript lines carry them). This feature installs a Stop hook into its settings that writes
 * them to a cache file, and reads that file back. The hook text itself is in core/usageHook.ts and
 * the reading in core/status.ts; this is the feature's edge.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { homePaths } from "../../core/paths.js";
import { readStatus, readStatusUpdatedAt } from "../../core/status.js";
import { hookCommand, hookFileName, hookInstalled, hookScript, withHook, withoutHook } from "../../core/usageHook.js";
import type { ActionResult, SettingsPayload } from "../../main/ipc.js";
import { usageContract, type UsageState } from "./contract.js";

/** What this feature needs from the rest of main. */
export interface UsageDeps {
  /** The whole settings payload, which the hook toggle answers with. */
  settingsPayload(): SettingsPayload;
}

/** What the rest of main may ask of this feature. */
export interface UsageFeature {
  /** How collection stands — the settings payload carries it. */
  state(): UsageState;
}

/**
 * Claude Code's own settings file, read as it is.
 *
 * It is the user's file, not ours: they may have hooks, permissions and anything else in it, and
 * writing our own object over it would delete every setting they have. So an unreadable file stops
 * the operation rather than starting from an empty one — "absent" and "unparseable" are different
 * answers, and only the first is a file we may create.
 */
function readClaudeSettings(): { settings: Record<string, unknown>; readable: boolean } {
  let text: string;
  try {
    // A BOM here is normal: plenty of editors and PowerShell itself write one.
    text = readFileSync(homePaths().settings, "utf8").replace(/^﻿/, "");
  } catch {
    return { settings: {}, readable: true };     // absent, which is a file we may create
  }
  if (!text.trim()) return { settings: {}, readable: true };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { settings: parsed as Record<string, unknown>, readable: true }
      : { settings: {}, readable: false };
  } catch {
    return { settings: {}, readable: false };
  }
}

function usageHookPath(): string {
  return join(homePaths().hooks, hookFileName(process.platform));
}

function usageState(): UsageState {
  return {
    collecting: hookInstalled(readClaudeSettings().settings),
    portable: !app.isPackaged || Boolean(process.env["PORTABLE_EXECUTABLE_DIR"]),
    updatedAt: readStatusUpdatedAt(),
    reported: readStatus(undefined, { windows: null }).windows.length,
  };
}

/**
 * Turn collection on or off, writing as little of the user's file as the job needs.
 *
 * The script is rewritten on every enable rather than only when absent: an application that moved,
 * or a script this app has since improved, would otherwise keep running yesterday's copy.
 */
function setUsageCollection(on: boolean): ActionResult {
  const paths = homePaths();
  const script = usageHookPath();
  try {
    const current = readClaudeSettings();
    if (!current.readable) {
      return {
        ok: false,
        message: `${paths.settings} is not valid JSON, so it was left alone. Fix it and try again.`,
      };
    }
    if (on) {
      mkdirSync(paths.hooks, { recursive: true });
      // The cache path is baked in rather than derived by the script: Claude Code keys its home off
      // CLAUDE_CONFIG_DIR and this app off CLAUDE_HOME, so only the installer knows both answers.
      writeFileSync(script, hookScript(process.platform, paths.rateLimits), "utf8");
      if (process.platform !== "win32") chmodSync(script, 0o755);
    }
    const before = current.settings;
    const after = on ? withHook(before, hookCommand(script)) : withoutHook(before);
    mkdirSync(dirname(paths.settings), { recursive: true });
    writeFileSync(paths.settings, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    if (!on) rmSync(script, { force: true });
  } catch (error) {
    return { ok: false, message: `Could not write Claude Code's settings: ${(error as Error).message}` };
  }
  return {
    ok: true,
    message: on
      ? "Collecting usage. The figures appear when the next session finishes a turn."
      : "Usage collection off. The hook has been removed.",
  };
}

export function register(ctx: MainContext, wire: Wire, deps: UsageDeps): UsageFeature {
  wire.bind(usageContract, {
    status: () => readStatus(undefined, ctx.config.status()),
    setUsageHook: (on) => ({ ...setUsageCollection(on), settings: deps.settingsPayload() }),
  });
  return { state: usageState };
}

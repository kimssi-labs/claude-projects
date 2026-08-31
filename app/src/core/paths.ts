/**
 * Where Claude Code keeps its state, and where this app keeps its own settings.
 *
 * Everything is derived from one root so a test can point the whole app at a throwaway home, and
 * so Windows and Linux differ in nothing but the root itself.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_HOME_ENV = "CLAUDE_HOME";

/** `~/.claude`, or whatever CLAUDE_HOME says — the single root every other path hangs off. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[CLAUDE_HOME_ENV] || join(homedir(), ".claude");
}

export interface HomePaths {
  root: string;
  projects: string;
  liveSessions: string;
  history: string;
  claudeJson: string;
  config: string;
  managerConfig: string;
  aliases: string;
  rateLimits: string;
  mcpStatus: string;
  outlookStatus: string;
  ponytailFlag: string;
  /** Where a pasted screenshot is written, so a terminal session can be given its path. */
  clips: string;
}

export function homePaths(root = claudeHome()): HomePaths {
  return {
    root,
    projects: join(root, "projects"),
    liveSessions: join(root, "sessions"),
    history: join(root, "history.jsonl"),
    // Claude Code's own settings file sits NEXT to the home directory, not inside it.
    claudeJson: join(root, "..", ".claude.json"),
    config: join(root, "config"),
    managerConfig: join(root, "config", "manager.json"),
    aliases: join(root, "config", "project-aliases.json"),
    rateLimits: join(root, "cache", "rate-limits.json"),
    mcpStatus: join(root, "cache", "mcp-status.json"),
    outlookStatus: join(root, "cache", "outlook-status.json"),
    ponytailFlag: join(root, ".ponytail-active"),
    clips: join(root, "cache", "hangar-clips"),
  };
}

/**
 * Claude Code's project-directory encoding: every non-alphanumeric character becomes `-`.
 * Not reversible — the real folder is read from a transcript's `cwd`, this only matches names.
 */
export function encodeProjectPath(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

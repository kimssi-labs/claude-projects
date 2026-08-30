/**
 * Reading (and editing) what Claude Code keeps under ~/.claude.
 *
 * Ported from the terminal version, including the parts that were learned the hard way: a project's
 * real folder only exists inside its transcripts, a session's title can come from three places, and
 * a "live" session is a pid that still exists — the registry file outlives the process.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigStore } from "./config.js";
import { encodeProjectPath, homePaths, type HomePaths } from "./paths.js";
import type { ProjectInfo, SessionInfo } from "./types.js";

const TRANSCRIPT_EXT = ".jsonl";
const CUSTOM_TITLE_FILE = "custom-title.json";
const MEMORY_DIR = "memory";
const CUSTOM_TITLE_TYPE = "custom-title";
/** Lines of a transcript scanned for `cwd`; it is written near the top or not at all. */
const HEAD_LINES = 20;
const NO_PROMPT = "(no prompt)";

interface CacheEntry<T> { signature: string; value: T }

function readLines(file: string, limit?: number): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;                                   // a partially written line is normal while a session runs
    }
    if (limit && out.length >= limit) break;
  }
  return out;
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function signature(file: string): string {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "-";
  }
}

export interface StoreOptions {
  /** Injected so tests can decide liveness without real processes. */
  isAlive?: (pid: number) => boolean;
  /** Injected so a dead network path cannot block a test. */
  folderExists?: (path: string) => boolean;
}

export class Store {
  readonly paths: HomePaths;
  readonly config: ConfigStore;
  private readonly isAlive: (pid: number) => boolean;
  private readonly folderExists: (path: string) => boolean;
  private titles: CacheEntry<Map<string, string>> | null = null;
  private cwds = new Map<string, CacheEntry<string | null>>();

  constructor(home?: string, options: StoreOptions = {}) {
    this.paths = homePaths(home);
    this.config = new ConfigStore(home);
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.folderExists = options.folderExists ?? ((path) => existsSync(path));
  }

  /** Session ids with a living process behind them, from the registry Claude Code writes. */
  liveSessions(): Map<string, number> {
    const live = new Map<string, number>();
    let entries: string[] = [];
    try {
      entries = readdirSync(this.paths.liveSessions);
    } catch {
      return live;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const data = readJsonFile<{ sessionId?: string; pid?: number }>(join(this.paths.liveSessions, entry), {});
      const pid = Number(data.pid);
      if (data.sessionId && Number.isFinite(pid) && this.isAlive(pid)) live.set(data.sessionId, pid);
    }
    return live;
  }

  /** First prompt per session. Re-parsed only when history.jsonl changed: it is megabytes. */
  historyTitles(): Map<string, string> {
    const sig = signature(this.paths.history);
    if (this.titles?.signature === sig) return this.titles.value;
    const titles = new Map<string, string>();
    for (const entry of readLines(this.paths.history)) {
      const row = entry as { sessionId?: string; display?: string };
      if (!row.sessionId || !row.display || titles.has(row.sessionId)) continue;
      titles.set(row.sessionId, row.display.trim().split("\n")[0] ?? "");
    }
    this.titles = { signature: sig, value: titles };
    return titles;
  }

  /** Real folder of a transcript, cached per file: a session's cwd cannot change. */
  transcriptCwd(file: string): string | null {
    const sig = signature(file);
    const hit = this.cwds.get(file);
    if (hit?.signature === sig) return hit.value;
    let cwd: string | null = null;
    for (const entry of readLines(file, HEAD_LINES)) {
      const row = entry as { cwd?: string };
      if (row.cwd) { cwd = row.cwd; break; }
    }
    this.cwds.set(file, { signature: sig, value: cwd });
    return cwd;
  }

  /** Folders known to Claude Code, keyed by their encoded name — the fallback for empty projects. */
  knownPaths(): Map<string, string> {
    const data = readJsonFile<{ projects?: Record<string, unknown> }>(this.paths.claudeJson, {});
    const known = new Map<string, string>();
    for (const path of Object.keys(data.projects ?? {})) {
      const encoded = encodeProjectPath(path);
      if (!known.has(encoded)) known.set(encoded, path);
    }
    return known;
  }

  customTitle(dir: string, sessionId: string): string | null {
    const data = readJsonFile<{ customTitle?: string }>(join(dir, sessionId, CUSTOM_TITLE_FILE), {});
    return data.customTitle || null;
  }

  /** Every project, newest use first. */
  scan(): ProjectInfo[] {
    const live = this.liveSessions();
    const titles = this.historyTitles();
    const known = this.knownPaths();
    const aliases = this.config.aliases();
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.paths.projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const projects = dirs.map((name) => this.readProject(name, live, titles, known, aliases));
    return projects.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  private readProject(
    dirName: string,
    live: Map<string, number>,
    titles: Map<string, string>,
    known: Map<string, string>,
    aliases: Record<string, string>,
  ): ProjectInfo {
    const dir = join(this.paths.projects, dirName);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(TRANSCRIPT_EXT))
      .map((e) => join(dir, e.name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    let cwd: string | null = null;
    for (const file of files) {
      cwd = this.transcriptCwd(file);
      if (cwd) break;
    }
    cwd = cwd ?? known.get(dirName) ?? null;

    const sessions: SessionInfo[] = files.map((file) => {
      const id = file.slice(file.lastIndexOf(sep()) + 1, -TRANSCRIPT_EXT.length);
      const st = statSync(file);
      const custom = this.customTitle(dir, id);
      const prompt = titles.get(id) ?? "";
      return {
        id,
        file,
        title: custom || prompt || NO_PROMPT,
        named: Boolean(custom),
        prompt,
        startedAt: st.birthtimeMs || st.ctimeMs,
        modifiedAt: st.mtimeMs,
        bytes: st.size,
        live: live.has(id),
        pid: live.get(id) ?? null,
      };
    });

    const dirMtime = statSync(dir).mtimeMs;
    const alias = (cwd && aliases[cwd]) || aliases[dirName] || null;
    return {
      dir: dirName,
      cwd,
      alias,
      name: alias || (cwd ? baseName(cwd) : dirName),
      sessions,
      hasMemory: existsSync(join(dir, MEMORY_DIR)),
      exists: cwd ? this.folderExists(cwd) : false,
      lastUsed: sessions.length ? Math.max(...sessions.map((s) => s.modifiedAt)) : dirMtime,
      totalBytes: sessions.reduce((sum, s) => sum + s.bytes, 0),
      liveCount: sessions.filter((s) => s.live).length,
    };
  }

  /**
   * Give a session a title, exactly the way Claude Code's own `/rename` does — the sidecar file it
   * reads plus the transcript line it appends — so the new name also shows up in `/resume`.
   */
  renameSession(session: SessionInfo, title: string): void {
    const dir = session.file.slice(0, session.file.lastIndexOf(sep()));
    const sideDir = join(dir, session.id);
    mkdirSync(sideDir, { recursive: true });
    writeFileSync(join(sideDir, CUSTOM_TITLE_FILE), JSON.stringify({ customTitle: title }), "utf8");
    const line = JSON.stringify({ type: CUSTOM_TITLE_TYPE, customTitle: title, sessionId: session.id });
    const existing = readFileSync(session.file, "utf8");
    appendFileSync(session.file, `${existing.endsWith("\n") || !existing ? "" : "\n"}${line}\n`, "utf8");
  }

  /** Display alias for a project; an empty name clears it. */
  renameProject(project: ProjectInfo, alias: string): void {
    const aliases = this.config.aliases();
    const key = project.cwd ?? project.dir;
    if (alias) aliases[key] = alias;
    else delete aliases[key];
    this.config.saveAliases(aliases);
  }

  deleteSession(session: SessionInfo): void {
    const dir = session.file.slice(0, session.file.lastIndexOf(sep()));
    try { unlinkSync(session.file); } catch { /* already gone */ }
    rmSync(join(dir, session.id), { recursive: true, force: true });
  }

  deleteProject(project: ProjectInfo): void {
    rmSync(join(this.paths.projects, project.dir), { recursive: true, force: true });
  }
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

/** A pid that no longer exists is not live; signal 0 asks without touching the process. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";   // exists, owned by someone else
  }
}

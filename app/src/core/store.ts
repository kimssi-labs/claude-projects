/**
 * Reading (and editing) what Claude Code keeps under ~/.claude.
 *
 * Ported from the terminal version, including the parts that were learned the hard way: a project's
 * real folder only exists inside its transcripts, a session's title can come from three places, and
 * a "live" session is a pid that still exists — the registry file outlives the process.
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { ConfigStore } from "./config.js";
import { encodeProjectPath, homePaths, type HomePaths } from "./paths.js";
import { factsFrom, type TranscriptFacts } from "./transcript.js";
import type { ProjectInfo, SessionInfo } from "./types.js";

const TRANSCRIPT_EXT = ".jsonl";
const CUSTOM_TITLE_FILE = "custom-title.json";
const MEMORY_DIR = "memory";
const CUSTOM_TITLE_TYPE = "custom-title";
/** Lines of a transcript scanned for `cwd`; it is written near the top or not at all. */
const HEAD_LINES = 20;
/**
 * How much of a transcript is read to find that `cwd`.
 *
 * These files reach tens of megabytes — the largest here is 48 MB — and reading one whole just to
 * look at its first line is what made a scan take twenty seconds and the window go grey with it.
 */
const HEAD_BYTES = 64 * 1024;
/**
 * How much of the END of a transcript is read, to find the newest `ai-title`.
 *
 * Claude Code rewrites that title as the conversation grows, so the last one is the good one and it
 * sits near the end. Measured on a 139 KB session: 18 KB from the end. Half a megabyte is generous
 * for that and still nothing next to a 48 MB file. A title further back than this window is simply
 * not found, and the row falls back to the first prompt — which is what it showed before.
 */
const TAIL_BYTES = 512 * 1024;
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

/** The first `bytes` of a file as text, without reading (or decoding) the rest of it. */
function readHead(file: string, bytes: number): string {
  let handle: number | null = null;
  try {
    handle = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(handle, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        /* already gone */
      }
    }
  }
}

/** The last `bytes` of a file as text. The first line comes back cut; callers drop it. */
function readTail(file: string, bytes: number, size: number): string {
  const from = Math.max(0, size - bytes);
  if (from === 0) return "";                      // the head read already covered the whole file
  let handle: number | null = null;
  try {
    handle = openSync(file, "r");
    const want = size - from;
    const buffer = Buffer.allocUnsafe(want);
    const read = readSync(handle, buffer, 0, want, from);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Objects from the first lines of `text`; a trailing partial line is dropped. */
function parseLines(text: string, limit: number): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;                                   // the cut-off last line, or a half-written one
    }
    if (out.length >= limit) break;
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
  /** Per transcript, re-read when it grows — unlike the cwd, the title keeps changing. */
  private facts = new Map<string, CacheEntry<TranscriptFacts>>();
  /** Answers for `folderExists`, filled in by a background probe — see `folderReachable`. */
  private folders = new Map<string, boolean>();
  private probing = new Set<string>();

  constructor(home?: string, options: StoreOptions = {}) {
    this.paths = homePaths(home);
    this.config = new ConfigStore(home);
    this.isAlive = options.isAlive ?? defaultIsAlive;
    // The default is deliberately NOT existsSync: a project on an unreachable network share makes
    // it wait for the SMB timeout — measured at 10.9 s here, on the thread that draws the window.
    this.folderExists = options.folderExists ?? ((path) => this.folderReachable(path));
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

  /**
   * Real folder of a transcript.
   *
   * Cached by path with no signature on purpose: a session's cwd cannot change, so a transcript
   * that is being appended to right now — the one session that would otherwise be re-read on every
   * single scan — is read exactly once.
   */
  transcriptCwd(file: string): string | null {
    const hit = this.cwds.get(file);
    if (hit) return hit.value;
    let cwd: string | null = null;
    for (const entry of parseLines(readHead(file, HEAD_BYTES), HEAD_LINES)) {
      const row = entry as { cwd?: string };
      if (row.cwd) { cwd = row.cwd; break; }
    }
    this.cwds.set(file, { signature: "", value: cwd });
    return cwd;
  }

  /**
   * The title and the first real prompt, read from the transcript rather than from `history.jsonl`.
   *
   * Two bounded reads — the start for the prompt, the end for the newest `ai-title` — cached
   * against size and mtime, so a session being appended to is re-read only when it actually grows.
   */
  transcriptFacts(file: string, st: { size: number; mtimeMs: number }): TranscriptFacts {
    const sig = `${st.size}:${st.mtimeMs}`;
    const hit = this.facts.get(file);
    if (hit?.signature === sig) return hit.value;
    const head = readHead(file, HEAD_BYTES);
    const complete = st.size <= HEAD_BYTES;
    const value = factsFrom(head, complete ? "" : readTail(file, TAIL_BYTES, st.size), complete);
    this.facts.set(file, { signature: sig, value });
    return value;
  }

  /**
   * Whether a folder is there, answered from the last background probe.
   *
   * A local path answers on the first probe, microseconds later. A dead UNC path takes its ten
   * seconds on a worker thread, where nobody is waiting: until it answers the folder is reported as
   * present, which is the harmless guess — the row simply is not greyed out yet.
   */
  private folderReachable(path: string): boolean {
    const known = this.folders.get(path);
    if (!this.probing.has(path)) {
      this.probing.add(path);
      void access(path)
        .then(() => this.folders.set(path, true))
        .catch(() => this.folders.set(path, false))
        .finally(() => this.probing.delete(path));
    }
    return known ?? true;
  }

  /** Folders known to Claude Code, keyed by their encoded name — the fallback for empty projects. */
  knownPaths(): Map<string, string> {
    const data = readJsonFile<{ projects?: Record<string, unknown> }>(this.paths.claudeJson, {});
    const known = new Map<string, string>();
    for (const path of Object.keys(data.projects ?? {})) {
      const encoded = encodeProjectPath(path);
      if (!known.has(encoded)) known.set(encoded, path);
    }
    // A folder added by hand has neither a transcript nor a .claude.json entry yet.
    for (const [dir, path] of Object.entries(this.config.addedProjects())) {
      if (!known.has(dir)) known.set(dir, path);
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
    const pins = this.config.pins();
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.paths.projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const projects = dirs.map((name) => this.readProject(name, live, titles, known, aliases, pins));
    // Pinned rows first, then newest use first — a pin is the user overruling the clock.
    return projects.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastUsed - a.lastUsed);
  }

  private readProject(
    dirName: string,
    live: Map<string, number>,
    titles: Map<string, string>,
    known: Map<string, string>,
    aliases: Record<string, string>,
    pins: { projects: string[]; sessions: string[] },
  ): ProjectInfo {
    const dir = join(this.paths.projects, dirName);
    // Stat once per file and sort on that: comparing with statSync() inside the comparator asks
    // the filesystem O(n log n) times for numbers that do not change during a scan.
    const stats = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(TRANSCRIPT_EXT))
      .map((e) => {
        const file = join(dir, e.name);
        return { file, stat: statSync(file) };
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const files = stats.map((entry) => entry.file);

    let cwd: string | null = null;
    for (const file of files) {
      cwd = this.transcriptCwd(file);
      if (cwd) break;
    }
    cwd = cwd ?? known.get(dirName) ?? null;

    const sessions: SessionInfo[] = stats.flatMap(({ file, stat: st }) => {
      const facts = this.transcriptFacts(file, st);
      // Not a session anyone can open: a few hundred bytes holding a title and no conversation.
      // Claude Code leaves one behind whenever the talking ends up in a different file.
      if (!facts.conversation) return [];
      const id = file.slice(file.lastIndexOf(sep()) + 1, -TRANSCRIPT_EXT.length);
      const custom = this.customTitle(dir, id);
      // The history file is the last resort now, not the first: it is not reliably per-session.
      const prompt = facts.firstPrompt || titles.get(id) || "";
      return [{
        id,
        file,
        // A name the user chose wins; then the one Claude Code wrote, which is what its own tab and
        // /resume picker show; then the question that started it.
        title: custom || facts.aiTitle || prompt || NO_PROMPT,
        named: Boolean(custom),
        prompt,
        startedAt: st.birthtimeMs || st.ctimeMs,
        modifiedAt: st.mtimeMs,
        bytes: st.size,
        live: live.has(id),
        pid: live.get(id) ?? null,
        pinned: pins.sessions.includes(id),
      }];
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned));   // stable: newest first within each group

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
      pinned: pins.projects.includes(dirName),
      // Filled in by the main process, which is where reading a working tree belongs.
      git: null,
      worktree: false,
      parentDir: null,
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

  /**
   * A folder that has never had a session, made into a project.
   *
   * Claude Code creates a project's directory the first time it writes a transcript there; this
   * makes the same directory ahead of time, so the folder is in the list and a session can be
   * started from it instead of from a terminal. Once one has run, the transcript's cwd takes over.
   */
  addProject(cwd: string): string {
    const dir = encodeProjectPath(cwd);
    mkdirSync(join(this.paths.projects, dir), { recursive: true });
    this.config.saveAddedProject(dir, cwd);
    return dir;
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

/**
 * A file name for a pasted image: sortable, unique, and readable in a terminal.
 *
 * Seconds are not enough — two screenshots in the same second are normal — so the name carries
 * milliseconds rather than a counter that would have to be remembered between runs.
 */
export function clipFileName(at = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `clip-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    + `-${pad(at.getMilliseconds(), 3)}.png`;
}

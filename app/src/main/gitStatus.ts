/**
 * Reading a project's git state from disk, and counting its changes off the UI thread.
 *
 * Two speeds. The head line comes from `.git/HEAD` and the ref it names — three small reads, cheap
 * enough to do for every project on every scan. The dirty count needs a real diff, so it is a
 * `git status` run for the selected project only, cached, and never waited on: the row shows the
 * branch immediately and gains the count when it arrives.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { randomUUID } from "node:crypto";

import { countDirty, parseHead, type GitInfo } from "../core/git.js";
import {
  classify, defaultBaseFrom, fetchArgs, reconcileArgs, splitBase, FETCH_TIMEOUT_MS, STEP_TIMEOUT_MS,
  type GitSyncConfig, type SyncOutcome,
} from "../core/gitSync.js";
import {
  addArgs, classifyWorktree, cleanBranchName, parseWorktrees, removeArgs, suggestPath,
  type Worktree, type WorktreeOutcome,
} from "../core/worktree.js";

/** Give up rather than hold anything up; a huge repository is not worth a stalled row. */
const STATUS_TIMEOUT_MS = 4_000;
/** A count this old is re-taken. Long enough that scrolling a list costs nothing. */
const COUNT_TTL_MS = 15_000;

interface Counted { at: number; dirty: number }
const counts = new Map<string, Counted>();
const running = new Set<string>();

/**
 * The `.git` for `cwd`: the directory itself, the file a worktree leaves behind, or a parent's.
 *
 * A project opened inside a repository is still in that repository, so the walk upwards matters —
 * but it stops at the filesystem root rather than wandering, and a missing folder simply has none.
 */
export function gitDir(cwd: string): string | null {
  let here = cwd;
  for (;;) {
    const candidate = join(here, ".git");
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        // A linked worktree: the file holds "gitdir: <path>".
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"));
        const target = pointer?.[1]?.trim();
        if (target) return target;
      }
    } catch {
      /* not here; try the parent */
    }
    const parent = dirname(here);
    if (parent === here) return null;
    here = parent;
  }
}

/** Where the head points, without running anything. Null when this is not a repository. */
export function headOf(cwd: string): GitInfo | null {
  const dir = gitDir(cwd);
  if (!dir) return null;
  let head: string;
  try {
    head = readFileSync(join(dir, "HEAD"), "utf8");
  } catch {
    return null;
  }
  const parsed = parseHead(head);
  if (!parsed) return null;
  const cached = counts.get(cwd);
  return {
    ...parsed,
    ahead: 0,
    behind: 0,
    dirty: cached && Date.now() - cached.at < COUNT_TTL_MS ? cached.dirty : null,
  };
}

/**
 * Count the uncommitted files, in the background, and call back when the number is in.
 *
 * One run per directory at a time, and at most one per TTL: a list that refreshes every fifteen
 * seconds must not turn into a git process per project per refresh.
 */
export function countChanges(cwd: string, done: (dirty: number) => void): void {
  const cached = counts.get(cwd);
  if (cached && Date.now() - cached.at < COUNT_TTL_MS) {
    done(cached.dirty);
    return;
  }
  if (running.has(cwd)) return;
  if (!existsSync(cwd)) return;
  running.add(cwd);
  execFile(
    "git",
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"],
    { cwd, timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => {
      running.delete(cwd);
      if (error) return;                         // no git on PATH, not a repo, or it took too long
      const dirty = countDirty(stdout);
      counts.set(cwd, { at: Date.now(), dirty });
      done(dirty);
    },
  );
}

/**
 * Bring a working tree up to date with its base branch.
 *
 * Fetch the base into a ref of our own, then rebase or merge onto that ref — never onto FETCH_HEAD,
 * which another fetch in the same repository can replace underneath us. Every step is bounded, so a
 * remote that stops answering fails the update instead of hanging the window.
 */
export async function updateFromBase(
  cwd: string,
  config: GitSyncConfig,
): Promise<SyncOutcome> {
  const run = (args: string[], timeout: number): Promise<{ code: number; output: string }> =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ code, output: `${stdout}\n${stderr}`.trim() });
        });
    });

  const head = headOf(cwd);
  if (!head) return { ok: false, kind: "no-base", message: "This project is not a git repository." };
  if (head.detached) {
    return { ok: false, kind: "detached", message: "The head is detached, so there is no branch to update." };
  }

  let base = config.base.trim();
  if (!base) {
    // What the remote itself calls its default, rather than assuming main.
    const guess = await run(["symbolic-ref", "refs/remotes/origin/HEAD"], STEP_TIMEOUT_MS);
    base = guess.code === 0 ? defaultBaseFrom(guess.output) : "";
  }
  const remotes = await run(["remote"], STEP_TIMEOUT_MS);
  const split = base ? splitBase(base, remotes.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) : null;
  if (!split) {
    return {
      ok: false,
      kind: "no-base",
      message: "No base branch to update from. Name one in Settings, Git — for example origin/main.",
    };
  }

  // Reject a branch name git would not accept before it reaches a command line.
  const wellFormed = await run(["check-ref-format", "--branch", split.branch], STEP_TIMEOUT_MS);
  if (wellFormed.code !== 0) {
    return { ok: false, kind: "no-base", message: `${split.branch} is not a valid branch name.` };
  }

  const privateRef = `refs/hangar/base/${randomUUID()}`;
  const fetched = await run(fetchArgs(split.remote, split.branch, privateRef), FETCH_TIMEOUT_MS);
  if (fetched.code !== 0) return classify(fetched.code, fetched.output);

  const moved = await run(reconcileArgs(config.strategy, privateRef), STEP_TIMEOUT_MS);
  const outcome = classify(moved.code, moved.output);
  // The private ref has served its purpose either way; leaving them behind litters the repository.
  await run(["update-ref", "-d", privateRef], STEP_TIMEOUT_MS);
  counts.delete(cwd);                              // whatever it was, the working tree just changed
  return outcome;
}

/** Every checkout of the repository this folder belongs to. */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile("git", ["worktree", "list", "--porcelain"], { cwd, timeout: STEP_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve({ code: error ? 1 : 0, out: stdout }));
  });
  return result.code === 0 ? parseWorktrees(result.out) : [];
}

/** True when this folder is a linked worktree rather than the repository's own checkout. */
export function isLinkedWorktree(cwd: string): boolean {
  try {
    return statSync(join(cwd, ".git")).isFile();     // a linked worktree's .git is a pointer file
  } catch {
    return false;
  }
}

/**
 * Create a worktree for a new branch, beside the repository.
 *
 * The base is qualified before it is passed: `worktree add` takes a revision, and an unqualified
 * name can be claimed by a tag. `--no-track` keeps the new branch from reporting itself behind the
 * base it was cut from before it has been pushed.
 */
export async function createWorktree(cwd: string, branch: string, base: string): Promise<
  WorktreeOutcome & { path?: string }
> {
  const name = cleanBranchName(branch);
  if (!name) return { ok: false, kind: "failed", message: `"${branch}" is not a branch name git will take.` };

  const run = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, timeout: FETCH_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: `${stdout}\n${stderr}`.trim(),
        }));
    });

  let qualified: string | null = null;
  if (base.trim()) {
    // One rev-parse per candidate is two processes at worst, and only when a base was named.
    const exists = async (ref: string): Promise<boolean> =>
      (await run(["rev-parse", "--verify", "--quiet", ref])).code === 0;
    for (const candidate of base.includes("/")
      ? [`refs/remotes/${base}`, `refs/heads/${base}`]
      : [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
      if (base.startsWith("refs/")) { qualified = (await exists(base)) ? base : null; break; }
      if (await exists(candidate)) { qualified = candidate; break; }
    }
    if (!qualified) {
      return { ok: false, kind: "no-base", message: `${base} is not a branch in this repository.` };
    }
  }

  const path = suggestPath(cwd, name);
  const created = await run(addArgs({ path, branch: name, base: qualified }));
  const outcome = classifyWorktree(created.code, created.out);
  return outcome.ok ? { ok: true, path } : outcome;
}

/** Remove a worktree, refusing one with uncommitted work unless forced. */
export async function dropWorktree(repo: string, path: string, force: boolean): Promise<WorktreeOutcome> {
  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile("git", removeArgs(path, force), { cwd: repo, timeout: STEP_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        out: `${stdout}\n${stderr}`.trim(),
      }));
  });
  counts.delete(path);
  return classifyWorktree(result.code, result.out);
}

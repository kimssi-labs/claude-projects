/**
 * Worktrees: one repository checked out in several folders at once.
 *
 * The reason this belongs in a session manager is that a worktree is how two agents work on one
 * repository without standing on each other. Each gets its own folder, its own branch and its own
 * sessions, and in this app that means each is simply another project in the list.
 *
 * Only the decisions are here — parsing what git says, and building what to say back.
 *
 * Two rules are borrowed from a fleet manager that has been running this for a while, and both are
 * bugs if you skip them. A new branch is created with `--no-track`, or `git status` in the new
 * worktree reports "behind by N" against the base it was cut from, before anything has been pushed.
 * And the base is passed fully qualified, because `worktree add` takes a revision, where a short
 * name can be claimed by a tag of the same name.
 */

export interface Worktree {
  /** Absolute path of the checkout. */
  path: string;
  /** Branch checked out there, or null when the head is detached. */
  branch: string | null;
  /** Commit the head is at. */
  head: string;
  /** The repository's own main checkout, rather than a linked worktree. */
  main: boolean;
  /** Locked worktrees refuse to be removed until unlocked. */
  locked: boolean;
}

/**
 * Read `git worktree list --porcelain`.
 *
 * The porcelain form is a blank-line-separated record per worktree, each a set of `key value`
 * lines. The first record is always the main checkout.
 */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    let path = "";
    let head = "";
    let branch: string | null = null;
    let locked = false;
    let detached = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") detached = true;
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
    }
    if (!path) continue;
    out.push({ path, head, branch: detached ? null : branch, main: out.length === 0, locked });
  }
  return out;
}

/** A branch name git will accept, from something a person typed. */
export function cleanBranchName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, "-");
  if (!name || name.startsWith("-")) return null;
  // The rules git itself enforces, so the failure is a message here rather than a command that dies.
  if (/[~^:?*[\\\x00-\x20\x7f]/.test(name)) return null;
  if (name.includes("..") || name.includes("@{") || name.endsWith(".") || name.endsWith(".lock")) return null;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return null;
  return name;
}

/**
 * Where a new worktree should go: beside the repository, named for the branch.
 *
 * Inside the repository would put a second checkout under the first, which git allows and everything
 * else — searches, watchers, the app's own scan — then has to be taught to ignore.
 */
export function suggestPath(repoPath: string, branch: string): string {
  const separator = repoPath.includes("\\") ? "\\" : "/";
  const trimmed = repoPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  const parent = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  const name = trimmed.slice(cut + 1) || "repo";
  const leaf = branch.replace(/[\\/]/g, "-");
  return `${parent}${separator}${name}-${leaf}`;
}

/** The fully qualified form of a base ref, given which refs exist. */
export function qualifyBase(base: string, exists: (ref: string) => boolean): string | null {
  const trimmed = base.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("refs/")) return exists(trimmed) ? trimmed : null;
  // A name with a slash is usually remote/branch; without one it is a local branch. Both are tried,
  // remote first, because that is what a base branch usually means here.
  const candidates = trimmed.includes("/")
    ? [`refs/remotes/${trimmed}`, `refs/heads/${trimmed}`]
    : [`refs/heads/${trimmed}`, `refs/remotes/origin/${trimmed}`];
  return candidates.find((ref) => exists(ref)) ?? null;
}

/**
 * `git worktree add` for a new branch, or for one that already exists.
 *
 * `--no-track` on a new branch: without it the branch inherits the base's upstream, and `git status`
 * announces it is behind by however many commits the base has — before a single commit of its own
 * has been made, and before it has ever been pushed.
 */
export function addArgs({ path, branch, base, existing }: {
  path: string;
  branch: string;
  base?: string | null;
  /** The branch is already in the repository and should be checked out, not created. */
  existing?: boolean;
}): string[] {
  if (existing) return ["worktree", "add", path, branch];
  const args = ["worktree", "add", "--no-track", "-b", branch, path];
  if (base) args.push(base);
  return args;
}

export function removeArgs(path: string, force = false): string[] {
  return force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
}

export type WorktreeOutcome =
  | { ok: true }
  | { ok: false; kind: "dirty" | "exists" | "branch-taken" | "locked" | "no-base" | "failed"; message: string };

/** What git's refusal actually means, in terms the screen can act on. */
export function classifyWorktree(code: number, output: string): WorktreeOutcome {
  if (code === 0) return { ok: true };
  const text = output.toLowerCase();
  if (/contains modified or untracked files|is dirty/.test(text)) {
    return {
      ok: false,
      kind: "dirty",
      message: "That worktree has uncommitted or untracked files. Deal with them, or remove it by force.",
    };
  }
  if (/already exists|is not an empty directory/.test(text)) {
    return { ok: false, kind: "exists", message: "There is already something at that path." };
  }
  if (/already used by worktree|already checked out/.test(text)) {
    return { ok: false, kind: "branch-taken", message: "That branch is already checked out in another worktree." };
  }
  if (/is locked/.test(text)) {
    return { ok: false, kind: "locked", message: "That worktree is locked." };
  }
  if (/invalid reference|not a valid object name|unknown revision/.test(text)) {
    return { ok: false, kind: "no-base", message: "That base branch does not exist here." };
  }
  const last = output.split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0] ?? "";
  return { ok: false, kind: "failed", message: last || "git refused to create the worktree." };
}

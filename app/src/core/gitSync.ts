/**
 * Bringing a project's branch up to date with the branch it came from.
 *
 * The decisions only: which base, which commands, and what the result means. Running them is the
 * main process's job, and keeping these here is what makes the awkward cases testable — a detached
 * head, a base that is not a remote branch, a rebase that stops on a conflict.
 *
 * Two things are borrowed from how a fleet manager does this, because both are bugs otherwise.
 * The base is fetched into a private ref rather than relied on through FETCH_HEAD, since a second
 * fetch anywhere in the repository can replace that between the fetch and the rebase. And every
 * remote step is bounded: a remote that hangs must fail the update, not the window.
 */

/** How local commits are reconciled with the base. */
export type MergeStrategy = "rebase" | "merge" | "ff-only";

export const MERGE_STRATEGIES: { key: MergeStrategy; label: string; note: string }[] = [
  { key: "rebase", label: "Rebase", note: "replay local commits on top of the base — a straight line" },
  { key: "merge", label: "Merge", note: "join the base in with a merge commit" },
  { key: "ff-only", label: "Fast-forward only", note: "move forward when nothing local is in the way, otherwise stop" },
];

export interface GitSyncConfig {
  strategy: MergeStrategy;
  /**
   * The branch to update from, as `remote/branch`, or empty to use whatever the remote calls its
   * default. A repository whose base is not `origin/main` is common enough to be worth asking.
   */
  base: string;
}

export const SYNC_DEFAULTS: GitSyncConfig = { strategy: "rebase", base: "" };

/** A remote that has hung has to fail the update rather than the window. */
export const FETCH_TIMEOUT_MS = 60_000;
export const STEP_TIMEOUT_MS = 60_000;

/**
 * Split `origin/feature/x` into its remote and branch, given the remotes that exist.
 *
 * Longest remote first: with remotes `origin` and `origin/mirror` — which git permits — the shorter
 * one would claim the ref and the branch would come out wrong.
 */
export function splitBase(base: string, remotes: string[]): { remote: string; branch: string } | null {
  const trimmed = base.trim().replace(/^refs\/remotes\//, "").replace(/^remotes\//, "");
  if (!trimmed || trimmed.startsWith("-")) return null;
  const remote = [...remotes].sort((a, b) => b.length - a.length)
    .find((name) => trimmed !== name && trimmed.startsWith(`${name}/`));
  if (!remote) return null;
  const branch = trimmed.slice(remote.length + 1);
  return branch ? { remote, branch } : null;
}

/** What `git remote show`-style default output names, e.g. `refs/remotes/origin/main`. */
export function defaultBaseFrom(symbolicRef: string): string {
  const match = /refs\/remotes\/(.+)$/.exec(symbolicRef.trim());
  return match?.[1] ?? "";
}

/**
 * Fetch the base into a ref of our own, and refresh the remote-tracking branch alongside it.
 *
 * `+` on both: the private ref is ours to overwrite, and the tracking ref may have been rewritten
 * upstream, which is not a reason for the update to fail.
 */
export function fetchArgs(remote: string, branch: string, privateRef: string): string[] {
  return [
    "fetch", remote,
    `+refs/heads/${branch}:${privateRef}`,
    `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
  ];
}

/** The command that actually moves the branch, for the chosen strategy. */
export function reconcileArgs(strategy: MergeStrategy, ref: string): string[] {
  switch (strategy) {
    case "merge": return ["merge", "--no-rebase", ref];
    case "ff-only": return ["merge", "--ff-only", ref];
    default: return ["rebase", ref];
  }
}

export type SyncOutcome =
  | { ok: true; kind: "current" | "updated" }
  | { ok: false; kind: "conflict" | "dirty" | "diverged" | "no-base" | "detached" | "offline" | "failed"; message: string };

/**
 * What the git output means, in terms a row can show.
 *
 * The message git prints is the only signal for most of these, and the useful part is telling apart
 * "you must do something" from "something went wrong": a conflict and an unclean tree are both the
 * user's turn, and saying which is most of the help.
 */
export function classify(code: number, output: string): SyncOutcome {
  const text = output.toLowerCase();
  if (code === 0) {
    const current = /already up to date|current branch .* is up to date|is up to date/.test(text);
    return { ok: true, kind: current ? "current" : "updated" };
  }
  if (/could not resolve host|unable to access|connection timed out|network is unreachable/.test(text)) {
    return { ok: false, kind: "offline", message: "Could not reach the remote." };
  }
  if (/conflict/.test(text)) {
    return {
      ok: false,
      kind: "conflict",
      message: "The update stopped on a conflict. Resolve it in the project, then finish the rebase or merge.",
    };
  }
  if (/local changes.*would be overwritten|cannot pull with rebase|unstaged changes|please commit or stash/.test(text)) {
    return {
      ok: false,
      kind: "dirty",
      message: "There are uncommitted changes in the way. Commit or stash them first.",
    };
  }
  if (/not possible to fast-forward|diverging branches|divergent/.test(text)) {
    return {
      ok: false,
      kind: "diverged",
      message: "The branch has commits the base does not, so it cannot fast-forward. Rebase or merge instead.",
    };
  }
  return { ok: false, kind: "failed", message: firstLine(output) || "The update did not finish." };
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0] ?? "";
}

/** What the menu entry is called, so it names the branch it will pull from. */
export function syncLabel(base: string): string {
  return base ? `Update from ${base}` : "Update from the base branch";
}

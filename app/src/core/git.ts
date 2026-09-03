/**
 * The one line about a repository worth putting on a row: where you are, and how much is uncommitted.
 *
 * Read from `.git` directly rather than by running git. A scan touches every project on the list,
 * a `git status` on a large repository takes long enough to notice, and spawning one per project
 * per refresh would make the window wait on the disk of every repo the user has ever opened. The
 * files here are small, fixed-format, and cheap to read.
 *
 * The compromise that buys it: the number of changed files needs an index-versus-worktree diff,
 * which is the expensive part of `git status`. So the dirty count is optional, filled in by the
 * caller only where it is cheap or asked for, and the head line stands on its own without it.
 */

/** A branch name, a tag, or a short commit for a detached head. */
export interface GitInfo {
  /** Branch, or the short commit when the head is detached. */
  head: string;
  /** True when the head is a commit rather than a branch. */
  detached: boolean;
  /** Commits ahead of / behind the upstream, when there is one and it has been fetched. */
  ahead: number;
  behind: number;
  /** Files with uncommitted changes, or null when nobody counted. */
  dirty: number | null;
}

/** What `.git/HEAD` says, as a branch name or a short commit. */
export function parseHead(head: string): { head: string; detached: boolean } | null {
  const text = head.trim();
  if (!text) return null;
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (branch?.[1]) return { head: branch[1], detached: false };
  // A detached head is the commit itself; forty hex characters, of which seven is what anyone reads.
  if (/^[0-9a-f]{7,40}$/i.test(text)) return { head: text.slice(0, 7), detached: true };
  return null;
}

/**
 * Ahead/behind, counted from the two commit lists a rev-list would produce.
 *
 * Kept separate so the caller can decide whether that walk is worth doing; on a row that only shows
 * a branch name, it is not.
 */
export function aheadBehind(local: string[], remote: string[]): { ahead: number; behind: number } {
  const theirs = new Set(remote);
  const ours = new Set(local);
  return {
    ahead: local.filter((commit) => !theirs.has(commit)).length,
    behind: remote.filter((commit) => !ours.has(commit)).length,
  };
}

/** The porcelain-v1 lines of `git status`, counted as "files with something uncommitted". */
export function countDirty(porcelain: string): number {
  return porcelain.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * The line a row shows: `main +2` or `main ●3` or `a1b2c3d detached`.
 *
 * Short by construction. A row has a name, a size and a time on it already, and a git line that
 * wraps costs more than it tells.
 */
export function gitLabel(info: GitInfo): string {
  const parts = [info.detached ? `${info.head} detached` : info.head];
  if (info.ahead) parts.push(`↑${info.ahead}`);
  if (info.behind) parts.push(`↓${info.behind}`);
  if (info.dirty) parts.push(`●${info.dirty}`);
  return parts.join(" ");
}

/**
 * The longer form, for a tooltip and the detail panel.
 *
 * A translator is passed in rather than imported: this module is the rules, and the wording is the
 * window's. English is what a caller without one gets, which keeps the tests readable.
 */
// Loose in the key so the window's own translator, whose keys are the full message union, can be
// passed straight in; the keys used here are all defined in the dictionaries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GitPhrase = (key: any, vars?: Record<string, string | number>) => string;

const EN_GIT: Record<string, (v: Record<string, string | number>) => string> = {
  "git.on": (v) => `Git: on ${v.branch}`,
  "git.detached": (v) => `Git: detached at ${v.commit}`,
  "git.push": (v) => `${v.count} to push`,
  "git.pull": (v) => `${v.count} to pull`,
  "git.uncounted": () => "changes not counted",
  "git.clean": () => "nothing uncommitted",
  "git.dirty": (v) => `${v.count} uncommitted`,
};
const inEnglish: GitPhrase = (key, vars = {}) => EN_GIT[key]?.(vars) ?? key;

export function gitTitle(info: GitInfo, t: GitPhrase = inEnglish): string {
  const where = info.detached
    ? t("git.detached", { commit: info.head })
    : t("git.on", { branch: info.head });
  const state: string[] = [];
  if (info.ahead) state.push(t("git.push", { count: info.ahead }));
  if (info.behind) state.push(t("git.pull", { count: info.behind }));
  if (info.dirty === null) state.push(t("git.uncounted"));
  else if (info.dirty === 0) state.push(t("git.clean"));
  else state.push(t("git.dirty", { count: info.dirty }));
  return `${where}, ${state.join(", ")}`;
}

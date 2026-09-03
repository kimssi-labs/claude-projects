/**
 * Core: reading git's worktree list, and building the commands that change it.
 *
 * Two of these guard against bugs that are invisible until someone is confused by them: a branch
 * that reports itself "behind" the moment it is created, and a base name that quietly resolves to
 * a tag instead of the branch of the same name.
 */
import { describe, expect, it } from "vitest";

import {
  addArgs, classifyWorktree, cleanBranchName, parseWorktrees, qualifyBase, removeArgs, suggestPath,
} from "../worktree.js";

const PORCELAIN = [
  "worktree C:/src/app",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree C:/src/app-feature",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feature/dock",
  "",
  "worktree C:/src/app-poke",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "locked",
  "",
].join("\n");

describe("parsing the list", () => {
  it("reads each checkout, and marks the repository's own as the main one", () => {
    const trees = parseWorktrees(PORCELAIN);
    expect(trees).toHaveLength(3);
    expect(trees[0]).toEqual({
      path: "C:/src/app",
      head: "1111111111111111111111111111111111111111",
      branch: "main",
      main: true,
      locked: false,
    });
    expect(trees[1]?.branch).toBe("feature/dock");        // the refs/heads/ prefix is not a name
    expect(trees[1]?.main).toBe(false);
  });

  it("reports a detached head as having no branch, and notices a lock", () => {
    const [, , detached] = parseWorktrees(PORCELAIN);
    expect(detached?.branch).toBeNull();
    expect(detached?.locked).toBe(true);
  });

  it("survives an empty list and trailing blank lines", () => {
    expect(parseWorktrees("")).toEqual([]);
    expect(parseWorktrees("\n\n")).toEqual([]);
  });
});

describe("naming things", () => {
  it("accepts the branch names git accepts", () => {
    expect(cleanBranchName("feature/dock")).toBe("feature/dock");
    expect(cleanBranchName("  spaces here ")).toBe("spaces-here");
  });

  it("turns any run of whitespace into a hyphen rather than refusing it", () => {
    // Typing a branch name with spaces is ordinary; git rejects them, so they are normalised here
    // instead of bouncing the user back to the field.
    expect(cleanBranchName("with\tspace and tab")).toBe("with-space-and-tab");
  });

  it("refuses the ones git would reject, rather than letting the command fail", () => {
    for (const bad of ["", "   ", "-x", "a..b", "a^b", "a:b", "a~1", "a?b", "a*b", "a[b",
      "trailing.", "x.lock", "/leading", "trailing/", "a//b", "a@{0}"]) {
      expect(cleanBranchName(bad), bad).toBeNull();
    }
  });

  it("puts a new worktree beside the repository, not inside it", () => {
    // Inside would nest a checkout under a checkout: git allows it and everything else then has to
    // learn to ignore it.
    expect(suggestPath("C:\\src\\app", "feature/dock")).toBe("C:\\src\\app-feature-dock");
    expect(suggestPath("/home/me/src/app", "fix")).toBe("/home/me/src/app-fix");
    expect(suggestPath("C:\\src\\app\\", "x")).toBe("C:\\src\\app-x");
  });
});

describe("qualifying the base", () => {
  const refs = new Set(["refs/heads/main", "refs/remotes/origin/main", "refs/tags/release"]);
  const exists = (ref: string): boolean => refs.has(ref);

  it("prefers the remote branch for a name that looks like one", () => {
    expect(qualifyBase("origin/main", exists)).toBe("refs/remotes/origin/main");
  });

  it("resolves a bare name to the local branch, then the remote's copy", () => {
    expect(qualifyBase("main", exists)).toBe("refs/heads/main");
    expect(qualifyBase("main", (r) => r === "refs/remotes/origin/main")).toBe("refs/remotes/origin/main");
  });

  it("never lets a tag stand in for a branch of the same name", () => {
    // The reason to qualify at all: `worktree add` takes a revision, and "release" is a tag here.
    expect(qualifyBase("release", exists)).toBeNull();
  });

  it("passes an already-qualified ref through, once it is real", () => {
    expect(qualifyBase("refs/heads/main", exists)).toBe("refs/heads/main");
    expect(qualifyBase("refs/heads/nope", exists)).toBeNull();
    expect(qualifyBase("", exists)).toBeNull();
  });
});

describe("the commands", () => {
  it("creates a new branch without tracking the base", () => {
    // With tracking, `git status` in the new worktree says "behind by N" before the branch has a
    // commit of its own — the base's commits, reported as the new branch's shortfall.
    expect(addArgs({ path: "C:/src/app-x", branch: "x", base: "refs/remotes/origin/main" }))
      .toEqual(["worktree", "add", "--no-track", "-b", "x", "C:/src/app-x", "refs/remotes/origin/main"]);
  });

  it("checks out an existing branch instead of creating one", () => {
    expect(addArgs({ path: "C:/src/app-x", branch: "x", existing: true }))
      .toEqual(["worktree", "add", "C:/src/app-x", "x"]);
  });

  it("cuts from the current head when no base is named", () => {
    expect(addArgs({ path: "p", branch: "b" })).toEqual(["worktree", "add", "--no-track", "-b", "b", "p"]);
  });

  it("removes gently by default and forcefully only when asked", () => {
    expect(removeArgs("p")).toEqual(["worktree", "remove", "p"]);
    expect(removeArgs("p", true)).toEqual(["worktree", "remove", "--force", "p"]);
  });
});

describe("classifying a refusal", () => {
  it("tells the ones the user can act on apart from a real failure", () => {
    // `kind` only exists on a refusal, so each case is narrowed before it is read.
    const kindOf = (code: number, output: string): string => {
      const outcome = classifyWorktree(code, output);
      return outcome.ok ? "ok" : outcome.kind;
    };
    expect(classifyWorktree(0, "")).toEqual({ ok: true });
    expect(kindOf(1, "fatal: 'C:/x' contains modified or untracked files, use --force to delete it"))
      .toBe("dirty");
    expect(kindOf(128, "fatal: 'C:/x' already exists")).toBe("exists");
    expect(kindOf(128, "fatal: 'feature' is already used by worktree at 'C:/y'")).toBe("branch-taken");
    expect(kindOf(128, "fatal: 'C:/x' is locked")).toBe("locked");
    expect(kindOf(128, "fatal: invalid reference: nope")).toBe("no-base");
  });

  it("falls back to git's own last line for anything else", () => {
    expect(classifyWorktree(1, "fatal: not a git repository\n"))
      .toEqual({ ok: false, kind: "failed", message: "fatal: not a git repository" });
  });
});

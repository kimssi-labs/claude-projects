/**
 * Core: finding a worktree's repository, and tucking it under that repository in the list.
 *
 * A worktree is a project of its own — its own folder and its own sessions — but showing it as a
 * sibling of the repository it came from hides the one fact that matters about it.
 */
import { describe, expect, it } from "vitest";

import { mainRepoFrom, placeWorktrees } from "../worktree.js";

describe("mainRepoFrom", () => {
  it("reads the repository out of the pointer git writes", () => {
    expect(mainRepoFrom("gitdir: C:/src/app/.git/worktrees/app-feature\n")).toBe("C:/src/app");
    expect(mainRepoFrom("gitdir: /home/me/app/.git/worktrees/x")).toBe("/home/me/app");
  });

  it("copes with backslashes and with the case git happens to use", () => {
    expect(mainRepoFrom("gitdir: C:\\src\\app\\.git\\worktrees\\x")).toBe("C:\\src\\app");
    expect(mainRepoFrom("gitdir: C:/src/app/.GIT/WORKTREES/x")).toBe("C:/src/app");
  });

  it("says nothing for a pointer that is not a worktree's", () => {
    expect(mainRepoFrom("gitdir: C:/src/app/.git")).toBeNull();   // a submodule, not a worktree
    expect(mainRepoFrom("")).toBeNull();
    expect(mainRepoFrom("nonsense")).toBeNull();
  });
});

describe("placeWorktrees", () => {
  const rows = [
    { dir: "app", parentDir: null },
    { dir: "other", parentDir: null },
    { dir: "app-feature", parentDir: "app" },
    { dir: "app-fix", parentDir: "app" },
  ];

  it("puts each worktree under its repository, indented, keeping the rest in order", () => {
    expect(placeWorktrees(rows)).toEqual([
      { item: rows[0], depth: 0 },
      { item: rows[2], depth: 1 },
      { item: rows[3], depth: 1 },
      { item: rows[1], depth: 0 },
    ]);
  });

  it("leaves a worktree where it was when its repository is not in the list", () => {
    // The repository may be a folder Claude Code has never opened, so it has no row to sit under.
    const orphan = [{ dir: "app-feature", parentDir: "app" }];
    expect(placeWorktrees(orphan)).toEqual([{ item: orphan[0], depth: 0 }]);
  });

  it("never loses or repeats a row", () => {
    const placed = placeWorktrees(rows);
    expect(placed).toHaveLength(rows.length);
    expect(new Set(placed.map((p) => p.item.dir)).size).toBe(rows.length);
  });

  it("ignores a row that claims itself as its own parent", () => {
    const odd = [{ dir: "app", parentDir: "app" }];
    expect(placeWorktrees(odd)).toEqual([{ item: odd[0], depth: 0 }]);
  });
});

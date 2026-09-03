/**
 * Core: reading a repository's head, and the one line a row shows for it.
 *
 * The parsing has to survive the shapes .git/HEAD actually takes — a branch with slashes in it, a
 * detached head, and a file that is not either.
 */
import { describe, expect, it } from "vitest";

import { aheadBehind, countDirty, gitLabel, gitTitle, parseHead, type GitInfo } from "../git.js";

const CLEAN: GitInfo = { head: "main", detached: false, ahead: 0, behind: 0, dirty: 0 };

describe("parseHead", () => {
  it("reads a branch, including one with slashes in its name", () => {
    expect(parseHead("ref: refs/heads/main\n")).toEqual({ head: "main", detached: false });
    expect(parseHead("ref: refs/heads/feature/dock-band\n"))
      .toEqual({ head: "feature/dock-band", detached: false });
  });

  it("reads a detached head as the short commit it is", () => {
    expect(parseHead("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n"))
      .toEqual({ head: "a1b2c3d", detached: true });
  });

  it("says nothing rather than guessing at a file it does not recognise", () => {
    expect(parseHead("")).toBeNull();
    expect(parseHead("ref: refs/tags/v1\n")).toBeNull();
    expect(parseHead("garbage")).toBeNull();
  });
});

describe("counting", () => {
  it("counts a porcelain line per changed file, ignoring the trailing newline", () => {
    expect(countDirty(" M src/a.ts\n?? new.txt\nA  src/b.ts\n")).toBe(3);
    expect(countDirty("")).toBe(0);
    expect(countDirty("\n")).toBe(0);
  });

  it("splits two commit lists into what to push and what to pull", () => {
    expect(aheadBehind(["c", "b", "a"], ["b", "a"])).toEqual({ ahead: 1, behind: 0 });
    expect(aheadBehind(["a"], ["c", "b", "a"])).toEqual({ ahead: 0, behind: 2 });
    expect(aheadBehind(["x", "a"], ["y", "a"])).toEqual({ ahead: 1, behind: 1 });
  });
});

describe("the line on a row", () => {
  it("is just the branch when there is nothing else to say", () => {
    expect(gitLabel(CLEAN)).toBe("main");
  });

  it("adds only the counts that are not zero", () => {
    expect(gitLabel({ ...CLEAN, dirty: 3 })).toBe("main ●3");
    expect(gitLabel({ ...CLEAN, ahead: 2 })).toBe("main ↑2");
    expect(gitLabel({ ...CLEAN, ahead: 2, behind: 1, dirty: 4 })).toBe("main ↑2 ↓1 ●4");
  });

  it("says a detached head is detached, since a bare commit reads like nothing", () => {
    expect(gitLabel({ ...CLEAN, head: "a1b2c3d", detached: true })).toBe("a1b2c3d detached");
  });

  it("spells the same state out in the tooltip, including when nothing counted it", () => {
    expect(gitTitle(CLEAN)).toBe("Git: on main, nothing uncommitted");
    expect(gitTitle({ ...CLEAN, dirty: 2 })).toBe("Git: on main, 2 uncommitted");
    expect(gitTitle({ ...CLEAN, dirty: null })).toBe("Git: on main, changes not counted");
    expect(gitTitle({ ...CLEAN, ahead: 1, behind: 2, dirty: 0 }))
      .toBe("Git: on main, 1 to push, 2 to pull, nothing uncommitted");
    expect(gitTitle({ ...CLEAN, head: "a1b2c3d", detached: true }))
      .toBe("Git: detached at a1b2c3d, nothing uncommitted");
  });

  it("says the same thing through a translator, in that language's own order", () => {
    // The tooltip is assembled from keys, so a language that words it differently is free to.
    const ko: Record<string, string> = {
      "git.on": "Git: {branch} 브랜치",
      "git.clean": "변경 사항 없음",
      "git.push": "푸시할 커밋 {count}개",
    };
    const t = (key: string, vars: Record<string, string | number> = {}): string =>
      (ko[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => String(vars[name] ?? whole));
    expect(gitTitle({ ...CLEAN, ahead: 1 }, t))
      .toBe("Git: main 브랜치, 푸시할 커밋 1개, 변경 사항 없음");
  });
});

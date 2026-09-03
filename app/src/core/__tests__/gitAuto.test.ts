/**
 * Core: which projects an unattended sweep is allowed to touch.
 *
 * These tests are the safety rules. An automatic rebase runs when nobody is watching, so every
 * refusal here is a working tree that would otherwise be rewritten under someone.
 */
import { describe, expect, it } from "vitest";

import { autoPlan, intervalMs, sweepSummary, MIN_INTERVAL_MINUTES, SWEEP_LIMIT } from "../gitAuto.js";
import type { GitInfo } from "../git.js";
import type { ProjectInfo } from "../types.js";

const GIT: GitInfo = { head: "feature", detached: false, ahead: 0, behind: 0, dirty: 0 };

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    dir: overrides.dir ?? "C--Work-app",
    cwd: "C:/Work/app",
    name: "app",
    alias: null,
    sessions: [],
    hasMemory: false,
    exists: true,
    lastUsed: 0,
    totalBytes: 0,
    liveCount: 0,
    pinned: false,
    git: GIT,
    worktree: false,
    ...overrides,
  };
}

describe("autoPlan", () => {
  it("does nothing at all when the sweep is off", () => {
    expect(autoPlan([project()], { mode: "off", strategy: "rebase" }).run).toEqual([]);
  });

  it("never touches a project with a session running in it", () => {
    // An agent is editing those files; moving the branch under it is the worst thing here.
    const plan = autoPlan([project({ liveCount: 1 })], { mode: "safe", strategy: "rebase" });
    expect(plan.run).toEqual([]);
    expect(plan.skipped).toEqual([{ dir: "C--Work-app", reason: "running" }]);
  });

  it("leaves an unclean tree alone when it knows the tree is unclean", () => {
    const plan = autoPlan([project({ git: { ...GIT, dirty: 2 } })], { mode: "full", strategy: "merge" });
    expect(plan.skipped).toEqual([{ dir: "C--Work-app", reason: "dirty" }]);
  });

  it("goes ahead when nobody counted the changes — git refuses an unclean tree by itself", () => {
    const plan = autoPlan([project({ git: { ...GIT, dirty: null } })], { mode: "safe", strategy: "rebase" });
    expect(plan.run).toHaveLength(1);
  });

  it("skips a detached head, a folder that is gone, and anything that is not a repository", () => {
    const plan = autoPlan([
      project({ dir: "a", git: { ...GIT, detached: true } }),
      project({ dir: "b", exists: false }),
      project({ dir: "c", git: null }),
    ], { mode: "full", strategy: "rebase" });
    expect(plan.run).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["detached", "gone", "no-repo"]);
  });

  it("forces fast-forward in safe mode, whatever strategy is configured", () => {
    // Safe means nothing is ever rewritten: git is asked for a fast-forward and refuses otherwise.
    expect(autoPlan([project()], { mode: "safe", strategy: "rebase" }).run[0]?.strategy).toBe("ff-only");
    expect(autoPlan([project()], { mode: "safe", strategy: "merge" }).run[0]?.strategy).toBe("ff-only");
  });

  it("uses the configured strategy in full mode", () => {
    expect(autoPlan([project()], { mode: "full", strategy: "merge" }).run[0]?.strategy).toBe("merge");
  });

  it("caps a sweep, so a long list does not become a fetch storm", () => {
    const many = Array.from({ length: SWEEP_LIMIT + 5 }, (_, i) => project({ dir: `p${i}` }));
    expect(autoPlan(many, { mode: "safe", strategy: "rebase" }).run).toHaveLength(SWEEP_LIMIT);
  });
});

describe("the timer and what it reports", () => {
  it("will not run more often than the floor, whatever the setting says", () => {
    expect(intervalMs(60)).toBe(3_600_000);
    expect(intervalMs(1)).toBe(MIN_INTERVAL_MINUTES * 60_000);
    expect(intervalMs(0)).toBe(MIN_INTERVAL_MINUTES * 60_000);
  });

  it("says nothing when a sweep changed nothing — silence is the normal outcome", () => {
    expect(sweepSummary([], 0)).toBeNull();
    expect(sweepSummary([], 3)).toBeNull();
  });

  it("names what it updated, and counts the rest", () => {
    expect(sweepSummary(["app"], 0)).toBe("Updated app from the base branch.");
    expect(sweepSummary(["a", "b", "c", "d", "e"], 0))
      .toBe("Updated a, b, c and 2 more from the base branch.");
  });
});

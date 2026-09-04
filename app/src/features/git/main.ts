/**
 * Git and worktrees — the main side.
 *
 * The git work itself is in main/gitStatus.ts and the pure decisions in core/gitSync.ts,
 * core/gitAuto.ts and core/worktree.ts. This is the feature's edge: its handlers, the automatic
 * sweep, and the one thing settings may ask of it.
 *
 * It depends on the projects feature, and says so in `GitDeps` rather than reaching for a global:
 * a repository is looked up by the project row that names it, and a change to a branch means the
 * rows need reading again. When projects moves onto the bridge, main passes its exports here.
 */
import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { autoPlan, intervalMs, sweepSummary } from "../../core/gitAuto.js";
import type { ProjectInfo } from "../../core/types.js";
import { countChanges, createWorktree, dropWorktree, listWorktrees, updateFromBase } from "../../main/gitStatus.js";
import { gitContract } from "./contract.js";

/** How long one project's change count may take before the row simply shows nothing. */
const COUNT_TIMEOUT_MS = 5_000;

/** What this feature needs from the rest of main. */
export interface GitDeps {
  /** The project row for a directory, from the last scan. */
  findProject(dir: string): ProjectInfo | undefined;
  /** Read the rows again — a branch, or what is uncommitted, may have moved — and return them. */
  rescan(): ProjectInfo[];
  /** Where an executable is, or null when it is not on PATH. */
  which(exe: string): string | null;
}

/** What the rest of main may do with this feature once it is registered. */
export interface GitFeature {
  /** The git settings changed; the sweep timer starts, stops or re-arms with them. */
  restartSweep(): void;
}

export function register(ctx: MainContext, wire: Wire, deps: GitDeps): GitFeature {
  const { findProject, rescan, which } = deps;

  wire.bind(gitContract, {
    // The expensive half of the git line, asked for a row at a time: the renderer asks for the
    // selected row only, so a long list never spawns a process per project.
    gitCount: (dir) => {
      const project = findProject(dir);
      const git = ctx.config.git();
      if (!project?.cwd || !project.exists || !git.enabled || !git.countChanges) return null;
      const cwd = project.cwd;
      return new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), COUNT_TIMEOUT_MS);
        countChanges(cwd, (dirty) => {
          clearTimeout(timer);
          if (project.git) project.git.dirty = dirty;
          resolve(dirty);
        });
      });
    },

    gitSync: async (dir) => {
      const project = findProject(dir);
      if (!project?.cwd || !project.exists) return { ok: false, message: "Folder is not available." };
      const git = ctx.config.git();
      const outcome = await updateFromBase(project.cwd, { strategy: git.strategy, base: git.base });
      rescan();                                      // the branch, and what is uncommitted, may have moved
      if (!outcome.ok) return { ok: false, message: outcome.message };
      return {
        ok: true,
        message: outcome.kind === "current" ? "Already up to date." : "Updated from the base branch.",
      };
    },

    worktreeList: async (dir) => {
      const project = findProject(dir);
      if (!project?.cwd || !project.exists || !project.git) return [];
      return listWorktrees(project.cwd);
    },

    // A second checkout is a second place to run a session, and this app's unit of "a place to run
    // a session" is a project row — so a new worktree is added to the list as a project of its own.
    worktreeAdd: async ({ dir, branch }) => {
      const project = findProject(dir);
      if (!project?.cwd || !project.exists) return { ok: false, message: "Folder is not available." };
      if (!which("git")) return { ok: false, message: "git is not on PATH." };
      const created = await createWorktree(project.cwd, branch, ctx.config.git().base);
      if (!created.ok) return { ok: false, message: created.message };
      const added = ctx.store.addProject(created.path as string);
      rescan();
      return { ok: true, dir: added, message: `Worktree at ${created.path}` };
    },

    // Its own project row goes with it, since the folder it named is gone.
    worktreeRemove: async ({ dir, force }) => {
      const project = findProject(dir);
      if (!project?.cwd) return { ok: false, message: "Folder is not available." };
      const outcome = await dropWorktree(project.cwd, project.cwd, force);
      if (!outcome.ok) return { ok: false, message: outcome.message };
      ctx.store.deleteProject(project);
      rescan();
      return { ok: true, message: "Worktree removed." };
    },
  });

  // The automatic sweep: every project on a schedule, only the ones it is safe to touch (a running
  // session, uncommitted work and a detached head are all skipped), and in "safe" mode git is asked
  // for a fast-forward, which it declines rather than rewriting anything. A sweep that changes
  // nothing says nothing — a notification per hour reporting no news is worse than none.
  let timer: NodeJS.Timeout | null = null;
  let sweeping = false;

  async function sweepFromBase(): Promise<void> {
    if (sweeping) return;                          // a slow remote must not overlap the next tick
    const git = ctx.config.git();
    if (git.auto.mode === "off") return;
    sweeping = true;
    const updated: string[] = [];
    let failed = 0;
    try {
      const plan = autoPlan(rescan(), { mode: git.auto.mode, strategy: git.strategy });
      for (const item of plan.run) {
        const project = findProject(item.dir);
        if (!project?.cwd) continue;
        const outcome = await updateFromBase(project.cwd, { strategy: item.strategy, base: git.base });
        if (outcome.ok && outcome.kind === "updated") updated.push(project.name);
        else if (!outcome.ok && outcome.kind !== "diverged" && outcome.kind !== "dirty") failed += 1;
      }
    } finally {
      sweeping = false;
    }
    if (updated.length) rescan();                  // the window's own refresh picks the branches up
    const summary = sweepSummary(updated, failed);
    if (summary) ctx.notify(summary);
  }

  function restartSweep(): void {
    if (timer) clearInterval(timer);
    timer = null;
    const git = ctx.config.git();
    if (git.auto.mode === "off") return;
    timer = setInterval(() => void sweepFromBase(), intervalMs(git.auto.everyMinutes));
  }

  restartSweep();
  return { restartSweep };
}

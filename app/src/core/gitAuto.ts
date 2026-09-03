/**
 * Updating from the base branch on a timer, and the reasons not to.
 *
 * Everything here is about what NOT to do. An update rewrites a working tree the user did not ask
 * about at that moment, so the interesting logic is the refusals: a session mid-edit, a tree with
 * uncommitted work, a branch that has moved on of its own.
 *
 * The safe mode does not decide whether a fast-forward is possible — it asks git to do one and lets
 * git refuse. `--ff-only` is exactly that question, so there is no state to read, race, or get
 * wrong: either the branch moves cleanly or nothing happens at all.
 */
import type { ProjectInfo } from "./types.js";
import type { MergeStrategy } from "./gitSync.js";

export type AutoMode =
  /** Never on its own. */
  | "off"
  /** Only when the branch moves forward with nothing in the way. */
  | "safe"
  /** Use the configured strategy, so local commits are rebased or merged. */
  | "full";

export const AUTO_MODES: { key: AutoMode; label: string; note: string }[] = [
  { key: "off", label: "Never", note: "update only from the right-click menu" },
  { key: "safe", label: "When it fast-forwards", note: "only where nothing local is in the way — nothing is ever rewritten" },
  { key: "full", label: "Using the strategy above", note: "rebase or merge without asking; a conflict stops and waits for you" },
];

export interface AutoConfig {
  mode: AutoMode;
  /** Minutes between sweeps. */
  everyMinutes: number;
}

export const AUTO_DEFAULTS: AutoConfig = { mode: "off", everyMinutes: 60 };
export const MIN_INTERVAL_MINUTES = 15;
/**
 * How many repositories one sweep will touch.
 *
 * Each is a fetch over the network. Someone with sixty projects should not have sixty fetches go
 * out at once because a timer fired, so a sweep takes the few most recently used and leaves the
 * rest for the next one.
 */
export const SWEEP_LIMIT = 8;

export type SkipReason = "no-repo" | "running" | "dirty" | "detached" | "gone";

export interface AutoPlan {
  /** Projects to attempt, newest use first. */
  run: { dir: string; strategy: MergeStrategy }[];
  /** Why each of the others was left alone; for the log, not the screen. */
  skipped: { dir: string; reason: SkipReason }[];
}

/**
 * Which projects this sweep should touch.
 *
 * A live session is the firmest refusal here: an agent is editing those files, and moving the
 * branch under it produces a mess neither of them can explain afterwards.
 */
export function autoPlan(
  projects: ProjectInfo[],
  { mode, strategy, limit = SWEEP_LIMIT }: { mode: AutoMode; strategy: MergeStrategy; limit?: number },
): AutoPlan {
  const run: AutoPlan["run"] = [];
  const skipped: AutoPlan["skipped"] = [];
  if (mode === "off") return { run, skipped };

  for (const project of projects) {
    if (run.length >= limit) break;
    if (!project.cwd || !project.exists) {
      skipped.push({ dir: project.dir, reason: "gone" });
      continue;
    }
    if (!project.git) {
      skipped.push({ dir: project.dir, reason: "no-repo" });
      continue;
    }
    if (project.liveCount > 0) {
      skipped.push({ dir: project.dir, reason: "running" });
      continue;
    }
    if (project.git.detached) {
      skipped.push({ dir: project.dir, reason: "detached" });
      continue;
    }
    // A count we have says don't; a count we do not have is not a reason to skip, and git refuses
    // an unclean tree by itself.
    if (project.git.dirty !== null && project.git.dirty > 0) {
      skipped.push({ dir: project.dir, reason: "dirty" });
      continue;
    }
    run.push({ dir: project.dir, strategy: mode === "safe" ? "ff-only" : strategy });
  }
  return { run, skipped };
}

/** Minutes, kept inside what the timer can honour. */
export function intervalMs(everyMinutes: number): number {
  return Math.max(MIN_INTERVAL_MINUTES, Math.round(everyMinutes)) * 60_000;
}

/** What a finished sweep says, if it says anything at all. */
export function sweepSummary(updated: string[], failed: number): string | null {
  if (updated.length === 0) return failed ? null : null;   // nothing changed: say nothing
  const names = updated.slice(0, 3).join(", ");
  const rest = updated.length > 3 ? ` and ${updated.length - 3} more` : "";
  return `Updated ${names}${rest} from the base branch.`;
}

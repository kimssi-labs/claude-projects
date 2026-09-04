/** What the page may ask about a project's repository and its worktrees. */
import { invoke } from "../../bridge/contract.js";
import type { Worktree } from "../../core/worktree.js";
import type { ActionResult, AddProjectResult } from "../../main/ipc.js";

export const gitContract = {
  /** Count what is uncommitted in one project; null when there is nothing to count. */
  gitCount: invoke<string, number | null>("git:count"),
  /** Bring one project's branch up to date with its base branch, the way the settings say to. */
  gitSync: invoke<string, ActionResult>("git:sync"),
  /** Every checkout of the repository this project belongs to. */
  worktreeList: invoke<string, Worktree[]>("worktree:list"),
  /** Add a worktree of this project on a new branch; it joins the list as its own project. */
  worktreeAdd: invoke<{ dir: string; branch: string }, AddProjectResult>("worktree:add"),
  /** Remove a worktree and its project row. */
  worktreeRemove: invoke<{ dir: string; force: boolean }, ActionResult>("worktree:remove"),
} as const;

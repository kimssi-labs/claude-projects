/**
 * Git and worktrees — the page side.
 *
 * Everything the window shows or asks about a repository lives here: the state for the selected
 * project, the right-click entries, and the dialogs behind them. `App` hands over the app-wide
 * things it needs — a dialog, a toast, a rescan, a way to land on a row — and does not know what a
 * worktree is.
 */
import { useCallback, useEffect, useState } from "react";

import type { ProjectInfo } from "@core/types";
import type { Worktree } from "@core/worktree";

import { api, type MenuItemSpec } from "../../renderer/api";
import type { Ask, AskResult } from "../../renderer/components/Modal";
import type { useText } from "../../renderer/useText";

type Translate = ReturnType<typeof useText>;

/**
 * Git's state for the project in front of the user: its repository's other checkouts, and the
 * count of what is uncommitted. One git call per selection, not one per row — the list of rows
 * shows the count on its next scan; this only asks for it early.
 */
export function useGit(
  dir: string | null,
  enabled: boolean,
  countChanges: boolean,
  onDirty: (dir: string, dirty: number) => void,
): { worktrees: Worktree[] } {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);

  useEffect(() => {
    if (!dir || !enabled) { setWorktrees([]); return; }
    let cancelled = false;
    void api.worktreeList(dir).then((list) => { if (!cancelled) setWorktrees(list); });
    return () => { cancelled = true; };
  }, [dir, enabled]);

  useEffect(() => {
    if (!dir || !enabled || !countChanges) return;
    let cancelled = false;
    void api.gitCount(dir).then((dirty) => {
      if (!cancelled && dirty !== null) onDirty(dir, dirty);
    });
    return () => { cancelled = true; };
  }, [dir, enabled, countChanges, onDirty]);

  return { worktrees };
}

export const GIT_ACTIONS = ["worktreeAdd", "worktreeRemove", "gitSync"] as const;
export type GitAction = (typeof GIT_ACTIONS)[number];

export function isGitAction(id: string | null): id is GitAction {
  return (GIT_ACTIONS as readonly string[]).includes(id ?? "");
}

/** The project menu's git entries, for a row that is a repository. */
export function gitMenuItems(target: ProjectInfo, base: string | undefined, t: Translate): MenuItemSpec[] {
  return [
    { id: "worktreeAdd", label: t("menu.worktreeAdd"), enabled: Boolean(target.git) },
    { id: "worktreeRemove", label: t("menu.worktreeRemove"), enabled: target.worktree },
    {
      id: "gitSync",
      label: base ? t("menu.sync", { base }) : t("menu.syncDefault"),
      enabled: Boolean(target.git),
    },
  ];
}

/** What running a git action needs from the app around it. */
export interface GitUi {
  askUser(ask: Ask): Promise<AskResult>;
  notify(result: { ok: boolean; message?: string }): void;
  /** Read the rows again and return them. */
  refresh(): Promise<ProjectInfo[]>;
  /** Select the row for `dir` in the freshly scanned list. */
  landOn(dir: string, scanned: ProjectInfo[]): void;
  t: Translate;
}

export async function runGitAction(action: GitAction, target: ProjectInfo, ui: GitUi): Promise<void> {
  const { askUser, notify, refresh, landOn, t } = ui;
  switch (action) {
    case "worktreeAdd": {
      const branch = await askUser({
        title: t("dialog.worktreeAdd"),
        detail: t("dialog.worktreeAdd.detail"),
        input: { placeholder: t("dialog.worktreeAdd.placeholder") },
        confirm: t("dialog.create"),
      });
      if (typeof branch !== "string") return;
      const result = await api.worktreeAdd({ dir: target.dir, branch });
      notify(result);
      if (!result.ok || !result.dir) return;
      // Land on the new worktree: it is a project now, and the point of making it was to work in it.
      landOn(result.dir, await refresh());
      return;
    }
    case "worktreeRemove": {
      const yes = await askUser({
        title: t("dialog.worktreeRemove"),
        detail: target.cwd ?? "",
        confirm: t("dialog.remove"),
        danger: true,
      });
      if (!yes) return;
      const first = await api.worktreeRemove({ dir: target.dir, force: false });
      if (first.ok) { notify(first); await refresh(); return; }
      // git refuses a worktree that holds work; forcing is the user's call, not ours.
      const force = await askUser({
        title: t("dialog.worktreeForce"),
        detail: first.message ?? "",
        confirm: t("dialog.remove"),
        danger: true,
      });
      if (!force) { notify(first); return; }
      notify(await api.worktreeRemove({ dir: target.dir, force: true }));
      await refresh();
      return;
    }
    case "gitSync": {
      notify({ ok: true, message: "Updating from the base branch…" });
      notify(await api.gitSync(target.dir));
      await refresh();
      return;
    }
  }
}

/** A stable callback for `useGit`'s dirty count: merge it into the row it belongs to. */
export function useDirtyPatch(setProjects: (update: (previous: ProjectInfo[]) => ProjectInfo[]) => void) {
  return useCallback((dir: string, dirty: number) => {
    setProjects((previous) => previous.map((item) => (item.dir === dir && item.git
      ? { ...item, git: { ...item.git, dirty } }
      : item)));
  }, [setProjects]);
}

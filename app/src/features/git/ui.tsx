/**
 * Git and worktrees — the page side.
 *
 * Everything the window shows or asks about a repository lives here: the state for the selected
 * project, the right-click entries, and the dialogs behind them. `App` hands over the app-wide
 * things it needs — a dialog, a toast, a rescan, a way to land on a row — and does not know what a
 * worktree is.
 */
import { useCallback, useEffect, useState } from "react";

import { AUTO_DEFAULTS, AUTO_MODES, MIN_INTERVAL_MINUTES } from "@core/gitAuto";
import { MERGE_STRATEGIES } from "@core/gitSync";
import type { GitConfig, ProjectInfo } from "@core/types";
import type { Worktree } from "@core/worktree";

import { api, type MenuItemSpec } from "../../renderer/api";
import type { Ask, AskResult } from "../../renderer/components/Modal";
import { Choice } from "../../renderer/components/SettingsCard";
import { useText } from "../../renderer/useText";

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

/** The settings card body: the row line, the change count, and how updating from the base works. */
export function GitSettings({ git, available, onChange, onInstall }: {
  git: GitConfig;
  /** Whether the git command line is on PATH — the branch line does not need it, the rest does. */
  available: boolean;
  onChange(git: GitConfig): void;
  /** Open the download page. */
  onInstall(): void;
}) {
  const t = useText();
  const set = (patch: Partial<GitConfig>): void => onChange({ ...git, ...patch });
  return (
    <>
      <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
        <input
          type="checkbox"
          checked={git.enabled}
          onChange={() => set({ enabled: !git.enabled })}
          className="accent-accent"
        />
        <span className="text-sm text-bone-100">{t("settings.git.show")}</span>
      </label>
      <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
        <input
          type="checkbox"
          checked={git.countChanges}
          disabled={!git.enabled}
          onChange={() => set({ countChanges: !git.countChanges })}
          className="accent-accent"
        />
        <span className={`text-sm ${git.enabled ? "text-bone-100" : "text-bone-500"}`}>
          {t("settings.git.count")}
        </span>
      </label>
      <div className="text-[11px] text-bone-500">{t("settings.git.note")}</div>

      <div className="text-[11px] text-bone-500 pt-2">{t("settings.git.updating")}</div>
      <label className="block px-3 py-1.5">
        <span className="text-[11px] text-bone-500">{t("settings.git.base")}</span>
        <input
          value={git.base}
          onChange={(event) => set({ base: event.target.value })}
          placeholder={t("settings.git.base.placeholder")}
          spellCheck={false}
          className="mt-1 w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm placeholder:text-bone-500 focus:border-accent/60"
        />
      </label>
      {MERGE_STRATEGIES.map((strategy) => (
        <Choice
          key={strategy.key}
          label={strategy.label}
          note={strategy.note}
          selected={git.strategy === strategy.key}
          onSelect={() => set({ strategy: strategy.key })}
        />
      ))}
      <div className="text-[11px] text-bone-500">{t("settings.git.runNote")}</div>

      <div className="text-[11px] text-bone-500 pt-2">{t("settings.git.auto")}</div>
      {AUTO_MODES.map((mode) => (
        <Choice
          key={mode.key}
          label={mode.label}
          note={mode.note}
          selected={git.auto.mode === mode.key}
          onSelect={() => set({ auto: { ...git.auto, mode: mode.key } })}
        />
      ))}
      {git.auto.mode === "off" ? null : (
        <label className="flex items-center gap-2 px-3 py-1.5">
          <span className="text-[11px] text-bone-500">{t("settings.git.every")}</span>
          <input
            type="number"
            min={MIN_INTERVAL_MINUTES}
            value={git.auto.everyMinutes}
            onChange={(event) => set({
              auto: { ...git.auto, everyMinutes: Number(event.target.value) || AUTO_DEFAULTS.everyMinutes },
            })}
            className="w-20 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-sm focus:border-accent/60"
          />
          <span className="text-[11px] text-bone-500">
            {t("settings.git.minutes", { min: MIN_INTERVAL_MINUTES })}
          </span>
        </label>
      )}
      {git.auto.mode === "full" ? (
        <div className="text-[11px] text-warn">{t("settings.git.fullWarning")}</div>
      ) : null}
      {/* The branch line is read from .git and needs nothing installed; everything below it
          shells out, so say which half is unavailable rather than failing quietly later. */}
      {available ? null : (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] text-warn flex-1">{t("settings.git.missing")}</span>
          <button type="button" className="btn btn-accent shrink-0" onClick={onInstall}>
            {t("settings.git.install")}
          </button>
        </div>
      )}
    </>
  );
}

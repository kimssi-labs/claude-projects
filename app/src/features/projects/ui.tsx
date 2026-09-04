/**
 * Projects and sessions — the page side.
 *
 * The list the window is built around, and everything done to a row from the page: the order the
 * rows are drawn (and walked) in, the right-click menus, the dialogs behind delete, the rename box,
 * the pane the projects sit in and the list a project's sessions sit in. `App` keeps the selection —
 * the keyboard drives it — and hands over what an action needs: a dialog, a toast, a rescan, and
 * the two things only the shell can do, changing screen and opening the rename box.
 */
import { useCallback, useMemo, useState, type RefObject } from "react";

import type { LaunchConfig, MetricSample, PermissionMode, ProjectInfo, SessionInfo, ShellChoice } from "@core/types";
import { placeWorktrees, type Placed } from "@core/worktree";

import { api, MENU_SEPARATOR, type MenuItemSpec } from "../../renderer/api";
import { ProjectRow, SessionRow } from "../../renderer/components/Lists";
import { Choice } from "../../renderer/components/SettingsCard";
import type { Ask, AskResult } from "../../renderer/components/Modal";
import { useText } from "../../renderer/useText";
import type { OpenSessionRequest } from "./contract";

type Translate = ReturnType<typeof useText>;

/** How many of a project's sessions the projects screen shows before offering the rest. */
const PREVIEW_COUNT = 8;

/** The rows, read and re-read: the list every other part of the window reads. */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const scan = useCallback(async (): Promise<ProjectInfo[]> => {
    const scanned = await api.scan();
    setProjects(scanned);
    return scanned;
  }, []);
  const liveSessions = useMemo(() => projects.flatMap((p) => p.sessions.filter((s) => s.live)), [projects]);
  return { projects, setProjects, scan, liveSessions };
}

/**
 * The list as it is drawn: matches in order, with each worktree tucked under its repository.
 *
 * One array for both the drawing and the keyboard, or the arrow keys would walk a different list
 * from the one on screen.
 */
export function filterProjects(projects: ProjectInfo[], query: string): Placed<ProjectInfo>[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? projects.filter((project) =>
      project.name.toLowerCase().includes(needle)
      || (project.cwd ?? "").toLowerCase().includes(needle)
      || project.sessions.some((s) => s.title.toLowerCase().includes(needle)))
    : projects;
  return placeWorktrees(matched);
}

/** A project's sessions — those matching the search, when there is one. */
export function filterSessions(project: ProjectInfo | null, query: string): SessionInfo[] {
  if (!project) return [];
  const needle = query.trim().toLowerCase();
  return needle ? project.sessions.filter((s) => s.title.toLowerCase().includes(needle)) : project.sessions;
}

/**
 * Where `dir` sits in a freshly scanned list — through the same placement it is drawn with. The
 * raw scan order is not what is on screen once a worktree has been tucked under its repository,
 * and selecting by the wrong index lands on a different row.
 */
export function indexOf(dir: string, scanned: ProjectInfo[]): number {
  return Math.max(0, placeWorktrees(scanned).findIndex((row) => row.item.dir === dir));
}

// ---- actions on a row ----------------------------------------------------------------------------

/** What an action on a row needs from the app around it. */
export interface ProjectsUi {
  askUser(ask: Ask): Promise<AskResult>;
  notify(result: { ok: boolean; message?: string }): void;
  /** Read the rows again and return them. */
  refresh(): Promise<ProjectInfo[]>;
  t: Translate;
}

/** Start or resume a session, say how it went, and read the rows again: a running dot may have lit. */
export async function openSession(request: OpenSessionRequest, ui: ProjectsUi): Promise<void> {
  ui.notify(await api.openSession(request));
  void ui.refresh();
}

/** Rename a project or, with a session id, one of its sessions. An empty title takes the name off again. */
export async function rename(target: { projectDir: string; sessionId?: string }, title: string, ui: ProjectsUi): Promise<void> {
  const result = target.sessionId
    ? await api.renameSession({ projectDir: target.projectDir, sessionId: target.sessionId, title })
    : await api.renameProject({ projectDir: target.projectDir, title });
  ui.notify(result);
  await ui.refresh();
}

/** Ask in the app's own dialog, then delete; the main side is told it was already asked. */
export async function deleteProject(target: ProjectInfo, ui: ProjectsUi): Promise<void> {
  const { askUser, notify, refresh, t } = ui;
  const yes = await askUser({
    title: t("dialog.deleteProject", { name: target.name }),
    detail: [
      t("dialog.deleteProject.detail", { count: target.sessions.length }),
      target.hasMemory ? t("dialog.deleteProject.memory") : "",
    ].filter(Boolean).join("\n"),
    confirm: t("dialog.delete"),
    danger: true,
  });
  if (!yes) return;
  const result = await api.deleteProject({ projectDir: target.dir, confirmed: true });
  notify(result);
  if (result.ok) await refresh();
}

export async function deleteSession(projectDir: string, target: SessionInfo, ui: ProjectsUi): Promise<void> {
  const { askUser, notify, refresh, t } = ui;
  const yes = await askUser({
    title: t("dialog.deleteSession", { name: target.title }),
    detail: t("dialog.deleteSession.detail"),
    confirm: t("dialog.delete"),
    danger: true,
  });
  if (!yes) return;
  const result = await api.deleteSession({ projectDir, sessionId: target.id, confirmed: true });
  notify(result);
  if (result.ok) await refresh();
}

// ---- right-click menus ---------------------------------------------------------------------------

export const PROJECT_ACTIONS = ["sessions", "new", "newWindow", "pin", "rename", "reveal", "delete"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];
export function isProjectAction(id: string | null): id is ProjectAction {
  return (PROJECT_ACTIONS as readonly string[]).includes(id ?? "");
}

export const SESSION_ACTIONS = ["resume", "resumeWindow", "pin", "rename", "delete"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];
export function isSessionAction(id: string | null): id is SessionAction {
  return (SESSION_ACTIONS as readonly string[]).includes(id ?? "");
}

/**
 * The right-click menu of a project row: what the keys do, plus pinning and the folder itself.
 * `extra` is what other features add for this row — git's entries — and goes above the delete line.
 */
export function projectMenuItems(target: ProjectInfo, extra: MenuItemSpec[], t: Translate): MenuItemSpec[] {
  return [
    { id: "sessions", label: t("menu.openSessions") },
    { id: "new", label: t("menu.newSession") },
    { id: "newWindow", label: t("menu.newSessionWindow") },
    { id: MENU_SEPARATOR, label: "" },
    { id: "pin", label: t("menu.pin"), checked: target.pinned },
    { id: "rename", label: t("menu.rename") },
    { id: "reveal", label: t("menu.showFolder"), enabled: Boolean(target.cwd && target.exists) },
    ...extra,
    { id: MENU_SEPARATOR, label: "" },
    { id: "delete", label: t("menu.delete"), enabled: target.liveCount === 0 },
  ];
}

/** The right-click menu of a session row, on either screen it is listed on. */
export function sessionMenuItems(target: SessionInfo, t: Translate): MenuItemSpec[] {
  return [
    { id: "resume", label: t("menu.resume"), enabled: !target.live },
    { id: "resumeWindow", label: t("menu.resumeWindow"), enabled: !target.live },
    { id: MENU_SEPARATOR, label: "" },
    { id: "pin", label: t("menu.pin"), checked: target.pinned },
    { id: "rename", label: t("menu.rename") },
    { id: MENU_SEPARATOR, label: "" },
    { id: "delete", label: t("menu.delete"), enabled: !target.live },
  ];
}

/** What a menu action needs beyond `ProjectsUi`: the two things only the shell can do. */
export interface RowUi extends ProjectsUi {
  /** Show this project's sessions. */
  enterSessions(dir: string): void;
  /** Open the rename box on this row — a project's dir, or a session's id. */
  startRename(id: string): void;
}

/**
 * Every action names its target outright rather than going through the selection, so the menu
 * works the same on a row that was not selected when it was clicked.
 */
export async function runProjectAction(action: ProjectAction, target: ProjectInfo, ui: RowUi): Promise<void> {
  switch (action) {
    case "sessions": ui.enterSessions(target.dir); break;
    case "new": await openSession({ projectDir: target.dir, sessionId: null, target: "sessionsWindow" }, ui); break;
    case "newWindow": await openSession({ projectDir: target.dir, sessionId: null, target: "newWindow" }, ui); break;
    case "pin": ui.notify(await api.togglePin({ kind: "projects", key: target.dir })); await ui.refresh(); break;
    case "rename": ui.startRename(target.dir); break;
    case "reveal": ui.notify(await api.revealProject(target.dir)); break;
    case "delete": await deleteProject(target, ui); break;
  }
}

export async function runSessionAction(action: SessionAction, projectDir: string, target: SessionInfo, ui: RowUi): Promise<void> {
  switch (action) {
    case "resume": await openSession({ projectDir, sessionId: target.id, target: "sessionsWindow" }, ui); break;
    case "resumeWindow": await openSession({ projectDir, sessionId: target.id, target: "newWindow" }, ui); break;
    case "pin": ui.notify(await api.togglePin({ kind: "sessions", key: target.id })); await ui.refresh(); break;
    case "rename": ui.startRename(target.id); break;
    case "delete": await deleteSession(projectDir, target, ui); break;
  }
}

// ---- the markup ----------------------------------------------------------------------------------

/** What `useRef<HTMLInputElement>(null)` hands out; `current` is null until the box is on screen. */
type EditRef = RefObject<HTMLInputElement>;

/**
 * The box a row turns into while it is being renamed. Blur commits, Enter commits explicitly — the
 * difference decides whether an emptied field means "take the name off" — and Escape cancels.
 */
export function RenameInput({ defaultValue, inputRef, onCommit, onCancel }: {
  defaultValue: string;
  inputRef: EditRef;
  onCommit(value: string, explicit: boolean): void;
  onCancel(): void;
}) {
  const t = useText();
  return (
    <input
      ref={inputRef}
      defaultValue={defaultValue}
      onBlur={(event) => onCommit(event.target.value, false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit((event.target as HTMLInputElement).value, true);
        if (event.key === "Escape") onCancel();
      }}
      data-testid="rename-input"
      aria-label={t("tip.newName")}
      className="w-full bg-ink-700 border border-accent/60 rounded-lg px-3 py-2 text-sm"
    />
  );
}

/** The search box, the add button and the project rows — the pane the window is navigated from. */
export function ProjectPane({
  placed, query, onQuery, searchRef, onAdd, editing, editRef, onRename, onCancelEdit, isSelected, onSelect, onOpen, onContextMenu, tight,
}: {
  placed: Placed<ProjectInfo>[];
  query: string;
  onQuery(query: string): void;
  searchRef: EditRef;
  onAdd(): void;
  /** The dir of the row being renamed, if any. */
  editing: string | null;
  editRef: EditRef;
  onRename(value: string, explicit: boolean): void;
  onCancelEdit(): void;
  /** Whether this row is the selected one — the shell's to say, since the screen decides it. */
  isSelected(item: ProjectInfo, index: number): boolean;
  onSelect(index: number): void;
  onOpen(dir: string): void;
  onContextMenu(item: ProjectInfo, index: number): void;
  /** A thin window: less padding around everything. */
  tight: boolean;
}) {
  const t = useText();
  return (
    <>
      <div className={`flex gap-1 ${tight ? "p-1" : "p-2"}`}>
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { onQuery(""); searchRef.current?.blur(); } }}
          placeholder={t("app.search")}
          className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm placeholder:text-bone-500 focus:border-accent/60"
        />
        {/* A folder that has never had a session has no other way into this list. */}
        <button
          type="button"
          className="btn px-2.5 shrink-0"
          title={t("app.addProject.title")}
          aria-label={t("app.addProject")}
          onClick={onAdd}
        >
          +
        </button>
      </div>
      <div className={`flex-1 overflow-auto space-y-0.5 ${tight ? "px-1 pb-1" : "px-2 pb-2"}`}>
        {placed.map(({ item, depth }, index) => (
          editing === item.dir ? (
            <RenameInput key={item.dir} inputRef={editRef} defaultValue={item.alias ?? item.name} onCommit={onRename} onCancel={onCancelEdit} />
          ) : (
            <ProjectRow
              key={item.dir}
              project={item}
              depth={depth}
              selected={isSelected(item, index)}
              onSelect={() => onSelect(index)}
              onOpen={() => onOpen(item.dir)}
              onContextMenu={() => onContextMenu(item, index)}
            />
          )
        ))}
        {placed.length === 0 ? <p className="px-3 py-6 text-xs text-bone-500">{t("app.noMatch")}</p> : null}
      </div>
    </>
  );
}

/** The sessions screen: one project's sessions, with the selected row and the rename box. */
export function SessionList({
  sessions, selected, editing, editRef, samples, onRename, onCancelEdit, onSelect, onOpen, onContextMenu,
}: {
  sessions: SessionInfo[];
  selected: number;
  /** The id of the session being renamed, if any. */
  editing: string | null;
  editRef: EditRef;
  /** The graph behind a row; empty when nothing is being measured. */
  samples(sessionId: string): MetricSample[];
  onRename(value: string, explicit: boolean): void;
  onCancelEdit(): void;
  onSelect(index: number): void;
  onOpen(): void;
  onContextMenu(item: SessionInfo, index: number): void;
}) {
  return (
    <>
      {sessions.map((item, index) => (
        editing === item.id ? (
          <RenameInput key={item.id} inputRef={editRef} defaultValue={item.title} onCommit={onRename} onCancel={onCancelEdit} />
        ) : (
          <SessionRow
            key={item.id}
            session={item}
            selected={index === selected}
            samples={samples(item.id)}
            onSelect={() => onSelect(index)}
            onOpen={onOpen}
            onContextMenu={() => onContextMenu(item, index)}
          />
        )
      ))}
    </>
  );
}

/** The projects screen's glimpse of the selected project: its first sessions, and a way to the rest. */
export function SessionPreview({ project, samples, onEnter, onContextMenu }: {
  project: ProjectInfo;
  samples(sessionId: string): MetricSample[];
  /** Any click lands on the sessions screen; the preview is a doorway, not a list to select from. */
  onEnter(): void;
  onContextMenu(item: SessionInfo, index: number): void;
}) {
  const t = useText();
  return (
    <>
      {project.sessions.slice(0, PREVIEW_COUNT).map((item, index) => (
        <SessionRow
          key={item.id}
          session={item}
          selected={false}
          samples={samples(item.id)}
          onSelect={onEnter}
          onOpen={onEnter}
          onContextMenu={() => onContextMenu(item, index)}
        />
      ))}
      {project.sessions.length > PREVIEW_COUNT ? (
        <button type="button" className="btn w-full mt-1" onClick={onEnter}>
          {t("app.showAll", { count: project.sessions.length })}
        </button>
      ) : null}
    </>
  );
}

// ---- how a session starts: the settings cards ----------------------------------------------------

const SHELLS: { key: ShellChoice; label: string; note: string }[] = [
  { key: "auto", label: "Auto", note: "PowerShell 7 when installed, else the system shell" },
  { key: "pwsh", label: "PowerShell 7", note: "pwsh" },
  { key: "powershell", label: "Windows PowerShell", note: "powershell.exe" },
  { key: "cmd", label: "Command Prompt", note: "cmd.exe /k" },
  { key: "bash", label: "bash", note: "bash -lc" },
  { key: "custom", label: "Custom program", note: "an editor like VS Code, opened on the project folder" },
  { key: "none", label: "No shell", note: "claude directly — the window closes when it exits" },
];

const PERMISSIONS: { key: PermissionMode; label: string; note: string }[] = [
  { key: "default", label: "Ask (default)", note: "the normal prompts" },
  { key: "bypass", label: "Bypass permissions", note: "--dangerously-skip-permissions" },
  { key: "accept", label: "Accept edits", note: "file edits go through, other tools still ask" },
  { key: "plan", label: "Plan", note: "plan first, change nothing until you approve" },
  { key: "auto", label: "Auto", note: "claude decides per tool call" },
];

/** The settings card body: which shell hosts a session, and the program when it is a custom one. */
export function LaunchSettings({ launch, onChange }: { launch: LaunchConfig; onChange(launch: LaunchConfig): void }) {
  const t = useText();
  const set = (patch: Partial<LaunchConfig>): void => onChange({ ...launch, ...patch });
  return (
    <>
      {SHELLS.map((shell) => (
        <Choice
          key={shell.key}
          label={t(`settings.shell.${shell.key}` as "settings.shell.auto")}
          // Two of these explain themselves; the rest name an executable, which is not translated.
          note={shell.key === "auto" || shell.key === "custom" || shell.key === "none"
            ? t(`settings.shell.${shell.key}.note` as "settings.shell.auto.note")
            : shell.note}
          selected={launch.shell === shell.key}
          onSelect={() => set({ shell: shell.key })}
        />
      ))}

      <div className={`flex items-center gap-2 pt-1 ${launch.shell === "custom" ? "" : "opacity-40"}`}>
        <span className="text-[11px] text-bone-500 shrink-0">{t("settings.launch.program")}</span>
        <input
          type="text"
          spellCheck={false}
          value={launch.customShell}
          disabled={launch.shell !== "custom"}
          placeholder={t("settings.launch.programPlaceholder")}
          onChange={(event) => set({ customShell: event.target.value })}
          className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-xs placeholder:text-bone-500 focus:border-accent/60"
        />
      </div>
      {launch.shell === "custom" && !launch.customShell.trim() ? (
        <div className="text-[11px] text-warn">{t("settings.launch.noPath")}</div>
      ) : null}
    </>
  );
}

/** The settings card body: the permission mode a session starts in. */
export function PermissionSettings({ launch, onChange }: { launch: LaunchConfig; onChange(launch: LaunchConfig): void }) {
  const t = useText();
  return (
    <>
      {PERMISSIONS.map((mode) => (
        <Choice
          key={mode.key}
          label={t(`settings.permission.${mode.key}` as "settings.permission.default")}
          // The bypass note is the flag itself, which stays as it is written on the command line.
          note={mode.key === "bypass"
            ? mode.note
            : t(`settings.permission.${mode.key}.note` as "settings.permission.default.note")}
          selected={launch.permission === mode.key}
          onSelect={() => onChange({ ...launch, permission: mode.key })}
        />
      ))}
    </>
  );
}

/**
 * The whole window: status strip, project list, session list, detail panel, monitor, settings.
 *
 * Selection and screen live here because the keyboard drives them — every list is a controlled
 * view of this state, so a key and a click end up in exactly the same place.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nextIndex, resolveAction, SHORTCUTS, type Screen } from "@core/keymap";
import type { Language } from "@core/i18n";
import { gitMenuItems, isGitAction, runGitAction, useDirtyPatch, useGit } from "../features/git/ui";
import {
  deleteProject, deleteSession, filterProjects, filterSessions, indexOf, isProjectAction, isSessionAction, openSession,
  ProjectPane, projectMenuItems, rename, runProjectAction, runSessionAction, SessionList, sessionMenuItems, SessionPreview,
  useProjects,
} from "../features/projects/ui";
import { useSettings } from "../features/settings/ui";
import { useUpdates } from "../features/updates/ui";
import { useUsage } from "../features/usage/ui";
import { useMetrics } from "../features/metrics/ui";
import { usePasteResults } from "../features/clipboard/ui";
import type { ProjectInfo, SessionInfo, ThemeMode } from "@core/types";

import { api, type AppInfo, type DisplayInfo, type SettingsPayload } from "./api";
import { DockButton, DockGrip, useDock } from "../features/dock/ui";
import { AreaChart, UsageCard } from "./components/Chart";
import { ProjectDetail, SessionDetail } from "./components/Lists";
import { SETTINGS_SECTIONS, SettingsView, type SettingsSection } from "./components/Settings";
import { Modal, type Ask, type AskResult } from "./components/Modal";
import { TitleBar } from "./components/TitleBar";
import { formatBytes } from "./format";
import { Splitter } from "./components/Splitter";
import { Truncated } from "./components/Truncated";
import { WindowControls } from "./components/WindowControls";
import { STACK_MIN, stackedTopHeight, useLayoutMode } from "./useLayoutMode";
import { useTheme } from "./useTheme";
import { TextProvider, useText } from "./useText";

const PAGE_SIZE = 10;
const REFRESH_MS = 15_000;
/** Room enough for a path, never so much that the lists it frames disappear. */
const NAV_MIN = 180;
const NAV_MAX = 560;
const ASIDE_MIN = 160;
/** Enough of a stacked pane to be a list rather than a sliver. */
const ASIDE_MAX = 640;

type Toast = { text: string; tone: "ok" | "bad" } | null;

/**
 * The window, wrapped in the language it is read in.
 *
 * Split so everything inside can call useText(): a provider cannot be consumed by the component
 * that renders it.
 */
export function App() {
  const [shell, setShell] = useState<{ language: Language; locale: string }>({ language: "system", locale: "en" });
  return (
    <TextProvider language={shell.language} locale={shell.locale}>
      <Window onLanguage={setShell} />
    </TextProvider>
  );
}

function Window({ onLanguage }: { onLanguage: (next: { language: Language; locale: string }) => void }) {
  const t = useText();
  // The rows are the projects feature's; what is selected among them is this file's.
  const { projects, setProjects, scan, liveSessions } = useProjects();
  const usage = useUsage();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [screen, setScreen] = useState<Screen>("projects");
  const [projectIndex, setProjectIndex] = useState(0);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  /** The dialog on screen, and the promise waiting on its answer. */
  const [dialog, setDialog] = useState<{ ask: Ask; settle: (result: AskResult) => void } | null>(null);
  // The payload is the settings feature's; the screen it is edited on is opened from here.
  const { settings, setSettings, load: loadSettings, save: saveSettings } = useSettings();
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const updates = useUpdates(info?.version);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("dock");
  // The graphs' series and their readings live with the metrics feature; destructured so the
  // markup below reads as it did.
  const metrics = useMetrics();
  const { systemHistory, sessionHistory, cpuGhz, memoryTotal, totalMemory, latestSystem } = metrics;
  // Docked counts as maximised: the band is the window at its full extent, so the middle caption
  // button offers to restore, and restoring is what gives the edge back.
  const [windowState, setWindowState] = useState({ maximized: false });
  // Whether the window is a band is dock's state, pushed on every change; nothing here guesses it.
  const dock = useDock();
  const [theme, setTheme] = useState<ThemeMode>("system");
  // Fractions of the window, not pixels: 0 = the size the layout would have chosen, anything else
  // is where the user left the divider — and it means the same thing when the window changes shape.
  const [navFraction, setNavFraction] = useState(0);
  const [asideFraction, setAsideFraction] = useState(0);
  const [stackFraction, setStackFraction] = useState(0);
  /** Measured height of the stacked pair, so the divider can be kept inside it. */
  const [stackHeight, setStackHeight] = useState(0);
  const stackRef = useRef<HTMLDivElement | null>(null);
  useTheme(theme);
  const { mode, width: windowWidth, height: windowHeight } = useLayoutMode(settings?.ui.layout ?? "auto", settings?.ui.stackBelow ?? 520);
  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [scanned] = await Promise.all([scan(), usage.refresh()]);
    return scanned;
  }, [scan, usage.refresh]);

  // First paint: everything the window needs, plus the position the last run ended on.
  useEffect(() => {
    void (async () => {
      const [, appInfo, saved] = await Promise.all([
        scan(), api.appInfo(), loadSettings(), usage.refresh(), metrics.load(),
      ]);
      setTheme(saved.ui.theme);
      setNavFraction(saved.ui.navWidth);
      setAsideFraction(saved.ui.asideWidth);
      setStackFraction(saved.ui.stackTop);
      setInfo(appInfo);
      onLanguage({ language: saved.ui.language, locale: appInfo.locale });
    })();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Main can save the settings too, so the language follows from wherever it changed.
  useEffect(() => {
    if (settings && info) onLanguage({ language: settings.ui.language, locale: info.locale });
  }, [settings?.ui.language, info?.locale, onLanguage, settings, info]);
  useEffect(() => api.onWindowState(setWindowState), []);

  // Measure the room the two stacked panes share, rather than guessing it from the window: the
  // header and toolbar above them came to 149 px here, which is more than a divider can spare.
  useEffect(() => {
    const element = stackRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      setStackHeight(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) => setStackHeight(entry?.contentRect.height ?? 0));
    observer.observe(element);
    setStackHeight(element.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, [mode]);
  useEffect(() => { void api.windowState().then(setWindowState); }, []);

  // The list as it is drawn — one array for both the drawing and the keyboard, or the arrow keys
  // would walk a different list from the one on screen.
  const placed = useMemo(() => filterProjects(projects, query), [projects, query]);
  const filtered = useMemo(() => placed.map((row) => row.item), [placed]);

  const project = filtered[Math.min(projectIndex, Math.max(0, filtered.length - 1))] ?? null;

  // Git's own state for the project in front of the user; the count it finds is merged into that
  // project's row, which is the one thing about git this file still does.
  const patchDirty = useDirtyPatch(setProjects);
  const { worktrees } = useGit(
    openProject ?? project?.dir ?? null,
    settings?.git.enabled ?? false,
    settings?.git.countChanges ?? false,
    patchDirty,
  );
  const openProjectInfo = projects.find((p) => p.dir === openProject) ?? null;
  const sessions = useMemo(() => filterSessions(openProjectInfo, query), [openProjectInfo, query]);
  const session = sessions[Math.min(sessionIndex, Math.max(0, sessions.length - 1))] ?? null;

  // What the keyboard handler reads. Kept in a ref because a key can arrive before React has
  // re-rendered with the new state, and acting on the previous screen is how F2 renamed the wrong
  // thing. The ref is written during render, so it is never behind.
  const latest = useRef({ screen, project, session, sessions, filtered, editing, helpOpen, settingsSection, openProject });
  latest.current = { screen, project, session, sessions, filtered, editing, helpOpen, settingsSection, openProject };

  /**
   * Ask in the app's own dialog rather than the system's.
   *
   * Electron has no `window.prompt` at all, so asking for a name that way returned nothing and the
   * feature silently did nothing; and a native message box wears the OS's colours, which beside a
   * dark window reads as a different program.
   */
  const askUser = useCallback((ask: Ask): Promise<AskResult> =>
    new Promise<AskResult>((resolve) => {
      setDialog({ ask, settle: (result) => { setDialog(null); resolve(result); } });
    }), []);

  const notify = useCallback((result: { ok: boolean; message?: string }) => {
    if (!result.message) return;
    setToast({ text: result.message, tone: result.ok ? "ok" : "bad" });
    setTimeout(() => setToast(null), 4000);
  }, []);

  /** What an action on a row needs from this window; the features do the rest themselves. */
  const rowUi = useMemo(() => ({ askUser, notify, refresh, t }), [askUser, notify, refresh, t]);

  const open = useCallback(async (target: "sessionsWindow" | "currentWindow" | "newWindow") => {
    const now = latest.current;
    const dir = now.screen === "sessions" ? now.openProject : now.project?.dir;
    if (!dir) return;
    await openSession({
      projectDir: dir,
      sessionId: now.screen === "sessions" ? now.session?.id ?? null : null,
      target,
    }, rowUi);
  }, [rowUi]);

  /** A fresh session in the project on screen — the one open, or the one under the cursor. */
  const startNew = useCallback(async () => {
    const now = latest.current;
    const dir = now.screen === "sessions" ? now.openProject : now.project?.dir;
    if (!dir) return;
    await openSession({ projectDir: dir, sessionId: null, target: "sessionsWindow" }, rowUi);
  }, [rowUi]);

  /** Pick a folder, make it a project, and land on its row. */
  const addProject = useCallback(async () => {
    const result = await api.addProject();
    notify(result);
    if (!result.ok || !result.dir) return;
    const scanned = await refresh();
    setQuery("");                                       // a filter could hide the row just added
    setScreen("projects");
    setProjectIndex(indexOf(result.dir, scanned));
  }, [notify, refresh]);

  const enterSessions = useCallback((dir: string) => {
    setOpenProject(dir);
    setScreen("sessions");
    setSessionIndex(0);
    void api.saveUi({ project: dir, cursor: 0 });
  }, []);

  const back = useCallback(() => {
    if (editing) { setEditing(null); return; }
    if (screen === "settings") { setScreen(openProject ? "sessions" : "projects"); return; }
    if (screen === "sessions") {
      setScreen("projects");
      setOpenProject(null);
      void api.saveUi({ project: null, cursor: projectIndex });
    }
  }, [editing, screen, openProject, projectIndex]);

  /** Delete what is under the cursor — a session on the sessions screen, else the project. */
  const remove = useCallback(async () => {
    const now = latest.current;
    if (now.screen === "sessions" && now.session) await deleteSession(now.openProject as string, now.session, rowUi);
    else if (now.project) await deleteProject(now.project, rowUi);
  }, [rowUi]);

  /** Select the row for `dir` in a freshly scanned list — through the same placement it is drawn with. */
  const landOn = useCallback((dir: string, scanned: ProjectInfo[]) => {
    setQuery("");
    setScreen("projects");
    setProjectIndex(indexOf(dir, scanned));
  }, []);

  /** The right-click menu of a project row: the projects feature's entries with git's slotted in. */
  const projectMenu = useCallback(async (target: ProjectInfo, index: number) => {
    setProjectIndex(index);
    setScreen("projects");
    const choice = await api.contextMenu(projectMenuItems(target, gitMenuItems(target, settings?.git.base, t), t));
    if (isProjectAction(choice)) await runProjectAction(choice, target, { ...rowUi, enterSessions, startRename: setEditing });
    // Git's entries carry their own dialogs; this file only hands over what they need.
    else if (isGitAction(choice)) await runGitAction(choice, target, { ...rowUi, landOn });
  }, [rowUi, enterSessions, settings?.git.base, landOn, t]);

  /** The right-click menu of a session row, on either screen it is listed on. */
  const sessionMenu = useCallback(async (projectDir: string, target: SessionInfo, index: number) => {
    if (latest.current.screen === "sessions") setSessionIndex(index);
    const choice = await api.contextMenu(sessionMenuItems(target, t));
    if (!isSessionAction(choice)) return;
    await runSessionAction(choice, projectDir, target, {
      ...rowUi,
      enterSessions,
      // The editor replaces the row on the sessions screen only, so the preview list gets there first.
      startRename: (id) => {
        if (latest.current.screen !== "sessions") enterSessions(projectDir);
        setSessionIndex(index);
        setEditing(id);
      },
    });
  }, [rowUi, enterSessions, t]);

  // The global shortcut can fire while another window has focus; its verdict still belongs here.
  usePasteResults(notify);
  // A sweep runs on a timer in the main process; it speaks only when it changed something.
  useEffect(() => api.onToast((message) => notify({ ok: true, message })), [notify]);

  /** Turn usage collection on or off; the settings it comes back with are this file's to keep. */
  const collectUsage = useCallback(async (on: boolean) => {
    const result = await usage.collect(on);
    setSettings(result.settings);
    notify(result);
  }, [notify, usage.collect]);

  const applySettings = useCallback(async (next: SettingsPayload) => {
    // Every section, not a list that has to be remembered: a section left out of this call is a
    // setting the screen appears to change and then silently reverts on the next push.
    const saved = await saveSettings({
      dock: next.dock,
      status: next.status,
      launch: next.launch,
      ui: next.ui,
      git: next.git,
      updates: next.updates,
    });
    setTheme(saved.ui.theme);
    await usage.refresh();                          // which windows are shown is a setting
  }, [usage.refresh]);

  const openSettings = useCallback(async () => {
    const [, screens] = await Promise.all([loadSettings(), dock.displays()]);
    setDisplays(screens);
    setScreen("settings");
  }, []);

  const applyDock = useCallback(async (enabled: boolean) => {
    if (!settings) return;
    if (!enabled) {
      setSettings(await dock.release());
      notify({ ok: true, message: "Undocked." });
      return;
    }
    const result = await dock.apply({ ...settings.dock, enabled: true });
    if (result.settings) setSettings(result.settings);
    notify({ ok: result.ok, message: result.message ?? "Docked." });
  }, [settings, notify]);

  // One keyboard handler for the window: the mapping lives in core, this only performs the action.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const now = latest.current;
      const typing = Boolean(now.editing) || document.activeElement === searchRef.current;
      const action = resolveAction(event, now.screen, typing);
      if (!action) return;
      if (now.helpOpen && action !== "help" && action !== "back") return;
      event.preventDefault();

      switch (action) {
        case "moveUp": case "moveDown": case "pageUp": case "pageDown": case "moveFirst": case "moveLast": {
          if (now.screen === "sessions") setSessionIndex((index) => nextIndex(action, index, now.sessions.length, PAGE_SIZE));
          else if (now.screen === "projects") setProjectIndex((index) => nextIndex(action, index, now.filtered.length, PAGE_SIZE));
          break;
        }
        case "enter": {
          if (now.editing) return;                // the input's own handler commits the edit
          if (now.screen === "projects" && now.project) enterSessions(now.project.dir);
          else if (now.screen === "sessions") void open("sessionsWindow");
          break;
        }
        case "openNewWindow": void open("newWindow"); break;
        case "newSession": void startNew(); break;
        case "pasteImage": void api.pasteImage().then(notify); break;
        case "rename": {
          const id = now.screen === "sessions" ? now.session?.id : now.project?.dir;
          if (id) setEditing(id);
          break;
        }
        case "delete": void remove(); break;
        case "back": now.helpOpen ? setHelpOpen(false) : back(); break;
        case "refresh": void refresh(); break;
        case "settings": void openSettings(); break;
        case "search": searchRef.current?.focus(); break;
        case "help": setHelpOpen((open) => !open); break;
        case "quit": void api.quit(); break;
        case "nextSection": case "previousSection": {
          if (now.screen !== "settings") break;
          const step = action === "nextSection" ? 1 : -1;
          const current = SETTINGS_SECTIONS.indexOf(now.settingsSection);
          const index = (current + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
          setSettingsSection(SETTINGS_SECTIONS[index] as SettingsSection);
          break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [screen, filtered, sessions, project, session, editing, helpOpen, settingsSection, open, startNew, back, remove, refresh, openSettings, enterSessions]);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  const commitRename = useCallback(async (value: string, explicit = false) => {
    const now = latest.current;
    const title = value.trim();
    setEditing(null);
    // An empty name takes the name off again, which is how the generated title is got back. Only
    // when it was typed and entered, though: blurring a field someone happened to clear, or clicked
    // into and out of, must not quietly rename anything.
    if (!title && !explicit) return;
    // Which thing is being renamed is decided by what is on screen at commit time, not by what was
    // on screen when this callback was created.
    const target = now.screen === "sessions" && now.session
      ? { projectDir: now.openProject as string, sessionId: now.session.id }
      : now.project ? { projectDir: now.project.dir } : null;
    if (target) await rename(target, title, rowUi);
  }, [rowUi]);

  const usageWindows = usage.status?.windows ?? [];
  // Both machine gauges read the same way: the share first, then the quantity behind it — a load
  // without its clock, or a percentage of memory without the gigabytes, is half a reading.
  const cpuValue = latestSystem
    ? `${latestSystem.cpu.toFixed(0)}%${cpuGhz ? ` · ${cpuGhz.toFixed(1)} GHz` : ""}`
    : "\u2014";
  const memoryPercent = latestSystem && totalMemory
    ? Math.round((latestSystem.memoryBytes / totalMemory) * 100)
    : null;
  const memoryValue = latestSystem
    ? `${memoryPercent === null ? "" : `${memoryPercent}% · `}${formatBytes(latestSystem.memoryBytes)}`
    : "—";

  // Monitoring off means there is nothing to draw — and nothing being measured, which is the point.
  const monitoring = settings?.ui.monitor ?? true;
  // Fractions turned back into pixels against what is on screen right now, then clamped so no pane
  // is squeezed out. Saving happens on release, so a drag writes one line, not one per frame.
  const navWidth = navFraction ? Math.round(navFraction * windowWidth) : 0;
  const asideWidth = asideFraction ? Math.round(asideFraction * windowWidth) : 0;
  const topHeight = stackedTopHeight(Math.round(stackFraction * stackHeight), stackHeight);
  const band = mode === "band";
  const column = mode === "column";
  const showDetail = mode === "full";
  // Both thin shapes lose the same things: the labels on buttons, and the space for two panes.
  const tight = band || column;

  // The same four gauges whichever way they are laid out — down a column when the window is narrow,
  // across a row when it is short.
  const machineCards = (
    <>
      {usageWindows.map((usage) => <UsageCard key={usage.key} window={usage} compact />)}
      <AreaChart samples={systemHistory} field="cpu" max={100} label={t("gauge.cpu")} value={cpuValue} />
      <AreaChart
        samples={systemHistory}
        field="memoryBytes"
        max={totalMemory}
        label={t("gauge.memory")}
        short={t("gauge.memoryShort")}
        value={memoryValue}
        total={memoryTotal ? formatBytes(memoryTotal) : undefined}
      />
    </>
  );

  // The two panes the projects feature draws. Which row is selected, and what a click on it does,
  // stay this file's: the keyboard drives both, and the same handlers serve it.
  const projectPane = (
    <ProjectPane
      placed={placed}
      query={query}
      onQuery={setQuery}
      searchRef={searchRef}
      onAdd={() => void addProject()}
      editing={editing}
      editRef={editRef}
      onRename={(value, explicit) => void commitRename(value, explicit)}
      onCancelEdit={() => setEditing(null)}
      isSelected={(item, index) => screen !== "settings" && (screen === "projects" ? index === projectIndex : item.dir === openProject)}
      onSelect={(index) => { setProjectIndex(index); setScreen("projects"); }}
      onOpen={enterSessions}
      onContextMenu={(item, index) => void projectMenu(item, index)}
      tight={tight}
    />
  );
  const samplesOf = (sessionId: string) => (monitoring ? sessionHistory[sessionId] ?? [] : []);
  const sessionRows = screen === "sessions" ? (
    <SessionList
      sessions={sessions}
      selected={sessionIndex}
      editing={editing}
      editRef={editRef}
      samples={samplesOf}
      onRename={(value, explicit) => void commitRename(value, explicit)}
      onCancelEdit={() => setEditing(null)}
      onSelect={setSessionIndex}
      onOpen={() => void open("sessionsWindow")}
      onContextMenu={(item, index) => void sessionMenu(openProject as string, item, index)}
    />
  ) : project ? (
    <SessionPreview
      project={project}
      samples={samplesOf}
      onEnter={() => enterSessions(project.dir)}
      onContextMenu={(item, index) => void sessionMenu(project.dir, item, index)}
    />
  ) : null;

  return (
    <div className="relative h-full flex flex-col bg-ink-900 overflow-hidden">
      {/* Docked, the frame does not resize; this is the one side that does. */}
      {dock.docked ? <DockGrip edge={dock.edge} onDrag={dock.drag} /> : null}
      <TitleBar
        version={info?.version ?? "—"}
        draggable={!dock.docked}
        controls={
          <WindowControls
            maximized={windowState.maximized}
            onMinimize={() => void api.windowCommand("minimize")}
            onMaximize={() => void api.windowCommand("maximize")}
            onClose={() => void api.windowCommand("close")}
            slot={<DockButton docked={dock.docked} edge={dock.edge} onToggle={() => void dock.toggle()} />}
          />
        }
      />

      <div className="flex-1 min-h-0 flex">
        {column ? null : (
          <>
            <nav
              className={`${navWidth ? "" : band ? "w-56" : "w-72"} shrink-0 border-r border-ink-600 flex flex-col`}
              style={navWidth ? { width: navWidth } : undefined}
            >
              {projectPane}
            </nav>
            <Splitter
              width={navWidth || (band ? 224 : 288)}
              side="left"
              min={NAV_MIN}
              max={NAV_MAX}
              onDrag={(width) => setNavFraction(windowWidth ? width / windowWidth : 0)}
              onCommit={(width) => void api.saveUi({ navWidth: windowWidth ? width / windowWidth : 0 })}
            />
          </>
        )}

        <main className="flex-1 min-w-0 flex flex-col">
          {screen === "settings" && settings ? (
            <SettingsView
              settings={settings}
              displays={displays}
              focused={settingsSection}
              onFocus={setSettingsSection}
              onChange={(next) => void applySettings(next)}
              onApplyDock={(enabled) => void applyDock(enabled)}
              onCollectUsage={(on) => void collectUsage(on)}
              onOpenPage={(page) => void api.openPage(page)}
              locale={info?.locale ?? "en"}
              updates={updates}
              onClose={back}
            />
          ) : (
            <>
              <div className={`flex items-center gap-2 border-b border-ink-600 ${tight ? "px-2 py-1" : "px-4 py-2"}`}>
                <Truncated
                  as="span"
                  title={screen === "sessions" && openProjectInfo ? openProjectInfo.cwd ?? undefined : undefined}
                  className="text-sm text-bone-200"
                >
                  {screen === "sessions" && openProjectInfo ? openProjectInfo.name : t("app.projects")}
                </Truncated>
                <span className="chip">{screen === "sessions"
                  ? t("app.sessions.count", { count: sessions.length })
                  : t("app.projects.count", { count: filtered.length })}</span>
                <div className="flex-1" />
                {/* The key belongs in the tooltip: on the face of a button it is width spent on
                    something only worth learning once. */}
                <button
                  type="button"
                  className="btn"
                  title={t("app.new.title")}
                  onClick={() => void startNew()}
                  disabled={screen === "sessions" ? !openProject : !project}
                >
                  {t("app.new")}
                </button>
                <button type="button" className="btn" title={t("app.settings.title")} onClick={() => void openSettings()} aria-label={t("app.settings")}>
                  {tight ? "\u2699" : t("app.settings")}
                </button>
              </div>

              <div className="flex-1 min-h-0 flex">
                {column ? (
                  // Stacked: the project list, that project's sessions, and the graphs, one under
                  // the other — a tall narrow window has no room for panes side by side.
                  <div ref={stackRef} className="flex-1 min-w-0 flex flex-col">
                    <div
                      className={`${topHeight ? "" : "flex-1"} min-h-0 flex flex-col border-b border-ink-600`}
                      style={topHeight ? { height: topHeight } : undefined}
                    >
                      {projectPane}
                    </div>
                    <Splitter
                      width={topHeight || Math.round(stackHeight / 2)}
                      side="top"
                      min={STACK_MIN}
                      max={Math.max(STACK_MIN, stackHeight - STACK_MIN)}
                      onDrag={(height) => setStackFraction(stackHeight ? height / stackHeight : 0)}
                      onCommit={(height) => void api.saveUi({ stackTop: stackHeight ? height / stackHeight : 0 })}
                    />
                    <div data-testid="stack-sessions" className="flex-1 min-h-0 overflow-auto p-1 space-y-0.5">
                      {sessionRows}
                    </div>
                  </div>
                ) : (
                <div className={`flex-1 min-w-0 overflow-auto space-y-0.5 ${tight ? "p-1" : "p-2"}`}>
                  {sessionRows}
                </div>
                )}

                {column ? null : (
                  <Splitter
                    width={asideWidth || (showDetail ? 320 : 208)}
                    side="right"
                    min={ASIDE_MIN}
                    max={ASIDE_MAX}
                    onDrag={(width) => setAsideFraction(windowWidth ? width / windowWidth : 0)}
                    onCommit={(width) => void api.saveUi({ asideWidth: windowWidth ? width / windowWidth : 0 })}
                  />
                )}
                {column || !monitoring ? null : showDetail ? (
                <aside
                  className={`${asideWidth ? "" : "w-80"} shrink-0 border-l border-ink-600 overflow-auto`}
                  style={asideWidth ? { width: asideWidth } : undefined}
                >
                  {screen === "sessions" && session ? (
                    <SessionDetail session={session} samples={monitoring ? sessionHistory[session.id] ?? [] : []} />
                  ) : project ? (
                    <ProjectDetail project={project} worktrees={worktrees} />
                  ) : null}

                  <div className="p-3 space-y-2 border-t border-ink-600">
                    {usageWindows.map((usage) => <UsageCard key={usage.key} window={usage} />)}
                    <AreaChart
                      samples={systemHistory}
                      field="cpu"
                      max={100}
                      label={t("gauge.cpuMachine")}
                      value={cpuValue}
                    />
                    <AreaChart
                      samples={systemHistory}
                      field="memoryBytes"
                      max={totalMemory}
                      label={t("gauge.memoryMachine")}
                      short={t("gauge.memoryShort")}
                      value={memoryValue}
                      total={memoryTotal ? formatBytes(memoryTotal) : undefined}
                    />
                    <div className="text-[11px] text-bone-500">
                      {liveSessions.length === 0
                        ? t("app.noSessionRunning")
                        : liveSessions.length === 1
                          ? t("app.sessionRunning")
                          : t("app.sessionsRunning", { count: liveSessions.length })}
                    </div>
                  </div>
                </aside>
                ) : (
                  // Band and compact: the machine graphs stay — they are the reason to keep the
                  // window on screen — but with no detail panel behind them.
                  //
                  // A band is short, not narrow: four cards down a column ran off the bottom of a
                  // 320 px strip and the last two were only reachable by scrolling, which for a
                  // gauge is the same as not being drawn. Short means lay them across.
                  <aside
                    className={`${asideWidth ? "" : band ? "w-80" : "w-52"} shrink-0 border-l border-ink-600 p-1 ${
                      band ? "flex flex-col gap-1 min-h-0" : "space-y-1 overflow-y-auto no-bar"}`}
                    style={asideWidth ? { width: asideWidth } : undefined}
                  >
                    {band
                      ? <div className="flex-1 min-h-0 flex items-start gap-1 [&>*]:min-w-0 [&>*]:flex-1">{machineCards}</div>
                      : machineCards}
                    <div className={`text-[11px] text-bone-500 ${band ? "shrink-0 text-center" : ""}`}>
                      {liveSessions.length ? t("app.running", { count: liveSessions.length }) : t("app.running.none")}
                    </div>
                  </aside>
                )}
              </div>

              {/* Everything shares the strip and shrinks to fit: scrolling some of it out of
                  sight is the same as not showing it. */}
              {column && monitoring ? (
                <div className="shrink-0 border-t border-ink-600 p-1 flex gap-1 [&>*]:min-w-0 [&>*]:flex-1">
                  {usageWindows.map((usage) => <UsageCard key={usage.key} window={usage} compact />)}
                  <AreaChart
                    compact
                    samples={systemHistory}
                    field="cpu"
                    max={100}
                    label={t("gauge.cpu")}
                    value={cpuValue}
                  />
                  <AreaChart
                    compact
                    samples={systemHistory}
                    field="memoryBytes"
                    max={totalMemory}
                    label={t("gauge.memory")}
                    short={t("gauge.memoryShort")}
                    value={memoryValue}
                    total={memoryTotal ? formatBytes(memoryTotal) : undefined}
                  />
                </div>
              ) : null}
            </>
          )}
        </main>
      </div>

      {dialog ? <Modal ask={dialog.ask} onDone={dialog.settle} /> : null}

      {toast ? (
        <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-lg ${
          toast.tone === "ok" ? "bg-ink-700 text-bone-100" : "bg-bad/90 text-ink-900"}`}>
          {toast.text}
        </div>
      ) : null}

      {helpOpen ? (
        <div className="absolute inset-0 bg-ink-900/80 flex items-center justify-center" onClick={() => setHelpOpen(false)}>
          <div className="card p-5 w-[30rem]" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-sm font-medium text-bone-100 mb-3">{t("keys.title")}</h2>
            <div className="space-y-1">
              {SHORTCUTS.map((shortcut) => (
                <div key={shortcut.keys} className="flex justify-between text-xs">
                  <span className="text-bone-400">{shortcut.description}</span>
                  <kbd className="chip">{shortcut.keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The whole window: status strip, project list, session list, detail panel, monitor, settings.
 *
 * Selection and screen live here because the keyboard drives them — every list is a controlled
 * view of this state, so a key and a click end up in exactly the same place.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nextIndex, resolveAction, SHORTCUTS, type Screen } from "@core/keymap";
import type { MetricSample, MetricsSnapshot, ProjectInfo, SessionInfo, StatusSnapshot, ThemeMode } from "@core/types";

import { api, type AppInfo, type DisplayInfo, type SettingsPayload } from "./api";
import { AreaChart } from "./components/Chart";
import { ProjectDetail, ProjectRow, SessionDetail, SessionRow } from "./components/Lists";
import { SETTINGS_SECTIONS, SettingsView, type SettingsSection } from "./components/Settings";
import { StatusBar } from "./components/StatusBar";
import { formatBytes } from "./format";
import { useLayoutMode } from "./useLayoutMode";
import { useTheme } from "./useTheme";

const PAGE_SIZE = 10;
const REFRESH_MS = 15_000;
const HISTORY_LIMIT = 300;

type Toast = { text: string; tone: "ok" | "bad" } | null;

export function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [screen, setScreen] = useState<Screen>("projects");
  const [projectIndex, setProjectIndex] = useState(0);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("dock");
  const [systemHistory, setSystemHistory] = useState<MetricSample[]>([]);
  const [sessionHistory, setSessionHistory] = useState<Record<string, MetricSample[]>>({});
  const [theme, setTheme] = useState<ThemeMode>("system");
  useTheme(theme);
  const { mode } = useLayoutMode();
  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [scanned, statusSnapshot] = await Promise.all([api.scan(), api.status()]);
    setProjects(scanned);
    setStatus(statusSnapshot);
  }, []);

  // First paint: everything the window needs, plus the position the last run ended on.
  useEffect(() => {
    void (async () => {
      const [scanned, statusSnapshot, appInfo, history, saved] = await Promise.all([
        api.scan(), api.status(), api.appInfo(), api.metrics(), api.loadSettings(),
      ]);
      setTheme(saved.ui.theme);
      setSettings(saved);
      setProjects(scanned);
      setStatus(statusSnapshot);
      setInfo(appInfo);
      setSystemHistory(history.system);
      setSessionHistory(history.sessions);
    })();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Live samples arrive from the main process; keep the same bounded history the sampler keeps.
  useEffect(() => api.onMetrics((snapshot: MetricsSnapshot) => {
    setSystemHistory((previous) => cap([...previous, {
      at: snapshot.at, cpu: snapshot.system.cpu, memoryBytes: snapshot.system.memoryBytes,
    }]));
    setSessionHistory((previous) => {
      const next: Record<string, MetricSample[]> = {};
      for (const [id, usage] of Object.entries(snapshot.sessions)) {
        next[id] = cap([...(previous[id] ?? []), { at: snapshot.at, cpu: usage.cpu, memoryBytes: usage.memoryBytes }]);
      }
      return next;
    });
  }), []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) =>
      project.name.toLowerCase().includes(needle)
      || (project.cwd ?? "").toLowerCase().includes(needle)
      || project.sessions.some((s) => s.title.toLowerCase().includes(needle)));
  }, [projects, query]);

  const project = filtered[Math.min(projectIndex, Math.max(0, filtered.length - 1))] ?? null;
  const sessions = useMemo(() => {
    const current = projects.find((p) => p.dir === openProject) ?? null;
    if (!current) return [];
    const needle = query.trim().toLowerCase();
    return needle ? current.sessions.filter((s) => s.title.toLowerCase().includes(needle)) : current.sessions;
  }, [projects, openProject, query]);
  const session = sessions[Math.min(sessionIndex, Math.max(0, sessions.length - 1))] ?? null;
  const openProjectInfo = projects.find((p) => p.dir === openProject) ?? null;

  // What the keyboard handler reads. Kept in a ref because a key can arrive before React has
  // re-rendered with the new state, and acting on the previous screen is how F2 renamed the wrong
  // thing. The ref is written during render, so it is never behind.
  const latest = useRef({ screen, project, session, sessions, filtered, editing, helpOpen, settingsSection, openProject });
  latest.current = { screen, project, session, sessions, filtered, editing, helpOpen, settingsSection, openProject };

  const notify = useCallback((result: { ok: boolean; message?: string }) => {
    if (!result.message) return;
    setToast({ text: result.message, tone: result.ok ? "ok" : "bad" });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const open = useCallback(async (target: "sessionsWindow" | "currentWindow" | "newWindow") => {
    const now = latest.current;
    const dir = now.screen === "sessions" ? now.openProject : now.project?.dir;
    if (!dir) return;
    const result = await api.openSession({
      projectDir: dir,
      sessionId: now.screen === "sessions" ? now.session?.id ?? null : null,
      target,
    });
    notify(result);
    void refresh();
  }, [screen, openProject, project, session, notify, refresh]);

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

  const remove = useCallback(async () => {
    const now = latest.current;
    const result = now.screen === "sessions" && now.session
      ? await api.deleteSession({ projectDir: now.openProject as string, sessionId: now.session.id })
      : now.project
        ? await api.deleteProject({ projectDir: now.project.dir })
        : { ok: false };
    notify(result);
    if (result.ok) await refresh();
  }, [screen, session, openProject, project, notify, refresh]);

  const applySettings = useCallback(async (next: SettingsPayload) => {
    const saved = await api.saveSettings({ dock: next.dock, status: next.status, launch: next.launch, ui: next.ui });
    setSettings(saved);
    setTheme(saved.ui.theme);
    setStatus(await api.status());
  }, []);

  const openSettings = useCallback(async () => {
    const [loaded, screens] = await Promise.all([api.loadSettings(), api.displays()]);
    setSettings(loaded);
    setDisplays(screens);
    setScreen("settings");
  }, []);

  const applyDock = useCallback(async (enabled: boolean) => {
    if (!settings) return;
    if (!enabled) {
      setSettings(await api.releaseDock());
      notify({ ok: true, message: "Undocked." });
      return;
    }
    const result = await api.applyDock({ ...settings.dock, enabled: true });
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
        case "openHere": void open("currentWindow"); break;
        case "openNewWindow": void open("newWindow"); break;
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
  }, [screen, filtered, sessions, project, session, editing, helpOpen, settingsSection, open, back, remove, refresh, openSettings, enterSessions]);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  const commitRename = useCallback(async (value: string) => {
    const now = latest.current;
    const title = value.trim();
    setEditing(null);
    if (!title) return;
    // Which thing is being renamed is decided by what is on screen at commit time, not by what was
    // on screen when this callback was created.
    const result = now.screen === "sessions" && now.session
      ? await api.renameSession({ projectDir: now.openProject as string, sessionId: now.session.id, title })
      : now.project
        ? await api.renameProject({ projectDir: now.project.dir, title })
        : { ok: false };
    notify(result);
    await refresh();
  }, [screen, session, openProject, project, notify, refresh]);

  const totalMemory = systemHistory.length ? Math.max(...systemHistory.map((s) => s.memoryBytes)) : 1;
  const latestSystem = systemHistory.length ? systemHistory[systemHistory.length - 1] : null;
  const liveSessions = projects.flatMap((p) => p.sessions.filter((s) => s.live));

  const band = mode === "band";
  const column = mode === "column";
  const showDetail = mode === "full";
  // Both thin shapes lose the same things: the labels on buttons, and the space for two panes.
  const tight = band || column;

  const projectPane = (
    <>
          <div className={band ? "p-1.5" : "p-2"}>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); searchRef.current?.blur(); } }}
              placeholder="Search projects  ( / )"
              className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm placeholder:text-bone-500 focus:border-accent/60"
            />
          </div>
          <div className="flex-1 overflow-auto px-2 pb-2 space-y-0.5">
            {filtered.map((item, index) => (
              editing === item.dir ? (
                <input
                  key={item.dir}
                  ref={editRef}
                  defaultValue={item.alias ?? item.name}
                  onBlur={(event) => void commitRename(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRename((event.target as HTMLInputElement).value);
                    if (event.key === "Escape") setEditing(null);
                  }}
                  data-testid="rename-input"
                  aria-label="New name"
                  className="w-full bg-ink-700 border border-accent/60 rounded-lg px-3 py-2 text-sm"
                />
              ) : (
                <ProjectRow
                  key={item.dir}
                  project={item}
                  selected={screen !== "settings" && (screen === "projects" ? index === projectIndex : item.dir === openProject)}
                  onSelect={() => { setProjectIndex(index); setScreen("projects"); }}
                  onOpen={() => enterSessions(item.dir)}
                />
              )
            ))}
            {filtered.length === 0 ? <p className="px-3 py-6 text-xs text-bone-500">No project matches.</p> : null}
          </div>
    </>
  );

  return (
    <div className="h-full flex flex-col bg-ink-900 overflow-hidden">
      <StatusBar status={status} appVersion={info?.version ?? "—"} compact={mode !== "full"} />

      <div className="flex-1 min-h-0 flex">
        {column ? null : (
          <nav className={`${band ? "w-56" : "w-72"} shrink-0 border-r border-ink-600 flex flex-col`}>
            {projectPane}
          </nav>
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
              onClose={back}
            />
          ) : (
            <>
              <div className={`px-4 flex items-center gap-2 border-b border-ink-600 ${band ? "py-1" : "py-2"}`}>
                <h1 className="text-sm text-bone-200 truncate">
                  {screen === "sessions" && openProjectInfo ? openProjectInfo.name : "Projects"}
                </h1>
                <span className="chip">{screen === "sessions" ? `${sessions.length} sessions` : `${filtered.length} projects`}</span>
                <div className="flex-1" />
                {screen === "sessions" ? (
                  <button type="button" className="btn" onClick={back}>{tight ? "Back" : "Back (Esc)"}</button>
                ) : null}
                <button type="button" className="btn" onClick={() => void open("sessionsWindow")} disabled={!project}>
                  {tight ? "Open" : "Open (Enter)"}
                </button>
                <button type="button" className="btn" onClick={() => void openSettings()} aria-label="Settings">
                  {tight ? "\u2699" : "Settings (S)"}
                </button>
              </div>

              <div className="flex-1 min-h-0 flex">
                {column && screen === "projects" ? (
                  <div className="flex-1 min-w-0 flex flex-col">{projectPane}</div>
                ) : (
                <div className="flex-1 min-w-0 overflow-auto p-2 space-y-0.5">
                  {screen === "sessions"
                    ? sessions.map((item: SessionInfo, index: number) => (
                      editing === item.id ? (
                        <input
                          key={item.id}
                          ref={editRef}
                          defaultValue={item.title}
                          onBlur={(event) => void commitRename(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void commitRename((event.target as HTMLInputElement).value);
                            if (event.key === "Escape") setEditing(null);
                          }}
                          data-testid="rename-input"
                  aria-label="New name"
                  className="w-full bg-ink-700 border border-accent/60 rounded-lg px-3 py-2 text-sm"
                        />
                      ) : (
                        <SessionRow
                          key={item.id}
                          session={item}
                          selected={index === sessionIndex}
                          samples={sessionHistory[item.id] ?? []}
                          onSelect={() => setSessionIndex(index)}
                          onOpen={() => void open("sessionsWindow")}
                        />
                      )
                    ))
                    : project
                      ? project.sessions.slice(0, 8).map((item) => (
                        <SessionRow
                          key={item.id}
                          session={item}
                          selected={false}
                          samples={sessionHistory[item.id] ?? []}
                          onSelect={() => enterSessions(project.dir)}
                          onOpen={() => enterSessions(project.dir)}
                        />
                      ))
                      : null}
                  {screen === "projects" && project && project.sessions.length > 8 ? (
                    <button type="button" className="btn w-full mt-1" onClick={() => enterSessions(project.dir)}>
                      Show all {project.sessions.length} sessions (Enter)
                    </button>
                  ) : null}
                </div>
                )}

                {column ? null : showDetail ? (
                <aside className="w-80 shrink-0 border-l border-ink-600 overflow-auto">
                  {screen === "sessions" && session ? (
                    <SessionDetail session={session} samples={sessionHistory[session.id] ?? []} />
                  ) : project ? (
                    <ProjectDetail project={project} />
                  ) : null}

                  <div className="p-3 space-y-2 border-t border-ink-600">
                    <AreaChart
                      samples={systemHistory}
                      field="cpu"
                      max={100}
                      label="CPU (machine)"
                      value={latestSystem ? `${latestSystem.cpu.toFixed(0)}%` : "—"}
                    />
                    <AreaChart
                      samples={systemHistory}
                      field="memoryBytes"
                      max={totalMemory}
                      label="Memory (machine)"
                      value={latestSystem ? formatBytes(latestSystem.memoryBytes) : "—"}
                    />
                    <div className="text-[11px] text-bone-500">
                      {liveSessions.length
                        ? `${liveSessions.length} session${liveSessions.length > 1 ? "s" : ""} running`
                        : "no session running"}
                    </div>
                  </div>
                </aside>
                ) : (
                  // Band and compact: the machine graphs stay — they are the reason to keep the
                  // window on screen — but as a narrow column with no detail panel behind them.
                  <aside className="w-52 shrink-0 border-l border-ink-600 p-2 space-y-2 overflow-hidden">
                    <AreaChart
                      samples={systemHistory}
                      field="cpu"
                      max={100}
                      label="CPU"
                      value={latestSystem ? `${latestSystem.cpu.toFixed(0)}%` : "—"}
                    />
                    <AreaChart
                      samples={systemHistory}
                      field="memoryBytes"
                      max={totalMemory}
                      label="Memory"
                      value={latestSystem ? formatBytes(latestSystem.memoryBytes) : "—"}
                    />
                    <div className="text-[11px] text-bone-500">
                      {liveSessions.length ? `${liveSessions.length} running` : "idle"}
                    </div>
                  </aside>
                )}
              </div>

              {column ? (
                <div className="shrink-0 border-t border-ink-600 p-1.5 grid grid-cols-2 gap-1.5">
                  <AreaChart
                    compact
                    samples={systemHistory}
                    field="cpu"
                    max={100}
                    label="CPU"
                    value={latestSystem ? `${latestSystem.cpu.toFixed(0)}%` : "\u2014"}
                  />
                  <AreaChart
                    compact
                    samples={systemHistory}
                    field="memoryBytes"
                    max={totalMemory}
                    label="Mem"
                    value={latestSystem ? formatBytes(latestSystem.memoryBytes) : "\u2014"}
                  />
                </div>
              ) : null}
            </>
          )}
        </main>
      </div>

      {toast ? (
        <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-lg ${
          toast.tone === "ok" ? "bg-ink-700 text-bone-100" : "bg-bad/90 text-ink-900"}`}>
          {toast.text}
        </div>
      ) : null}

      {helpOpen ? (
        <div className="absolute inset-0 bg-ink-900/80 flex items-center justify-center" onClick={() => setHelpOpen(false)}>
          <div className="card p-5 w-[30rem]" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-sm font-medium text-bone-100 mb-3">Keyboard</h2>
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

function cap(samples: MetricSample[]): MetricSample[] {
  return samples.length > HISTORY_LIMIT ? samples.slice(samples.length - HISTORY_LIMIT) : samples;
}

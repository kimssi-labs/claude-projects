/**
 * The Electron main process: one window, the IPC surface the renderer is allowed to use, the
 * session launcher, the dock and the metrics sampler.
 *
 * All the reading and the command building live in `src/core`, which is why this file is mostly
 * wiring: the parts worth testing are tested without Electron.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";

import { ConfigStore, percentFloor } from "../core/config.js";
import { launchCommand, LINUX_TERMINALS, CLAUDE_EXE } from "../core/launcher.js";
import { MetricsHistory, SYSTEM_SERIES } from "../core/metrics.js";
import { claudeHome } from "../core/paths.js";
import { readStatus, installedMcpServers } from "../core/status.js";
import { Store } from "../core/store.js";
import type { DockConfig, LaunchConfig, ProjectInfo, StatusConfig, UiConfig } from "../core/types.js";
import { bandRect, bandThickness, Dock, pickDisplay } from "./dock.js";
import { CHANNEL, type ActionResult, type AppInfo, type DeleteRequest, type DisplayInfo, type OpenSessionRequest, type RenameRequest, type SettingsPayload } from "./ipc.js";
import { sample, SAMPLE_INTERVAL_MS } from "./sampler.js";

const DEV_SERVER = "http://localhost:5273";
const WINDOW = { width: 1180, height: 760, minWidth: 420, minHeight: 320 } as const;

const store = new Store();
const config = new ConfigStore();
const history = new MetricsHistory();
let window: BrowserWindow | null = null;
let dock: Dock | null = null;
let sampling: NodeJS.Timeout | null = null;
let lastProjects: ProjectInfo[] = [];

function which(exe: string): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync(command, [exe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).find((line) => line.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** Resolve the claude executable, never the bare name: a shell function of that name would win. */
function claudeExecutable(): string | null {
  return which(CLAUDE_EXE);
}

function detectLinuxTerminal(configured: string): { exe: string; args: readonly string[] } | null {
  if (configured) return { exe: configured, args: [] };
  for (const candidate of LINUX_TERMINALS) if (which(candidate.exe)) return candidate;
  return null;
}

function findProject(dir: string): ProjectInfo | undefined {
  return lastProjects.find((p) => p.dir === dir);
}

/** Do two rectangles share any pixel? Enough to decide a saved position is still reachable. */
function rectsOverlap(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function scanProjects(): ProjectInfo[] {
  lastProjects = store.scan();
  return lastProjects;
}

async function createWindow(): Promise<void> {
  // Reopen where it was left, but only if that rectangle is still on a connected display — a saved
  // position from a monitor that is now unplugged would open the window off-screen.
  const savedBounds = config.ui().window;
  const onScreen = savedBounds
    ? screen.getAllDisplays().some((display) => rectsOverlap(display.workArea, savedBounds))
    : false;

  window = new BrowserWindow({
    ...WINDOW,
    ...(onScreen && savedBounds ? savedBounds : {}),
    show: false,
    backgroundColor: "#141413",
    title: "Hangar",
    autoHideMenuBar: true,
    icon: join(__dirname, "..", "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  dock = new Dock(window);
  // Dragging a docked window out of its band is how you undock it; the saved setting follows.
  dock.onUserUndock = () => {
    const current = config.dock();
    if (!current.enabled) return;
    config.saveDock({ ...current, enabled: false });
    window?.webContents.send(CHANNEL.settingsPush, settingsPayload());
  };

  // Subscribe BEFORE loading: `ready-to-show` fires during the load, and a listener attached
  // afterwards misses it — the window then stays hidden forever with no error anywhere.
  window.once("ready-to-show", () => window?.show());
  // `close` and not `closed`: the reservation is removed while the window still exists, and
  // synchronously, because nothing waits for us once the process starts shutting down.
  window.on("close", () => {
    // Docked, the bounds are the band's, not the user's choice — do not remember those.
    if (window && !dock?.isDocked && !window.isMinimized()) {
      config.saveUi({ ...config.ui(), window: window.getNormalBounds() });
    }
    dock?.releaseSync();
  });
  window.on("closed", () => {
    window = null;
  });

  const devUrl = process.env["HANGAR_DEV"] ? DEV_SERVER : null;
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  window.show();                                  // belt and braces: the load is done, so is the wait

  const saved = config.dock();
  if (saved.enabled) {
    const placement = await dock.apply(saved);
    if (placement.note) window.webContents.send(CHANNEL.appInfo, placement.note);
  }
}

function stopSampling(): void {
  if (!sampling) return;
  clearInterval(sampling);
  sampling = null;
}

/** Runs only when the setting says so — the whole point of the setting is that off costs nothing. */
function startSampling(): void {
  if (sampling) return;
  if (!config.ui().monitor) return;
  sampling = setInterval(async () => {
    const targets = lastProjects.flatMap((project) =>
      project.sessions.filter((s) => s.live && s.pid).map((s) => ({ sessionId: s.id, pid: s.pid as number })));
    try {
      const snapshot = await sample(targets);
      history.push(snapshot);
      history.keepOnly(targets.map((t) => t.sessionId));
      window?.webContents.send(CHANNEL.metricsPush, snapshot);
    } catch {
      /* a sampling hiccup must never take the app down */
    }
  }, SAMPLE_INTERVAL_MS);
}

function settingsPayload(): SettingsPayload {
  const dockConfig = config.dock();
  const { display } = pickDisplay(dockConfig.device);
  const span = bandThickness(display.workArea, dockConfig.edge);
  const probe = readStatus(undefined, config.status()).health;
  void probe;
  const claudeJson = safeJson(store.paths.claudeJson);
  const mcpProbe = safeJson(store.paths.mcpStatus);
  return {
    dock: dockConfig,
    status: config.status(),
    launch: config.launch(),
    ui: config.ui(),
    mcpServers: installedMcpServers(claudeJson, mcpProbe),
    dockDevices: config.dockDevices(),
    dockFloor: config.dockFloor(dockConfig.edge),
    minPercent: percentFloor(config.dockFloor(dockConfig.edge), span),
  };
}

function safeJson(file: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function displays(): DisplayInfo[] {
  const saved = new Set(config.dockDevices());
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    label: display.label || `Display ${display.id}`,
    bounds: display.bounds,
    primary: display.id === primary.id,
    saved: saved.has(String(display.id)),
  }));
}

function registerIpc(): void {
  ipcMain.handle(CHANNEL.scan, () => scanProjects());
  ipcMain.handle(CHANNEL.status, () => readStatus(undefined, config.status()));
  ipcMain.handle(CHANNEL.metrics, () => ({
    system: history.get(SYSTEM_SERIES),
    sessions: Object.fromEntries(history.keys().filter((k) => k !== SYSTEM_SERIES).map((k) => [k, history.get(k)])),
  }));

  ipcMain.handle(CHANNEL.openSession, (_event, request: OpenSessionRequest): ActionResult => {
    const project = findProject(request.projectDir);
    if (!project?.cwd) return { ok: false, message: "That project's folder is unknown." };
    if (!project.exists) return { ok: false, message: `Folder is gone: ${project.cwd}` };
    const exe = claudeExecutable();
    if (!exe) return { ok: false, message: "claude is not on PATH — install Claude Code first." };
    const session = request.sessionId ? project.sessions.find((s) => s.id === request.sessionId) : null;
    if (session?.live) return { ok: false, message: "That session is already running." };

    const launch: LaunchConfig = config.launch();
    const command = launchCommand({
      cwd: project.cwd,
      claudeExe: exe,
      sessionId: session?.id ?? null,
      displayName: session?.named ? session.title : null,
      config: launch,
      target: request.target,
      platform: process.platform,
      hasWindowsTerminal: process.platform === "win32" && Boolean(which("wt.exe")),
      linuxTerminal: process.platform === "win32" ? null : detectLinuxTerminal(launch.terminal),
    });
    try {
      const child = spawn(command.exe, command.args, {
        cwd: command.cwd,
        detached: true,
        stdio: "ignore",
        // Without a terminal of its own the shell needs a console window to appear in.
        windowsHide: false,
        shell: false,
      });
      child.unref();
      return { ok: true, message: `Opened ${session ? session.title : project.name}` };
    } catch (error) {
      return { ok: false, message: `Could not start: ${(error as Error).message}` };
    }
  });

  ipcMain.handle(CHANNEL.renameSession, (_event, request: RenameRequest): ActionResult => {
    const project = findProject(request.projectDir);
    const session = project?.sessions.find((s) => s.id === request.sessionId);
    if (!session) return { ok: false, message: "Session not found." };
    store.renameSession(session, request.title);
    scanProjects();
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.renameProject, (_event, request: RenameRequest): ActionResult => {
    const project = findProject(request.projectDir);
    if (!project) return { ok: false, message: "Project not found." };
    store.renameProject(project, request.title);
    scanProjects();
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.deleteSession, async (_event, request: DeleteRequest): Promise<ActionResult> => {
    const project = findProject(request.projectDir);
    const session = project?.sessions.find((s) => s.id === request.sessionId);
    if (!session) return { ok: false, message: "Session not found." };
    if (session.live) return { ok: false, message: "That session is running." };
    const confirmed = await confirm(`Delete session “${session.title}”?`, "The transcript is removed from disk.");
    if (!confirmed) return { ok: false };
    store.deleteSession(session);
    scanProjects();
    return { ok: true, message: "Session deleted." };
  });

  ipcMain.handle(CHANNEL.deleteProject, async (_event, request: DeleteRequest): Promise<ActionResult> => {
    const project = findProject(request.projectDir);
    if (!project) return { ok: false, message: "Project not found." };
    if (project.liveCount) return { ok: false, message: "A session in this project is running." };
    const extra = project.hasMemory ? " Its memory/ folder goes with it." : "";
    const confirmed = await confirm(
      `Delete “${project.name}” and its ${project.sessions.length} session(s)?`,
      `Only Claude Code's history is deleted; your code is untouched.${extra}`,
    );
    if (!confirmed) return { ok: false };
    store.deleteProject(project);
    scanProjects();
    return { ok: true, message: "Project deleted." };
  });

  ipcMain.handle(CHANNEL.revealProject, (_event, dir: string): ActionResult => {
    const project = findProject(dir);
    if (!project?.cwd || !project.exists) return { ok: false, message: "Folder is not available." };
    shell.openPath(project.cwd);
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.loadSettings, () => settingsPayload());
  ipcMain.handle(CHANNEL.displays, () => displays());

  ipcMain.handle(CHANNEL.saveSettings, (_event, payload: {
    dock?: DockConfig; status?: StatusConfig; launch?: LaunchConfig; ui?: UiConfig;
  }) => {
    if (payload.dock) config.saveDock(payload.dock);
    if (payload.status) config.saveStatus(payload.status);
    if (payload.launch) config.saveLaunch(payload.launch);
    // The theme lives with the rest of the remembered position, so it comes back with it.
    if (payload.ui) {
      config.saveUi({ ...config.ui(), ...payload.ui });
      if (config.ui().monitor) startSampling();
      else stopSampling();
    }
    return settingsPayload();
  });

  ipcMain.handle(CHANNEL.applyDock, async (_event, wanted: DockConfig) => {
    if (!window || !dock) return { ok: false, message: "No window." };
    const { display } = pickDisplay(wanted.device);
    const span = bandThickness(display.workArea, wanted.edge);
    const floor = config.dockFloor(wanted.edge);
    const percent = Math.max(wanted.percent, percentFloor(floor, span));
    const applied: DockConfig = { ...wanted, percent };
    config.saveDock(applied);
    const placement = await dock.apply(applied);
    // What the window really got is the floor for this axis: remember it so the slider can stop there.
    const got = bandThickness(placement.applied, applied.edge);
    const asked = bandThickness(bandRect(display.workArea, applied.edge, applied.percent), applied.edge);
    if (got > asked + 2) config.saveDockFloor(applied.edge, got);
    return { ok: true, message: placement.note ?? undefined, settings: settingsPayload() };
  });

  ipcMain.handle(CHANNEL.releaseDock, async () => {
    await dock?.release();
    const current = config.dock();
    config.saveDock({ ...current, enabled: false });
    return settingsPayload();
  });

  ipcMain.handle(CHANNEL.saveUi, (_event, ui: Partial<UiConfig>) => config.saveUi({ ...config.ui(), ...ui }));

  ipcMain.handle(CHANNEL.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    claudeFound: Boolean(claudeExecutable()),
    home: claudeHome(),
    dockSupported: process.platform === "win32" || !process.env["WAYLAND_DISPLAY"],
    dockNote: process.env["WAYLAND_DISPLAY"]
      ? "Wayland does not let an application reserve screen space."
      : null,
  }));

  ipcMain.handle(CHANNEL.quit, () => app.quit());
}

async function confirm(message: string, detail: string): Promise<boolean> {
  if (!window) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  return response === 0;
}

app.whenReady().then(async () => {
  registerIpc();
  scanProjects();
  await createWindow();
  startSampling();
  console.log(`[hangar] window ready — ${lastProjects.length} projects from ${claudeHome()}`);
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

process.on("uncaughtException", (error) => {
  console.error("[hangar] fatal:", error);
});

// An app that disappears should say why. These are the three ways it can happen without anyone
// closing a window, and all three are silent by default.
process.on("unhandledRejection", (reason) => console.error("[hangar] unhandled rejection:", reason));
app.on("render-process-gone", (_event, _contents, details) =>
  console.error("[hangar] renderer gone:", details.reason, details.exitCode));
app.on("child-process-gone", (_event, details) =>
  console.error("[hangar] child gone:", details.type, details.reason, details.exitCode));

app.on("window-all-closed", () => {
  console.log("[hangar] window-all-closed -> quitting");
  stopSampling();
  dock?.releaseSync();
  app.quit();
});

// Windows is already handled synchronously on close; X11 needs an `xprop` call, which does need
// waiting for — so hold the quit open exactly once, for that.
let clearingStruts = false;
app.on("before-quit", (event) => {
  dock?.releaseSync();                            // never leave a reserved edge behind
  if (process.platform === "win32" || clearingStruts) return;
  clearingStruts = true;
  event.preventDefault();
  void dock?.release().finally(() => app.quit());
});

export { which, detectLinuxTerminal };
void execFile;
void existsSync;

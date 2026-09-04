/**
 * Projects and sessions — the main side.
 *
 * Owns the list every other feature reads — the last scan — and everything done to a row: opening
 * a session in a terminal, renaming, deleting, pinning, adding a folder. Reading Claude Code's
 * folders and building the launch command live in `core`; this is where they meet Electron.
 *
 * Nothing here reaches into another feature. The head line on each row comes from `main/gitStatus`,
 * a plain module; whoever measures the running set is told it may have changed and looks itself.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { dialog, shell } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { launchCommand, sessionEnvironment } from "../../core/launcher.js";
import type { ProjectInfo } from "../../core/types.js";
import { claudeExecutable, detectLinuxTerminal, haveExecutable, which } from "../../main/executables.js";
import { headOf, isLinkedWorktree, mainCheckoutOf } from "../../main/gitStatus.js";
import type { ActionResult, AddProjectResult } from "../../main/ipc.js";
import type { SessionTarget } from "../../main/sampler.js";
import { projectsContract } from "./contract.js";

/** A scan slower than this is worth a line in the log. */
const SLOW_SCAN_MS = 200;

/** What this feature needs from the rest of main. */
export interface ProjectsDeps {
  /** The list was read again; whoever watches the running set should look at it. */
  scanned(): void;
}

/** What the rest of main may do with this feature once it is registered. */
export interface ProjectsFeature {
  /** Read everything again. The list handed back is the one every later answer is about. */
  scan(): ProjectInfo[];
  find(dir: string): ProjectInfo | undefined;
  /** Sessions worth measuring right now: the running ones, from the last scan. */
  liveTargets(): SessionTarget[];
}

export function register(ctx: MainContext, wire: Wire, deps: ProjectsDeps): ProjectsFeature {
  let projects: ProjectInfo[] = [];

  const find = (dir: string): ProjectInfo | undefined => projects.find((p) => p.dir === dir);

  function scan(): ProjectInfo[] {
    const t0 = Date.now();
    projects = ctx.store.scan();
    // The head line is three small reads per project; the change count is a git process, so it is
    // asked for separately and only for the row in front of the user.
    if (ctx.config.git().enabled) {
      for (const project of projects) {
        if (project.cwd && project.exists) {
          project.git = headOf(project.cwd);
          project.worktree = Boolean(project.git) && isLinkedWorktree(project.cwd);
        }
      }
      // Second pass: a worktree points at a folder, and the list is keyed by project. Match the two so
      // the window can show each worktree under the repository it came from.
      // Compared with separators and case normalised: the pointer file writes forward slashes where
      // a transcript's cwd on Windows has backslashes, and the two would never match as written.
      const key = (path: string): string => {
        let real = path;
        try {
          // 8.3 short names are the one that actually bit: TEMP reads C:\Users\EXAMPL~1 in a
          // transcript's cwd and C:/Users/ExampleUser in git's own pointer file. Only resolving
          // the real path makes those the same folder.
          real = realpathSync.native(path);
        } catch {
          /* gone, or unreachable: fall back to what was written */
        }
        return real.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      };
      const byPath = new Map(projects
        .filter((p) => p.cwd)
        .map((p) => [key(p.cwd as string), p.dir]));
      for (const project of projects) {
        if (!project.worktree || !project.cwd) continue;
        const repo = mainCheckoutOf(project.cwd);
        project.parentDir = repo ? byPath.get(key(repo)) ?? null : null;
      }
    }
    const ms = Date.now() - t0;
    if (ms > SLOW_SCAN_MS) console.log(`[hangar] scan took ${ms} ms for ${projects.length} projects`);
    deps.scanned();                                 // the running set may have changed
    return projects;
  }

  /** The native box, for a caller that did not ask in the window's own dialog. */
  async function confirm(message: string, detail: string): Promise<boolean> {
    const window = ctx.window();
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

  wire.bind(projectsContract, {
    scan: () => scan(),

    openSession: (request): ActionResult => {
      const project = find(request.projectDir);
      if (!project?.cwd) return { ok: false, message: "That project's folder is unknown." };
      if (!project.exists) return { ok: false, message: `Folder is gone: ${project.cwd}` };
      const exe = claudeExecutable();
      if (!exe) return { ok: false, message: "claude is not on PATH — install Claude Code first." };
      const session = request.sessionId ? project.sessions.find((s) => s.id === request.sessionId) : null;
      if (session?.live) return { ok: false, message: "That session is already running." };

      const launch = ctx.config.launch();
      const command = launchCommand({
        cwd: project.cwd,
        claudeExe: exe,
        sessionId: session?.id ?? null,
        // Only a name the user chose. --name is persisted as a *custom* title, so passing the title
        // this app happens to be showing overwrites the one Claude Code generated — permanently, in
        // its own tab and /resume picker too. Left alone, it keeps refining that title as the
        // conversation grows, and this app now reads it rather than competing with it.
        displayName: session?.named ? session.title : null,
        config: launch,
        target: request.target,
        platform: process.platform,
        hasWindowsTerminal: process.platform === "win32" && Boolean(which("wt.exe")),
        linuxTerminal: process.platform === "win32" ? null : detectLinuxTerminal(launch.terminal),
      }, haveExecutable);
      try {
        const child = spawn(command.exe, command.args, {
          cwd: command.cwd,
          // Not process.env as it is: started from inside a Claude Code session, this app carries that
          // session's markers, and a claude that inherits them stops saving its transcript.
          env: sessionEnvironment(process.env),
          detached: true,
          stdio: "ignore",
          // Without a terminal of its own the shell needs a console window to appear in.
          windowsHide: false,
          shell: false,
        });
        child.unref();
        const what = session ? session.title : project.name;
        return {
          ok: true,
          message: command.fellBack
            ? `Opened ${what} in ${command.shell} — the shell chosen in Settings is not installed here.`
            : `Opened ${what}`,
        };
      } catch (error) {
        return { ok: false, message: `Could not start: ${(error as Error).message}` };
      }
    },

    renameSession: (request): ActionResult => {
      const project = find(request.projectDir);
      const session = project?.sessions.find((s) => s.id === request.sessionId);
      if (!session) return { ok: false, message: "Session not found." };
      ctx.store.renameSession(session, request.title);
      scan();
      return { ok: true };
    },

    renameProject: (request): ActionResult => {
      const project = find(request.projectDir);
      if (!project) return { ok: false, message: "Project not found." };
      ctx.store.renameProject(project, request.title);
      scan();
      return { ok: true };
    },

    deleteSession: async (request): Promise<ActionResult> => {
      const project = find(request.projectDir);
      const session = project?.sessions.find((s) => s.id === request.sessionId);
      if (!session) return { ok: false, message: "Session not found." };
      if (session.live) return { ok: false, message: "That session is running." };
      // The window asks in its own dialog, which matches the app; the native box is the fallback for
      // a caller that did not.
      if (!request.confirmed
        && !await confirm(`Delete session “${session.title}”?`, "The transcript is removed from disk.")) {
        return { ok: false };
      }
      ctx.store.deleteSession(session);
      scan();
      return { ok: true, message: "Session deleted." };
    },

    deleteProject: async (request): Promise<ActionResult> => {
      const project = find(request.projectDir);
      if (!project) return { ok: false, message: "Project not found." };
      if (project.liveCount) return { ok: false, message: "A session in this project is running." };
      const extra = project.hasMemory ? " Its memory/ folder goes with it." : "";
      if (!request.confirmed && !await confirm(
        `Delete “${project.name}” and its ${project.sessions.length} session(s)?`,
        `Only Claude Code's history is deleted; your code is untouched.${extra}`,
      )) {
        return { ok: false };
      }
      ctx.store.deleteProject(project);
      scan();
      return { ok: true, message: "Project deleted." };
    },

    revealProject: (dir): ActionResult => {
      const project = find(dir);
      if (!project?.cwd || !project.exists) return { ok: false, message: "Folder is not available." };
      void shell.openPath(project.cwd);
      return { ok: true };
    },

    /**
     * A folder chosen in a dialog becomes a project — one with no sessions yet, from which the
     * first can be started. Until now the only way in was to run claude in a terminal there first.
     */
    addProject: async (): Promise<AddProjectResult> => {
      const window = ctx.window();
      if (!window) return { ok: false };
      // Electron 43 changed the default starting folder from "wherever you were last" to Downloads,
      // which is nowhere near where anyone keeps code. Start beside the project used most recently
      // instead — the list is newest first, so that is the first row with a folder still on disk.
      const recent = projects.find((p) => p.cwd && p.exists)?.cwd;
      const picked = await dialog.showOpenDialog(window, {
        title: "Add a project folder",
        properties: ["openDirectory", "createDirectory"],
        ...(recent ? { defaultPath: dirname(recent) } : {}),
      });
      const folder = picked.filePaths[0];
      if (picked.canceled || !folder) return { ok: false };
      const dir = ctx.store.addProject(folder);
      scan();
      return { ok: true, dir, message: `Added ${folder}` };
    },

    togglePin: (request): ActionResult => {
      const pinned = ctx.config.togglePin(request.kind, request.key);
      scan();
      return { ok: true, message: pinned ? "Pinned to the top." : "Unpinned." };
    },
  });

  return {
    scan,
    find,
    liveTargets: () => projects.flatMap((project) =>
      project.sessions.filter((s) => s.live && s.pid).map((s) => ({ sessionId: s.id, pid: s.pid as number }))),
  };
}

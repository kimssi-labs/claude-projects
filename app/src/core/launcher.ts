/**
 * Building the command that starts a Claude session.
 *
 * Pure on purpose: the main process runs what this returns, and the tests assert the exact argv —
 * the permission flags and the resolved executable are the part that silently went wrong before.
 */
import type { LaunchConfig, OpenTarget, PermissionMode, ShellChoice } from "./types.js";

export const CLAUDE_EXE = "claude";
export const RESUME_FLAG = "--resume";
export const NAME_FLAG = "--name";
export const PERMISSION_FLAG = "--permission-mode";

/** Flags per permission mode, exactly as `claude --help` documents them. */
export const PERMISSION_ARGS: Record<PermissionMode, string[]> = {
  default: [],
  bypass: ["--dangerously-skip-permissions"],
  accept: [PERMISSION_FLAG, "acceptEdits"],
  plan: [PERMISSION_FLAG, "plan"],
  auto: [PERMISSION_FLAG, "auto"],
};

/** Terminals tried on Linux, in order, when the config does not name one. */
export const LINUX_TERMINALS = [
  { exe: "wezterm", args: ["start", "--cwd"] },
  { exe: "kitty", args: ["--directory"] },
  { exe: "alacritty", args: ["--working-directory"] },
  { exe: "konsole", args: ["--workdir"] },
  { exe: "gnome-terminal", args: ["--working-directory"] },
  { exe: "xfce4-terminal", args: ["--working-directory"] },
  { exe: "xterm", args: [] },
] as const;

export interface LaunchRequest {
  cwd: string;
  claudeExe: string;
  sessionId?: string | null;
  /** Title to force on the session; only for a session the user renamed. */
  displayName?: string | null;
  config: LaunchConfig;
  target: OpenTarget;
  platform: NodeJS.Platform;
  /** Windows Terminal is used when present; without it the shell opens in its own window. */
  hasWindowsTerminal: boolean;
  /** Terminal to use on Linux — resolved by the caller from LINUX_TERMINALS. */
  linuxTerminal?: { exe: string; args: readonly string[] } | null;
}

export interface LaunchCommand {
  exe: string;
  args: string[];
  cwd: string;
  /** True when the command opens its own window and does not need a detached console. */
  ownsWindow: boolean;
}

/** `claude` plus the flags this session should start with. */
export function claudeArgv(request: LaunchRequest): string[] {
  const argv = [request.claudeExe, ...PERMISSION_ARGS[request.config.permission]];
  if (request.sessionId) argv.push(RESUME_FLAG, request.sessionId);
  if (request.displayName) argv.push(NAME_FLAG, request.displayName);
  return argv;
}

/** PowerShell quoting: single quotes, doubled inside. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** UTF-16LE base64, so a Korean title or a path with spaces needs no escaping rules at all. */
export function psEncode(argv: string[]): string {
  const command = `& ${argv.map(psQuote).join(" ")}`;
  return Buffer.from(command, "utf16le").toString("base64");
}

/** cmd.exe quoting for one argument. */
export function cmdQuote(value: string): string {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function shellExe(shell: ShellChoice, platform: NodeJS.Platform, pwshAvailable: boolean): string {
  if (shell === "pwsh") return "pwsh.exe";
  if (shell === "powershell") return "powershell.exe";
  if (shell === "cmd") return "cmd.exe";
  if (shell === "bash") return "bash";
  if (platform === "win32") return pwshAvailable ? "pwsh.exe" : "powershell.exe";
  return "bash";
}

/**
 * Wrap the claude invocation in the configured shell, so the window survives claude exiting.
 * `none` runs claude directly and the window closes with it.
 */
export function hostedCommand(
  argv: string[],
  shell: ShellChoice,
  platform: NodeJS.Platform,
  pwshAvailable: boolean,
): { exe: string; args: string[] } {
  if (shell === "none") return { exe: argv[0] as string, args: argv.slice(1) };
  const exe = shellExe(shell, platform, pwshAvailable);
  if (exe === "cmd.exe") return { exe, args: ["/k", argv.map(cmdQuote).join(" ")] };
  if (exe === "bash") return { exe, args: ["-lc", `${argv.map(shQuote).join(" ")}; exec bash`] };
  return { exe, args: ["-NoExit", "-EncodedCommand", psEncode(argv)] };
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const WT_EXE = "wt.exe";
/** Windows Terminal window the sessions gather in; created on first use, reused after. */
export const SESSIONS_WINDOW = "Claude";
export const CURRENT_WINDOW = "0";
export const NEW_WINDOW = "new";

export function windowArgument(target: OpenTarget): string {
  if (target === "currentWindow") return CURRENT_WINDOW;
  if (target === "newWindow") return NEW_WINDOW;
  return SESSIONS_WINDOW;
}

/**
 * The full command to run. On Windows that is `wt` opening a titled tab in the chosen window when
 * Windows Terminal is present; on Linux it is the detected terminal emulator; and where neither
 * exists the hosted shell is started directly.
 */
export function launchCommand(request: LaunchRequest, pwshAvailable = true): LaunchCommand {
  // "Custom program" is a program like VS Code, not another shell to host claude in. It is opened
  // ON the project — started in the project folder, with that folder as its argument — and what
  // runs inside it is its own business: no terminal wraps it, and no claude command is passed.
  // An empty path is a half-finished setting and falls through to Auto, so a session still opens.
  const custom = request.config.shell === "custom" ? request.config.customShell.trim() : "";
  if (custom) {
    return { exe: custom, args: [request.cwd], cwd: request.cwd, ownsWindow: true };
  }
  const argv = claudeArgv(request);
  const hosted = hostedCommand(argv, request.config.shell, request.platform, pwshAvailable);
  const title = request.displayName || "Claude";

  if (request.platform === "win32" && request.hasWindowsTerminal) {
    return {
      exe: WT_EXE,
      args: ["-w", windowArgument(request.target), "nt", "--title", title, "-d", request.cwd, hosted.exe, ...hosted.args],
      cwd: request.cwd,
      ownsWindow: true,
    };
  }
  if (request.platform !== "win32" && request.linuxTerminal) {
    const term = request.linuxTerminal;
    const dirArgs = term.args.length ? [...term.args, request.cwd] : [];
    // Every one of these terminals takes the program to run after `-e`.
    return { exe: term.exe, args: [...dirArgs, "-e", hosted.exe, ...hosted.args], cwd: request.cwd, ownsWindow: true };
  }
  return { exe: hosted.exe, args: hosted.args, cwd: request.cwd, ownsWindow: false };
}

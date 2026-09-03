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
  /**
   * The name to give the session, which Claude Code puts in its prompt box, its /resume picker AND
   * the terminal tab. Passing the name this app shows is what keeps the tab and the row saying the
   * same thing; leaving it null lets Claude Code name the session from the conversation.
   */
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
  /** The shell that will host the session, so a fallback can be reported rather than guessed at. */
  shell: string;
  /** True when the shell asked for was not installed and the next one down was used. */
  fellBack: boolean;
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

/**
 * The shells to try, in order, for a given choice.
 *
 * A choice is a preference rather than a demand: someone who picked PowerShell 7 on one machine and
 * opens the same settings on a machine without it wants a session, not an error. So every choice
 * continues down the same chain, and only the end of the chain is a failure.
 *
 * Windows always ends at cmd.exe, which cannot be absent. Auto starts at the top of the chain.
 */
export function shellChain(shell: ShellChoice, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return shell === "bash" || shell === "auto" ? ["bash", "sh"] : ["bash", "sh"];
  const windows = ["pwsh.exe", "powershell.exe", "cmd.exe"];
  switch (shell) {
    case "pwsh": return windows;
    case "powershell": return windows.slice(1);
    case "cmd": return ["cmd.exe"];
    case "bash": return ["bash", ...windows];      // git bash, then whatever Windows itself has
    default: return windows;                       // auto
  }
}

/**
 * The first shell in the chain that is actually installed, and whether that was the first choice.
 *
 * `have` answers for one executable. The last entry is used regardless when nothing answered yes:
 * on Windows that is cmd.exe, and a launch that fails there has a real problem to report.
 */
export function resolveShell(
  shell: ShellChoice,
  platform: NodeJS.Platform,
  have: (exe: string) => boolean,
): { exe: string; fellBack: boolean } {
  const chain = shellChain(shell, platform);
  const found = chain.find((exe) => have(exe));
  const exe = found ?? chain[chain.length - 1] as string;
  return { exe, fellBack: exe !== chain[0] };
}

/**
 * Wrap the claude invocation in the configured shell, so the window survives claude exiting.
 * `none` runs claude directly and the window closes with it.
 */
export function hostedCommand(
  argv: string[],
  shell: ShellChoice,
  platform: NodeJS.Platform,
  have: (exe: string) => boolean = () => true,
): { exe: string; args: string[]; fellBack: boolean } {
  if (shell === "none") return { exe: argv[0] as string, args: argv.slice(1), fellBack: false };
  const { exe, fellBack } = resolveShell(shell, platform, have);
  if (exe === "cmd.exe") return { exe, args: ["/k", argv.map(cmdQuote).join(" ")], fellBack };
  if (exe === "bash" || exe === "sh") {
    return { exe, args: ["-lc", `${argv.map(shQuote).join(" ")}; exec ${exe}`], fellBack };
  }
  return { exe, args: ["-NoExit", "-EncodedCommand", psEncode(argv)], fellBack };
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
/**
 * What Claude Code stamps on the environment of every process it starts, to tell a child session
 * from a top-level one. Config a user sets in their profile (CLAUDE_CODE_USE_BEDROCK, say) is not
 * in this list and passes through.
 */
export const SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

/**
 * The environment a launched session runs in: ours, minus the marks of a session we were started
 * from.
 *
 * Hangar started from inside a Claude Code session — a `claude --p` typed at its prompt, or a tool
 * call — inherits that session's markers, and a `claude` we then spawn inherits them again and takes
 * itself for a child session: it stops saving its transcript and says so on start. Every session
 * this app opens is a top-level one, whatever started the app.
 */
export function sessionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of SESSION_MARKERS) delete clean[key];
  return clean;
}

export function launchCommand(request: LaunchRequest, have: (exe: string) => boolean = () => true): LaunchCommand {
  // "Custom program" is a program like VS Code, not another shell to host claude in. It is opened
  // ON the project — started in the project folder, with that folder as its argument — and what
  // runs inside it is its own business: no terminal wraps it, and no claude command is passed.
  // An empty path is a half-finished setting and falls through to Auto, so a session still opens.
  const custom = request.config.shell === "custom" ? request.config.customShell.trim() : "";
  if (custom) {
    return { exe: custom, args: [request.cwd], cwd: request.cwd, ownsWindow: true, shell: custom, fellBack: false };
  }
  const argv = claudeArgv(request);
  const hosted = hostedCommand(argv, request.config.shell, request.platform, have);
  const title = request.displayName || "Claude";

  if (request.platform === "win32" && request.hasWindowsTerminal) {
    return {
      exe: WT_EXE,
      args: ["-w", windowArgument(request.target), "nt", "--title", title, "-d", request.cwd, hosted.exe, ...hosted.args],
      cwd: request.cwd,
      ownsWindow: true,
      shell: hosted.exe,
      fellBack: hosted.fellBack,
    };
  }
  if (request.platform !== "win32" && request.linuxTerminal) {
    const term = request.linuxTerminal;
    const dirArgs = term.args.length ? [...term.args, request.cwd] : [];
    // Every one of these terminals takes the program to run after `-e`.
    return {
      exe: term.exe,
      args: [...dirArgs, "-e", hosted.exe, ...hosted.args],
      cwd: request.cwd,
      ownsWindow: true,
      shell: hosted.exe,
      fellBack: hosted.fellBack,
    };
  }
  return {
    exe: hosted.exe,
    args: hosted.args,
    cwd: request.cwd,
    ownsWindow: false,
    shell: hosted.exe,
    fellBack: hosted.fellBack,
  };
}

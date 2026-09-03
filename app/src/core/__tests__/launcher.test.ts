import { describe, expect, it } from "vitest";

import {
  claudeArgv, cmdQuote, hostedCommand, launchCommand, psEncode, psQuote, resolveShell,
  sessionEnvironment, shellChain, shQuote,
  CURRENT_WINDOW, NEW_WINDOW, SESSIONS_WINDOW, WT_EXE,
} from "../launcher.js";
import type { LaunchRequest } from "../launcher.js";
import type { LaunchConfig as Config } from "../types.js";

const CLAUDE = "C:\\Users\\me\\.local\\bin\\claude.EXE";
const SESSION = "abc123";

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  const config: Config = {
    shell: "auto", permission: "default", terminal: "", customShell: "", pasteHotkey: "", autoClipPath: true,
  };
  return {
    cwd: "C:\\proj",
    claudeExe: CLAUDE,
    sessionId: SESSION,
    displayName: null,
    config,
    target: "sessionsWindow",
    platform: "win32",
    hasWindowsTerminal: true,
    ...overrides,
  } as LaunchRequest;
}

function withConfig(overrides: Partial<Config>): Config {
  return { shell: "auto", permission: "default", terminal: "", customShell: "", pasteHotkey: "", autoClipPath: true, ...overrides };
}

describe("claude argv", () => {
  it("names the executable and appends the flags", () => {
    expect(claudeArgv(request())).toEqual([CLAUDE, "--resume", SESSION]);
  });

  it("adds the permission mode the settings chose", () => {
    expect(claudeArgv(request({ config: withConfig({ permission: "bypass" }) })))
      .toEqual([CLAUDE, "--dangerously-skip-permissions", "--resume", SESSION]);
    expect(claudeArgv(request({ config: withConfig({ permission: "plan" }) })))
      .toEqual([CLAUDE, "--permission-mode", "plan", "--resume", SESSION]);
  });

  it("forces the display name only when the session has one", () => {
    expect(claudeArgv(request({ displayName: "새 제목" })))
      .toEqual([CLAUDE, "--resume", SESSION, "--name", "새 제목"]);
    expect(claudeArgv(request({ sessionId: null }))).toEqual([CLAUDE]);
  });
});

describe("quoting", () => {
  it("doubles a single quote for PowerShell", () => {
    expect(psQuote("it's")).toBe("'it''s'");
  });

  it("round-trips through the encoded command", () => {
    const decoded = Buffer.from(psEncode([CLAUDE, "--name", "새 제목"]), "base64").toString("utf16le");
    expect(decoded).toBe(`& '${CLAUDE}' '--name' '새 제목'`);
  });

  it("quotes for cmd only what needs it", () => {
    expect(cmdQuote("plain")).toBe("plain");
    expect(cmdQuote("with space")).toBe('"with space"');
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
});

/** A machine that has some shells and not others. */
const only = (...installed: string[]) => (exe: string): boolean => installed.includes(exe);
const ALL = () => true;

describe("hosted command", () => {
  it("keeps the window open with PowerShell", () => {
    const hosted = hostedCommand([CLAUDE], "pwsh", "win32", ALL);
    expect(hosted.exe).toBe("pwsh.exe");
    expect(hosted.args.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"]);
  });

  it("uses cmd and bash in their own syntax", () => {
    expect(hostedCommand([CLAUDE], "cmd", "win32", ALL).args[0]).toBe("/k");
    const bash = hostedCommand(["claude"], "bash", "linux", ALL);
    expect(bash.exe).toBe("bash");
    expect(bash.args[1]).toContain("exec bash");
  });

  it("runs claude directly when no shell is wanted", () => {
    expect(hostedCommand([CLAUDE, "--resume", SESSION], "none", "win32", ALL))
      .toEqual({ exe: CLAUDE, args: ["--resume", SESSION], fellBack: false });
  });
});

/**
 * The chain that keeps a session opening on a machine that is not the one the settings were made on.
 *
 * The bug this replaces: availability was never passed in, so Auto always chose PowerShell 7 and a
 * machine without it got a launch that simply failed.
 */
describe("choosing a shell that is actually installed", () => {
  it("prefers PowerShell 7, then Windows PowerShell, then cmd", () => {
    expect(resolveShell("auto", "win32", only("pwsh.exe", "powershell.exe", "cmd.exe")).exe).toBe("pwsh.exe");
    expect(resolveShell("auto", "win32", only("powershell.exe", "cmd.exe")).exe).toBe("powershell.exe");
    expect(resolveShell("auto", "win32", only("cmd.exe")).exe).toBe("cmd.exe");
  });

  it("treats an explicit choice as a preference, not a demand", () => {
    // Settings made on a machine with PowerShell 7, opened on one without it.
    const resolved = resolveShell("pwsh", "win32", only("powershell.exe", "cmd.exe"));
    expect(resolved).toEqual({ exe: "powershell.exe", fellBack: true });
  });

  it("says when it used the first choice, so nothing is reported that did not happen", () => {
    expect(resolveShell("pwsh", "win32", ALL).fellBack).toBe(false);
    expect(resolveShell("cmd", "win32", ALL).fellBack).toBe(false);
  });

  it("never falls below what the user asked for when they asked for the bottom", () => {
    expect(shellChain("cmd", "win32")).toEqual(["cmd.exe"]);
    expect(shellChain("powershell", "win32")).toEqual(["powershell.exe", "cmd.exe"]);
  });

  it("ends at cmd even when nothing answers, since a launch has to try something", () => {
    expect(resolveShell("auto", "win32", () => false)).toEqual({ exe: "cmd.exe", fellBack: true });
  });

  it("falls from bash to sh elsewhere", () => {
    expect(resolveShell("auto", "linux", only("sh"))).toEqual({ exe: "sh", fellBack: true });
    const shell = hostedCommand(["claude"], "auto", "linux", only("sh"));
    expect(shell.args[1]).toContain("exec sh");
  });

  it("carries the shell it settled on out to the caller", () => {
    const command = launchCommand(request({}), only("powershell.exe", "cmd.exe"));
    expect(command.shell).toBe("powershell.exe");
    expect(command.fellBack).toBe(true);
  });
});

describe("launch command", () => {
  it("opens a titled tab in the sessions window on Windows", () => {
    const command = launchCommand(request({ displayName: "데모" }));
    expect(command.exe).toBe(WT_EXE);
    expect(command.args.slice(0, 6)).toEqual(["-w", SESSIONS_WINDOW, "nt", "--title", "데모", "-d"]);
    expect(command.ownsWindow).toBe(true);
  });

  it("targets the current or a new window", () => {
    expect(launchCommand(request({ target: "currentWindow" })).args[1]).toBe(CURRENT_WINDOW);
    expect(launchCommand(request({ target: "newWindow" })).args[1]).toBe(NEW_WINDOW);
  });

  it("starts the shell itself when Windows Terminal is absent", () => {
    const command = launchCommand(request({ hasWindowsTerminal: false }));
    expect(command.exe).toBe("pwsh.exe");
    expect(command.ownsWindow).toBe(false);
  });

  it("uses the detected terminal emulator on Linux", () => {
    const command = launchCommand(request({
      platform: "linux",
      hasWindowsTerminal: false,
      claudeExe: "/usr/bin/claude",
      cwd: "/home/me/src",
      config: withConfig({ shell: "bash" }),
      linuxTerminal: { exe: "gnome-terminal", args: ["--working-directory"] },
    }));
    expect(command.exe).toBe("gnome-terminal");
    expect(command.args.slice(0, 3)).toEqual(["--working-directory", "/home/me/src", "-e"]);
    expect(command.args).toContain("bash");
  });
});

describe("a custom program", () => {
  it("is opened on the project folder, with no terminal and no claude command", () => {
    // "Custom program" means a program like VS Code: what runs inside it is its own business, so
    // it is handed the project — not the claude invocation, which it would read as files to open.
    const custom = "C:\\tools\\Code.exe";
    const command = launchCommand(request({ config: withConfig({ shell: "custom", customShell: custom }) }));
    expect(command.exe).toBe(custom);
    expect(command.args).toEqual(["C:\\proj"]);
    expect(command.cwd).toBe("C:\\proj");
    expect(command.ownsWindow).toBe(true);
  });

  it("falls back to the platform default when no path was given", () => {
    // "custom" with an empty path is a half-finished setting, not a reason to fail to open.
    const command = launchCommand(request({ config: withConfig({ shell: "custom", customShell: "   " }) }));
    expect(command.exe).toBe(WT_EXE);
    expect(command.args.join(" ")).toContain("pwsh.exe");
  });
});

describe("sessionEnvironment", () => {
  it("drops the marks of the Claude Code session the app was started from, and nothing else", () => {
    // Hangar opened from a `claude` prompt: a session it then launches told the user
    // "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".
    const inherited = {
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "6bf15f8f",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PID: "11980",
      CLAUDE_EFFORT: "high",
      CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\x",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_EXECPATH: "C:\\claude.exe",
      // A user's own settings, and the app's own home override, are not marks of a session.
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_HOME: "D:\\home\\.claude",
      PATH: "C:\\bin",
    };
    expect(sessionEnvironment(inherited)).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_HOME: "D:\\home\\.claude",
      PATH: "C:\\bin",
    });
    expect(inherited.CLAUDECODE).toBe("1");                   // the caller's copy is untouched
  });
});

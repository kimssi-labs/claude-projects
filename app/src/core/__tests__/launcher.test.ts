import { describe, expect, it } from "vitest";

import {
  claudeArgv, cmdQuote, hostedCommand, launchCommand, psEncode, psQuote, shQuote,
  CURRENT_WINDOW, NEW_WINDOW, SESSIONS_WINDOW, WT_EXE,
} from "../launcher.js";
import type { LaunchRequest } from "../launcher.js";
import type { LaunchConfig as Config } from "../types.js";

const CLAUDE = "C:\\Users\\me\\.local\\bin\\claude.EXE";
const SESSION = "abc123";

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  const config: Config = { shell: "auto", permission: "default", terminal: "" };
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
  return { shell: "auto", permission: "default", terminal: "", ...overrides };
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

describe("hosted command", () => {
  it("keeps the window open with PowerShell", () => {
    const hosted = hostedCommand([CLAUDE], "pwsh", "win32", true);
    expect(hosted.exe).toBe("pwsh.exe");
    expect(hosted.args.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"]);
  });

  it("falls back to Windows PowerShell when 7 is missing", () => {
    expect(hostedCommand([CLAUDE], "auto", "win32", false).exe).toBe("powershell.exe");
  });

  it("uses cmd and bash in their own syntax", () => {
    expect(hostedCommand([CLAUDE], "cmd", "win32", true).args[0]).toBe("/k");
    const bash = hostedCommand(["claude"], "bash", "linux", false);
    expect(bash.exe).toBe("bash");
    expect(bash.args[1]).toContain("exec bash");
  });

  it("runs claude directly when no shell is wanted", () => {
    expect(hostedCommand([CLAUDE, "--resume", SESSION], "none", "win32", true))
      .toEqual({ exe: CLAUDE, args: ["--resume", SESSION] });
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

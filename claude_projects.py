"""Claude Projects — a keyboard manager for the projects and sessions Claude Code keeps
under ~/.claude: list every project, drill into its sessions, resume / rename / delete them.
Standalone: no dependency on a running Claude session, standard library only.

Data sources (all under ~/.claude):
  projects/<enc>/*.jsonl            one transcript per session; first lines carry "cwd"
  projects/<enc>/<sid>/custom-title.json   /rename result  {"customTitle": "..."}
  sessions/*.json                   live-session registry (pid, sessionId, cwd)
  history.jsonl                     prompt history -> first prompt per session (title fallback)
  .claude.json  projects{}          real paths for <enc> dirs that have no transcript left
  config/project-aliases.json       display aliases for projects (this tool's own file)
  config/manager-dock.json          AppBar dock: monitor / edge / thickness (this tool's own file)
  cache/rate-limits.json            5h / 7d usage published by the statusline script
  cache/mcp-status.json, cache/outlook-status.json, .ponytail-active   status-line verdicts

Windows only (console input records + AppBar docking).  `--self-test` exercises the data layer
in a throwaway home; run it after any change.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

# ----------------------------------------------------------------------------- constants
CLAUDE_HOME = Path(os.environ.get("CLAUDE_HOME", Path.home() / ".claude"))
PROJECTS_DIRNAME = "projects"
LIVE_SESSIONS_DIRNAME = "sessions"
HISTORY_FILENAME = "history.jsonl"
CLAUDE_JSON_FILENAME = ".claude.json"          # sibling of ~/.claude, i.e. ~/.claude.json
ALIASES_FILE = Path("config") / "project-aliases.json"
CUSTOM_TITLE_FILENAME = "custom-title.json"
MEMORY_DIRNAME = "memory"
TRANSCRIPT_EXT = ".jsonl"
TRANSCRIPT_HEAD_LINES = 20                     # lines to scan for the "cwd" field
CUSTOM_TITLE_TYPE = "custom-title"

WT_EXE = "wt.exe"
CLAUDE_EXE = "claude"
SESSIONS_WINDOW = "Claude"                     # wt window NAME: created on first use, reused (new tab) afterwards
CURRENT_WINDOW = "0"                           # wt: the window this process is running in
NEW_WINDOW = "new"                             # wt: always a brand-new window
WT_WINDOW_FLAG, WT_NEW_TAB = "-w", "nt"
CREATE_NEW_CONSOLE = 0x00000010                # no Windows Terminal: open a plain console window
WT_TITLE_FLAG, WT_DIR_FLAG = "--title", "-d"
CLAUDE_RESUME_FLAG, CLAUDE_NAME_FLAG = "--resume", "--name"
def powershell_exe(which=shutil.which) -> str:
    """Shell that hosts session tabs: PowerShell 7 when installed, else the built-in 5.1 that
    every Windows has. Returned by NAME, never as a full path — the MSIX pwsh lives under a
    versioned `WindowsApps` package folder that changes on every PowerShell update.
    `which` is injectable so `--self-test` can exercise BOTH branches on one machine."""
    return "pwsh.exe" if which("pwsh") else "powershell.exe"


PS_EXE = powershell_exe()
PS_ARGS = ["-NoExit", "-EncodedCommand"]       # shell stays after claude exits; UTF-16LE b64 dodges quoting
CMD_EXE, CMD_ARGS = "cmd.exe", ["/k"]          # /k = keep the prompt after claude exits
# Shell that hosts an opened session. AUTO keeps powershell_exe()'s "7 if installed, else 5.1".
SHELL_AUTO, SHELL_PWSH, SHELL_WINPS, SHELL_CMD, SHELL_NONE = "auto", "pwsh", "powershell", "cmd", "none"
SHELL_CHOICES = (
    (SHELL_AUTO, "Auto", "PowerShell 7 when installed, else Windows PowerShell"),
    (SHELL_PWSH, "PowerShell 7", "pwsh.exe"),
    (SHELL_WINPS, "Windows PowerShell", "powershell.exe — always present"),
    (SHELL_CMD, "Command Prompt", "cmd.exe /k"),
    (SHELL_NONE, "No shell", "claude directly — the tab closes when it exits"),
)
SHELL_EXE = {SHELL_PWSH: "pwsh.exe", SHELL_WINPS: "powershell.exe", SHELL_CMD: CMD_EXE}
LAUNCH_FILE = Path("config") / "manager-launch.json"     # how sessions are opened
APP_TITLE = "Claude Projects"                  # console/tab title while the manager runs
CONSOLE_TITLE_MAX = 1024

STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
STD_OUTPUT_HANDLE = -11
STD_INPUT_HANDLE = -10
KEY_EVENT = 0x0001
IDLE_REFRESH_MS = 15000                        # redraw while idle: rate-limit windows roll, sessions start/stop
WAIT_TIMEOUT = 0x00000102                      # WaitForSingleObject: nothing to read yet
SHIFT_PRESSED = 0x0010                         # dwControlKeyState bit: Shift+Tab vs Tab

LIVE_MARK = "●"
ELLIPSIS = "…"
DETAIL_MIN_LINES = 8                           # detail pane keeps at least this many rows (excl. separators)
INSTALL_DIRNAME = "ClaudeProjects"             # under %LOCALAPPDATA%\Programs
SHORTCUT_NAME = "Claude Projects.lnk"          # under the user's Start-menu Programs folder
ICON_NAME = "icon.ico"
LIST_BOX_CHROME = 3                            # top border + column header + bottom border
DETAIL_BOX_CHROME = 2                          # top + bottom border
BOX_SIDE_COLS = 4                              # '│ ' + text + ' │'
DETAIL_LABEL_W = 11                            # label column of the detail viewer (incl. leading space)
# Status line (moved off the Claude statusline 2026-08-27): same sources, same glyphs.
RATE_LIMITS_CACHE = Path("cache") / "rate-limits.json"
MCP_CACHE = Path("cache") / "mcp-status.json"
OUTLOOK_CACHE = Path("cache") / "outlook-status.json"
PONYTAIL_FLAG = ".ponytail-active"
PONYTAIL_PLUGIN_GLOB = "plugins/cache/*/ponytail"   # absent = plugin not installed -> segment hidden
RATE_BAR_CELLS = 10                            # 5h bar: 100 / cells = % per cell
RATE_BAR_ON, RATE_BAR_OFF = "█", "░"
RATE_WARN_PCT, RATE_HIGH_PCT = 50, 80
OK_MARK, BAD_MARK = "✔", "✘"
MARK_PAD = " "                                 # ✔/✘ render narrower than the emoji icons: pad to line up
# Names shown beside each status icon (the statusline had to omit these to fit 80 columns).
RATE_LABELS = {"five_hour": "5h", "seven_day": "7d"}
MCP_LABEL, OUTLOOK_LABEL, PONYTAIL_LABEL = "MCP", "Outlook", "ponytail"
UNKNOWN_MARK = "?"                             # selected server that the probe cache says nothing about
CHECKED, UNCHECKED = "[x]", "[ ]"
BOX_TL, BOX_TR, BOX_BL, BOX_BR, BOX_H, BOX_V = "┌", "┐", "└", "┘", "─", "│"
RULE_CHAR = "─"
# Opening a session is `wt` + a shell + claude starting up: Popen returns long before any of that
# is on screen, so the footer spins until the window really exists.
SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
SPINNER_POLL_S = 0.1
OPEN_TIMEOUT_S = 12.0

# Dock (AppBar): the manager can reserve a screen edge for itself, exactly the way the taskbar
# does, so every other window's maximize/Snap stops at its border.
DOCK_FILE = Path("config") / "manager-dock.json"
DOCK_STATE_FILE = Path("config") / "manager-dock-state.json"   # runtime only: the HWND we docked
STATUS_FILE = Path("config") / "manager-status.json"           # which MCP servers the status line reports
DOCK_EDGES = ("left", "top", "right", "bottom")   # index == the ABE_* value Windows expects
DOCK_DEFAULT_EDGE = "top"
DOCK_PCT_MIN, DOCK_PCT_MAX, DOCK_PCT_DEFAULT = 5, 60, 20
DOCK_FIELDS = ("Edge", "Size", "Dock")         # rows of the form, selected with ↑↓
DOCK_FIELD_KEYS = ("edge", "percent", "enabled")          # the cfg key each row edits
DOCK_FIELD_EDGE, DOCK_FIELD_SIZE, DOCK_FIELD_DOCK = 0, 1, 2
# Settings screen stages. Enter descends, Esc backs out; ↑↓ never means two things at once.
# Tab order of the settings group boxes; the dock box is always entered at its monitor list.
STAGE_MONITOR, STAGE_FORM, STAGE_EDIT, STAGE_MCP, STAGE_SHELL = ("monitor", "form", "edit",
                                                                "mcp", "shell")
SETTINGS_SECTIONS = (STAGE_MONITOR, STAGE_MCP, STAGE_SHELL)
ABM_NEW, ABM_REMOVE, ABM_QUERYPOS, ABM_SETPOS = 0, 1, 2, 3
SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE = 0x0001, 0x0002, 0x0010
HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
MONITORINFOF_PRIMARY = 0x01
DWMWA_EXTENDED_FRAME_BOUNDS = 9                # what DWM actually paints, minus the invisible border
SW_MAXIMIZE, SW_RESTORE = 3, 9
DOCK_KEEP_INTERVAL_S = 0.12                    # how fast maximize/restore is answered
CCHDEVICENAME = 32
DPI_PER_MONITOR_AWARE_V2 = -4
TITLE_SETTLE_S = 0.6           # Windows Terminal copies the console title to its window async


# ----------------------------------------------------------------------------- model
@dataclass
class Session:
    sid: str
    path: Path
    mtime: float
    size: int
    title: str
    live: bool
    custom: bool = False          # title came from custom-title.json (user-chosen)
    prompt: str = ""              # first prompt from history.jsonl (shown in the detail pane)
    created: float = 0.0          # transcript creation time — when the session was started

    @property
    def side_dir(self) -> Path:
        return self.path.parent / self.sid


@dataclass
class Project:
    enc_dir: Path
    cwd: str | None
    alias: str | None = None
    sessions: list[Session] = field(default_factory=list)
    has_memory: bool = False

    @property
    def name(self) -> str:
        if self.cwd:
            return Path(self.cwd).name or self.cwd
        return self.enc_dir.name

    @property
    def display(self) -> str:
        return self.alias or self.name

    @property
    def last_used(self) -> float:
        return max((s.mtime for s in self.sessions), default=self.enc_dir.stat().st_mtime)

    @property
    def live(self) -> bool:
        return any(s.live for s in self.sessions)

    @property
    def live_count(self) -> int:
        return sum(s.live for s in self.sessions)

    @property
    def total_size(self) -> int:
        return sum(s.size for s in self.sessions)

    @property
    def exists(self) -> bool:
        return bool(self.cwd) and Path(self.cwd).is_dir()


# ----------------------------------------------------------------------------- store
class Store:
    """All reads/writes against one Claude home. No UI here."""

    def __init__(self, home: Path = CLAUDE_HOME, claude_args: tuple[str, ...] = ()):
        self.home = home
        self.claude_args = tuple(claude_args)   # forwarded to every claude launched from here (e.g. --dangerously-skip-permissions)
        self.projects_dir = home / PROJECTS_DIRNAME
        self.live_dir = home / LIVE_SESSIONS_DIRNAME
        self.history_file = home / HISTORY_FILENAME
        self.claude_json = home.parent / CLAUDE_JSON_FILENAME
        self.aliases_file = home / ALIASES_FILE
        self.dock_file = home / DOCK_FILE
        self.dock_state_file = home / DOCK_STATE_FILE
        self.status_file = home / STATUS_FILE
        self.launch_file = home / LAUNCH_FILE

    # -- helpers ---------------------------------------------------------------
    @staticmethod
    def encode_path(p: str) -> str:
        """Claude Code's project-dir encoding: every non-alphanumeric char -> '-'."""
        return re.sub(r"[^A-Za-z0-9]", "-", p)

    @staticmethod
    def _iter_json_lines(path: Path, limit: int | None = None):
        try:
            with path.open(encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f):
                    if limit is not None and i >= limit:
                        return
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            return

    @staticmethod
    def _load_json(path: Path, default):
        # utf-8-sig, not utf-8: anything written by Windows PowerShell 5.1's `Set-Content -Encoding
        # utf8` carries a BOM, which json.loads rejects — the config would then silently fall back
        # to defaults instead of failing, i.e. settings quietly disappear.
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return default

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == STILL_ACTIVE
        finally:
            k32.CloseHandle(h)

    # -- lookups ---------------------------------------------------------------
    def live_session_ids(self) -> set[str]:
        ids = set()
        for f in self.live_dir.glob("*.json"):
            d = self._load_json(f, {})
            if d.get("sessionId") and self._pid_alive(int(d.get("pid", 0))):
                ids.add(d["sessionId"])
        return ids

    def history_titles(self) -> dict[str, str]:
        titles: dict[str, str] = {}
        for d in self._iter_json_lines(self.history_file):
            sid = d.get("sessionId")
            if sid and sid not in titles and d.get("display"):
                titles[sid] = d["display"].strip().splitlines()[0]
        return titles

    def known_paths_by_enc(self) -> dict[str, str]:
        d = self._load_json(self.claude_json, {})
        out: dict[str, str] = {}
        for p in d.get("projects", {}):
            out.setdefault(self.encode_path(p), p)
        return out

    def status_items(self) -> list[tuple[str, str, str]]:
        """(icon, label, text) segments for the manager's status line, from the same global
        caches the Claude statusline used to print: rate limits, MCP, Outlook, ponytail mode."""
        items: list[tuple[str, str, str]] = []
        rates = self._load_json(self.home / RATE_LIMITS_CACHE, {})
        for icon, key, fmt, cells in (("⏳", "five_hour", "%H:%M", RATE_BAR_CELLS),
                                      ("📅", "seven_day", "%m/%d %H:%M", 0)):
            label = RATE_LABELS[key]
            window = rates.get(key) or {}
            if window.get("used_percentage") is None:
                continue
            pct, at = round(window["used_percentage"]), window.get("resets_at")
            if at and at <= time.time():                       # window already rolled over
                pct, at = 0, None
            pct = max(0, min(100, pct))
            style = Ansi.RED if pct >= RATE_HIGH_PCT else Ansi.YELLOW if pct >= RATE_WARN_PCT else Ansi.GREEN
            bar = ""
            if cells:
                on = pct * cells // 100
                bar = style + RATE_BAR_ON * on + Ansi.DIM + RATE_BAR_OFF * (cells - on) + Ansi.FG_DEFAULT + " "
            text = f"{bar}{style}{pct}%{Ansi.FG_DEFAULT}"
            if at:
                text += Ansi.DIM + " ↻ " + time.strftime(fmt, time.localtime(at)) + Ansi.FG_DEFAULT
            items.append((icon, label, text))
        probed = (self._load_json(self.home / MCP_CACHE, {}) or {}).get("servers") or {}
        chosen = self.load_status_cfg()["mcp"]
        shown = {n: probed.get(n) for n in chosen} if chosen is not None else dict(probed)
        if shown:                                   # empty selection (or nothing installed) hides it
            if any(v is not None and not v.get("ok") for v in shown.values()):
                mark = Ansi.RED + BAD_MARK         # a known failure outranks a missing verdict
            elif any(v is None for v in shown.values()):
                mark = Ansi.DIM + UNKNOWN_MARK     # selected, but the probe cache says nothing
            else:
                mark = Ansi.GREEN + OK_MARK
            label = ", ".join(shown) if chosen is not None else MCP_LABEL
            items.append(("🤖", label, mark + Ansi.FG_DEFAULT + MARK_PAD))
        for icon, label, cache in (("📧", OUTLOOK_LABEL, OUTLOOK_CACHE),):
            servers = (self._load_json(self.home / cache, {}) or {}).get("servers") or {}
            if not servers:
                continue
            ok = all(v.get("ok") for v in servers.values())
            items.append((icon, label, (Ansi.GREEN + OK_MARK if ok else Ansi.RED + BAD_MARK) + Ansi.FG_DEFAULT + MARK_PAD))
        try:
            mode = (self.home / PONYTAIL_FLAG).read_text(encoding="utf-8").strip().splitlines()[0]
        except (OSError, IndexError):
            mode = ""
        if mode or any(self.home.glob(PONYTAIL_PLUGIN_GLOB)):        # hidden when not installed
            items.append(("🧔", PONYTAIL_LABEL,
                          (Ansi.GREEN + mode if mode else Ansi.DIM + "off") + Ansi.FG_DEFAULT))
        return items

    def load_launch_cfg(self) -> dict:
        cfg = self._load_json(self.launch_file, {})
        shell = cfg.get("shell")
        return {"shell": shell if shell in SHELL_EXE or shell in (SHELL_AUTO, SHELL_NONE) else SHELL_AUTO}

    def save_launch_cfg(self, cfg: dict) -> None:
        self.launch_file.parent.mkdir(parents=True, exist_ok=True)
        self.launch_file.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def shell_cmd(claude: list[str], shell: str = SHELL_AUTO) -> list[str]:
        """Wrap the claude invocation in the chosen shell so the tab survives claude exiting.
        PowerShell takes the command as UTF-16LE base64 (no quoting rules to get wrong); cmd
        takes a quoted command line; SHELL_NONE runs claude with no shell at all."""
        if shell == SHELL_NONE:
            return list(claude)
        if shell == SHELL_CMD:
            return [CMD_EXE, *CMD_ARGS, subprocess.list2cmdline(claude)]
        exe = SHELL_EXE.get(shell) or PS_EXE            # SHELL_AUTO -> whatever is installed
        return [exe, *PS_ARGS, ps_encode(claude)]

    def installed_mcp_servers(self) -> list[str]:
        """Every MCP server this machine knows about: configured in ~/.claude.json, or seen by
        whatever publishes the probe cache."""
        names = set((self._load_json(self.claude_json, {}).get("mcpServers") or {}))
        names |= set(((self._load_json(self.home / MCP_CACHE, {}) or {}).get("servers") or {}))
        return sorted(names)

    def load_status_cfg(self) -> dict:
        """`mcp`: list of server names to report, or None for "every server in the cache" —
        the default on a machine that has never opened the settings screen."""
        cfg = self._load_json(self.home / STATUS_FILE, {})
        chosen = cfg.get("mcp")
        return {"mcp": [str(n) for n in chosen] if isinstance(chosen, list) else None}

    def save_status_cfg(self, cfg: dict) -> None:
        self.status_file.parent.mkdir(parents=True, exist_ok=True)
        self.status_file.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_aliases(self) -> dict[str, str]:
        return self._load_json(self.aliases_file, {})

    def save_aliases(self, aliases: dict[str, str]) -> None:
        self.aliases_file.parent.mkdir(parents=True, exist_ok=True)
        self.aliases_file.write_text(json.dumps(aliases, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_dock(self) -> dict:
        """Dock config, normalized — a hand-edited or stale file must not be able to crash startup."""
        cfg = self._load_json(self.dock_file, {})
        cfg = cfg if isinstance(cfg, dict) else {}
        try:
            pct = int(cfg.get("percent", DOCK_PCT_DEFAULT))
        except (TypeError, ValueError):
            pct = DOCK_PCT_DEFAULT
        return {"enabled": bool(cfg.get("enabled", False)),
                "device": cfg.get("device") or None,
                "edge": cfg.get("edge") if cfg.get("edge") in DOCK_EDGES else DOCK_DEFAULT_EDGE,
                "percent": max(DOCK_PCT_MIN, min(DOCK_PCT_MAX, pct))}

    def save_dock(self, cfg: dict) -> None:
        self.dock_file.parent.mkdir(parents=True, exist_ok=True)
        self.dock_file.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_docked_hwnd(self) -> int | None:
        """The window a previous run reserved space for. Kept OUT of manager-dock.json so live,
        unsaved tuning never writes itself into the user's saved settings."""
        state = self._load_json(self.dock_state_file, {})
        try:
            return int(state["hwnd"]) if isinstance(state, dict) and state.get("hwnd") else None
        except (TypeError, ValueError):
            return None

    def save_docked_hwnd(self, hwnd: int | None) -> None:
        self.dock_state_file.parent.mkdir(parents=True, exist_ok=True)
        self.dock_state_file.write_text(json.dumps({"hwnd": hwnd} if hwnd else {}), encoding="utf-8")

    def transcript_cwd(self, path: Path) -> str | None:
        for d in self._iter_json_lines(path, TRANSCRIPT_HEAD_LINES):
            if d.get("cwd"):
                return d["cwd"]
        return None

    def custom_title(self, enc_dir: Path, sid: str) -> str | None:
        d = self._load_json(enc_dir / sid / CUSTOM_TITLE_FILENAME, {})
        return d.get("customTitle") or None

    # -- scan ------------------------------------------------------------------
    def scan(self) -> list[Project]:
        live, titles, known, aliases = (self.live_session_ids(), self.history_titles(),
                                        self.known_paths_by_enc(), self.load_aliases())
        projects: list[Project] = []
        for enc_dir in sorted(p for p in self.projects_dir.iterdir() if p.is_dir()):
            transcripts = sorted(enc_dir.glob(f"*{TRANSCRIPT_EXT}"), key=lambda p: p.stat().st_mtime, reverse=True)
            cwd = next((c for c in (self.transcript_cwd(t) for t in transcripts) if c), known.get(enc_dir.name))
            if cwd:
                cwd = os.path.normpath(cwd)
            proj = Project(enc_dir, cwd, aliases.get(cwd or enc_dir.name), has_memory=(enc_dir / MEMORY_DIRNAME).is_dir())
            for t in transcripts:
                sid, st = t.stem, t.stat()
                custom = self.custom_title(enc_dir, sid)
                title = custom or titles.get(sid) or "(no prompt)"
                proj.sessions.append(Session(sid, t, st.st_mtime, st.st_size, title, sid in live,
                                             bool(custom), titles.get(sid, ""), st.st_ctime))
            projects.append(proj)
        projects.sort(key=lambda p: p.last_used, reverse=True)
        return projects

    # -- actions ---------------------------------------------------------------
    @staticmethod
    def has_windows_terminal() -> bool:
        return shutil.which(WT_EXE) is not None

    @staticmethod
    def launch_cmd(cwd: str, tab_title: str, sid: str | None = None, name: str | None = None,
                   claude_args: tuple[str, ...] = (), window: str = SESSIONS_WINDOW,
                   shell: str = SHELL_AUTO) -> list[str]:
        """Command that starts claude in `cwd` (resuming `sid`, forcing the display `name`), hosted
        in a PowerShell shell. With Windows Terminal it becomes a titled tab of `window`; without
        it, the shell is started directly and the caller opens a plain console window instead."""
        claude = [CLAUDE_EXE, *claude_args]
        if sid:
            claude += [CLAUDE_RESUME_FLAG, sid]
        if name:
            claude += [CLAUDE_NAME_FLAG, name]
        hosted = Store.shell_cmd(claude, shell)
        if not Store.has_windows_terminal():
            return hosted
        return [WT_EXE, WT_WINDOW_FLAG, window, WT_NEW_TAB, WT_TITLE_FLAG, tab_title, WT_DIR_FLAG, cwd,
                *hosted]

    def open_in_new_tab(self, cwd: str, tab_title: str, sid: str | None = None, name: str | None = None,
                        window: str = SESSIONS_WINDOW) -> None:
        cmd = self.launch_cmd(cwd, tab_title, sid, name, self.claude_args, window,
                              self.load_launch_cfg()["shell"])
        extra = {} if self.has_windows_terminal() else {"cwd": cwd, "creationflags": CREATE_NEW_CONSOLE}
        subprocess.Popen(cmd, close_fds=True, **extra)

    def rename_session(self, s: Session, title: str) -> None:
        s.side_dir.mkdir(exist_ok=True)
        (s.side_dir / CUSTOM_TITLE_FILENAME).write_text(json.dumps({"customTitle": title}, ensure_ascii=False), encoding="utf-8")
        line = json.dumps({"type": CUSTOM_TITLE_TYPE, "customTitle": title, "sessionId": s.sid}, ensure_ascii=False)
        with s.path.open("a+", encoding="utf-8") as f:
            f.seek(0, os.SEEK_END)
            if f.tell() and not self._ends_with_newline(s.path):
                f.write("\n")
            f.write(line + "\n")
        s.title, s.custom = title, True

    @staticmethod
    def _ends_with_newline(path: Path) -> bool:
        with path.open("rb") as f:
            f.seek(-1, os.SEEK_END)
            return f.read(1) == b"\n"

    def rename_project(self, p: Project, alias: str) -> None:
        aliases = self.load_aliases()
        key = p.cwd or p.enc_dir.name
        if alias:
            aliases[key] = alias
        else:
            aliases.pop(key, None)
        self.save_aliases(aliases)
        p.alias = alias or None

    @staticmethod
    def delete_session(p: Project, s: Session) -> None:
        s.path.unlink(missing_ok=True)
        shutil.rmtree(s.side_dir, ignore_errors=True)
        p.sessions.remove(s)

    @staticmethod
    def delete_project(p: Project) -> None:
        shutil.rmtree(p.enc_dir)


# ----------------------------------------------------------------------------- Korean keyboard
# Dubeolsik layout: the jamo the Korean IME emits for each Latin key position (row by row).
JAMO_TO_KEY = dict(zip("ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔㅁㄴㅇㄹㅎㅗㅓㅏㅣㅋㅌㅊㅍㅠㅜㅡ", "qwertyuiopasdfghjklzxcvbnm"))
JAMO_TO_KEY.update(zip("ㅃㅉㄸㄲㅆㅒㅖ", "QWERTOP"))                # shifted positions
CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
JUNGSEONG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
JONGSEONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"     # index 0 = no final consonant
COMPOUND_JAMO = {"ㅘ": "ㅗㅏ", "ㅙ": "ㅗㅐ", "ㅚ": "ㅗㅣ", "ㅝ": "ㅜㅓ", "ㅞ": "ㅜㅔ", "ㅟ": "ㅜㅣ", "ㅢ": "ㅡㅣ",
                 "ㄳ": "ㄱㅅ", "ㄵ": "ㄴㅈ", "ㄶ": "ㄴㅎ", "ㄺ": "ㄹㄱ", "ㄻ": "ㄹㅁ", "ㄼ": "ㄹㅂ", "ㄽ": "ㄹㅅ",
                 "ㄾ": "ㄹㅌ", "ㄿ": "ㄹㅍ", "ㅀ": "ㄹㅎ", "ㅄ": "ㅂㅅ"}
# Set-1 scan codes of the letter keys: the PHYSICAL key, available even while the IME composes.
SCAN_TO_KEY = dict(zip([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
                        0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26,
                        0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x32],
                       "qwertyuiopasdfghjklzxcvbnm"))
HANGUL_SYLLABLE_BASE, HANGUL_SYLLABLE_LAST = 0xAC00, 0xD7A3
JUNG_COUNT, JONG_COUNT = 21, 28


def hangul_to_keys(ch: str) -> list[str]:
    """Latin keys that produced `ch` on a Dubeolsik keyboard: a lone jamo -> one key, a composed
    syllable -> its keystrokes in order (요 -> d, y). Empty list when `ch` is not Hangul."""
    code = ord(ch)
    if HANGUL_SYLLABLE_BASE <= code <= HANGUL_SYLLABLE_LAST:
        code -= HANGUL_SYLLABLE_BASE
        jamo = CHOSEONG[code // (JUNG_COUNT * JONG_COUNT)] + JUNGSEONG[code % (JUNG_COUNT * JONG_COUNT) // JONG_COUNT] \
            + JONGSEONG[code % JONG_COUNT].strip()
    else:
        jamo = ch
    keys = []
    for j in jamo:
        for basic in COMPOUND_JAMO.get(j, j):
            if basic not in JAMO_TO_KEY:
                return []
            keys.append(JAMO_TO_KEY[basic])
    return keys


# ----------------------------------------------------------------------------- text helpers
def next_section(stage: str, step: int) -> str:
    """Neighbouring settings box in Tab order. Any dock stage counts as the dock box, so Tab
    from a field list lands on the next box rather than nowhere."""
    current = stage if stage in SETTINGS_SECTIONS else STAGE_MONITOR
    return SETTINGS_SECTIONS[(SETTINGS_SECTIONS.index(current) + step) % len(SETTINGS_SECTIONS)]


def ps_quote(arg: str) -> str:
    return "'" + arg.replace("'", "''") + "'"


def ps_encode(argv: list[str]) -> str:
    """PowerShell -EncodedCommand payload for `argv`: `& 'exe' 'arg' …` (the call operator is
    required — a quoted token at command position is a string expression, not an invocation)."""
    return base64.b64encode(("& " + " ".join(ps_quote(a) for a in argv)).encode("utf-16-le")).decode("ascii")


def ps_decode(payload: str) -> str:
    return base64.b64decode(payload).decode("utf-16-le")



ANSI_RE = re.compile(chr(27) + r"\[[0-9;]*m")


def strip_ansi(s: str) -> str:
    """Text without its colour codes — what the terminal actually shows, for width maths."""
    return ANSI_RE.sub("", s)


def cell_width(s: str) -> int:
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def fit(s: str, width: int, align_right: bool = False) -> str:
    """Truncate to `width` cells (with an ellipsis) and pad to exactly `width` cells."""
    if cell_width(s) > width:
        out, w = "", 0
        for c in s:
            cw = cell_width(c)
            if w + cw > width - 1:
                break
            out, w = out + c, w + cw
        s = out + ELLIPSIS
    pad = " " * (width - cell_width(s))
    return pad + s if align_right else s + pad


def wrap_cells(s: str, width: int) -> list[str]:
    """Greedy per-character wrap by display cells (Korean text has no reliable spaces)."""
    lines, cur, w = [], "", 0
    for c in s.replace("\r", "").replace("\n", " "):
        cw = cell_width(c)
        if w + cw > width:
            lines.append(cur)
            cur, w = "", 0
        cur, w = cur + c, w + cw
    lines.append(cur)
    return lines


def fmt_time(ts: float) -> str:
    t = time.localtime(ts)
    return time.strftime("%m-%d %H:%M" if t.tm_year == time.localtime().tm_year else "%Y-%m-%d", t)


def fmt_size(n: int) -> str:
    return f"{n / 1024:.0f}K" if n < 1024 * 1024 else f"{n / 1024 / 1024:.1f}M"


# ----------------------------------------------------------------------------- TUI
class Ansi:
    CLEAR = "\x1b[2J\x1b[H"
    HOME = "\x1b[H"
    EOL = "\x1b[K"
    RESET = "\x1b[0m"
    BOLD = "\x1b[1m"
    DIM = "\x1b[2m"
    INV = "\x1b[7m"
    RED = "\x1b[31m"
    GREEN = "\x1b[32m"
    YELLOW = "\x1b[33m"
    CYAN = "\x1b[36m"
    FG_DEFAULT = "\x1b[39m"          # back to default color, keeps INV/BOLD (unlike RESET)
    ALT_ON, ALT_OFF = "\x1b[?1049h", "\x1b[?1049l"
    CUR_HIDE, CUR_SHOW = "\x1b[?25l", "\x1b[?25h"


class KeyEventRecord(ctypes.Structure):
    _fields_ = [("bKeyDown", ctypes.c_int), ("wRepeatCount", ctypes.c_ushort),
                ("wVirtualKeyCode", ctypes.c_ushort), ("wVirtualScanCode", ctypes.c_ushort),
                ("UnicodeChar", ctypes.c_wchar), ("dwControlKeyState", ctypes.c_ulong)]


class InputRecord(ctypes.Structure):
    class _Event(ctypes.Union):
        _fields_ = [("KeyEvent", KeyEventRecord), ("_pad", ctypes.c_char * 16)]
    _fields_ = [("EventType", ctypes.c_ushort), ("Event", _Event)]


class Key:
    UP, DOWN, LEFT, RIGHT = "UP", "DOWN", "LEFT", "RIGHT"
    PGUP, PGDN, HOME, END, DEL, F2, F5 = "PGUP", "PGDN", "HOME", "END", "DEL", "F2", "F5"
    TAB, BACKTAB = "TAB", "BACKTAB"
    ENTER, ESC, BACKSPACE = "\r", "\x1b", "\x08"
    # Virtual-key codes are the PHYSICAL key, so these work whatever the IME language is.
    _VK = {0x08: BACKSPACE, 0x09: TAB, 0x0D: ENTER, 0x1B: ESC, 0x21: PGUP, 0x22: PGDN, 0x23: END, 0x24: HOME,
           0x25: LEFT, 0x26: UP, 0x27: RIGHT, 0x28: DOWN, 0x2E: DEL, 0x71: F2, 0x74: F5}
    _VK_LETTER_FIRST, _VK_LETTER_LAST = 0x41, 0x5A          # 'A'..'Z'
    _VK_PROCESSKEY = 0xE5                                   # "the IME is handling this keystroke"
    _pending: deque = deque()          # queued keys (a Hangul syllable maps to several)
    _acted = 0                         # keystrokes already acted on that the IME has yet to commit

    @classmethod
    def decode(cls, vk: int, ch: str, translate: bool = True, state: int = 0) -> list[str]:
        """Keys produced by one key-down event. Empty list = ignore (modifier, IME processing…).
        `translate` maps Hangul to its Dubeolsik Latin key position (command mode); text prompts
        pass the character through unchanged."""
        if vk in cls._VK:
            key = cls._VK[vk]
            return [cls.BACKTAB if key == cls.TAB and state & SHIFT_PRESSED else key]
        if ch and ch >= " ":
            if translate:
                keys = hangul_to_keys(ch)
                if keys:
                    return keys
            return [ch]
        if translate and cls._VK_LETTER_FIRST <= vk <= cls._VK_LETTER_LAST:
            return [chr(vk).lower()]                        # letter key with no char (IME idle)
        return []

    @classmethod
    def feed(cls, vk: int, ch: str, scan: int = 0, translate: bool = True, state: int = 0) -> list[str]:
        """Keys to act on for one key-down event, in command mode acting DURING IME composition.

        With a Korean IME the keystroke first arrives as VK_PROCESSKEY (no character) and the text
        only lands later, on commit — waiting for it is what made keys need Enter. So the physical
        key is taken from the scan code straight away, and the eventual commit event is cancelled
        against `_acted` so the same keystroke never runs twice."""
        if not translate:
            cls._acted = 0
            return cls.decode(vk, ch, False, state)
        if vk == cls._VK_PROCESSKEY:
            keys = [SCAN_TO_KEY[scan]] if scan in SCAN_TO_KEY else []
            cls._acted += len(keys)
            return keys
        keys = cls.decode(vk, ch, True, state)
        if ch and hangul_to_keys(ch):                       # IME committed what we already handled
            drop = min(cls._acted, len(keys))
            cls._acted -= drop
            return keys[drop:]
        if keys and (not ch or ch < " ") and cls._VK_LETTER_FIRST <= vk <= cls._VK_LETTER_LAST:
            cls._acted += 1                                 # letter key handled before any commit
        elif keys:
            cls._acted = 0                                  # plain ASCII / navigation: nothing pending
        return keys

    @classmethod
    def read(cls, translate: bool = True, timeout_ms: int | None = None) -> str:
        """Next key, or "" when `timeout_ms` passes with nothing pressed — the caller uses that
        to redraw. Console input records are read directly because IME composition hands
        msvcrt.getwch NUL chars and desyncs its two-call extended-key protocol."""
        if cls._pending:
            return cls._pending.popleft()
        k32 = ctypes.windll.kernel32
        handle = k32.GetStdHandle(STD_INPUT_HANDLE)
        record, count = InputRecord(), ctypes.c_ulong()
        while True:
            if timeout_ms is not None and k32.WaitForSingleObject(handle, timeout_ms) == WAIT_TIMEOUT:
                return ""                       # idle tick: let the caller redraw
            if not k32.ReadConsoleInputW(handle, ctypes.byref(record), 1, ctypes.byref(count)) or not count.value:
                return ""
            if record.EventType != KEY_EVENT or not record.Event.KeyEvent.bKeyDown:
                continue
            event = record.Event.KeyEvent
            keys = cls.feed(event.wVirtualKeyCode, event.UnicodeChar, event.wVirtualScanCode,
                            translate, event.dwControlKeyState)
            if keys:
                cls._pending.extend(keys[1:])
                return keys[0]


# ----------------------------------------------------------------------------- dock (AppBar)
class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class APPBARDATA(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("hWnd", ctypes.c_void_p),
                ("uCallbackMessage", ctypes.c_uint), ("uEdge", ctypes.c_uint),
                ("rc", RECT), ("lParam", ctypes.c_ssize_t)]


class MONITORINFOEX(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", RECT), ("rcWork", RECT),
                ("dwFlags", ctypes.c_ulong), ("szDevice", ctypes.c_wchar * CCHDEVICENAME)]


@dataclass
class Monitor:
    device: str
    rect: tuple[int, int, int, int]        # (left, top, right, bottom) in virtual-screen coords
    primary: bool

    @property
    def label(self) -> str:
        left, top, right, bottom = self.rect
        return (f"{self.device}  {right - left}×{bottom - top}  @{left},{top}"
                + ("  (primary)" if self.primary else ""))


def edge_band(box: tuple[int, int, int, int], edge: str, thick: int) -> tuple[int, int, int, int]:
    """`box` trimmed to a band of `thick` px hugging `edge`. The one place the edge switch lives —
    the strip, the post-QUERYPOS thickness restore, and the minimum-size retry all go through it."""
    left, top, right, bottom = box
    if edge == "top":
        return (left, top, right, top + thick)
    if edge == "bottom":
        return (left, bottom - thick, right, bottom)
    if edge == "left":
        return (left, top, left + thick, bottom)
    return (right - thick, top, right, bottom)


def band_thickness(box: tuple[int, int, int, int], edge: str) -> int:
    """How thick `box` is along `edge`'s own axis."""
    return box[3] - box[1] if edge in ("top", "bottom") else box[2] - box[0]


def strip_rect(mon: tuple[int, int, int, int], edge: str, percent: int) -> tuple[int, int, int, int]:
    """The docked strip inside monitor rect `mon`. Thickness is a percentage of the monitor's own
    extent along the edge's axis, so one setting means the same thing on a 2560×1440 landscape
    panel and a 1080×1920 portrait one. Pure — no Win32, so `--self-test` can assert it."""
    percent = max(DOCK_PCT_MIN, min(DOCK_PCT_MAX, percent))
    return edge_band(mon, edge, max(1, band_thickness(mon, edge) * percent // 100))


CTRL_HANDLER = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_ulong)


def on_console_close(callback) -> object:
    """Run `callback` when the console is closed — the X button, closing the Windows Terminal tab,
    Ctrl-C, logoff or shutdown. Without this, only `Q` reached the cleanup path and every other way
    of quitting stranded the dock's reservation.

    The returned handler MUST be kept referenced by the caller: ctypes would otherwise collect it
    and Windows would call into freed memory."""
    def handler(_event: int) -> int:
        callback()
        return 0                    # 0 = not handled, so Windows still terminates us as usual

    box = CTRL_HANDLER(handler)
    ctypes.windll.kernel32.SetConsoleCtrlHandler(box, True)
    return box


def set_dpi_awareness() -> None:
    """Per-monitor DPI awareness. Without it Windows virtualizes both the monitor rects we read
    and the coordinates we pass to SetWindowPos, and the strip lands somewhere else on a scaled
    display. Must run before any monitor or window query."""
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(DPI_PER_MONITOR_AWARE_V2))
    except (AttributeError, OSError):
        pass                                   # pre-1703 Windows: leave the process as-is


def window_rect(hwnd) -> tuple[int, int, int, int] | None:
    r = RECT()
    if not hwnd or not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return (r.left, r.top, r.right, r.bottom)


def visible_rect(hwnd) -> tuple[int, int, int, int] | None:
    """The rect DWM actually PAINTS. `GetWindowRect` includes an invisible resize border — measured
    7 px left/right/bottom (0 top) on this machine — so aligning the window rect to a screen edge
    leaves the visible window looking inset by exactly that much. Falls back to the window rect on
    the (pre-Vista-style) systems where DWM has nothing to say."""
    r = RECT()
    if not hwnd:
        return None
    hresult = ctypes.windll.dwmapi.DwmGetWindowAttribute(
        ctypes.c_void_p(hwnd), ctypes.c_uint(DWMWA_EXTENDED_FRAME_BOUNDS),
        ctypes.byref(r), ctypes.sizeof(r))
    return window_rect(hwnd) if hresult else (r.left, r.top, r.right, r.bottom)


def dockable(hwnd) -> bool:
    """Can this window actually be docked? Judged by RECT AREA, not IsWindowVisible: under Windows
    Terminal, GetConsoleWindow() returns a `PseudoConsoleWindow` stub that reports itself VISIBLE
    and gives itself away only by a zero-area rect (measured 2026-08-28 — a visibility test picks
    the stub, and every SetWindowPos on it silently does nothing)."""
    r = window_rect(hwnd)
    return bool(hwnd) and bool(ctypes.windll.user32.IsWindowVisible(hwnd)) and r is not None \
        and r[2] > r[0] and r[3] > r[1]


def find_window(title: str) -> int | None:
    """First visible, real-sized top-level window whose title is exactly `title`."""
    u32 = ctypes.windll.user32
    found: list[int] = []

    def callback(hwnd, _lparam):
        text = ctypes.create_unicode_buffer(CONSOLE_TITLE_MAX)
        u32.GetWindowTextW(hwnd, text, CONSOLE_TITLE_MAX)
        if text.value == title and dockable(hwnd):
            found.append(hwnd)
            return 0                           # 0 stops EnumWindows
        return 1

    proto = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_ssize_t)
    u32.EnumWindows(proto(callback), 0)
    return found[0] if found else None


def host_window() -> int | None:
    """The real top-level window hosting this console, or None.

    conhost answers straight from GetConsoleWindow(). Windows Terminal (the Windows 11 default)
    does not — its window is found by console title instead, and the title is made UNIQUE PER
    PROCESS first: a fixed marker matched a DIFFERENT terminal that still had that title
    (measured 2026-08-28), which would have docked someone else's window."""
    k32 = ctypes.windll.kernel32
    console = k32.GetConsoleWindow()
    if dockable(console):
        return console
    buf = ctypes.create_unicode_buffer(CONSOLE_TITLE_MAX)
    k32.GetConsoleTitleW(buf, CONSOLE_TITLE_MAX)
    previous, marker = buf.value, f"{APP_TITLE} #{os.getpid()}"
    k32.SetConsoleTitleW(marker)
    try:
        time.sleep(TITLE_SETTLE_S)
        return find_window(marker)
    finally:
        k32.SetConsoleTitleW(previous)


def pick_monitor(monitors: list[Monitor], wanted: str | None) -> tuple[Monitor | None, str | None]:
    """Which monitor to dock on → `(monitor, missing)`.

    `missing` is the configured device that is not connected right now, and is what makes the
    fallback SAYABLE instead of silent. The saved device is never rewritten here: unplugging a
    monitor should not erase the user's choice, so plugging it back in restores the dock to it.
    Pure — no Win32, so `--self-test` can assert the decision."""
    if not monitors:
        return None, wanted
    for m in monitors:
        if m.device == wanted:
            return m, None
    return monitors[0], (wanted or None)


def list_monitors() -> list[Monitor]:
    """Every display, primary first. `rcMonitor` (not `rcWork`) is the base for the strip: the
    strip is what CREATES the work-area cut, so it must be measured against the full panel."""
    u32 = ctypes.windll.user32
    out: list[Monitor] = []

    def callback(hmonitor, _hdc, _rect, _lparam):
        info = MONITORINFOEX()
        info.cbSize = ctypes.sizeof(MONITORINFOEX)
        if u32.GetMonitorInfoW(hmonitor, ctypes.byref(info)):
            m = info.rcMonitor
            out.append(Monitor(info.szDevice, (m.left, m.top, m.right, m.bottom),
                               bool(info.dwFlags & MONITORINFOF_PRIMARY)))
        return 1

    proto = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                               ctypes.POINTER(RECT), ctypes.c_ssize_t)
    u32.EnumDisplayMonitors(None, None, proto(callback), 0)
    out.sort(key=lambda m: (not m.primary, m.device))
    return out


class Dock:
    """Reserves a screen edge for this window through the Windows AppBar API — the same mechanism
    the taskbar uses, so other windows' maximize and Snap stop at the border instead of covering us.

    The registration is owned by THIS process and released in Tui.run()'s `finally`. That is the
    whole reason the dock lives in the manager rather than an external launcher: an appbar that is
    never removed leaves the desktop permanently shrunk.
    """

    def __init__(self, store: Store):
        self.store = store
        self.cfg = store.load_dock()
        self.hwnd: int | None = None
        self.registered = False
        self.note = ""
        self.band: tuple[int, int, int, int] | None = None    # the painted rect we hold
        self._keeper: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()          # keeper thread vs the settings screen's commit

    # -- geometry --------------------------------------------------------------
    def monitor(self) -> Monitor | None:
        """The monitor to dock on. A configured monitor that is not connected falls back to the
        primary and says so — the saved choice is kept, so reconnecting that display restores it."""
        chosen, missing = pick_monitor(list_monitors(), self.cfg.get("device"))
        if missing and chosen:
            self.note = (f"{missing} is not connected — docking on {chosen.device} instead "
                         f"(your saved choice is kept).")
        elif missing:
            self.note = "No monitors reported — cannot dock."
        return chosen

    def target_rect(self) -> tuple[int, int, int, int] | None:
        m = self.monitor()
        return strip_rect(m.rect, self.cfg["edge"], self.cfg["percent"]) if m else None

    def thickness_px(self) -> int:
        rc = self.target_rect()
        if not rc:
            return 0
        return rc[3] - rc[1] if self.cfg["edge"] in ("top", "bottom") else rc[2] - rc[0]

    # -- win32 -----------------------------------------------------------------
    def _appbar(self, rc: tuple[int, int, int, int] | None = None) -> APPBARDATA:
        data = APPBARDATA()
        data.cbSize = ctypes.sizeof(APPBARDATA)
        data.hWnd = ctypes.c_void_p(self.hwnd)
        data.uEdge = DOCK_EDGES.index(self.cfg["edge"])
        if rc:
            data.rc = RECT(*rc)
        return data

    @staticmethod
    def _shell():
        shell = ctypes.windll.shell32
        shell.SHAppBarMessage.restype = ctypes.c_size_t
        return shell

    def apply(self) -> bool:
        """Register if needed, then place the strip. True when the window ends up docked.

        Docked == MAXIMIZED: WS_MAXIMIZE survives a SetWindowPos to a custom rect (measured
        2026-08-28), so the window keeps its Restore button while sitting in the band, and Windows
        keeps `rcNormalPosition` — which is what makes "restore" hand back the exact pre-dock size
        without us storing it."""
        if self.hwnd is None:
            self.hwnd = host_window()
        if self.hwnd and not ctypes.windll.user32.IsZoomed(self.hwnd):
            ctypes.windll.user32.ShowWindow(ctypes.c_void_p(self.hwnd), SW_MAXIMIZE)
        rc = self.target_rect()
        if not self.hwnd:
            self.note = "Could not find this terminal's window — dock unavailable here."
            return False
        if rc is None:
            self.note = "No monitors reported."
            return False
        shell = self._shell()
        if not self.registered:
            shell.SHAppBarMessage(ABM_NEW, ctypes.byref(self._appbar()))
            self.registered = True
            self.store.save_docked_hwnd(self.hwnd)     # so a hard kill can still be cleaned up next run
        edge = self.cfg["edge"]
        data = self._appbar(rc)
        # QUERYPOS slides the rect clear of the taskbar and any other appbar, but only along the
        # edge's axis — it does NOT preserve thickness, so restore that before SETPOS.
        shell.SHAppBarMessage(ABM_QUERYPOS, ctypes.byref(data))
        band = edge_band((data.rc.left, data.rc.top, data.rc.right, data.rc.bottom),
                         edge, band_thickness(rc, edge))
        painted = self._place(band)
        # A terminal can REFUSE to get that small: Windows Terminal enforces a minimum window size
        # (measured 2026-08-28 — a 216 px strip on the 1080-wide portrait panel came back 480 px).
        # Reserve what it really occupies, or the surplus sits on top of other windows while the
        # work area claims that space is free. Re-place afterwards: the clamped window does NOT
        # stay anchored to the edge on its own (measured: it landed 480 px inboard).
        if painted and band_thickness(painted, edge) > band_thickness(band, edge):
            got = band_thickness(painted, edge)
            band = edge_band(band, edge, got)
            painted = self._place(band)
            self.note = f"Terminal would not shrink below {got} px — reserved that instead."
        # Reserve exactly what is PAINTED, so no sliver of reserved-but-empty desktop is left over.
        self.band = painted or band
        data.rc = RECT(*self.band)
        shell.SHAppBarMessage(ABM_SETPOS, ctypes.byref(data))
        self._start_keeper()
        return True

    def _set_pos(self, rect: tuple[int, int, int, int]) -> None:
        u32 = ctypes.windll.user32
        u32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_int, ctypes.c_uint]
        u32.SetWindowPos(ctypes.c_void_p(self.hwnd), ctypes.c_void_p(HWND_TOPMOST),
                         rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1], SWP_NOACTIVATE)

    def _place(self, band: tuple[int, int, int, int]):
        """Move the window so its PAINTED edges land on `band`; return where they actually landed.

        Two passes: the first tells us this window's invisible resize border (7 px left/right/bottom
        here), the second compensates for it. Without this the docked window sits visibly inset from
        the screen edge even though its window rect is flush."""
        self._set_pos(band)
        win, painted = window_rect(self.hwnd), visible_rect(self.hwnd)
        if win and painted:
            pad = (painted[0] - win[0], painted[1] - win[1], win[2] - painted[2], win[3] - painted[3])
            if any(pad):
                self._set_pos((band[0] - pad[0], band[1] - pad[1], band[2] + pad[2], band[3] + pad[3]))
        return visible_rect(self.hwnd)

    def _start_keeper(self) -> None:
        """Watch the window's maximize state, which IS the dock toggle.

        ponytail: a poll, not a SetWinEventHook; the hook needs its own message-pumping thread
        while the TUI blocks in ReadConsoleInputW. Swap it in if the poll ever shows up."""
        if self._keeper:
            return
        self._stop.clear()
        self._keeper = threading.Thread(target=self._keep_pinned, daemon=True)
        self._keeper.start()

    def _keep_pinned(self) -> None:
        """Maximize → dock into the band. Restore → undock and let Windows hand back the previous
        size. The window's own maximize state is the single source of truth, so the title-bar
        buttons drive the dock instead of a separate hidden gesture."""
        u32 = ctypes.windll.user32
        while not self._stop.wait(DOCK_KEEP_INTERVAL_S):
            hwnd = self.hwnd
            if not self.cfg["enabled"] or not hwnd or not u32.IsWindow(hwnd):
                continue                                  # feature off: ordinary window behaviour
            with self._lock:
                if u32.IsZoomed(hwnd):
                    if not self.registered:
                        self.apply()                      # user maximized: take the edge
                    elif self.band and visible_rect(hwnd) != self.band:
                        self._place(self.band)            # nudged out of its own band: come back
                elif self.registered:
                    self.remove()                         # user restored: give the space back

    def remove(self) -> None:
        """Hand the reserved space back. Safe to call when never docked (the exit path always does)."""
        self.band = None
        if not self.registered:
            return
        self._shell().SHAppBarMessage(ABM_REMOVE, ctypes.byref(self._appbar()))
        self.registered = False
        self.store.save_docked_hwnd(None)
        if self.hwnd:
            u32 = ctypes.windll.user32
            u32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_int, ctypes.c_int, ctypes.c_uint]
            u32.SetWindowPos(ctypes.c_void_p(self.hwnd), ctypes.c_void_p(HWND_NOTOPMOST), 0, 0, 0, 0,
                             SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)

    def reclaim_stale(self) -> bool:
        """Release a reservation a PREVIOUS run left behind.

        `remove()` only runs on this process's exit path, so closing the terminal window or tab
        used to strand the appbar: Windows kept the edge reserved, and the next run's ABM_QUERYPOS
        politely slid the new strip BELOW the phantom band — the reported "top stays blank and the
        manager comes down lower". Windows does not reliably prune appbars whose window is gone,
        and if the manager ran in a Windows Terminal window that is still open, the HWND is very
        much alive and Windows will hold that space forever.

        Only ever removes a window that is gone, or one still titled as ours — never a live window
        belonging to someone else, since HWND values get recycled.
        """
        hwnd = self.store.load_docked_hwnd()
        if not hwnd:
            return False
        u32 = ctypes.windll.user32
        if u32.IsWindow(hwnd):
            buf = ctypes.create_unicode_buffer(CONSOLE_TITLE_MAX)
            u32.GetWindowTextW(hwnd, buf, CONSOLE_TITLE_MAX)
            if not buf.value.startswith(APP_TITLE):
                self.store.save_docked_hwnd(None)      # recycled onto someone else: let it be
                return False
        data = APPBARDATA()
        data.cbSize = ctypes.sizeof(APPBARDATA)
        data.hWnd = ctypes.c_void_p(hwnd)
        self._shell().SHAppBarMessage(ABM_REMOVE, ctypes.byref(data))
        self.store.save_docked_hwnd(None)
        return True

    def reapply(self) -> bool:
        """Bring the desktop in line with the current config, whichever way it points.
        Takes the lock because the keeper thread may be acting on the same window right now."""
        with self._lock:
            if self.cfg["enabled"]:
                return self.apply()
            self.remove()
            if self.hwnd and ctypes.windll.user32.IsZoomed(self.hwnd):
                ctypes.windll.user32.ShowWindow(ctypes.c_void_p(self.hwnd), SW_RESTORE)
            return False

    def shutdown(self) -> None:
        """Session teardown: stop watching, then hand the reserved space back. `remove()` alone no
        longer stops the keeper, because undocking is now a normal thing that happens mid-session
        (the user restores the window) and the keeper has to be there to see the next maximize."""
        self._stop.set()
        self._keeper = None
        self.remove()

    def save(self) -> None:
        self.store.save_dock(self.cfg)


class Tui:
    HINT_PROJECTS = "↑↓ move  Enter/→ sessions  T open here  O open new window  F2 alias  Del delete  S settings  F5 refresh  Q quit"
    HINT_SESSIONS = "↑↓ move  Enter resume  T resume here  O resume new window  F2 rename  Del delete  S settings  ←/Esc back  Q quit"
    # Two stages, so no arrow key ever means two things at once.
    HINT_DOCK_MONITOR = "↑↓ monitor  Enter/→ apply & settings  Tab next box  Esc cancel"
    HINT_MCP = "↑↓ server  Space/Enter show or hide  A all  Tab next box  Esc close"
    HINT_SHELL = "↑↓ shell  Space/Enter select  Tab next box  Esc close"
    HINT_DOCK_FORM = "↑↓ field  Enter/→ edit  Tab next box  Esc back"
    # Per field, because each one uses the axis its own display suggests.
    HINT_DOCK_EDIT = ("←→ edge  Enter apply & save  Esc cancel edit",
                      "↑↓ size  0-9 type %  Enter apply & save  Esc cancel edit",
                      "↑↓ dock on/off  Enter apply & save  Esc cancel edit")

    def __init__(self, store: Store):
        self.store = store
        self.projects: list[Project] = []
        self.project: Project | None = None       # None = project list, else its session list
        self.cursor = 0
        self.top = 0
        self.status = ""
        self.status_visible = True      # false where none of the status sources exist
        self.out = sys.stdout
        self.dock = Dock(store)

    # -- console ---------------------------------------------------------------
    @staticmethod
    def _enable_vt() -> None:
        k32 = ctypes.windll.kernel32
        h = k32.GetStdHandle(STD_OUTPUT_HANDLE)
        mode = ctypes.c_uint()
        if k32.GetConsoleMode(h, ctypes.byref(mode)):
            k32.SetConsoleMode(h, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING)

    @staticmethod
    def _console_title() -> str:
        buf = ctypes.create_unicode_buffer(CONSOLE_TITLE_MAX)
        ctypes.windll.kernel32.GetConsoleTitleW(buf, CONSOLE_TITLE_MAX)
        return buf.value

    @staticmethod
    def _set_console_title(text: str) -> None:
        ctypes.windll.kernel32.SetConsoleTitleW(text)

    def _sync_title(self) -> None:
        self._set_console_title(APP_TITLE + (f" · {self.project.display}" if self.project else ""))

    def run(self) -> None:
        self._enable_vt()
        set_dpi_awareness()                       # before any monitor/window query
        previous_title = self._console_title()
        self.out.write(Ansi.ALT_ON + Ansi.CUR_HIDE)
        # Closing the window/tab skips `finally` entirely, so cleanup is hooked BOTH ways round:
        # on the way out here, and on the way in below for whatever an earlier run left behind.
        self._ctrl_handler = on_console_close(self.dock.shutdown)
        try:
            if self.dock.reclaim_stale():
                self.status = Ansi.YELLOW + "Released a dock reservation left by an earlier run."
            if self.dock.cfg["enabled"]:
                # Report the note on SUCCESS too: docking on a different monitor than the one that
                # was configured is exactly the case that must not happen quietly.
                if not self.dock.apply():
                    self.status = Ansi.YELLOW + (self.dock.note or "Dock failed.")
                elif self.dock.note:
                    self.status = Ansi.YELLOW + self.dock.note
            self.refresh()
            while True:
                self._sync_title()
                self.render()
                # A timed-out read returns "" and simply loops: the next render picks up a
                # rolled rate-limit window or a session that started or ended meanwhile.
                k = Key.read(timeout_ms=IDLE_REFRESH_MS)
                if not k:
                    self.refresh()
                    continue
                if not self.handle(k):
                    break
        finally:
            self.dock.shutdown()                  # first: never leave the work area reserved
            self.out.write(Ansi.CUR_SHOW + Ansi.ALT_OFF)
            self.out.flush()
            self._set_console_title(previous_title)

    # -- state -----------------------------------------------------------------
    def refresh(self) -> None:
        keep = self.project.enc_dir if self.project else None
        self.projects = self.store.scan()
        self.project = next((p for p in self.projects if p.enc_dir == keep), None) if keep else None
        self.clamp()

    def rows(self) -> list:
        return self.project.sessions if self.project else self.projects

    def clamp(self) -> None:
        self.cursor = max(0, min(self.cursor, len(self.rows()) - 1))
        height = self.list_height()
        self.top = min(self.top, self.cursor)
        if self.cursor >= self.top + height:
            self.top = self.cursor - height + 1

    def layout(self) -> tuple[int, int]:
        """(list rows, detail rows) for the two group boxes. The list shrinks to its content so the
        detail box gets the rest; a long list still leaves DETAIL_MIN_LINES for it, and a terminal
        too short for both drops the detail box (its frame included)."""
        screen = shutil.get_terminal_size().lines - (2 if self.status_visible else 1)   # status + hint
        avail = screen - LIST_BOX_CHROME
        if avail < DETAIL_MIN_LINES + DETAIL_BOX_CHROME + 3:
            return max(1, avail), 0
        avail -= DETAIL_BOX_CHROME
        list_h = max(1, min(max(len(self.rows()), 1), avail - DETAIL_MIN_LINES))
        return list_h, avail - list_h

    def list_height(self) -> int:
        return self.layout()[0]

    def current(self):
        rows = self.rows()
        return rows[self.cursor] if rows else None

    # -- render ----------------------------------------------------------------
    def render(self) -> None:
        """The list and the detail viewer, each in its own group box — the same frame the settings
        screen uses, so one screen reads like the other. The list box is titled with what it holds
        (and where), the detail box with what the cursor is on."""
        cols, lines = shutil.get_terminal_size()
        w = cols - 1
        inner = max(10, w - BOX_SIDE_COLS)
        rows, (height, detail_h) = self.rows(), self.layout()
        if self.project:
            title = f"Sessions · {self.project.display}"
            where = self.project.cwd or self.project.enc_dir.name
        else:
            title = f"Projects · {len(self.projects)}"
            where = str(self.store.projects_dir)
        if self.store.claude_args:
            where += "   ⚡ " + " ".join(self.store.claude_args)
        buf = [Ansi.HOME]
        buf += self._box_top(title, where, w)
        buf += self._box_row(Ansi.INV + (self.session_row(None, inner) if self.project
                                         else self.project_row(None, inner)), w)
        for i in range(self.top, self.top + height):
            if i < len(rows):
                text = self.session_row(rows[i], inner) if self.project else self.project_row(rows[i], inner)
                buf += self._box_row((Ansi.INV if i == self.cursor else "") + text, w)
            else:
                buf += self._box_row("", w)
        buf += self._box_bottom(w)
        if detail_h:
            detail = self.detail_lines(inner)[:detail_h]
            buf += self._box_top("Session" if self.project else "Project", "", w)
            buf += [r for label, style, text in detail
                    for r in self._box_row(Ansi.CYAN + label + Ansi.RESET + style
                                           + fit(text, inner - cell_width(label)), w)]
            for _ in range(detail_h - len(detail)):
                buf += self._box_row("", w)
            buf += self._box_bottom(w)
        status = self.status_line(w)
        self.status_visible = bool(status)
        if status:
            buf.append(status + Ansi.RESET + Ansi.EOL + "\n")
        hint = self.HINT_SESSIONS if self.project else self.HINT_PROJECTS
        footer = self.status or (Ansi.DIM + hint)
        buf.append(fit(footer, w + (len(Ansi.DIM) if not self.status else 0)) + Ansi.RESET + Ansi.EOL)
        self.out.write("".join(buf))
        self.out.flush()
        self.status = ""

    def status_line(self, w: int) -> str:
        """The rate-limit / MCP / Outlook / ponytail line, refreshed from disk on every render."""
        items = self.store.status_items()
        if not items:
            return ""
        def render(with_labels: bool) -> tuple[str, int]:
            cell = lambda icon, label, body: (f"{icon} {Ansi.DIM}{label}{Ansi.RESET} " if with_labels
                                              else f"{icon} ") + body
            text = (Ansi.DIM + " | " + Ansi.RESET).join(cell(*item) for item in items)
            plain = strip_ansi(text)
            return text, cell_width(plain)

        text, width = render(True)
        if width + 1 > w:                       # names dropped before the values are lost
            text, width = render(False)
        if width + 1 > w:
            return " " + fit(strip_ansi(text), w - 1)
        return " " + text + " " * (w - width - 1)

    def detail_lines(self, w: int) -> list[tuple[str, str, str]]:
        """Viewer rows (label, style, text) for the highlighted item. A long value wraps onto
        continuation rows with an empty label so it stays aligned under its field."""
        item = self.current()
        if item is None:
            return []
        rows: list[tuple[str, str, str]] = []

        def field(label: str, text: str, style: str = "") -> None:
            for i, line in enumerate(wrap_cells(text, max(8, w - DETAIL_LABEL_W))):
                rows.append((fit(" " + label if i == 0 else "", DETAIL_LABEL_W), style, line))

        if self.project is None:
            field("Name", item.display, Ansi.BOLD)
            if item.alias:
                field("Folder", item.name)                  # the real folder behind a display alias
            field("Path", item.cwd or "(unknown — no transcript carries a cwd)",
                  "" if item.exists else Ansi.RED)
            if item.cwd and not item.exists:
                field("", "the folder no longer exists; opening a session here would fail", Ansi.RED)
            field("Sessions", f"{len(item.sessions)}"
                              + (f"   Running  {item.live_count}" if item.live_count else "")
                              + (f"   Size  {fmt_size(item.total_size)}" if item.sessions else ""))
            field("Last used", fmt_time(item.last_used))
            field("Memory", ("yes — memory/ is kept here and Del would delete it with the project"
                             if item.has_memory else "no"),
                  Ansi.YELLOW if item.has_memory else Ansi.DIM)
            field("Dir", item.enc_dir.name, Ansi.DIM)
        else:
            field("Title", item.title, Ansi.BOLD)
            field("Named", "yes — set here or by /rename, and shown in /resume" if item.custom
                           else "no — the title above is the session's first prompt",
                  "" if item.custom else Ansi.DIM)
            if item.prompt and item.prompt != item.title:
                field("Prompt", item.prompt)                # the first prompt, when a name replaced it
            field("Id", item.sid)
            field("Started", fmt_time(item.created))
            field("Modified", fmt_time(item.mtime))
            field("Size", fmt_size(item.size))
            field("State", f"{LIVE_MARK} running — Del is refused while it is" if item.live else "idle",
                  Ansi.GREEN if item.live else Ansi.DIM)
            field("Project", self.project.cwd or self.project.enc_dir.name, Ansi.DIM)
            field("File", str(item.path), Ansi.DIM)
        return rows

    def project_row(self, p: Project | None, w: int) -> str:
        fixed = 2 + 5 + 12 + 4 + 2                    # live, sessions, date, mem, spacing
        name_w = max(12, min(28, (w - fixed) // 3))
        path_w = max(10, w - fixed - name_w)
        if p is None:
            return fit("  Name", name_w + 2) + fit("Path", path_w) + fit("Sess", 5, True) + fit("Last used", 12, True) + fit("Mem", 4, True) + "  "
        mark = (Ansi.GREEN + LIVE_MARK + Ansi.FG_DEFAULT if p.live else " ")
        path = p.cwd or "(unknown path)"
        path_text = (Ansi.RED if not p.exists else "") + fit(path, path_w) + (Ansi.FG_DEFAULT if not p.exists else "")
        return (mark + " " + fit(p.display, name_w) + path_text + fit(str(len(p.sessions)), 5, True)
                + fit(fmt_time(p.last_used), 12, True) + fit("M" if p.has_memory else "", 4, True) + "  ")

    def session_row(self, s: Session | None, w: int) -> str:
        fixed = 2 + 9 + 12 + 7 + 2
        title_w = max(10, w - fixed)
        if s is None:
            return fit("  Title", title_w + 2) + fit("Id", 9) + fit("Modified", 12, True) + fit("Size", 7, True) + "  "
        mark = (Ansi.GREEN + LIVE_MARK + Ansi.FG_DEFAULT if s.live else " ")
        return (mark + " " + fit(s.title, title_w) + fit(s.sid[:8], 9) + fit(fmt_time(s.mtime), 12, True)
                + fit(fmt_size(s.size), 7, True) + "  ")

    # -- prompts ---------------------------------------------------------------
    def prompt(self, label: str, initial: str = "") -> str | None:
        """Inline line editor on the footer row. Returns None on Esc."""
        text = initial
        lines = shutil.get_terminal_size().lines
        self.out.write(Ansi.CUR_SHOW)
        try:
            while True:
                self.out.write(f"\x1b[{lines};1H" + Ansi.YELLOW + label + Ansi.RESET + text + Ansi.EOL)
                self.out.flush()
                k = Key.read(translate=False)          # titles are typed in Korean as-is
                if k == Key.ENTER:
                    return text.strip()
                if k == Key.ESC:
                    return None
                if k == Key.BACKSPACE:
                    text = text[:-1]
                elif len(k) == 1 and k.isprintable():
                    text += k
        finally:
            self.out.write(Ansi.CUR_HIDE)

    def confirm(self, question: str) -> bool:
        lines = shutil.get_terminal_size().lines
        self.out.write(f"\x1b[{lines};1H" + Ansi.RED + Ansi.BOLD + question + "  [Enter = yes / Esc = no] " + Ansi.RESET + Ansi.EOL)
        self.out.flush()
        while True:
            k = Key.read()
            if k == Key.ENTER:
                return True
            if k == Key.ESC:
                return False

    # -- dock settings ---------------------------------------------------------
    def settings(self) -> None:
        """S: dock settings, as a three-stage descent so ↑↓ never means two things at once —
        monitor → field → that field's value. Enter descends and APPLIES; Esc backs out one stage,
        and from the monitor list cancels whatever has not been applied yet.

        Arrow keys only edit pending values: applying on every keystroke re-placed the window
        constantly and made a value impossible to follow. The px readout previews the result."""
        monitors = list_monitors()
        if not monitors:
            self.status = Ansi.RED + "No monitors reported."
            return
        saved = dict(self.dock.cfg)
        cfg = self.dock.cfg
        # Capture the absent-monitor case BEFORE the selection is snapped to a live monitor,
        # otherwise the screen would show a perfectly normal choice and never mention that the
        # configured display is missing.
        chosen, missing = pick_monitor(monitors, cfg["device"])
        idx = monitors.index(chosen)
        cfg["device"] = chosen.device
        stage, field, before_edit, committed = STAGE_MONITOR, DOCK_FIELD_EDGE, None, False
        servers, server_idx = self.store.installed_mcp_servers(), 0
        shell_idx = next((i for i, c in enumerate(SHELL_CHOICES)
                          if c[0] == self.store.load_launch_cfg()["shell"]), 0)
        while True:
            self._render_settings(monitors, idx, stage, missing, field,
                                  servers, server_idx, shell_idx)
            k = Key.read()
            # Tab is the ONLY way between boxes. While editing a value it would abandon the
            # edit, so it is ignored there.
            if k in (Key.TAB, Key.BACKTAB) and stage != STAGE_EDIT:
                stage = next_section(stage, 1 if k == Key.TAB else -1)
                continue
            if stage == STAGE_SHELL:
                if k == Key.ESC:
                    stage = STAGE_MONITOR
                elif k in (Key.UP, Key.DOWN):
                    shell_idx = (shell_idx + (1 if k == Key.DOWN else -1)) % len(SHELL_CHOICES)
                elif k in (" ", Key.ENTER):
                    self.store.save_launch_cfg({"shell": SHELL_CHOICES[shell_idx][0]})
                continue
            if stage == STAGE_MCP:
                if k == Key.ESC:
                    stage = STAGE_MONITOR
                elif k in (Key.UP, Key.DOWN) and servers:
                    server_idx = (server_idx + (1 if k == Key.DOWN else -1)) % len(servers)
                elif k in (" ", Key.ENTER) and servers:
                    self._toggle_mcp(servers, servers[server_idx])
                elif k.lower() == "a" and servers:
                    self.store.save_status_cfg({"mcp": None})    # None = report every server
                continue
            if k == Key.ESC:
                if stage == STAGE_EDIT:                  # undo just this field
                    cfg[DOCK_FIELD_KEYS[field]] = before_edit
                    stage = STAGE_FORM
                elif stage == STAGE_FORM:
                    stage = STAGE_MONITOR
                else:
                    # Only ever discards edits made since the last Enter, so cancelling is a pure
                    # in-memory restore — no re-place of the window, no flicker.
                    self.dock.cfg = saved
                    self.status = (self.dock.note if committed and self.dock.note
                                   else "Dock unchanged.")
                    return
                continue
            # RIGHT descends everywhere EXCEPT while editing, where it belongs to the Edge value.
            if k == Key.ENTER or (k == Key.RIGHT and stage != STAGE_EDIT):
                if stage == STAGE_MONITOR:
                    # Descending also APPLIES, so picking a monitor is a complete action on its
                    # own — otherwise a monitor change could only be committed by going on to
                    # edit some other field and pressing Enter there.
                    self._commit_dock()
                    saved, missing, committed = dict(cfg), None, True
                    stage, field = STAGE_FORM, DOCK_FIELD_EDGE
                elif stage == STAGE_FORM:
                    before_edit, stage = cfg[DOCK_FIELD_KEYS[field]], STAGE_EDIT
                else:
                    # Enter is the ONLY thing that touches the desktop. Adjusting on every arrow
                    # key re-placed the window constantly and made a value hard to choose; the px
                    # readout previews the result without moving anything.
                    self._commit_dock()
                    saved, committed = dict(cfg), True   # Esc cancels edits made SINCE this apply
                    stage = STAGE_FORM
                continue
            if stage == STAGE_MONITOR:
                if k in (Key.UP, Key.DOWN):
                    idx = (idx + (1 if k == Key.DOWN else -1)) % len(monitors)
                    cfg["device"] = monitors[idx].device
            elif stage == STAGE_FORM:
                if k in (Key.UP, Key.DOWN):
                    field = (field + (1 if k == Key.DOWN else -1)) % len(DOCK_FIELDS)
            else:
                self._edit_field(field, k)

    def _edit_field(self, field: int, k: str) -> None:
        """Value keys while editing one field. Each field takes the axis its own display suggests:
        the edge list reads left-to-right so it is ←→, while size and dock are single values that
        go up and down. A key on the wrong axis is ignored rather than doing something surprising."""
        if field == DOCK_FIELD_EDGE:
            if k in (Key.LEFT, Key.RIGHT):
                self._adjust_field(field, 1 if k == Key.RIGHT else -1)
        elif field == DOCK_FIELD_SIZE:
            if k in (Key.UP, Key.DOWN):
                self._adjust_field(field, 1 if k == Key.UP else -1)
            elif k.isdigit():
                # Typing a digit while editing Size IS the editor — the ratio can be entered
                # directly instead of stepped to.
                typed = self.prompt(f"Size % ({DOCK_PCT_MIN}-{DOCK_PCT_MAX}): ", k)
                if (typed or "").isdigit():     # Esc, empty, or junk: leave the value alone
                    self.dock.cfg["percent"] = max(DOCK_PCT_MIN, min(DOCK_PCT_MAX, int(typed)))
        elif k in (Key.UP, Key.DOWN):
            self._adjust_field(field, 1 if k == Key.UP else -1)

    def _commit_dock(self) -> None:
        """Apply the pending config to the desktop and persist it. The only writer of either."""
        cfg = self.dock.cfg
        self.dock.note = ""
        applied = self.dock.reapply()
        self.dock.save()
        if cfg["enabled"] and not applied:
            self.dock.note = self.dock.note or "Dock failed."
        elif not self.dock.note:
            self.dock.note = (f"Applied and saved: {cfg['edge']} {cfg['percent']}% "
                              f"({self.dock.thickness_px()} px) on {cfg['device']}."
                              if cfg["enabled"] else "Dock off — applied and saved.")

    def _adjust_field(self, field: int, step: int) -> None:
        """Step one field's value. `_edit_field` decides which key means +1 or -1 for that field."""
        cfg = self.dock.cfg
        if field == DOCK_FIELD_EDGE:
            cfg["edge"] = DOCK_EDGES[(DOCK_EDGES.index(cfg["edge"]) + step) % len(DOCK_EDGES)]
        elif field == DOCK_FIELD_SIZE:
            cfg["percent"] = max(DOCK_PCT_MIN, min(DOCK_PCT_MAX, cfg["percent"] + step))
        else:
            cfg["enabled"] = step > 0           # ← off, → on: directional, never a blind flip

    def _toggle_mcp(self, servers: list[str], name: str) -> None:
        """Show or hide one server. The stored form is an explicit list, so a server installed
        later stays hidden until it is picked — the default "everything" (None) is only the state
        of a machine that has never chosen, and `A` puts it back."""
        chosen = self.store.load_status_cfg()["mcp"]
        selected = list(servers) if chosen is None else [n for n in chosen if n in servers or True]
        if name in selected:
            selected.remove(name)
        else:
            selected.append(name)
        self.store.save_status_cfg({"mcp": [n for n in servers if n in selected]})

    # -- group-box frame -------------------------------------------------------
    def _box_top(self, title: str, note: str, w: int) -> list[str]:
        """Top border carrying the box title, plus a dim note (path, forwarded options) after it."""
        head = f"{BOX_TL}{BOX_H} {title} {BOX_H} " if note else f"{BOX_TL}{BOX_H} {title} "
        rest = w - cell_width(head) - 1
        if note and rest > 12:
            shown = fit(note, rest - 2).rstrip()
            return [Ansi.CYAN + head + Ansi.RESET + Ansi.DIM + shown + Ansi.RESET + Ansi.CYAN
                    + " " + BOX_H * max(0, rest - cell_width(shown) - 1) + BOX_TR + Ansi.RESET
                    + Ansi.EOL + "\n"]
        return [Ansi.CYAN + head + BOX_H * max(0, rest) + BOX_TR + Ansi.RESET + Ansi.EOL + "\n"]

    def _box_row(self, body: str, w: int) -> list[str]:
        """One framed row. `body` carries its own styles, so it is measured with the codes stripped
        and padded here — otherwise a blank or short row collapses the frame to `│  │`."""
        pad = " " * max(0, w - BOX_SIDE_COLS - cell_width(strip_ansi(body)))
        return [Ansi.CYAN + BOX_V + Ansi.RESET + " " + body + Ansi.RESET + pad + " "
                + Ansi.CYAN + BOX_V + Ansi.RESET + Ansi.EOL + "\n"]

    def _box_bottom(self, w: int) -> list[str]:
        return [Ansi.CYAN + BOX_BL + BOX_H * max(0, w - 2) + BOX_BR + Ansi.RESET + Ansi.EOL + "\n"]

    # -- settings rendering ----------------------------------------------------
    def _box(self, title: str, rows: list[tuple[str, str]], w: int, focused: bool) -> list[str]:
        """One group box. `rows` are (style, plain text) so the frame can pad by display width —
        a row carrying its own colour codes could not be measured reliably."""
        inner = max(10, w - 4)
        edge = Ansi.CYAN if focused else Ansi.DIM
        head = f"{BOX_TL}{BOX_H} {title} "
        out = [edge + head + BOX_H * max(0, w - cell_width(head) - 1) + BOX_TR + Ansi.RESET + Ansi.EOL + "\n"]
        for style, text in rows:
            out.append(edge + BOX_V + Ansi.RESET + " " + style + fit(text, inner)
                       + Ansi.RESET + " " + edge + BOX_V + Ansi.RESET + Ansi.EOL + "\n")
        out.append(edge + BOX_BL + BOX_H * max(0, w - 2) + BOX_BR + Ansi.RESET + Ansi.EOL + "\n")
        return out

    def _dock_rows(self, monitors: list[Monitor], idx: int, stage: str,
                   missing: str | None, field: int) -> list[tuple[str, str]]:
        cfg, mon = self.dock.cfg, monitors[idx]
        span = band_thickness(mon.rect, cfg["edge"])       # the chosen monitor's own extent
        if stage not in (STAGE_MONITOR, STAGE_FORM, STAGE_EDIT):
            return [(Ansi.DIM, f"{mon.device}   {cfg['edge']}   {cfg['percent']} %"
                               f"   {'on' if cfg['enabled'] else 'off'}")]
        rows: list[tuple[str, str]] = [(Ansi.CYAN, "Monitor")]
        if missing:
            rows.append((Ansi.YELLOW, f"  {missing}  (saved, not connected)"))
        for i, m in enumerate(monitors):
            selected, focused = i == idx, stage == STAGE_MONITOR
            style = (Ansi.INV if (selected and focused)
                     else (Ansi.BOLD if selected else Ansi.DIM))
            # ▸ is the cursor, [x] is the choice — same grammar as the other two boxes, so a
            # non-focused list still shows what is chosen without looking like it has focus.
            rows.append((style, f"  {'▸' if selected and focused else ' '} "
                                f"{CHECKED if selected else UNCHECKED} {m.label}"))
        rows.append(("", ""))
        values = [
            ("  ".join(f"[{e}]" if e == cfg["edge"] else f" {e} " for e in DOCK_EDGES), ""),
            (f"{cfg['percent']} %   →  {self.dock.thickness_px()} px   (of {span} px on {mon.device})", ""),
            ("on — this edge is reserved" if cfg["enabled"] else "off — no space reserved",
             Ansi.GREEN if cfg["enabled"] else Ansi.DIM),
        ]
        field_focus = stage in (STAGE_FORM, STAGE_EDIT)     # only ONE cursor on screen at a time
        for i, (label, (value, style)) in enumerate(zip(DOCK_FIELDS, values)):
            selected = field_focus and i == field
            # Row lit while picking a field, VALUE lit while editing it, so the screen always says
            # which of the two ↑↓ is driving. Both are plain text here; the box adds the colour.
            lit = (Ansi.INV if selected else (style if field_focus else Ansi.DIM))
            rows.append((lit, ("  ▸ " if selected else "    ") + fit(label, 9) + value))
        if self.dock.note:
            rows.append((Ansi.YELLOW, "  " + self.dock.note))
        return rows

    def _mcp_rows(self, servers: list[str], idx: int, focused: bool) -> list[tuple[str, str]]:
        chosen = self.store.load_status_cfg()["mcp"]
        probed = (Store._load_json(self.store.home / MCP_CACHE, {}) or {}).get("servers") or {}
        shown = servers if chosen is None else [n for n in servers if n in chosen]
        if not focused:
            return [(Ansi.DIM, "MCP  " + (", ".join(shown) if shown else "none shown")
                     + ("   (all)" if chosen is None else ""))]
        if not servers:
            return [(Ansi.DIM, "  no MCP server installed on this machine")]
        rows = []
        for i, name in enumerate(servers):
            on = chosen is None or name in chosen
            probe = probed.get(name)
            verdict = "" if probe is None else (f"  {OK_MARK}" if probe.get("ok") else f"  {BAD_MARK}")
            rows.append((Ansi.INV if i == idx else ("" if on else Ansi.DIM),
                         f"  {'▸' if i == idx else ' '} {CHECKED if on else UNCHECKED} {name}{verdict}"))
        rows.append((Ansi.DIM, "  unchecked servers are left out; none checked hides the segment"))
        return rows

    def _shell_rows(self, idx: int, focused: bool) -> list[tuple[str, str]]:
        current = self.store.load_launch_cfg()["shell"]
        label = next(c[1] for c in SHELL_CHOICES if c[0] == current)
        if not focused:
            return [(Ansi.DIM, f"Session shell  {label}"
                     + (f"  ({PS_EXE})" if current == SHELL_AUTO else ""))]
        rows = []
        for i, (key, name, note) in enumerate(SHELL_CHOICES):
            exe = SHELL_EXE.get(key)
            missing = exe is not None and shutil.which(exe) is None
            row = (f"  {'▸' if i == idx else ' '} {CHECKED if key == current else UNCHECKED} "
                   f"{fit(name, 20)}{note}" + ("  (not found)" if missing else ""))
            rows.append((Ansi.INV if i == idx else
                         (Ansi.YELLOW if missing else "" if key == current else Ansi.DIM), row))
        return rows

    def _render_settings(self, monitors: list[Monitor], idx: int, stage: str,
                         missing: str | None = None, field: int = 0,
                         servers: list[str] | None = None, server_idx: int = 0,
                         shell_idx: int = 0) -> None:
        """All three sections at once, each in its own group box: the focused one is expanded and
        cyan-framed, the others collapse to a single dim summary so the screen stays one page."""
        servers = servers if servers is not None else []
        cols, lines = shutil.get_terminal_size()
        w = cols - 1
        dock_focus = stage in (STAGE_MONITOR, STAGE_FORM, STAGE_EDIT)
        buf = [Ansi.CLEAR,
               Ansi.BOLD + fit(" Settings", 10) + Ansi.RESET
               + Ansi.DIM + fit("· Tab moves between boxes", w - 10) + Ansi.RESET + Ansi.EOL + "\n",
               Ansi.EOL + "\n"]
        buf += self._box("Dock", self._dock_rows(monitors, idx, stage, missing, field), w, dock_focus)
        buf += self._box("Status line", self._mcp_rows(servers, server_idx, stage == STAGE_MCP),
                         w, stage == STAGE_MCP)
        buf += self._box("Launch", self._shell_rows(shell_idx, stage == STAGE_SHELL),
                         w, stage == STAGE_SHELL)
        hint = (self.HINT_DOCK_EDIT[field] if stage == STAGE_EDIT
                else {STAGE_MONITOR: self.HINT_DOCK_MONITOR, STAGE_FORM: self.HINT_DOCK_FORM,
                      STAGE_MCP: self.HINT_MCP, STAGE_SHELL: self.HINT_SHELL}[stage])
        buf.append(f"\x1b[{lines};1H" + Ansi.DIM + fit(hint, w) + Ansi.RESET + Ansi.EOL)
        self.out.write("".join(buf))
        self.out.flush()

    # -- input -----------------------------------------------------------------
    def handle(self, k: str) -> bool:
        if not k:                                # idle tick, or a key with no meaning here
            return True
        rows = self.rows()
        if k.lower() == "q":
            return False
        if k == Key.UP:
            self.cursor -= 1
        elif k == Key.DOWN:
            self.cursor += 1
        elif k == Key.PGUP:
            self.cursor -= self.list_height()
        elif k == Key.PGDN:
            self.cursor += self.list_height()
        elif k == Key.HOME:
            self.cursor = 0
        elif k == Key.END:
            self.cursor = len(rows) - 1
        elif k == Key.F5:
            self.refresh()
            self.status = "Refreshed."
        elif k in (Key.ESC, Key.BACKSPACE, Key.LEFT) and self.project:
            self.cursor = self.projects.index(self.project)
            self.project, self.top = None, 0
        elif k == Key.ENTER or (k == Key.RIGHT and self.project is None):   # → only drills in; never launches
            self.enter()
        elif k.lower() == "o":
            self.open_in(NEW_WINDOW)
        elif k.lower() == "t":
            self.open_in(CURRENT_WINDOW)
        elif k == Key.F2:
            self.rename()
        elif k == Key.DEL:
            self.delete()
        elif k.lower() == "s":
            self.settings()
        self.clamp()
        return True

    def enter(self) -> None:
        item = self.current()
        if item is None:
            return
        if self.project is None:
            self.project, self.cursor, self.top = item, 0, 0
        else:
            self.launch(self.project, item)

    def open_in(self, window: str) -> None:
        """T / O: the same target Enter would open (project folder, or a session resume) placed in
        `window` — CURRENT_WINDOW (tab beside the manager) or NEW_WINDOW (a brand-new window)."""
        item = self.current()
        if item is None:
            return
        if self.project is None:
            self.launch(item, None, window)
        else:
            self.launch(self.project, item, window)

    def launch(self, p: Project, s: Session | None, window: str = SESSIONS_WINDOW) -> None:
        if shutil.which(CLAUDE_EXE) is None:
            self.status = Ansi.RED + f"{CLAUDE_EXE} is not on PATH — install Claude Code first."
            return
        if not p.exists:
            self.status = Ansi.RED + f"Folder missing: {p.cwd or p.enc_dir.name}"
            return
        if s and s.live:
            self.status = Ansi.YELLOW + "That session is already running."
            return
        tab_title = p.display + (f" · {s.title}" if s else "")
        self.store.open_in_new_tab(p.cwd, tab_title, s.sid if s else None, s.title if (s and s.custom) else None, window)
        where = {CURRENT_WINDOW: "here", NEW_WINDOW: "a new window"}.get(window, f"window {window}")
        if self.wait_for_window(tab_title):
            self.status = Ansi.GREEN + f"Opened in {where}: {tab_title}"
        else:
            self.status = Ansi.YELLOW + f"Still opening: {tab_title}"

    def wait_for_window(self, title: str) -> bool:
        """Spin on the footer until the launched terminal window actually exists.

        `subprocess.Popen` returns as soon as `wt` is spawned — long before the window, its shell
        and claude are up — so without this the manager claims "Opened" while nothing is visible
        yet. Polls the real end state (a top-level window with that title) and gives up after a
        hard cap rather than blocking forever, reporting honestly either way."""
        deadline = time.monotonic() + OPEN_TIMEOUT_S
        width = shutil.get_terminal_size().columns - 1
        row = shutil.get_terminal_size().lines
        for frame in itertools.count():
            if find_window(title):
                return True
            if time.monotonic() >= deadline:
                return False
            label = f"{SPINNER_FRAMES[frame % len(SPINNER_FRAMES)]} Opening {title}…"
            self.out.write(f"\x1b[{row};1H" + Ansi.YELLOW + fit(label, width) + Ansi.RESET + Ansi.EOL)
            self.out.flush()
            time.sleep(SPINNER_POLL_S)
        return False

    def rename(self) -> None:
        item = self.current()
        if item is None:
            return
        if self.project is None:
            new = self.prompt("Alias (empty clears): ", item.alias or "")
            if new is not None:
                self.store.rename_project(item, new)
                self.status = "Alias saved."
        else:
            new = self.prompt("Title: ", item.title)
            if new:
                self.store.rename_session(item, new)
                self.status = "Title saved (visible in /resume too)."

    def delete(self) -> None:
        item = self.current()
        if item is None:
            return
        if item.live:
            self.status = Ansi.YELLOW + "Refusing to delete: session(s) still running."
            return
        if self.project is None:
            extra = " INCLUDING its memory/ folder" if item.has_memory else ""
            if self.confirm(f"Delete project '{item.display}' with {len(item.sessions)} session(s){extra}?"):
                self.store.delete_project(item)
                self.refresh()
                self.status = "Project deleted."
        else:
            if self.confirm(f"Delete session '{fit(item.title, 40).strip()}'?"):
                self.store.delete_session(self.project, item)
                self.status = "Session deleted."


# ----------------------------------------------------------------------------- install
def install_paths() -> tuple[Path, Path]:
    """(install dir, Start-menu shortcut)."""
    return (Path(os.environ["LOCALAPPDATA"]) / "Programs" / INSTALL_DIRNAME,
            Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / SHORTCUT_NAME)


def create_shortcut(link: Path, target: str, arguments: str = "", icon: str = "",
                    workdir: str = "") -> None:
    """Write a .lnk through WScript.Shell — the one shortcut API every Windows has, and the reason
    this shells out to PowerShell instead of taking a dependency."""
    script = (f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut({ps_quote(str(link))});"
              f"$s.TargetPath={ps_quote(target)};$s.Arguments={ps_quote(arguments)};"
              f"$s.WorkingDirectory={ps_quote(workdir or str(Path(target).parent))};"
              + (f"$s.IconLocation={ps_quote(icon)};" if icon else "")
              + f"$s.Description={ps_quote(APP_TITLE)};$s.Save()")
    link.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([PS_EXE, "-NoProfile", "-NonInteractive", "-Command", script], check=True,
                   stdout=subprocess.DEVNULL)


def install() -> None:
    """Copy the program somewhere stable and add a Start-menu entry.

    Windows 11 offers no "Pin to taskbar" verb on a bare .exe, and the manager runs inside Windows
    Terminal, so the running window's taskbar button belongs to Terminal — pinning it would pin
    Terminal. A Start-menu entry is the supported route: Start, right-click the entry, pin."""
    target_dir, link = install_paths()
    target_dir.mkdir(parents=True, exist_ok=True)
    frozen = getattr(sys, "frozen", False)
    source = Path(sys.executable if frozen else __file__).resolve()
    icon = ""
    if frozen:
        exe = target_dir / source.name
        if source != exe:
            shutil.copy2(source, exe)
        target, arguments = str(exe), ""
    else:
        # Running from a checkout: point the shortcut at this interpreter and this file, and use the
        # repo's icon so the entry still looks like the app.
        target, arguments = sys.executable, f'"{source}"'
        repo_icon = source.parent / "assets" / ICON_NAME
        icon = str(repo_icon) if repo_icon.exists() else ""
    create_shortcut(link, target, arguments, icon, str(target_dir))
    print(f"installed: {target}")
    print(f"start menu: {link}")
    print("To pin: open Start, find 'Claude Projects', right-click it and choose Pin to taskbar.")


def uninstall() -> None:
    target_dir, link = install_paths()
    link.unlink(missing_ok=True)
    running = Path(sys.executable).resolve()
    if target_dir.exists():
        # Only the copy we are RUNNING FROM has to stay; a build run from elsewhere can clean up
        # fully. Keying this on `frozen` alone left the installed copy behind for good.
        if running.is_relative_to(target_dir):
            print(f"left in place (running from it): {target_dir}")
        else:
            try:
                shutil.rmtree(target_dir)                   # never ignore_errors: a locked exe means
                print(f"removed: {target_dir}")             # an open window, and saying "removed"
            except OSError as exc:                          # would be a lie the user acts on
                print(f"could not remove {target_dir}: {exc}")
                print("A manager window is probably still open from it — close it and re-run.")
    print(f"removed: {link}")


# ----------------------------------------------------------------------------- CLI
def print_list(store: Store) -> None:
    for i, p in enumerate(store.scan(), 1):
        live = LIVE_MARK if p.live else " "
        print(f"{i:>3} {live} {fit(p.display, 28)} {fit(p.cwd or '(unknown)', 60)} {len(p.sessions):>3}  {fmt_time(p.last_used)}")


def self_test() -> None:
    """Data-layer check against a throwaway home. Fails loudly if scan/rename/delete break."""
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / ".claude"
        cwd = str(Path(tmp) / "Work" / "Demo")
        Path(cwd).mkdir(parents=True)
        enc = home / PROJECTS_DIRNAME / Store.encode_path(cwd)
        enc.mkdir(parents=True)
        (enc / MEMORY_DIRNAME).mkdir()
        sid = "11111111-2222-3333-4444-555555555555"
        (enc / f"{sid}{TRANSCRIPT_EXT}").write_text(json.dumps({"type": "user", "cwd": cwd, "sessionId": sid}) + "\n", encoding="utf-8")
        (home / LIVE_SESSIONS_DIRNAME).mkdir()
        (home / HISTORY_FILENAME).write_text(json.dumps({"display": "첫 프롬프트\n둘째 줄", "sessionId": sid}, ensure_ascii=False) + "\n", encoding="utf-8")
        (home.parent / CLAUDE_JSON_FILENAME).write_text(json.dumps({"projects": {cwd: {}}}), encoding="utf-8")

        store = Store(home)
        assert Store.encode_path(r"C:\Users\Terry") == "C--Users-Terry"
        assert Store.encode_path("C:/Local/OneDrive - Movensys/문서/99. Archive") == "C--Local-OneDrive---Movensys----99--Archive"
        projects = store.scan()
        assert len(projects) == 1 and projects[0].cwd == os.path.normpath(cwd) and projects[0].has_memory
        s = projects[0].sessions[0]
        assert s.title == "첫 프롬프트" and not s.live

        store.rename_session(s, "새 제목")
        assert json.loads((enc / sid / CUSTOM_TITLE_FILENAME).read_text(encoding="utf-8"))["customTitle"] == "새 제목"
        last = (enc / f"{sid}{TRANSCRIPT_EXT}").read_text(encoding="utf-8").splitlines()[-1]
        assert json.loads(last) == {"type": CUSTOM_TITLE_TYPE, "customTitle": "새 제목", "sessionId": sid}
        renamed = store.scan()[0].sessions[0]
        assert renamed.title == "새 제목" and renamed.custom and s.custom     # flag set both on rename and on rescan
        cmd = Store.launch_cmd(cwd, "데모 · 새 제목", sid, "새 제목")
        assert cmd[:3] == [WT_EXE, "-w", SESSIONS_WINDOW] and cmd[-4:-1] == [PS_EXE, *PS_ARGS]
        assert Store.launch_cmd(cwd, "데모", window=CURRENT_WINDOW)[:4] == [WT_EXE, "-w", "0", "nt"]
        assert Store.launch_cmd(cwd, "데모", window=NEW_WINDOW)[:4] == [WT_EXE, "-w", "new", "nt"]
        # session shell:each choice wraps the same claude invocation its own way
        argv = [CLAUDE_EXE, CLAUDE_RESUME_FLAG, sid]
        assert Store.shell_cmd(argv, SHELL_NONE) == argv
        assert Store.shell_cmd(argv, SHELL_CMD)[:2] == [CMD_EXE, "/k"]
        assert sid in Store.shell_cmd(argv, SHELL_CMD)[2]
        assert Store.shell_cmd(argv, SHELL_WINPS)[0] == "powershell.exe"
        assert Store.shell_cmd(argv, SHELL_PWSH)[0] == "pwsh.exe"
        assert Store.shell_cmd(argv, SHELL_AUTO)[0] == PS_EXE
        assert store.load_launch_cfg()["shell"] == SHELL_AUTO          # default
        store.save_launch_cfg({"shell": SHELL_CMD})
        assert store.load_launch_cfg()["shell"] == SHELL_CMD
        store.save_launch_cfg({"shell": "nonsense"})
        assert store.load_launch_cfg()["shell"] == SHELL_AUTO          # unknown value ignored
        assert Store.launch_cmd(cwd, "데모", shell=SHELL_CMD)[-2] == "/k"
        if Store.has_windows_terminal():                      # fallback path: pretend wt is missing
            original = Store.has_windows_terminal
            Store.has_windows_terminal = staticmethod(lambda: False)
            try:
                assert Store.launch_cmd(cwd, "데모")[:2] == [PS_EXE, PS_ARGS[0]]
            finally:
                Store.has_windows_terminal = original
        inner = ps_decode(cmd[-1])
        assert inner == f"& 'claude' '--resume' '{sid}' '--name' '새 제목'", inner
        assert CLAUDE_NAME_FLAG not in ps_decode(Store.launch_cmd(cwd, "데모")[-1])
        bypass = ps_decode(Store.launch_cmd(cwd, "데모", claude_args=("--dangerously-skip-permissions",))[-1])
        assert bypass == "& 'claude' '--dangerously-skip-permissions'", bypass
        assert ps_quote("it's") == "'it''s'"
        # install paths are derived, never typed in twice
        target_dir, link = install_paths()
        assert target_dir.name == INSTALL_DIRNAME and link.name == SHORTCUT_NAME
        assert link.parent.name == "Programs"

        store.rename_project(projects[0], "데모")
        assert store.scan()[0].display == "데모"
        store.rename_project(projects[0], "")
        assert store.scan()[0].display == "Demo"

        assert fit("한글제목", 5) == "한글…" and cell_width(fit("abc", 6)) == 6 and fit("ab", 4, True) == "  ab"
        assert wrap_cells("한글abc", 4) == ["한글", "abc"] and wrap_cells("", 5) == [""]
        assert hangul_to_keys("ㅂ") == ["q"] and hangul_to_keys("ㅃ") == ["Q"] and hangul_to_keys("ㅐ") == ["o"]
        assert hangul_to_keys("요") == ["d", "y"] and hangul_to_keys("왜") == ["d", "h", "o"]
        assert hangul_to_keys("값") == ["r", "k", "q", "t"] and hangul_to_keys("a") == [] and hangul_to_keys("\r") == []
        assert Key.decode(0x25, "\x00") == [Key.LEFT] and Key.decode(0x71, "\x00") == [Key.F2]
        assert Key.decode(0x2E, "\x00") == [Key.DEL] and Key.decode(0x0D, "\r") == [Key.ENTER]
        assert Key.decode(0x51, "q") == ["q"] and Key.decode(0x51, "\x00") == ["q"]      # IME idle / composing
        assert Key.decode(0, "ㅂ") == ["q"] and Key.decode(0, "요") == ["d", "y"]         # IME committed Hangul
        assert Key.decode(0, "한", translate=False) == ["한"] and Key.decode(0x10, "\x00") == []
        assert Key.decode(0x09, "\t") == [Key.TAB]
        assert Key.decode(0x09, "\t", state=SHIFT_PRESSED) == [Key.BACKTAB]
        assert Key.feed(0x09, "\t", state=SHIFT_PRESSED) == [Key.BACKTAB]
        assert next_section(STAGE_MONITOR, 1) == STAGE_MCP
        assert next_section(STAGE_SHELL, 1) == STAGE_MONITOR
        assert next_section(STAGE_MONITOR, -1) == STAGE_SHELL
        assert next_section(STAGE_EDIT, 1) == STAGE_MCP        # any dock stage = the dock box
        # IME composing: act on the scan code at once, then swallow the commit that follows
        Key._acted = 0
        assert Key.feed(0xE5, "\x00", 0x18) == ["o"]                      # ㅐ key, still composing
        assert Key.feed(0, "ㅐ") == [] and Key._acted == 0                 # commit cancelled
        assert Key.feed(0xE5, "\x00", 0x20) == ["d"] and Key.feed(0xE5, "\x00", 0x15) == ["y"]
        assert Key.feed(0, "요") == [] and Key._acted == 0                 # two-key syllable cancelled
        assert Key.feed(0xE5, "\x00", 0x1C) == []                         # Enter-to-commit does nothing
        assert Key.feed(0, "ㅂ") == ["q"]                                  # commit with nothing acted on
        assert Key.feed(0x51, "q") == ["q"] and Key._acted == 0            # IME off: unchanged
        assert Key.feed(0, "한", translate=False) == ["한"]                # prompt keeps raw text
        # status line: reads the same caches the Claude statusline publishes
        (home / "cache").mkdir()
        (home / RATE_LIMITS_CACHE).write_text(json.dumps(
            {"five_hour": {"used_percentage": 78, "resets_at": int(time.time()) + 3600},
             "seven_day": {"used_percentage": 57, "resets_at": int(time.time()) + 86400}}), encoding="utf-8")
        (home / MCP_CACHE).write_text(json.dumps({"servers": {"wiki": {"ok": True}}}), encoding="utf-8")
        (home / OUTLOOK_CACHE).write_text(json.dumps({"servers": {"Outlook": {"ok": False}}}), encoding="utf-8")
        (home / PONYTAIL_FLAG).write_text("full\n", encoding="utf-8")
        plain = strip_ansi(Tui(store).status_line(140))   # wide: names shown
        assert "⏳ 5h " + RATE_BAR_ON * 7 + RATE_BAR_OFF * 3 + " 78%" in plain, plain
        assert "📅 7d 57%" in plain and "🤖 MCP ✔" in plain, plain      # no selection = every server
        # picking servers: the label names them, an unknown one reads "?", and an empty pick hides it
        (home / MCP_CACHE).write_text(json.dumps(
            {"servers": {"wiki": {"ok": True}, "chrome": {"ok": False}}}), encoding="utf-8")
        assert store.installed_mcp_servers() == ["chrome", "wiki"]
        store.save_status_cfg({"mcp": ["wiki"]})
        line = lambda: strip_ansi(Tui(store).status_line(140))
        assert "🤖 wiki " + OK_MARK in line(), line()
        store.save_status_cfg({"mcp": ["wiki", "chrome"]})
        assert "🤖 wiki, chrome " + BAD_MARK in line(), line()
        store.save_status_cfg({"mcp": ["wiki", "ghost"]})
        assert "🤖 wiki, ghost " + UNKNOWN_MARK in line(), line()
        store.save_status_cfg({"mcp": ["chrome", "ghost"]})      # a real failure outranks the unknown
        assert "🤖 chrome, ghost " + BAD_MARK in line(), line()
        store.save_status_cfg({"mcp": []})
        assert "🤖" not in line(), line()
        # the detail box reports every fact it has about the highlighted row
        proj = store.scan()[0]
        tui = Tui(store)
        tui.projects, tui.cursor = [proj], 0
        # continuation rows carry an empty label, so only the named ones are compared
        labels = lambda: [l for l in (strip_ansi(lbl).strip() for lbl, _, _ in tui.detail_lines(70)) if l]
        assert labels()[:6] == ["Name", "Path", "Sessions", "Last used", "Memory", "Dir"], labels()
        tui.project = proj
        assert labels() == ["Title", "Named", "Prompt", "Id", "Started", "Modified", "Size",
                            "State", "Project", "File"], labels()   # a renamed session keeps its prompt
        assert Tui(store).handle("") is True                  # idle tick is not a command
        (home / RATE_LIMITS_CACHE).write_text(json.dumps(
            {"five_hour": {"used_percentage": 0, "resets_at": int(time.time()) + 3600}}), encoding="utf-8")
        just_reset = strip_ansi(Tui(store).status_line(140))
        assert "⏳ 5h " + RATE_BAR_OFF * 10 + " 0%" in just_reset, just_reset   # 0% still shows
        store.save_status_cfg({"mcp": None})
        assert store.load_status_cfg()["mcp"] is None and "🤖 MCP" in line()
        assert "📧 Outlook ✘" in plain and "🧔 ponytail full" in plain, plain
        for width in (120, 80, 40, 12):        # never wider than the terminal, values before names
            line = Tui(store).status_line(width)
            assert cell_width(strip_ansi(line)) <= width, (width, line)
        assert "wiki MCP" not in strip_ansi(Tui(store).status_line(80))
        (home / RATE_LIMITS_CACHE).write_text(json.dumps(
            {"five_hour": {"used_percentage": 40, "resets_at": 1}}), encoding="utf-8")   # already reset
        assert "⏳ 5h " + RATE_BAR_OFF * 10 + " 0%" in strip_ansi(Tui(store).status_line(140))

        # dock geometry: percent applies to the EDGE's own axis, on either monitor orientation
        land, port = (0, 0, 2560, 1440), (-1080, -81, 0, 1839)      # this PC's actual two panels
        assert strip_rect(land, "top", 20) == (0, 0, 2560, 288)
        assert strip_rect(land, "bottom", 20) == (0, 1152, 2560, 1440)
        assert strip_rect(land, "left", 20) == (0, 0, 512, 1440)
        assert strip_rect(land, "right", 20) == (2048, 0, 2560, 1440)
        assert strip_rect(port, "top", 25) == (-1080, -81, 0, 399)      # negative origin survives
        assert strip_rect(port, "left", 25) == (-1080, -81, -810, 1839) # 25% of 1080, not of 1920
        for edge in DOCK_EDGES:                                        # clamped, never off-monitor
            l, t, r, b = strip_rect(port, edge, 500)
            assert port[0] <= l < r <= port[2] and port[1] <= t < b <= port[3], edge
        # Per-field arrow axes. Easy to wire up backwards and invisible until someone presses it,
        # so each mapping is pinned here — including that the wrong axis does NOTHING.
        tui = Tui(store)
        tui.dock.cfg = {"enabled": False, "device": None, "edge": "top", "percent": 20}
        cfg = tui.dock.cfg
        tui._edit_field(DOCK_FIELD_EDGE, Key.RIGHT); assert cfg["edge"] == "right", cfg
        tui._edit_field(DOCK_FIELD_EDGE, Key.LEFT);  assert cfg["edge"] == "top"
        tui._edit_field(DOCK_FIELD_EDGE, Key.UP);    assert cfg["edge"] == "top"      # wrong axis
        tui._edit_field(DOCK_FIELD_EDGE, Key.LEFT);  assert cfg["edge"] == "left"     # wraps round
        tui._edit_field(DOCK_FIELD_SIZE, Key.UP);    assert cfg["percent"] == 21
        tui._edit_field(DOCK_FIELD_SIZE, Key.DOWN);  assert cfg["percent"] == 20
        tui._edit_field(DOCK_FIELD_SIZE, Key.RIGHT); assert cfg["percent"] == 20      # wrong axis
        for _ in range(100):
            tui._edit_field(DOCK_FIELD_SIZE, Key.UP)
        assert cfg["percent"] == DOCK_PCT_MAX                                          # clamped
        for _ in range(200):
            tui._edit_field(DOCK_FIELD_SIZE, Key.DOWN)
        assert cfg["percent"] == DOCK_PCT_MIN
        tui._edit_field(DOCK_FIELD_DOCK, Key.UP);    assert cfg["enabled"] is True
        tui._edit_field(DOCK_FIELD_DOCK, Key.DOWN);  assert cfg["enabled"] is False
        tui._edit_field(DOCK_FIELD_DOCK, Key.LEFT);  assert cfg["enabled"] is False   # wrong axis
        assert len(Tui.HINT_DOCK_EDIT) == len(DOCK_FIELDS)      # one hint per editable field
        # the open-progress spinner polls for a REAL window; a title nothing owns must stay unfound
        assert find_window(f"no such window {os.getpid()}") is None
        assert len(SPINNER_FRAMES) > 1 and OPEN_TIMEOUT_S > SPINNER_POLL_S

        # PowerShell 7 when present, the always-installed 5.1 otherwise — both branches, by name
        assert powershell_exe(lambda _: r"C:\somewhere\pwsh.exe") == "pwsh.exe"
        assert powershell_exe(lambda _: None) == "powershell.exe"

        # absent monitor: fall back to primary, name what is missing, never rewrite the saved choice
        mon_a = Monitor(r"\\.\DISPLAY2", land, True)
        mon_b = Monitor(r"\\.\DISPLAY1", port, False)
        assert pick_monitor([mon_a, mon_b], r"\\.\DISPLAY1") == (mon_b, None)      # present: exact
        assert pick_monitor([mon_a, mon_b], None) == (mon_a, None)                 # unset: primary
        assert pick_monitor([mon_a], r"\\.\DISPLAY9") == (mon_a, r"\\.\DISPLAY9")  # gone: says so
        assert pick_monitor([], r"\\.\DISPLAY2") == (None, r"\\.\DISPLAY2")        # no monitors
        assert store.load_dock()["device"] is None    # fallback never writes itself into config

        # config normalization: a hand-edited file must not be able to crash startup
        (home / "config").mkdir(exist_ok=True)
        store.save_dock({"enabled": True, "device": r"\\.\DISPLAY2", "edge": "left", "percent": 33})
        assert store.load_dock() == {"enabled": True, "device": r"\\.\DISPLAY2", "edge": "left", "percent": 33}
        store.dock_file.write_text('{"edge": "sideways", "percent": "junk"}', encoding="utf-8")
        assert store.load_dock() == {"enabled": False, "device": None,
                                     "edge": DOCK_DEFAULT_EDGE, "percent": DOCK_PCT_DEFAULT}
        store.dock_file.write_text("not json at all", encoding="utf-8")
        assert store.load_dock()["edge"] == DOCK_DEFAULT_EDGE
        store.dock_file.unlink()
        # docked-HWND state: what lets the NEXT run release a reservation a hard kill stranded
        assert store.load_docked_hwnd() is None                       # absent file
        store.save_docked_hwnd(135076)
        assert store.load_docked_hwnd() == 135076
        assert "hwnd" not in store.load_dock()                        # never leaks into user config
        store.save_docked_hwnd(None)
        assert store.load_docked_hwnd() is None
        store.dock_state_file.write_text('{"hwnd": "not-a-handle"}', encoding="utf-8")
        assert store.load_docked_hwnd() is None                       # corrupt file must not throw
        store.dock_state_file.unlink()
        # BOM: Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes one, and a plain utf-8
        # read would reject it and silently hand back defaults, i.e. lose the user's settings.
        store.dock_file.write_text('﻿{"enabled": true, "edge": "right", "percent": 40}', encoding="utf-8")
        assert store.load_dock() == {"enabled": True, "device": None, "edge": "right", "percent": 40}
        store.dock_file.unlink()

        store.delete_session(projects[0], s)
        assert not (enc / sid).exists() and not (enc / f"{sid}{TRANSCRIPT_EXT}").exists()
        assert store.scan()[0].cwd == os.path.normpath(cwd)          # path recovered from .claude.json
        store.delete_project(projects[0])
        assert store.scan() == []
    print("self-test OK")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--home", type=Path, default=CLAUDE_HOME, help="Claude home (default ~/.claude)")
    ap.add_argument("--list", action="store_true", help="print the project table and exit")
    ap.add_argument("--self-test", action="store_true", help="run the data-layer self-check")
    ap.add_argument("--install", action="store_true",
                    help="add a Start-menu entry (from which Windows can pin it to the taskbar)")
    ap.add_argument("--uninstall", action="store_true", help="remove that Start-menu entry")
    ap.add_argument("--claude-arg", action="append", default=[], metavar="ARG",
                    help="extra option for every claude launched from the manager; use --claude-arg=--flag form (repeatable)")
    a = ap.parse_args()
    if a.install:
        install()
    elif a.uninstall:
        uninstall()
    elif a.self_test:
        self_test()
    elif a.list:
        print_list(Store(a.home))
    else:
        Tui(Store(a.home, a.claude_arg)).run()


if __name__ == "__main__":
    main()

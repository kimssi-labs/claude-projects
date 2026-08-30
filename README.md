<img src="app/build/icon.png" width="96" align="right" alt="">

# Hangar

**Session manager for [Claude Code](https://claude.com/claude-code).** Where your sessions are kept
between flights: Hangar lists every project you have ever opened, drills into that project's
sessions, and resumes, renames or deletes them — in one window, driven by the keyboard, with no LLM
tokens spent.

It can also **dock to a screen edge**: not merely a window parked at the side, but a reserved band
the desktop works around, so a maximised window stops at it instead of covering it.

## Why

`/resume` shows one flat list of sessions for the current folder. This shows **every project**, what
is running right now, what each session is costing in CPU and memory, and lets you jump straight into
any of them in a new terminal — while the manager stays open for the next one.

## Install

Download from [Releases](../../releases):

| Platform | File |
|---|---|
| Windows | `Hangar Setup <version>.exe` (installer) or `Hangar <version>.exe` (portable) |
| Linux | `.AppImage` (any distribution) or `.deb` |

Nothing else is needed — the app only reads files Claude Code already writes, and launches `claude`
from your `PATH`.

From source (Node 20+):

```bash
git clone https://github.com/kimssi-labs/hangar.git
cd hangar/app
npm ci
npm run build && npx electron .      # or: npm run dev
```

Optional — make it a flag on `claude` itself, by adding this to your PowerShell `$PROFILE`:

```powershell
function claude {
    $i = [array]::IndexOf($args, '--p')
    if ($i -lt 0) { & (Get-Command claude -CommandType Application) @args; return }
    Start-Process "$env:LOCALAPPDATA\Programs\Hangar\Hangar.exe"
}
```

Then `claude --p` opens the manager. The permission mode sessions start in is a setting
(**Settings · Permissions**), not something the wrapper decides.

## Keys

Everything is reachable from the keyboard; `?` shows this list in the app.

| Key | Projects | Sessions |
|---|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | move | move |
| `Enter` | open the project's sessions | resume in a new terminal |
| `O` | new session in a new window | resume in a new window |
| `F2` | set a display alias | rename the session |
| `Del` | delete the project folder | delete the session |
| `/` | search projects | search projects |
| `S` | settings | settings |
| `←` `Esc` | — | back to projects |
| `Tab` | — (settings: next section) | — |
| `F5` / `Ctrl+Q` | refresh / quit | refresh / quit |

Deletions ask first and refuse anything still running. Renaming a session writes the same
`custom-title.json` Claude Code's own `/rename` writes, so the new name also shows up in `/resume`.

## Monitoring

Every running session is sampled once a second — its whole process tree, not just the `claude`
process — and drawn as a sparkline in its row; the machine's own CPU, clock speed and memory are
drawn beside the list. Five minutes of history is kept, which is enough to see whether a session is
working or stuck.

A monitor may not be the reason a machine is busy, so every reading is taken in-process — a toolhelp
snapshot plus `GetProcessTimes` on Windows, `/proc` on Linux, `os.cpus()` for the machine itself —
and on a worker thread, so none of it lands on the thread that draws the window. Sampling costs
about 3 % of one core, and **Settings · Monitoring** turns it off entirely, stopping the timer
rather than just the drawing.

## Layout

The window has four shapes and picks one from its own size, so it works docked as a thin band on any
edge without a scrollbar:

| Shape | When | What it shows |
|---|---|---|
| Full | wide and tall | project list, session list, detail panel, machine graphs |
| Compact | narrow | list and graphs, no detail panel |
| Band | short (top/bottom dock) | one strip: list plus graphs |
| Stacked | narrower than the width you set | project list, its sessions and the graphs, one under the other |

**Settings · Layout** decides: side by side, stacked, or stacked below a width of your choosing.
The three panes can also be dragged to any width; double-click a divider for the default back.

## What it reads

Everything comes from files Claude Code maintains under `~/.claude` (override with `CLAUDE_HOME`):

| Path | Used for |
|---|---|
| `projects/<encoded-path>/*.jsonl` | one transcript per session; the real folder comes from its `cwd` |
| `projects/<encoded-path>/<id>/custom-title.json` | session title set by `/rename` |
| `sessions/*.json` | which sessions are running right now (the ● mark) |
| `history.jsonl` | first prompt of a session, used as its title when it has no custom one |
| `~/.claude.json` | folder path for projects whose transcripts are gone |
| `config/manager.json` | this app's own settings: dock (per monitor), status line, launch, appearance |
| `config/project-aliases.json` | display aliases for projects |

The status strip is optional: each segment appears only if that source exists on your machine — rate
limits from `cache/rate-limits.json` (5 h, 7 d, and the weekly Fable/Opus and Sonnet windows), MCP
health from its status cache. On a machine without them the segment is not drawn at all.

## Settings (`S`)

One screen of cards — **Appearance**, **Layout**, **Monitoring**, **Dock**, **Status line**,
**Launch**, **Permissions**. `Tab` moves between them, `Esc` closes. Every choice, and the project and row you were last on, is kept in
`config/manager.json`.

**Appearance** — light, dark, or system. System follows the OS setting and changes with it, without
a restart.

**Dock** places the manager as a reserved band on a monitor edge — pick the monitor, then the edge,
size and on/off. Dragging the band's inner edge sets its size; dragging the window anywhere else
undocks it. Monitors are remembered by where they are and how big they are, because Electron's
display ids are not the same from one run to the next.

The space is genuinely reserved: on Windows through an application desktop toolbar
(`SHAppBarMessage`), on Linux/X11 through `_NET_WM_STRUT_PARTIAL`, both of which shrink the work area
so maximised windows stop at the band. Wayland has no equivalent an ordinary application may use, so
there the window is positioned but nothing is reserved, and the screen says so.

Every monitor keeps its own edge, size and on/off — a band that suits a portrait display is wrong on
a wide one — and displays with saved settings are marked `(saved)`. Each **arrangement** of monitors
also remembers which of them was docked, so plugging a screen in or out brings back that setup. A window manager may refuse to
shrink below some minimum; the first refusal is measured and becomes the lower bound of the size
setting, so what the screen shows is what docking will give you.

**Status line** lists the MCP servers this machine has — from `~/.claude.json` and from the probe
cache — and lets you check the ones the segment should report, with **Select all** / **Select none**
and an "Every server, always" mode that follows the list as it changes. Uncheck everything and the
segment disappears.

**Launch** picks the terminal and shell that host an opened session: PowerShell 7, Windows
PowerShell, Command Prompt or none on Windows; on Linux the first terminal emulator found, or a named
one. A missing executable is marked rather than failing when a session is opened.

**Permissions** picks the mode a session starts in — ask (default), bypass, accept edits, plan, or
auto.

## Development

```bash
cd app
npm run dev          # vite + electron, hot reload
npm run typecheck
npm test             # unit tests (vitest)
npm run e2e          # end-to-end against the built app (playwright)
npm run dist         # installers into app/release
```

CI runs typecheck, unit tests and the end-to-end suite on Windows and Linux for every push; a tag
builds the installers on both and publishes them.

Tests are filed by what they cover, and a fix lands with the case that would have caught it:

| Where | What it covers |
|---|---|
| `src/core/__tests__` | the feature's own logic — scanning, config, launch commands, key map, layout rules |
| `src/main/__tests__` | the main process: docking arithmetic and what the OS is asked for |
| `src/renderer/__tests__` | what the window decides to draw |
| `e2e` | the built app, driven like a person: keyboard, settings, and the real docked window |

The end-to-end suite drives the real window: it docks to every attached monitor on every edge and
checks the desktop's work area really changed and came back. A machine with one screen exercises
one, and the run says which it checked.

## Requirements

Windows 10/11 or Linux (X11 for docking), and `claude` on `PATH`.

## Releases

Every version's changes are listed in [CHANGELOG.md](CHANGELOG.md); CI publishes that section as the
release notes and refuses to release a tag that has no section.

Versions up to **v1.15.0** were *Claude Projects*, a Windows terminal application written in
Python; it is still downloadable from its release, and its source is in this repository's history.

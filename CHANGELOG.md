# Changelog

Every release is built from the tag by CI, which uses the matching section below as the release
notes. Add the section **before** tagging.

## v1.6.0

- `--install` adds a Start-menu entry (copying the exe to `%LOCALAPPDATA%\Programs\ClaudeProjects`),
  which is what makes *Pin to taskbar* available — Windows 11 offers that verb only from the Start
  menu, and pinning the running window would pin Windows Terminal instead.
- `--uninstall` removes the entry again.

## v1.5.0

- The screen redraws itself every 15 s while idle, so the status line no longer shows values from
  whenever a key was last pressed — a rolled 5 h or 7 d window, and sessions that started or ended
  meanwhile, now appear on their own.

## v1.4.0

- `Tab` / `Shift+Tab` move between the settings group boxes; the `D` / `M` / `L` letter shortcuts are
  gone, so no key means two things depending on where you are.
- The project and session screens are drawn as group boxes too — the list in one, the detail viewer
  in the other — so every screen in the app now reads the same way.
- The box title carries where you are (project count and path, or the project's folder).

## v1.3.0

- Settings is one screen: **Dock**, **Status line** and **Launch** are each drawn in their own group
  box, all visible at once. The focused box expands; the other two collapse to a summary line.
- `D` / `M` / `L` switch between the boxes from anywhere on the screen.
- One cursor on screen at a time: `▸` marks the focused row, `[x]` marks what is chosen.

## v1.2.0

- **Settings · Launch**: choose the shell that hosts an opened session — Auto (PowerShell 7 when
  installed, else Windows PowerShell), PowerShell 7, Windows PowerShell, Command Prompt, or no shell
  at all (the tab then closes with `claude`).
- A choice whose executable is missing is marked `(not found)` instead of failing when a session is
  opened.
- Saved in `config/manager-launch.json`.

## v1.1.0

- **Settings · Status line**: pick which MCP servers the 🤖 segment reports on, from the servers
  found in `~/.claude.json` and in the probe cache. Each row shows its current verdict.
- The segment reads ✔ when every checked server is healthy, ✘ when one is failing, and a dim `?`
  when a checked server has no verdict yet; unchecking all of them hides it.
- No selection keeps the previous behaviour of reporting every server. Saved in
  `config/manager-status.json`.

## v1.0.0

First public release.

- Project list (last used first) with a live-session mark, session count, memory flag, and the
  session list behind `Enter`.
- Resume, open, rename and delete, each in a tab of the `Claude` window (`Enter`), the current
  window (`T`) or a new window (`O`).
- Renaming a session writes the same `custom-title.json` Claude Code's `/rename` writes, so the new
  title also shows in `/resume`.
- Detail viewer under the list, optional status line (rate limits, MCP, Outlook, ponytail), AppBar
  docking, and Korean-IME-safe keys.
- Single-file `ClaudeProjects.exe`, standard library only.

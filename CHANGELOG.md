# Changelog

Every release is built from the tag by CI, which uses the matching section below as the release
notes. Add the section **before** tagging.

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

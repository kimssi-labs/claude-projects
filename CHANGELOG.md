# Changelog

Every release is built from the tag by CI, which uses the matching section below as the release
notes. Add the section **before** tagging.

## v1.11.0

- Sessions start from the resolved `claude` executable with the flags appended, instead of the bare
  name. A `claude` function in the user's PowerShell profile (the `claudex` wrapper, for one)
  outranks the executable in that shell, so the permission mode the manager set could be replaced by
  whatever the wrapper forwarded; now `claude --dangerously-skip-permissions …` means exactly that.

## v1.10.0

- **Much faster redraws.** A frame no longer touches the filesystem: a project's folder check and
  last-used time are resolved by the scan, and an unreachable path (a UNC share whose host is off)
  is probed off the UI thread instead of stalling every row of every frame — 4.5 ms → 0.4 ms per
  frame here. Keystrokes that are already queued skip their frame, so holding a key no longer piles
  up redraws.
- Scanning is cheaper too: `history.jsonl` is only re-parsed when it changes and a transcript's
  folder is remembered per file, halving the idle refresh.
- **Renaming no longer duplicates the line.** A title that reached the end of the row made the
  terminal wrap and scroll, leaving a copy behind on every keystroke; the editor is now one row and
  scrolls sideways, showing the end of what you are typing.
- **The dock is remembered per monitor** — edge, size and on/off belong to the display, and moving
  the cursor in the monitor list shows what that monitor would go back to. Monitors with saved
  settings are marked `(saved)`.

## v1.9.0

- The exe carries a full Windows version resource, so File properties → Details is filled in:
  company and copyright **kimssi-labs** (MIT), product and description, internal and original
  filename, and the version — both File and Product.
- `__version__` in the source is the single origin of that version; `--version` prints it, and CI
  refuses a tag that disagrees with the source, `pyproject.toml`, or the built exe.

## v1.8.0

- **Settings · Permissions**: the mode every session opened from the manager starts in — Ask
  (default), Bypass permissions, Accept edits, Plan, or Auto. Launching the exe directly used to
  mean plain `claude`; the mode is now a setting rather than something only the `claude --p` wrapper
  could pass.
- A mode already given on the command line (`claudex --p`) still wins, and the box says so instead
  of showing a setting that is being overridden.
- Saved in `config/manager-launch.json` next to the shell choice.

## v1.7.0

- The detail box now reports everything the manager knows about the highlighted row, one labelled
  field per fact: a project shows its alias and real folder, path (called out in red when the folder
  is gone), session count with how many are running and their total size, last use, whether a
  `memory/` folder would be deleted with it, and its encoded directory; a session adds whether the
  title is a name or its first prompt, the prompt itself when a name replaced it, when it started,
  its state, and which project it belongs to.
- `--uninstall` no longer prints "removed" when the folder could not be deleted — a manager window
  still running from it now says so.

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

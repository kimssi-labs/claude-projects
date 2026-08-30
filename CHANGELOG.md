# Changelog

Every release is built from the tag by CI, which uses the matching section below as the release
notes. Add the section **before** tagging.

## v2.0.0

**Claude Projects is now Hangar, a desktop application.** Same job, same keys, a window instead of a
console — and it runs on Linux as well as Windows. The new name keeps a third-party tool from
reading as an official product; *for Claude Code* is a subtitle, never part of the name.

- Rewritten in Electron and TypeScript. Every feature of the terminal version is here: the project
  and session lists, resume in a tab or a new window, aliases, `/rename`-compatible session titles,
  guarded deletes, search, per-monitor docking, the status strip, and the launch and permission
  settings.
- **Docking still reserves the space.** The band is registered as an application desktop toolbar on
  Windows and as `_NET_WM_STRUT_PARTIAL` on X11, so the desktop work area shrinks and a maximised
  window stops at the band instead of covering it. Wayland cannot do this for an ordinary
  application, and the screen says so rather than pretending.
- **CPU and memory monitoring that costs nothing.** Each running session's whole process tree is
  sampled once a second and drawn in its row; the machine's own CPU, clock speed and memory are
  charted beside the list, with five minutes of history. Every reading is taken in-process — a
  toolhelp snapshot and `GetProcessTimes` on Windows, `/proc` on Linux, `os.cpus()` for the machine.
  The obvious library for this shelled out to WMI: `processes()` measured 3.6 s per call and `mem()`
  3.3 s, once a second. The whole app now costs about 3 % of one core.
- **Monitoring can be switched off** (Settings · Monitoring). Off is not a hidden graph: the timer
  stops and nothing is measured at all.
- **Light, dark and system themes.** System follows the OS and changes with it, without a restart.
- **Four layouts, chosen from the window's own size** — full, compact, a horizontal band for a
  top/bottom dock, and a vertical column for a left/right dock. None of them scrolls the page.
- The usage strip reads the weekly Fable/Opus and Sonnet windows as well as the 5-hour and 7-day
  ones, when Claude Code has published them.
- **Usage is drawn as bars**, one fixed-width column per window, so the labels line up with each
  other and the percentages line up with each other however many windows a machine reports. A band
  too narrow for all of them fades at the edge instead of clipping one in half.
- **The three panes can be dragged to any width** — double-click a divider to go back to the
  layout's own. Widths are remembered like every other setting.
- Dragging or resizing a docked window undocks it and gives the edge back, instead of snapping the
  window into the band it just left.
- **Everything is remembered**: the window's own size and position (restored only if that rectangle
  is still on a connected display), the pane widths, the theme, the per-monitor dock, the shell and
  permission mode, the MCP servers the strip reports, and the project and row you were last on.
- Keyboard operation is unchanged, and `?` lists every key.
- The band gives its edge back the moment the window closes, and fills the space it reserved exactly
  — Windows enforces a window's minimum size and drags it back inside the work area unless both are
  handled, which is what left a strip of desktop above the window and a shrunken desktop behind it.

The Python terminal version is not part of this release. It remains available as **v1.15.0** under
the old name, and its source is in this repository's history.

## v1.15.0

- The size setting stops at what the terminal will actually do. Once a refusal has been measured on
  an axis, that floor becomes the lower bound — stepping down stops there instead of changing a
  number nothing acts on — and the row states it: `38 %  →  583 px  min 38 % (terminal floor 580 px)`.
- Opening the settings screen raises a saved size that is under the floor and says so, so what the
  screen shows is what docking will give you.

## v1.14.0

- A left or right dock that seemed to ignore the size setting now explains itself. Windows Terminal
  refuses to shrink past a minimum that depends on its font (measured 580 px here), so every
  percentage below that produced the same window. The manager remembers that floor per axis and
  shows it beside the size — `20 %  →  307 px  ! terminal floor 580 px` — instead of promising a
  width the terminal will not give.
- The floor is stored per axis in `config/manager.json`, so the warning is there before you apply.

## v1.13.0

- **Narrow windows no longer tear the frame.** List rows had minimum column widths that made them
  wider than their box below about 45 columns, so every row wrapped and overlapped the borders.
  Columns are dropped as the window narrows — memory flag, then date, then count, then the path —
  and the name keeps what is left; a dropped column now renders as nothing instead of a stray `…`.
- Box titles, framed rows and detail labels are clamped to the width they actually have, and the
  settings screen never draws more rows than the window is tall.
- Checked across 165 size combinations from 200×60 down to 12×6: nothing exceeds the frame.

## v1.12.0

- Everything the manager remembers now lives in one file, `config/manager.json`, with a section per
  feature (`dock`, `status`, `launch`, `ui`). Settings written by an older build are still read from
  their single-purpose files until the section exists, so nothing is lost on upgrade.
- **Where you were is remembered too**: the project that was open and the row the cursor was on come
  back on the next start.

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

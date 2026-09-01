# Changelog

Every release is built from the tag by CI, which uses the matching section below as the release
notes. Add the section **before** tagging.

## v2.6.2

- **An upright usage bar still says when the window frees up.** Narrowing the pane stood the rate
  cards up and dropped the reset line with the rest of the text — losing the one thing the gauge is
  consulted for. The upright card now carries the time remaining (`↻ 2h 11m`) under the percentage,
  with the exact clock time still in the tooltip.

## v2.6.1

- **A card at the boundary no longer flickers between its two shapes.** Standing a card upright
  frees width, which put it back over the threshold, which laid it down again — one threshold
  cannot decide a question whose answer changes the measurement. Going upright now happens below
  132 px and lying back across only above 168 px, so a card at any width settles.
- **Memory reads as a share as well as a quantity** — `47% · 15 GB` beside CPU's `27% · 1.7 GHz`,
  so both machine gauges answer the same two questions.

## v2.6.0

A day of living in the docked band, fixing what it made visible.

### The window

- **Docking has its own caption button** — leftmost, before the three the OS always has. Maximise
  and docking used to share a button, so "restore" gave back a screen edge in one state and a window
  size in the other; now maximise always means fill the screen, restore always means the last window
  size, and the dock button toggles the band. Its glyph is drawn for the configured edge: a wall on
  that side, an arrow into it to dock, out of it to undock.
- **Undocking puts the window back on screen.** Releasing the band used to leave the window exactly
  where the band was — a strip pressed against the edge, sometimes past it. It now returns to the
  remembered window rectangle, or centred at the default size, clamped inside the work area either
  way. Maximising from a docked state gets the same placement first, so the restore after it has a
  window shape to come back to.
- **The title bar is a title bar**: icon, name, version, caption buttons. Keys moved off button faces
  into tooltips.

### Usage and monitoring

- **The usage gauges moved off the title bar**, where a narrow window cut them off, and sit with the
  CPU and memory graphs in every shape — same cards, same format. **Settings · Status line** ticks
  which windows are drawn.
- **The CPU clock is live now.** `os.cpus()` reports the figure the registry was given at boot — a
  flat 2995 MHz on all twenty cores here while the real clock swung — so the reading came from PDH's
  `% Processor Performance` times the base clock instead, the same sum Task Manager shows. Verified
  against a one-core burner (expected 5.0 % of 20 cores, read 4.9 %) and an independent
  measurement of a live session's tree (5.8 % vs 4.6 %).
- **Memory says what it is out of** (`12 GB / 31.7 GB`), and the label is Memory, not Mem — the
  abbreviation only appears where the card is too narrow for the word.
- **Narrow cards shrink first, then stand up.** Cards share the row's width evenly however many
  there are; below reading width each becomes an upright bar with the short label, and the full
  reading lives in its tooltip.
- **A live session row draws CPU and memory as separate sparklines**, each with its own number, on a
  shared baseline with headroom — one line no longer rides the canvas top while the other sits on
  the bottom border.
- **Rows wrap instead of overlapping.** Too narrow for a name and its numbers on one line, the
  numbers drop to a second line; the thresholds are measured per row kind, because a live session
  row carries 324 px of fixed content and a project row about 110.
- **The per-model weekly gauges are gone.** Verified against the real payload with Fable 5 running:
  Claude Code sends `five_hour` and `seven_day`, and nothing else — so the Fable/Opus and Sonnet
  windows could never draw, and only made the settings list lie.
- **The Outlook and ponytail segments are gone** for the same reason as MCP before them: each read a
  cache only this one machine's own scripts write.

### Settings and launch

- **Pane sizes are remembered as fractions of the window**, saved as you let go of the divider — a
  pixel count set in a wide window was wrong in a docked band, which is how the stacked sessions
  pane ended up eight pixels tall.
- **Custom program means a program like VS Code**: opening a session starts it on the project folder
  — no terminal around it, no claude command passed, which such a program would read as files to
  open. An empty path still falls back to Auto.
- The launch screen now says plainly that the automatic screenshot path has **no shortcut of its
  own** — plain Ctrl+V is the whole gesture — and that Ctrl+Alt+V is a fallback for a clipboard that
  already carries text.
- The stack-below slider is gone from Layout: auto simply stacks when the window is narrow.

## v2.5.1

Both faults were found by living with a docked band, and both are fixed with a case that fails
without the fix.

- **Stacked: entering a project shows its sessions again.** The divider between the project list and
  the sessions is remembered in pixels, and a docked band is usually far shorter than the window it
  was set in — 661 px of project list in a 762 px band left the sessions eight pixels of room, which
  reads as nothing at all. The remembered height is still kept, and still used in full wherever it
  fits; what is drawn is now cut to the space the two panes actually share, measured rather than
  guessed, so the lower pane is never smaller than a list.

- **Dragging a band's grip moves it the distance you dragged.** Re-asserting the band — the guard
  that undoes what the shell does to it behind our back — was also undoing each step of a drag in
  progress, putting the window back to the size it had before the drag started. Measured on a
  left-hand band: a 120 px drag moved it 48 px, the few steps that happened to land between two
  corrections. Re-asserting now stands aside while the hand is on the grip. Verified across both
  monitors on all four edges: 120 px dragged, 120 px given, and the far edge never moves.

## v2.5.0

- **A docked band cannot be dragged or pulled off its edge, and does not pretend it can.** Docking
  is the maximised state, so the title bar no longer drags the window and the frame no longer
  resizes at all — Windows draws the resize cursor for every side of a frame at once, so the only
  way to stop three sides offering a resize that cannot happen was to stop the frame resizing and
  give the fourth side a grip of its own. Measured: arrow on all four sides of the frame, and the
  resize cursor only on the band's inner edge.
- **Resizing the band no longer jumps or flickers.** Two faults, both measured on a top-docked band:
  settling a drag re-applied the whole dock, which recomputed the band from a percentage rounded to
  a whole number and placed the window up to twenty pixels from where the drag ended; and the new
  reservation was asked for at the window's own position, which the shell answers with the free
  space **below the band's existing reservation** — so the band walked down the screen by its own
  height, `y = -81` becoming `y = 499`. The band is now reserved anchored to its edge at exactly the
  thickness dragged to, and the window is not moved at all unless the shell insists.
- **Every usage window says when it resets** — in the docked band too, which used to drop it for
  want of room, and that is the shape the app is left in all day. The reading leads with the time
  left rather than a bare clock time, because "when does this free up" is the question a percentage
  provokes: `9% ↻ 4h 43m left · 19:00`. A weekly window counts in days, not in three-digit hours.
- **The usage strip is legible from across the desk.** The percentage went from 12 px to 16 px and
  the bar from 6 px to 10 px tall, with brighter labels.
- **The MCP segment is gone.** Claude Code exposes no live MCP state, so the dot could only report a
  separate handshake against one configured server — it never moved when a server was reconnected in
  the session, which is the only thing it was being read for. Its settings section went with it.

## v2.4.0

- **Your ordinary paste key now works for screenshots.** Copy one and Hangar writes it out and
  leaves the clipboard holding both the picture and that file's path, so Ctrl+V in a terminal
  pastes the path while Ctrl+V in an image editor still pastes the image — each window takes the
  format it understands. Nothing is intercepted, so no other application's paste is affected, and
  the shortcut remains for a clipboard that already carries text. **Settings · Launch** turns it
  off; the last 50 screenshots are kept and older ones are cleared out. Windows only.
- **The paste shortcut now actually pastes.** It was sending Ctrl+V about 60 ms after the shortcut
  fired — while the hand that pressed Ctrl+Alt+V was still on those keys, so the terminal received
  Ctrl+Alt+V, which is not paste, and nothing appeared. The image was saved and the path was on the
  clipboard the whole time, which is why it looked like nothing had happened at all. Hangar now
  waits for the modifiers to come up before it sends anything (up to 1.2 s, then sends regardless
  rather than swallowing the paste). Measured: a 250 ms hold pasted nothing before, the path after.

## v2.3.1

- **The paste shortcut says what happened.** It is pressed in another window, so a toast inside
  Hangar was the same as saying nothing: there is now a desktop notification either way — the image
  is ready, or there was none on the clipboard — and Settings says plainly when another application
  is holding the shortcut. (Hangar has to be running for it to work at all, which the screen now
  also says.)
- **A Back button on the settings screen**, since `Esc` is only obvious to someone who already knows
  it. `Esc` still works.
- A cut-off label carries its tooltip in the same frame it is cut, not one render later — and the
  test that checks it now names the labels that went quiet instead of counting them.
- The window no longer grows by three pixels each time it is reopened: the saved rectangle was
  restored through the constructor, which does not measure a window the same way `setBounds` does.

## v2.3.0

- **Paste a screenshot into a terminal session.** A terminal cannot take a bitmap, so copying a
  screenshot used to mean saving it somewhere by hand and typing the path. Press **Ctrl+Alt+V** in
  the terminal instead: Hangar writes the clipboard's image out, puts that file's path on the
  clipboard, and sends the paste — the path lands where the cursor already is, ready for Claude Code
  to open. The shortcut is a setting (Launch), and `V` in Hangar's own window does the same thing
  without the keystroke.
- **A docked band has no border of its own.** Measured against the desktop: the top row, the bottom
  row and about three columns at each side were the wallpaper showing through — Windows 11's 1 px
  border and rounded corners. Docked, the window is told to have neither, so the band ends exactly
  where the screen does.

## v2.2.5

- **A loading window, in the order you would expect**: it appears first and alone — measured at
  340 ms from launch, which is as soon as Electron can draw anything — names each step while the app
  starts hidden behind it, and is closed as the app's own window is shown, once that window has
  actually rendered. Nothing half-drawn appears on the way.
- **Each MCP server has its own indicator.** "MCP ✔" answered a question nobody asked; every checked
  server now gets its own dot and its own tooltip — connected, not responding, or never probed.
- **Launch · Custom program**: name the executable that hosts a session, and it is started with the
  claude command as its arguments. Left empty it behaves as Auto, so a session still opens.

## v2.2.4

- **Docked is the maximised state, and now behaves like one.** The maximise button docks — back to
  the band this arrangement remembers — and restore undocks into an ordinary resizable window. While
  docked the window is not movable and not maximisable, so it cannot be dragged off its edge at all;
  putting it back on every move event was fighting the window manager's own drag loop instead.
- **The loading panel is the window itself.** A second window meant a second renderer starting up
  beside the app's own — 800 ms — so the "loading" window arrived after the loading. The panel is
  markup in the page, painted when the document parses, and the window is shown the moment it is
  created: measured **1,000 ms → about 500 ms** from launch, with the taskbar button showing
  progress from that same moment.
- **Text that does not fit says the whole of itself on hover** — measured rather than guessed, so a
  label only carries a tooltip when it is really cut off. The MCP segment lists every server it was
  asked about with its verdict, one per line.
- **The splash arrives about twice as early.** It was waiting for its page to load — 800 ms, because
  its renderer was starting up beside the app's own — and only then appearing. The window is shown
  the moment it is created, painted by the compositor from its background colour, with the text
  filling in behind it: measured 1,000 ms → 400-550 ms from launch.

## v2.2.3

Everything the 2.x line changed, in one place — the terminal manager became a desktop app, and the
faults found while living with it were fixed.

### The app

**Claude Projects became Hangar**, an Electron + TypeScript desktop app for Windows and Linux with
every feature and every key of the terminal version. The name is Hangar; *for Claude Code* is a
subtitle, never part of the name or the appId, so a third-party tool does not read as an official
one. The Python terminal version remains downloadable as **v1.15.0**.

- **No title bar.** The caption buttons are drawn in the app's own header, so a docked window fills
  its band edge to edge. Docked counts as the maximised state: the middle button offers to restore,
  and restoring is what gives the edge back.
- **Four shapes, chosen by the window's own size** — full, compact, a band for a top/bottom dock,
  and a stacked column. **Settings · Layout** picks side-by-side, stacked, or stacked below a width
  you choose. Every pane can be dragged to any width, and the stacked layout has its own divider.
- **Light, dark and system themes**, the system one following the OS without a restart.
- **A splash while it starts**, naming each step, and only when starting takes longer than 450 ms.
- Usage bars for the 5 h, 7 d and weekly Fable/Opus and Sonnet windows, each percentage beside the
  bar it measures, with a refresh button; every segment of the strip — usage, Outlook, ponytail, and
  each MCP server — can be turned on or off.
- **Everything is remembered**: window size and position, pane widths, theme, layout, the shell and
  permission mode, and the dock — per monitor *and* per monitor arrangement, so plugging a screen in
  or out brings back that setup.

### Docking

The band is genuinely reserved — an application desktop toolbar on Windows, `_NET_WM_STRUT_PARTIAL`
on X11 — so a maximised window stops at it. Wayland cannot do this for an ordinary application, and
says so instead of pretending. Faults fixed along the way, each with a test that fails without it:

- The band **fills exactly what it reserved**: Windows enforces a window's minimum size and drags it
  back inside the work area unless both are handled.
- The edge is **given back the moment the window closes**, synchronously — an async release loses the
  race with process exit. A forced kill leaks nothing either; Windows reclaims it.
- **A percentage means the same thing every time.** Three faults compounded into a band that grew on
  its own — 12 % became 26 %, then 35 %, then 53 %.
- **A second monitor works.** Electron's display ids are not stable between runs, so a dock saved for
  the second screen came back on the first; and the DIP-to-pixel conversion used the scale of the
  monitor the *window* was on, not the one being docked to.
- **A resized band stays on its edge** instead of drifting inwards, and **dragging or maximising a
  docked window keeps it docked** — only restoring undocks.
- A dock change made in **Settings** sticks rather than being overridden on the next read.

### Speed

The window used to freeze for tens of seconds. Three causes, all measured:

- A project on an unreachable network share made every scan wait for the SMB timeout — **10.9 s**,
  on the thread that draws the window. Reachability is now answered by a background probe.
- Reading a transcript's first line read the whole file: 48 MB, 23 MB, 20 MB, once per scan. Only
  the first 64 KB is read, and the answer is kept — **a scan went from 21 s to 36 ms**.
- Registering or removing the band makes the shell tell every window on the desktop; that call runs
  on a worker thread now.

**Monitoring costs about 3 % of one core.** The obvious library for it shelled out to WMI —
`processes()` measured 3.6 s per call and `mem()` 3.3 s, once a second — so every reading is taken
in-process (a toolhelp snapshot and `GetProcessTimes` on Windows, `/proc` on Linux, `os.cpus()` for
the machine) on a worker thread. Each running session's whole process tree is sampled once a second
and drawn in its row, with the machine's CPU, clock speed and memory beside the list.
**Settings · Monitoring** turns it off entirely — the timer stops, not just the drawing.

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

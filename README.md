<img src="assets/icon.png" width="96" align="right" alt="">

# Claude Projects

A keyboard-driven manager for the projects and sessions that [Claude Code](https://claude.com/claude-code)
keeps under `~/.claude`. It lists every project you have ever opened, drills into that project's
sessions, and resumes, renames or deletes them — in one screen, with no LLM tokens spent.

```
 Projects · 31                                    C:\Users\you\.claude\projects
   Name              Path                                 Sess   Last used  Mem
 ● my-service        C:\src\my-service                      17  08-27 19:25    M
   docs-site         C:\src\docs-site                        3  08-25 13:50
   …

─── Project ───────────────────────────────────────────────────────────────────
 Name      my-service
 Path      C:\src\my-service
 Sessions  17   Last used  08-27 19:25   Memory  yes
 Dir       C--src-my-service

 ⏳ 5h ████████░░ 81% ↻ 22:40 | 📅 7d 57% ↻ 08/31 14:00 | 🤖 wiki MCP ✔
 ↑↓ move  Enter/→ sessions  T open here  O open new window  F2 alias  Del delete  Q quit
```

## Why

`/resume` shows one flat list of sessions for the current folder. This shows **every project**, what
is running right now, how large each transcript is, and lets you jump straight into any of them in a
new terminal tab — while the manager stays open for the next one.

## Install

Download `ClaudeProjects.exe` from [Releases](../../releases) and run it. Nothing to install: it is a
single file, and it only reads the files Claude Code already writes.

From source instead (Python 3.10+, standard library only):

```powershell
git clone https://github.com/kimssi-labs/claude-projects.git
python claude-projects/claude_projects.py
```

Optional — make it a flag on `claude` itself, by adding this to your PowerShell `$PROFILE`:

```powershell
function claude {
    $i = [array]::IndexOf($args, '--p')
    if ($i -lt 0) { & (Get-Command claude -CommandType Application) @args; return }
    $rest = @($args | Select-Object -Skip ($i + 1))
    $fwd  = @($args | Select-Object -First $i | ForEach-Object { "--claude-arg=$_" })
    & 'C:\path\to\ClaudeProjects.exe' @rest @fwd
}
```

Then `claude --p` opens the manager, and anything before `--p` is passed on to every session it
opens — `claude --dangerously-skip-permissions --p` opens sessions in that mode.

## Keys

| Key | Projects | Sessions |
|---|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | move | move |
| `Enter` / `→` | open the project's sessions | resume in a tab of the `Claude` window |
| `T` | new session here (current window) | resume here (current window) |
| `O` | new session in a new window | resume in a new window |
| `F2` | set a display alias | rename the session |
| `Del` | delete the project folder | delete the session |
| `S` | settings: docking, status line | settings |
| `←` `Esc` | — | back to projects |
| `F5` / `Q` | refresh / quit | refresh / quit |

Deletions ask first (`Enter` = yes, `Esc` = no) and refuse anything still running. Renaming a session
writes the same `custom-title.json` Claude Code's own `/rename` writes, so the new name also shows up
in `/resume`.

**Korean keyboard**: command keys work with the IME on — keys are read from console input records and
decoded by virtual-key, by scan code while the IME is still composing, and by Dubeolsik jamo mapping
(`ㅂ` acts as `q`), so nothing has to be committed with Enter first. The rename prompt takes Korean
text as typed.

## What it reads

Everything comes from files Claude Code maintains under `~/.claude` (override with `CLAUDE_HOME`):

| Path | Used for |
|---|---|
| `projects/<encoded-path>/*.jsonl` | one transcript per session; the real folder comes from its `cwd` |
| `projects/<encoded-path>/<id>/custom-title.json` | session title set by `/rename` |
| `sessions/*.json` | which sessions are running right now (the ● mark) |
| `history.jsonl` | first prompt of a session, used as its title when it has no custom one |
| `~/.claude.json` | folder path for projects whose transcripts are gone |
| `config/project-aliases.json`, `config/manager-dock.json` | this tool's own settings |

The status line is optional: each segment appears only if that source exists on your machine — rate
limits from `cache/rate-limits.json`, MCP and Outlook health from their status caches, and the
ponytail mode flag. On a machine without them the line is not drawn at all.

## Settings (`S`)

**Dock** places the manager as a reserved band on a monitor edge — pick the monitor, then the edge,
size and on/off; `Enter` applies, `Esc` backs out.

**Status line** (`M` from the dock screen) lists the MCP servers this machine has — from
`~/.claude.json` and from the probe cache — and lets you check the ones the 🤖 segment should report:

```
  MCP servers
    [x] chrome-devtools  ✘
  ▸ [x] github
    [x] wiki  ✔
```

`Space`/`Enter` toggles, `A` goes back to reporting every server. The segment shows ✔ when all the
checked servers are healthy, ✘ when one is failing, and a dim `?` when a checked server has no
verdict in the cache. Uncheck everything and the segment disappears. Choices live in
`config/manager-status.json`.

## Options

```
claude_projects.py [--list] [--self-test] [--home <dir>] [--claude-arg=<option>]…
```

`--list` prints the project table and exits, `--self-test` runs the data-layer checks in a throwaway
home, `--claude-arg=` adds an option to every `claude` the manager launches (repeatable).

## Requirements

Windows, Python 3.10+ (only for running from source), and `claude` on `PATH`. Windows Terminal is
used for tabs when present; otherwise sessions open in a plain console window.

## License

MIT — see [LICENSE](LICENSE).

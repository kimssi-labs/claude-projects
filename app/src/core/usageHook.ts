/**
 * Collecting Claude Code's usage figures, by asking Claude Code for them.
 *
 * The gauges read `cache/rate-limits.json`, and nothing in a stock install writes it: it appeared
 * on the author's machine only because a personal status-line script happened to publish it, so on
 * every other machine the gauges were silently blank however many sessions had run.
 *
 * Claude Code hands the current `rate_limits` to its Stop hook on stdin at the end of every turn,
 * piggybacked on a response it already made. Reading that costs nothing: no API call, no
 * credentials, and no polling of the usage endpoint, which rate-limits the very thing it reports.
 * So the fix is a small hook of our own that writes the figures where the gauges already look.
 *
 * A file rather than a POST to a port of our own — which is how a fleet manager with many panes to
 * attribute would do it — because this app is usually CLOSED. The hook keeps the file current
 * whether or not anything is listening, and the window shows today's numbers the moment it opens;
 * a socket would drop every turn that happened while the app was shut, which is most of them.
 *
 * Nothing here assumes a shell beyond the one the platform ships. The POSIX script is `sh` with
 * builtins; the Windows script is `cmd` reading stdin through `more.com`. No bash, no curl, no jq.
 *
 * `settings.json` is the user's file, so this is off until it is asked for, names itself where it
 * is written, and removes exactly what it added.
 */

/** Base name of the hook script; the extension follows the platform. */
export const HOOK_BASE = "hangar-usage";

export function hookFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${HOOK_BASE}.cmd` : `${HOOK_BASE}.sh`;
}

/**
 * How the hook is spelled in settings.json.
 *
 * The path is quoted and no `shell` is named: Claude Code runs the script with whatever the
 * platform associates with it, so nothing here depends on bash being installed.
 */
export function hookCommand(scriptPath: string): string {
  return `"${scriptPath}"`;
}

/** Recognises our own entry however the path was spelled when it was written. */
function isOurs(command: string | undefined): boolean {
  return typeof command === "string" && command.includes(HOOK_BASE);
}

const NOTE = "Written by Hangar. Publishes Claude Code's rate limits so the manager can draw them."
  + " Turn it off in Hangar under Settings, Usage.";

/** A single-quoted shell literal, safe for a path with anything in it. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * The POSIX hook.
 *
 * The rate-limit block is copied out whole rather than parsed field by field: whatever it carries
 * today or grows tomorrow, the reader already tolerates what it does not recognise, and a hook that
 * reshapes the data is one more place for the schema to go stale.
 */
export function posixHook(cachePath: string): string {
  return `#!/bin/sh
# ${NOTE}
cache=${shellQuote(cachePath)}

payload=
while IFS= read -r line || [ -n "$line" ]; do
  payload="$payload$line"
done
[ -n "$payload" ] || exit 0

case "$payload" in
  *'"rate_limits"'*) ;;
  *) exit 0 ;;
esac

rest=\${payload#*'"rate_limits"'}
rest=\${rest#*\\{}
# Count braces to the one that closes the block: five_hour and seven_day nest inside it, so
# stopping at the first closing brace would cut the block in half.
depth=1
body=
while [ -n "$rest" ] && [ "$depth" -gt 0 ]; do
  c=\${rest%"\${rest#?}"}
  rest=\${rest#?}
  case "$c" in
    "{") depth=$((depth + 1)) ;;
    "}") depth=$((depth - 1)); [ "$depth" -eq 0 ] && break ;;
  esac
  body="$body$c"
done
[ -n "$body" ] || exit 0

dir=\${cache%/*}
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || exit 0
now=$(date +%s 2>/dev/null) || now=0
tmp="$cache.tmp.$$"
# Write then rename, so a read never catches a half-written file.
if printf '{%s,"updated_at":%s}\\n' "$body" "$now" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$cache" 2>/dev/null || rm -f "$tmp" 2>/dev/null
fi
exit 0
`;
}

/**
 * The Windows hook.
 *
 * `cmd` has no way to capture stdin in a variable, so the payload goes to a temp file through
 * `more.com` — a System32 program present on every Windows — and PowerShell, also always present,
 * does the parsing. PowerShell starts once per turn at most, and only when the payload actually
 * carries rate limits.
 */
export function windowsHook(cachePath: string): string {
  return [
    "@echo off",
    `rem ${NOTE}`,
    "setlocal",
    // The destination is written down at install time rather than derived here. Claude Code keys
    // its home off CLAUDE_CONFIG_DIR and Hangar off CLAUDE_HOME; on a machine that sets either one,
    // a hook that guessed would publish to a file nothing reads.
    `set "HANGAR_CACHE=${cachePath}"`,
    'set "HANGAR_PAYLOAD=%TEMP%\\hangar-usage-%RANDOM%%RANDOM%.json"',
    '"%SystemRoot%\\System32\\more.com" > "%HANGAR_PAYLOAD%" 2>nul',
    'if not exist "%HANGAR_PAYLOAD%" exit /b 0',
    // Skip the PowerShell start entirely on a turn that carries no rate limits.
    '"%SystemRoot%\\System32\\findstr.exe" /c:\\"rate_limits\\" "%HANGAR_PAYLOAD%" >nul 2>nul',
    "if errorlevel 1 goto :cleanup",
    // Not one double quote inside the -Command string: cmd ends the argument at the first one it
    // meets, and the tail of the script then runs as commands of its own. Single quotes throughout.
    //
    // WriteAllText rather than Set-Content: Windows PowerShell writes a BOM under -Encoding utf8,
    // and a BOM is the difference between a gauge and a blank panel.
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive'
      + ' -ExecutionPolicy Bypass -Command "'
      + "$ErrorActionPreference='Stop';"
      + " try {"
      + " $p = Get-Content -Raw -LiteralPath $env:HANGAR_PAYLOAD | ConvertFrom-Json;"
      + " $r = $p.rate_limits; if (-not $r) { exit 0 };"
      + " $file = $env:HANGAR_CACHE; $dir = Split-Path -Parent $file;"
      + " if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null };"
      + " $out = @{}; foreach ($f in $r.PSObject.Properties) { $out[$f.Name] = $f.Value };"
      + " $out['updated_at'] = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds();"
      + " $tmp = $file + '.tmp';"
      + " [IO.File]::WriteAllText($tmp, ($out | ConvertTo-Json -Depth 6 -Compress));"
      + " Move-Item -Force -LiteralPath $tmp -Destination $file"
      + " } catch { exit 0 }"
      + '" >nul 2>nul',
    ":cleanup",
    'del "%HANGAR_PAYLOAD%" >nul 2>nul',
    "exit /b 0",
    "",
  ].join("\r\n");
}

/** The script for this platform, publishing to the one file Hangar will read. */
export function hookScript(platform: NodeJS.Platform, cachePath: string): string {
  return platform === "win32" ? windowsHook(cachePath) : posixHook(cachePath);
}

interface HookEntry { type?: string; command?: string; shell?: string }
interface HookGroup { matcher?: string; hooks?: HookEntry[] }

function stopGroups(settings: Record<string, unknown>): HookGroup[] {
  const hooks = settings["hooks"];
  if (!hooks || typeof hooks !== "object") return [];
  const stop = (hooks as Record<string, unknown>)["Stop"];
  return Array.isArray(stop) ? (stop as HookGroup[]) : [];
}

/** True when this settings object already runs our hook, wherever it was installed from. */
export function hookInstalled(settings: Record<string, unknown>): boolean {
  return stopGroups(settings).some((group) => (group.hooks ?? []).some((hook) => isOurs(hook.command)));
}

/**
 * The settings with our hook added, leaving every other hook alone.
 *
 * Its own group rather than appended to someone else's: a group can carry a matcher, and joining
 * one would inherit a condition that has nothing to do with us. An install over an older one
 * replaces the entry, so a moved application folder does not leave a hook pointing at nothing.
 */
export function withHook(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  const kept = stopGroups(settings)
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isOurs(h.command)) }))
    .filter((group) => (group.hooks ?? []).length > 0);
  const hooks = { ...(settings["hooks"] as Record<string, unknown> ?? {}) };
  hooks["Stop"] = [...kept, { hooks: [{ type: "command", command }] }];
  return { ...settings, hooks };
}

/** The settings with our hook removed, and any group we emptied removed with it. */
export function withoutHook(settings: Record<string, unknown>): Record<string, unknown> {
  const groups = stopGroups(settings)
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isOurs(h.command)) }))
    .filter((group) => (group.hooks ?? []).length > 0);
  const hooks = { ...(settings["hooks"] as Record<string, unknown> ?? {}) };
  if (groups.length) hooks["Stop"] = groups;
  else delete hooks["Stop"];
  const next: Record<string, unknown> = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next["hooks"];
  return next;
}

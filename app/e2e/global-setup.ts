/**
 * Before the suite: no test app may be left over from an earlier run.
 *
 * These tests drive the real shell, and an app that failed to quit — measured: a main process with
 * its window gone, alive for hours, that "exited before attach completed" the moment a debugger
 * looked at it — keeps an appbar the shell still talks to. Every later `SHAppBarMessage`, in every
 * instance, then waits on a window that will never answer: a run that takes twelve minutes instead
 * of seven, reservations that arrive after the test gave up, and another instance that cannot quit.
 * Only Playwright-launched Electron processes are touched (the loader is in their command line);
 * the installed app is never one of them.
 */
import { execFileSync } from "node:child_process";

export default function globalSetup(): void {
  if (process.platform !== "win32") return;
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\"",
    "| Where-Object { $_.CommandLine -like '*playwright-core*electron*loader.js*' }",
    "| ForEach-Object { Write-Output ('left over: ' + $_.ProcessId + ' since ' + $_.CreationDate); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000 });
    if (out.trim()) console.log(`  [e2e] ${out.trim().split(/\r?\n/).join("\n  [e2e] ")}`);
  } catch (error) {
    console.log(`  [e2e] could not look for leftover test apps: ${(error as Error).message.split("\n")[0]}`);
  }
}

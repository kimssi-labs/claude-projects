/**
 * CPU and memory readings that cost nothing.
 *
 * The obvious library for this (`systeminformation`) shells out to PowerShell/WMI on Windows: here
 * one `processes()` call measured 3.6 s and one `mem()` call 3.3 s, and the sampler was making both
 * every second. A monitor may not be the reason a machine is busy.
 *
 * So: the process table comes from a toolhelp snapshot, per-process CPU and memory from the
 * handles Windows already keeps, and the machine's own load from `os.cpus()` — all in-process, all
 * microseconds. Linux reads the same numbers out of /proc, which is just as cheap.
 */
import { readFileSync, readdirSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";

import type { ProcessRow } from "../core/metrics.js";
import { liveClockGhz } from "./cpuClock.js";

/** Busy time of one process since it started, and what it is holding in memory right now. */
export interface ProcessUsage {
  /** Kernel + user time, in milliseconds. */
  busyMs: number;
  memoryBytes: number;
}

export interface MachineReading {
  /** 0–100 across all cores. */
  cpu: number;
  memoryBytes: number;
  memoryTotalBytes: number;
  /** Current clock in GHz, or null when the platform does not report one. */
  cpuGhz: number | null;
}

// -- Windows ------------------------------------------------------------------------------------

const TH32CS_SNAPPROCESS = 0x00000002;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;
const INVALID_HANDLE = -1;
/** FILETIME counts 100-nanosecond ticks; 10,000 of them make a millisecond. */
const TICKS_PER_MS = 10000;

interface WinApi {
  table: () => ProcessRow[];
  usage: (pid: number) => ProcessUsage | null;
}

let winApi: WinApi | null | undefined;

function loadWindows(): WinApi | null {
  if (winApi !== undefined) return winApi;
  if (process.platform !== "win32") return (winApi = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const kernel32 = koffi.load("kernel32.dll");

    const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
      dwSize: "uint32", cntUsage: "uint32", th32ProcessID: "uint32", th32DefaultHeapID: "uintptr",
      th32ModuleID: "uint32", cntThreads: "uint32", th32ParentProcessID: "uint32",
      pcPriClassBase: "int32", dwFlags: "uint32", szExeFile: koffi.array("uint16", 260),
    });
    const FILETIME = koffi.struct("FILETIME", { dwLowDateTime: "uint32", dwHighDateTime: "uint32" });
    // Only the first three fields are read; the rest keeps the size right for `cb`.
    const PROCESS_MEMORY_COUNTERS = koffi.struct("PROCESS_MEMORY_COUNTERS", {
      cb: "uint32", PageFaultCount: "uint32",
      PeakWorkingSetSize: "uintptr", WorkingSetSize: "uintptr",
      QuotaPeakPagedPoolUsage: "uintptr", QuotaPagedPoolUsage: "uintptr",
      QuotaPeakNonPagedPoolUsage: "uintptr", QuotaNonPagedPoolUsage: "uintptr",
      PagefileUsage: "uintptr", PeakPagefileUsage: "uintptr",
    });

    const CreateToolhelp32Snapshot = kernel32.func("__stdcall", "CreateToolhelp32Snapshot", "intptr", ["uint32", "uint32"]);
    const Process32FirstW = kernel32.func("__stdcall", "Process32FirstW", "bool", ["intptr", koffi.inout(koffi.pointer(PROCESSENTRY32W))]);
    const Process32NextW = kernel32.func("__stdcall", "Process32NextW", "bool", ["intptr", koffi.inout(koffi.pointer(PROCESSENTRY32W))]);
    const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "bool", ["intptr"]);
    const OpenProcess = kernel32.func("__stdcall", "OpenProcess", "intptr", ["uint32", "bool", "uint32"]);
    const GetProcessTimes = kernel32.func("__stdcall", "GetProcessTimes", "bool", [
      "intptr", koffi.out(koffi.pointer(FILETIME)), koffi.out(koffi.pointer(FILETIME)),
      koffi.out(koffi.pointer(FILETIME)), koffi.out(koffi.pointer(FILETIME)),
    ]);
    // K32-prefixed: the psapi entry point that lives in kernel32 on every supported Windows.
    const GetProcessMemoryInfo = kernel32.func("__stdcall", "K32GetProcessMemoryInfo", "bool", [
      "intptr", koffi.out(koffi.pointer(PROCESS_MEMORY_COUNTERS)), "uint32",
    ]);

    const blankTime = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const filetimeMs = (t: { dwLowDateTime: number; dwHighDateTime: number }): number =>
      (t.dwHighDateTime * 4294967296 + t.dwLowDateTime) / TICKS_PER_MS;

    winApi = {
      table: () => {
        const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot === INVALID_HANDLE) return [];
        const rows: ProcessRow[] = [];
        try {
          const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W), cntUsage: 0, th32ProcessID: 0,
            th32DefaultHeapID: 0, th32ModuleID: 0, cntThreads: 0, th32ParentProcessID: 0,
            pcPriClassBase: 0, dwFlags: 0, szExeFile: new Array<number>(260).fill(0) };
          let more = Process32FirstW(snapshot, entry);
          while (more) {
            rows.push({ pid: entry.th32ProcessID, parentPid: entry.th32ParentProcessID, cpu: 0, memoryBytes: 0 });
            entry.dwSize = koffi.sizeof(PROCESSENTRY32W);
            more = Process32NextW(snapshot, entry);
          }
        } finally {
          CloseHandle(snapshot);
        }
        return rows;
      },
      usage: (pid) => {
        const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
        if (!handle || handle === 0) return null;
        try {
          const creation = { ...blankTime }, exit = { ...blankTime };
          const kernel = { ...blankTime }, user = { ...blankTime };
          if (!GetProcessTimes(handle, creation, exit, kernel, user)) return null;
          const counters = {
            cb: koffi.sizeof(PROCESS_MEMORY_COUNTERS), PageFaultCount: 0,
            PeakWorkingSetSize: 0, WorkingSetSize: 0, QuotaPeakPagedPoolUsage: 0, QuotaPagedPoolUsage: 0,
            QuotaPeakNonPagedPoolUsage: 0, QuotaNonPagedPoolUsage: 0, PagefileUsage: 0, PeakPagefileUsage: 0,
          };
          const gotMemory = GetProcessMemoryInfo(handle, counters, koffi.sizeof(PROCESS_MEMORY_COUNTERS));
          return {
            busyMs: filetimeMs(kernel) + filetimeMs(user),
            memoryBytes: gotMemory ? Number(counters.WorkingSetSize) : 0,
          };
        } finally {
          CloseHandle(handle);
        }
      },
    };
    return winApi;
  } catch (error) {
    console.error("[hangar] native metrics unavailable:", (error as Error).message);
    return (winApi = null);
  }
}

// -- Linux --------------------------------------------------------------------------------------

/** `/proc/<pid>/stat`: utime and stime are fields 14 and 15, after a comm that may contain spaces. */
export function parseProcStat(text: string): { parentPid: number; busyTicks: number } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 2).split(" ");
  const parentPid = Number(fields[1]);              // ppid is field 4 overall, second after state
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(parentPid) || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { parentPid, busyTicks: utime + stime };
}

/** `/proc/<pid>/statm`: the second number is the resident set, in pages. */
export function parseProcStatm(text: string, pageSize = 4096): number {
  const resident = Number(text.split(" ")[1]);
  return Number.isFinite(resident) ? resident * pageSize : 0;
}

const LINUX_TICKS_PER_SECOND = 100;               // USER_HZ, fixed at 100 on every mainstream build

function linuxTable(): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      if (stat) rows.push({ pid: Number(name), parentPid: stat.parentPid, cpu: 0, memoryBytes: 0 });
    } catch {
      /* the process ended while we were reading it */
    }
  }
  return rows;
}

function linuxUsage(pid: number): ProcessUsage | null {
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (!stat) return null;
    return {
      busyMs: (stat.busyTicks / LINUX_TICKS_PER_SECOND) * 1000,
      memoryBytes: parseProcStatm(readFileSync(`/proc/${pid}/statm`, "utf8")),
    };
  } catch {
    return null;
  }
}

// -- what the sampler uses ----------------------------------------------------------------------

/** Every process on the machine, with its parent — enough to walk a session's tree. */
export function processTable(): ProcessRow[] {
  if (process.platform === "win32") return loadWindows()?.table() ?? [];
  if (process.platform === "linux") return linuxTable();
  return [];
}

/** Busy time and resident memory for one process, or null if it is gone or not ours to read. */
export function processUsage(pid: number): ProcessUsage | null {
  if (process.platform === "win32") return loadWindows()?.usage(pid) ?? null;
  if (process.platform === "linux") return linuxUsage(pid);
  return null;
}

/**
 * Total busy/idle jiffies across cores, the core count and the clock — from ONE `os.cpus()` call.
 *
 * The clock is the NOMINAL one. On Windows `os.cpus()` reports the same figure on every core and
 * never changes it — 2995 MHz here while the live clock was swinging — so it is the base clock, and
 * the window says so. A live reading needs the `% Processor Performance` counter, which is a PDH
 * query per sample; not worth the cost for a number that is decoration beside the busy percentage.
 *
 * It is the most expensive thing left in a sample (it walks every core), so it is read once and
 * everything the sampler needs comes out of that single reading.
 */
export function cpuTotals(): { busy: number; total: number; ghz: number | null; cores: number } {
  const cores = cpus();
  let busy = 0;
  let total = 0;
  let speed = 0;
  for (const core of cores) {
    const t = core.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
    speed += core.speed;
  }
  // The live clock when the platform will give one; otherwise the nominal figure os.cpus() reports,
  // which on Windows is what the registry was told at boot and never changes.
  const nominal = cores.length && speed ? speed / cores.length / 1000 : null;
  return { busy, total, ghz: liveClockGhz() ?? nominal, cores: cores.length || 1 };
}

export function machineMemory(): { used: number; total: number } {
  const total = totalmem();
  return { used: total - freemem(), total };
}

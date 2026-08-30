/**
 * Where the CPU and memory numbers come from.
 *
 * Everything is read in-process (see nativeMetrics): one snapshot of the process table, then two
 * cheap queries per pid we actually track. A percentage is a rate, so each reading is the
 * difference from the previous one — which is also why the first sample of a process reads 0.
 */
import { cpuTotals, machineMemory, processTable, processUsage } from "./nativeMetrics.js";
import { processTree } from "../core/metrics.js";
import type { MetricsSnapshot } from "../core/types.js";

export const SAMPLE_INTERVAL_MS = 1000;

export interface SessionTarget {
  sessionId: string;
  pid: number;
}

/** Busy milliseconds and wall-clock, per pid, from the previous sample. */
interface Previous {
  busyMs: number;
  at: number;
}

const lastProcess = new Map<number, Previous>();
let lastCpu: { busy: number; total: number } | null = null;

/** Busy time over elapsed time, as a percentage of the whole machine. */
export function ratePercent(busyDeltaMs: number, elapsedMs: number, cores: number): number {
  if (elapsedMs <= 0 || cores <= 0) return 0;
  const percent = (busyDeltaMs / (elapsedMs * cores)) * 100;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

/** Machine load from two readings of the same counters; 0 when there is no previous one. */
export function loadPercent(
  previous: { busy: number; total: number } | null,
  current: { busy: number; total: number },
): number {
  if (!previous) return 0;
  const total = current.total - previous.total;
  const busy = current.busy - previous.busy;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((busy / total) * 1000) / 10));
}

export async function sample(targets: SessionTarget[], now = Date.now()): Promise<MetricsSnapshot> {
  const totals = cpuTotals();
  const cores = totals.cores;
  const cpu = loadPercent(lastCpu, totals);
  lastCpu = { busy: totals.busy, total: totals.total };

  const memory = machineMemory();
  const sessions: MetricsSnapshot["sessions"] = {};

  // The table is only needed when something is running; with no live session there is nothing to
  // attribute and the snapshot is two OS calls in total.
  if (targets.length) {
    const rows = processTable();
    const alive = new Set<number>();
    for (const target of targets) {
      const tree = processTree(rows, target.pid);
      if (!tree.length) continue;                  // ended between the scan and this sample
      let busyMs = 0;
      let memoryBytes = 0;
      for (const row of tree) {
        const usage = processUsage(row.pid);
        if (!usage) continue;
        busyMs += usage.busyMs;
        memoryBytes += usage.memoryBytes;
      }
      alive.add(target.pid);
      const previous = lastProcess.get(target.pid);
      lastProcess.set(target.pid, { busyMs, at: now });
      sessions[target.sessionId] = {
        cpu: previous ? ratePercent(busyMs - previous.busyMs, now - previous.at, cores) : 0,
        memoryBytes,
        pid: target.pid,
      };
    }
    for (const pid of lastProcess.keys()) if (!alive.has(pid)) lastProcess.delete(pid);
  } else if (lastProcess.size) {
    lastProcess.clear();
  }

  return {
    at: now,
    system: {
      cpu,
      memoryBytes: memory.used,
      memoryTotalBytes: memory.total,
      cpuGhz: totals.ghz,
    },
    sessions,
  };
}

/** Test seam: forget what the last sample saw. */
export function resetSampler(): void {
  lastProcess.clear();
  lastCpu = null;
}

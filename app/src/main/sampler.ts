/**
 * Where the CPU and memory numbers come from.
 *
 * One `systeminformation` call gives the whole process table with parent pids, so a session's tree
 * and the machine total come from the same snapshot — no second reading that disagrees with the first.
 */
import { totalmem } from "node:os";
import si from "systeminformation";

import { processTree, sumTree, type ProcessRow } from "../core/metrics.js";
import type { MetricsSnapshot } from "../core/types.js";

export const SAMPLE_INTERVAL_MS = 1000;

export interface SessionTarget {
  sessionId: string;
  pid: number;
}

/** Read every process once, then attribute it. `si.processes()` is the only cross-platform source. */
export async function sample(targets: SessionTarget[], now = Date.now()): Promise<MetricsSnapshot> {
  const [processes, memory, load] = await Promise.all([si.processes(), si.mem(), si.currentLoad()]);
  const rows: ProcessRow[] = processes.list.map((p) => ({
    pid: p.pid,
    parentPid: p.parentPid,
    cpu: p.cpu ?? 0,
    // `mem` is a percentage of physical memory; the absolute number is what a reader can judge.
    memoryBytes: Math.round(((p.mem ?? 0) / 100) * (memory.total || totalmem())),
  }));

  const sessions: MetricsSnapshot["sessions"] = {};
  for (const target of targets) {
    const tree = processTree(rows, target.pid);
    if (!tree.length) continue;                    // the session ended between the scan and this sample
    const totals = sumTree(tree);
    sessions[target.sessionId] = { ...totals, pid: target.pid };
  }

  return {
    at: now,
    system: {
      cpu: Math.round(load.currentLoad * 10) / 10,
      memoryBytes: memory.active || memory.used,
      memoryTotalBytes: memory.total || totalmem(),
    },
    sessions,
  };
}

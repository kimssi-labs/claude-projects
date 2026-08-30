/**
 * CPU and memory history for the machine and for each running session.
 *
 * A session is a process TREE (claude plus whatever it spawned), so the sample sums the tree —
 * charting only the parent would have shown a busy session as idle.
 */
import type { MetricSample, MetricsSnapshot } from "./types.js";

/** Kept history: 300 samples at one per second is five minutes, which fits a chart without scrolling. */
export const HISTORY_LENGTH = 300;
export const SYSTEM_SERIES = "system";

export interface ProcessRow {
  pid: number;
  parentPid: number;
  /** Percent of one core, as the OS reports it. */
  cpu: number;
  memoryBytes: number;
}

/** Every descendant of `root`, plus `root` itself — one pass, no recursion into missing pids. */
export function processTree(rows: ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.parentPid);
    if (list) list.push(row);
    else children.set(row.parentPid, [row]);
  }
  const seen = new Set<number>();
  const out: ProcessRow[] = [];
  const queue = rows.filter((r) => r.pid === root);
  while (queue.length) {
    const row = queue.shift() as ProcessRow;
    if (seen.has(row.pid)) continue;              // a pid cycle would otherwise hang the sampler
    seen.add(row.pid);
    out.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return out;
}

export function sumTree(rows: ProcessRow[]): { cpu: number; memoryBytes: number } {
  return rows.reduce(
    (acc, row) => ({ cpu: acc.cpu + row.cpu, memoryBytes: acc.memoryBytes + row.memoryBytes }),
    { cpu: 0, memoryBytes: 0 },
  );
}

/** Fixed-length history per series; the oldest sample falls off the end. */
export class MetricsHistory {
  private readonly series = new Map<string, MetricSample[]>();

  constructor(private readonly length = HISTORY_LENGTH) {}

  push(snapshot: MetricsSnapshot): void {
    this.add(SYSTEM_SERIES, { at: snapshot.at, cpu: snapshot.system.cpu, memoryBytes: snapshot.system.memoryBytes });
    for (const [sessionId, usage] of Object.entries(snapshot.sessions)) {
      this.add(sessionId, { at: snapshot.at, cpu: usage.cpu, memoryBytes: usage.memoryBytes });
    }
  }

  private add(key: string, sample: MetricSample): void {
    const samples = this.series.get(key) ?? [];
    samples.push(sample);
    if (samples.length > this.length) samples.splice(0, samples.length - this.length);
    this.series.set(key, samples);
  }

  get(key: string): MetricSample[] {
    return this.series.get(key) ?? [];
  }

  keys(): string[] {
    return [...this.series.keys()];
  }

  /** Drop history for sessions that are gone, so a long-running app does not grow without bound. */
  keepOnly(keys: Iterable<string>): void {
    const keep = new Set([SYSTEM_SERIES, ...keys]);
    for (const key of this.series.keys()) if (!keep.has(key)) this.series.delete(key);
  }
}

export function latest(samples: MetricSample[]): MetricSample | null {
  return samples.length ? (samples[samples.length - 1] as MetricSample) : null;
}

export function peakCpu(samples: MetricSample[]): number {
  return samples.reduce((max, s) => Math.max(max, s.cpu), 0);
}

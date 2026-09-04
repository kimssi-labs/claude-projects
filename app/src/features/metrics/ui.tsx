/**
 * CPU and memory — the page side.
 *
 * Owns the series the graphs are drawn from: the machine's, and one per running session. Filled
 * once from the history at first paint, then extended on every sample the main process pushes. The
 * graphs themselves (AreaChart) and the gauge row stay in the screens that lay them out.
 */
import { useCallback, useEffect, useState } from "react";

import type { MetricSample, MetricsSnapshot } from "@core/types";

import { api } from "../../renderer/api";
import { Choice } from "../../renderer/components/SettingsCard";

/** Samples a series keeps; older ones fall off the left of the graph. */
const HISTORY_LIMIT = 300;

const cap = (samples: MetricSample[]): MetricSample[] => samples.slice(-HISTORY_LIMIT);

export interface Metrics {
  systemHistory: MetricSample[];
  sessionHistory: Record<string, MetricSample[]>;
  /** Not part of the history: a clock speed is a reading of right now, not a series. */
  cpuGhz: number | null;
  /** What the machine has, as the sampler reports it — the ceiling the memory graph is drawn to. */
  memoryTotal: number;
  /** The machine's memory when the sampler has said so; until then, the largest reading seen. */
  totalMemory: number;
  latestSystem: MetricSample | null;
  /** Read the history so far — once, at first paint. Stable. */
  load(): Promise<void>;
}

export function useMetrics(): Metrics {
  const [systemHistory, setSystemHistory] = useState<MetricSample[]>([]);
  const [sessionHistory, setSessionHistory] = useState<Record<string, MetricSample[]>>({});
  const [cpuGhz, setCpuGhz] = useState<number | null>(null);
  const [memoryTotal, setMemoryTotal] = useState(0);

  const load = useCallback(async () => {
    const history = await api.metrics();
    setSystemHistory(history.system);
    setSessionHistory(history.sessions);
  }, []);

  useEffect(() => api.onMetrics((snapshot: MetricsSnapshot) => {
    setCpuGhz(snapshot.system.cpuGhz);
    setMemoryTotal(snapshot.system.memoryTotalBytes);
    setSystemHistory((previous) => cap([...previous, {
      at: snapshot.at, cpu: snapshot.system.cpu, memoryBytes: snapshot.system.memoryBytes,
    }]));
    setSessionHistory((previous) => {
      const next: Record<string, MetricSample[]> = {};
      for (const [id, usage] of Object.entries(snapshot.sessions)) {
        next[id] = cap([...(previous[id] ?? []), { at: snapshot.at, cpu: usage.cpu, memoryBytes: usage.memoryBytes }]);
      }
      return next;
    });
  }), []);

  const totalMemory = memoryTotal || (systemHistory.length ? Math.max(...systemHistory.map((s) => s.memoryBytes)) : 1);
  const latestSystem = systemHistory.length ? systemHistory[systemHistory.length - 1] ?? null : null;

  return { systemHistory, sessionHistory, cpuGhz, memoryTotal, totalMemory, latestSystem, load };
}

/** The settings card body: whether anything is measured at all. */
export function MonitorSettings({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  return (
    <>
      <Choice
        label="On"
        note="CPU and memory sampled once a second, in-process"
        selected={on}
        onSelect={() => onChange(true)}
      />
      <Choice
        label="Off"
        note="no sampling at all — the graphs disappear and nothing is measured"
        selected={!on}
        onSelect={() => onChange(false)}
      />
    </>
  );
}

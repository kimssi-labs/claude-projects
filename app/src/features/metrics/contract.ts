/** CPU and memory, for the machine and for each running session. */
import { event, invoke } from "../../bridge/contract.js";
import type { MetricSample, MetricsSnapshot } from "../../core/types.js";

/** Everything sampled so far, so a window that opens late draws the same graphs as one that did not. */
export interface MetricsHistoryPayload {
  system: MetricSample[];
  sessions: Record<string, MetricSample[]>;
}

export const metricsContract = {
  /** The history as it stands, asked for once at first paint. */
  metrics: invoke<void, MetricsHistoryPayload>("metrics:history"),
  /** A new sample, on every tick of the sampler. */
  onMetrics: event<MetricsSnapshot>("metrics:push"),
} as const;

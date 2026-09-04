/**
 * CPU and memory sampling — the main side.
 *
 * The measuring is in main/nativeMetrics.ts and main/sampler.ts, and runs on a worker thread so
 * the window never waits on it (main/samplerWorker.ts). This is the feature's edge: the history it
 * keeps, the worker's lifetime, and the one thing the rest of main does to it — telling it which
 * sessions to follow when the project rows change.
 */
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { MetricsHistory, SYSTEM_SERIES } from "../../core/metrics.js";
import type { MetricsSnapshot } from "../../core/types.js";
import { sample, SAMPLE_INTERVAL_MS, type SessionTarget } from "../../main/sampler.js";
import { metricsContract } from "./contract.js";

/**
 * The worker script stays in dist/main with the rest of the process entry points; this file moved
 * to dist/features/metrics, so the path is relative to where it now compiles to.
 */
const WORKER_SCRIPT = join(__dirname, "..", "..", "main", "samplerWorker.js");

/** What this feature needs from the rest of main. */
export interface MetricsDeps {
  /** Sessions worth measuring right now: the running ones, from the last scan. */
  targets(): SessionTarget[];
}

/** What the rest of main may do with this feature once it is registered. */
export interface MetricsFeature {
  /** Start measuring, if the monitor setting says so. Safe to call when already running. */
  start(): void;
  stop(): void;
  /** The project rows changed; the running set may have with them. */
  retarget(): void;
}

export function register(ctx: MainContext, wire: Wire, deps: MetricsDeps): MetricsFeature {
  const history = new MetricsHistory();
  let worker: Worker | null = null;
  let inline: NodeJS.Timeout | null = null;

  wire.bind(metricsContract, {
    metrics: () => ({
      system: history.get(SYSTEM_SERIES),
      sessions: Object.fromEntries(history.keys().filter((k) => k !== SYSTEM_SERIES).map((k) => [k, history.get(k)])),
    }),
  });

  function accept(snapshot: MetricsSnapshot): void {
    history.push(snapshot);
    history.keepOnly(Object.keys(snapshot.sessions));
    wire.emit(metricsContract.onMetrics, snapshot);
  }

  function retarget(): void {
    worker?.postMessage({ targets: deps.targets() });
  }

  function stop(): void {
    if (worker) {
      worker.postMessage({ stop: true });
      void worker.terminate();
      worker = null;
    }
    if (inline) {
      clearInterval(inline);
      inline = null;
    }
  }

  // The in-process sampler, used only if the worker cannot start. Packaging can put the worker
  // script somewhere `new Worker()` will not follow; measuring on the main thread is worse than
  // measuring off it, but far better than not measuring at all.
  function startInline(): void {
    if (inline) return;
    inline = setInterval(() => {
      void sample(deps.targets())
        .then(accept)
        .catch(() => {
          /* a sampling hiccup must never take the app down */
        });
    }, SAMPLE_INTERVAL_MS);
  }

  // Runs only when the setting says so — the whole point of the setting is that off costs nothing.
  function start(): void {
    if (worker || inline) return;
    if (!ctx.config.ui().monitor) return;
    try {
      worker = new Worker(WORKER_SCRIPT, { workerData: { intervalMs: SAMPLE_INTERVAL_MS } });
      worker.on("message", (snapshot: MetricsSnapshot) => accept(snapshot));
      worker.on("error", (error) => {
        console.error("[hangar] sampler worker failed, measuring in-process:", error.message);
        worker = null;
        startInline();
      });
      worker.unref();                             // a sampler must never hold the app open
      retarget();
    } catch (error) {
      console.error("[hangar] sampler worker unavailable:", (error as Error).message);
      startInline();
    }
  }

  return { start, stop, retarget };
}

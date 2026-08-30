/**
 * The sampler, on its own thread.
 *
 * Reading the process table and every tracked pid costs 13-40 ms a second — small, but it lands on
 * the thread that draws the window, once a second, forever. Here it lands on nobody: the worker
 * owns the timer, and main only receives finished snapshots.
 */
import { parentPort, workerData } from "node:worker_threads";

import { sample, type SessionTarget } from "./sampler.js";

export interface SamplerCommand {
  /** Which sessions to attribute; replaces the previous list. */
  targets?: SessionTarget[];
  /** Stop sampling and let the thread end. */
  stop?: boolean;
}

const interval = Number(workerData?.intervalMs) || 1000;
let targets: SessionTarget[] = [];
let busy = false;

const timer = setInterval(() => {
  // Never overlap: a slow sample must not queue up behind itself on a machine under load.
  if (busy) return;
  busy = true;
  void sample(targets)
    .then((snapshot) => parentPort?.postMessage(snapshot))
    .catch(() => {
      /* a sampling hiccup must never take the app down */
    })
    .finally(() => {
      busy = false;
    });
}, interval);

parentPort?.on("message", (command: SamplerCommand) => {
  if (command.targets) targets = command.targets;
  if (command.stop) {
    clearInterval(timer);
    parentPort?.close();
  }
});

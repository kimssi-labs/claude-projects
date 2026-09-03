/**
 * The rate-limit windows Claude Code publishes, and nothing else.
 *
 * Three other indicators lived here and were all removed for the same reason: each read a cache
 * file that only one machine's own scripts write, so for anybody else the segment was either absent
 * or, worse, wrong. MCP health could not see a live connection at all; Outlook reachability came
 * from a private mail probe; the ponytail chip from a local mode flag. Usage comes from Claude
 * Code itself, which is what makes it worth drawing for everyone.
 */
import { readFileSync } from "node:fs";

import { RATE_WINDOWS } from "./constants.js";
import { homePaths } from "./paths.js";
import type { RateWindow, StatusConfig, StatusSnapshot } from "./types.js";

export { RATE_WINDOWS } from "./constants.js";


interface RateBucket { used_percentage?: number; utilization?: number; resets_at?: number }

function readJson<T>(file: string, fallback: T): T {
  try {
    // Strip a BOM: JSON.parse throws on one, and the throw would read as "this machine reports no
    // usage" rather than as the encoding accident it is. Windows tools write one by default.
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return fallback;
  }
}

/** Windows present in the cache, normalised; a window whose reset already passed reads 0 %. */
export function rateWindows(raw: Record<string, unknown>, now = Date.now()): RateWindow[] {
  const out: RateWindow[] = [];
  for (const { key, label, short } of RATE_WINDOWS) {
    const bucket = raw[key] as RateBucket | undefined;
    if (!bucket || typeof bucket !== "object") continue;
    const used = bucket.used_percentage ?? bucket.utilization;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const resetsAt = typeof bucket.resets_at === "number" ? bucket.resets_at * 1000 : null;
    const rolled = resetsAt !== null && resetsAt <= now;
    out.push({
      key,
      label,
      short,
      usedPercent: rolled ? 0 : Math.max(0, Math.min(100, Math.round(used))),
      resetsAt: rolled ? null : resetsAt,
    });
  }
  return out;
}

/** When the cache was last published, in epoch ms, or null when it has never been. */
export function readStatusUpdatedAt(home?: string): number | null {
  const raw = readJson<{ updated_at?: unknown }>(homePaths(home).rateLimits, {});
  const seconds = typeof raw.updated_at === "number" ? raw.updated_at : null;
  return seconds && Number.isFinite(seconds) ? seconds * 1000 : null;
}

export function readStatus(
  home?: string,
  config: StatusConfig = { windows: null },
  now = Date.now(),
): StatusSnapshot {
  const all = rateWindows(readJson<Record<string, unknown>>(homePaths(home).rateLimits, {}), now);
  const chosen = config.windows;
  return { windows: chosen === null ? all : all.filter((w) => chosen.includes(w.key)) };
}

export { readJson as readStatusJson };

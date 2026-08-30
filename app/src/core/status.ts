/**
 * The status strip: rate-limit windows and the health of things Claude Code depends on.
 *
 * Every value comes from a cache file some other tool publishes, so each segment appears only if
 * that file exists on this machine — a teammate without the wiki MCP or the Outlook probe sees
 * neither, rather than a red cross for something they never installed.
 */
import { readFileSync } from "node:fs";

import { homePaths } from "./paths.js";
import type { HealthItem, RateWindow, StatusConfig, StatusSnapshot } from "./types.js";

/**
 * Rate-limit buckets Claude Code reports, in the order they are shown. The model-specific weekly
 * windows are what "how much Fable have I used this week" actually reads from: Fable and the other
 * top-tier models share the Opus weekly bucket.
 */
export const RATE_WINDOWS: { key: string; label: string }[] = [
  { key: "five_hour", label: "5h" },
  { key: "seven_day", label: "7d all" },
  { key: "seven_day_opus", label: "7d Fable/Opus" },
  { key: "seven_day_sonnet", label: "7d Sonnet" },
];

interface RateBucket { used_percentage?: number; utilization?: number; resets_at?: number }

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Windows present in the cache, normalised; a window whose reset already passed reads 0 %. */
export function rateWindows(raw: Record<string, unknown>, now = Date.now()): RateWindow[] {
  const out: RateWindow[] = [];
  for (const { key, label } of RATE_WINDOWS) {
    const bucket = raw[key] as RateBucket | undefined;
    if (!bucket || typeof bucket !== "object") continue;
    const used = bucket.used_percentage ?? bucket.utilization;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const resetsAt = typeof bucket.resets_at === "number" ? bucket.resets_at * 1000 : null;
    const rolled = resetsAt !== null && resetsAt <= now;
    out.push({
      key,
      label,
      usedPercent: rolled ? 0 : Math.max(0, Math.min(100, Math.round(used))),
      resetsAt: rolled ? null : resetsAt,
    });
  }
  return out;
}

/** MCP servers this machine knows about: configured in .claude.json, or seen by the probe. */
export function installedMcpServers(claudeJson: Record<string, unknown>, probe: Record<string, unknown>): string[] {
  const configured = Object.keys((claudeJson["mcpServers"] as Record<string, unknown>) ?? {});
  const probed = Object.keys((probe["servers"] as Record<string, unknown>) ?? {});
  return [...new Set([...configured, ...probed])].sort();
}

/**
 * One health verdict for the selected MCP servers: a failure outranks a server the probe has said
 * nothing about, which outranks all-good.
 */
export function mcpHealth(probe: Record<string, unknown>, selected: string[] | null): HealthItem | null {
  const servers = (probe["servers"] as Record<string, { ok?: boolean }>) ?? {};
  const names = selected ?? Object.keys(servers);
  if (!names.length) return null;
  const chosen = names.map((name) => ({ name, verdict: servers[name] }));
  const failing = chosen.filter((s) => s.verdict && s.verdict.ok === false).map((s) => s.name);
  const unknown = chosen.filter((s) => !s.verdict).map((s) => s.name);
  const ok = failing.length ? false : unknown.length ? null : true;
  const detail = failing.length ? `${failing.join(", ")} failing`
    : unknown.length ? `${unknown.join(", ")} not probed`
      : `${chosen.length} server${chosen.length > 1 ? "s" : ""} healthy`;
  return { key: "mcp", label: selected ? names.join(", ") : "MCP", ok, detail };
}

export function readStatus(
  home?: string,
  config: StatusConfig = { mcp: null, outlook: true, ponytail: true, usage: true },
  now = Date.now(),
): StatusSnapshot {
  const paths = homePaths(home);
  const windows = config.usage === false
    ? []
    : rateWindows(readJson<Record<string, unknown>>(paths.rateLimits, {}), now);
  const health: HealthItem[] = [];

  const mcp = mcpHealth(readJson<Record<string, unknown>>(paths.mcpStatus, {}), config.mcp);
  if (mcp) health.push(mcp);

  const outlook = config.outlook === false
    ? {}
    : readJson<{ servers?: Record<string, { ok?: boolean }> }>(paths.outlookStatus, {});
  const outlookServers = Object.values(outlook.servers ?? {});
  if (outlookServers.length) {
    health.push({
      key: "outlook",
      label: "Outlook",
      ok: outlookServers.every((s) => s.ok === true),
      detail: outlookServers.every((s) => s.ok === true) ? "reachable" : "not reachable",
    });
  }

  let ponytail: string | null = null;
  if (config.ponytail === false) return { windows, health, ponytail };
  try {
    ponytail = readFileSync(paths.ponytailFlag, "utf8").trim().split("\n")[0] || null;
  } catch {
    ponytail = null;
  }
  return { windows, health, ponytail };
}

export { readJson as readStatusJson };

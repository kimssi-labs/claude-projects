import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { rateWindows, readStatus } from "../status.js";
import { MetricsHistory, processTree, sumTree, SYSTEM_SERIES } from "../metrics.js";
import type { MetricsSnapshot } from "../types.js";

const NOW = 1_800_000_000_000;

describe("rate windows", () => {
  it("reports every bucket Claude Code publishes, including the model-specific weeks", () => {
    const windows = rateWindows({
      five_hour: { used_percentage: 78, resets_at: NOW / 1000 + 3600 },
      seven_day: { used_percentage: 57, resets_at: NOW / 1000 + 86400 },
      seven_day_opus: { used_percentage: 41, resets_at: NOW / 1000 + 86400 },
      seven_day_sonnet: { used_percentage: 12, resets_at: NOW / 1000 + 86400 },
    }, NOW);
    expect(windows.map((w) => w.key)).toEqual(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]);
    expect(windows.find((w) => w.key === "seven_day_opus")).toMatchObject({ usedPercent: 41, label: "7d Fable/Opus" });
  });

  it("skips a bucket that is not there and zeroes one that already rolled", () => {
    const windows = rateWindows({ five_hour: { used_percentage: 90, resets_at: NOW / 1000 - 10 } }, NOW);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ usedPercent: 0, resetsAt: null });
  });

  it("accepts the utilization spelling and clamps out-of-range values", () => {
    expect(rateWindows({ seven_day: { utilization: 140 } }, NOW)[0]?.usedPercent).toBe(100);
  });
});

describe("readStatus", () => {
  it("shows only the segments this machine has", () => {
    const home = join(mkdtempSync(join(tmpdir(), "cp-status-")), ".claude");
    mkdirSync(join(home, "cache"), { recursive: true });
    expect(readStatus(home)).toEqual({ windows: [], health: [], ponytail: null });

    writeFileSync(join(home, "cache", "rate-limits.json"), JSON.stringify({
      five_hour: { used_percentage: 10, resets_at: NOW / 1000 + 60 },
    }));
    writeFileSync(join(home, ".ponytail-active"), "full\n");
    const status = readStatus(home, { outlook: true, ponytail: true, usage: true }, NOW);
    expect(status.windows).toHaveLength(1);
    expect(status.ponytail).toBe("full");

    // An MCP cache left over from an older version is not a source any more: the dot reported a
    // separate handshake, never this session's connection, so reconnecting a server never moved it.
    writeFileSync(join(home, "cache", "mcp-status.json"), JSON.stringify({ servers: { wiki: { ok: true } } }));
    expect(readStatus(home, { outlook: true, ponytail: true, usage: true }, NOW).health).toEqual([]);
  });
});

describe("metrics", () => {
  const rows = [
    { pid: 1, parentPid: 0, cpu: 1, memoryBytes: 100 },
    { pid: 2, parentPid: 1, cpu: 2, memoryBytes: 200 },
    { pid: 3, parentPid: 2, cpu: 4, memoryBytes: 400 },
    { pid: 9, parentPid: 0, cpu: 8, memoryBytes: 800 },
  ];

  it("sums a session's whole process tree", () => {
    expect(processTree(rows, 1).map((r) => r.pid)).toEqual([1, 2, 3]);
    expect(sumTree(processTree(rows, 1))).toEqual({ cpu: 7, memoryBytes: 700 });
    expect(processTree(rows, 404)).toEqual([]);
  });

  it("survives a cycle in the process table", () => {
    const cyclic = [{ pid: 1, parentPid: 2, cpu: 1, memoryBytes: 1 }, { pid: 2, parentPid: 1, cpu: 1, memoryBytes: 1 }];
    expect(processTree(cyclic, 1).map((r) => r.pid)).toEqual([1, 2]);
  });

  it("keeps a bounded history and forgets sessions that ended", () => {
    const history = new MetricsHistory(3);
    const snapshot = (at: number, cpu: number): MetricsSnapshot => ({
      at,
      system: { cpu, memoryBytes: 1, memoryTotalBytes: 10, cpuGhz: 3.4 },
      sessions: { s1: { cpu, memoryBytes: 2, pid: 5 } },
    });
    for (let i = 0; i < 5; i += 1) history.push(snapshot(i, i));
    expect(history.get(SYSTEM_SERIES).map((s) => s.cpu)).toEqual([2, 3, 4]);
    expect(history.get("s1")).toHaveLength(3);
    history.keepOnly([]);
    expect(history.keys()).toEqual([SYSTEM_SERIES]);
  });
});

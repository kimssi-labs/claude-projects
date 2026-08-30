/**
 * The one settings file, `config/manager.json`, with a section per feature.
 *
 * The terminal version of this app wrote the same file and the same section names, so an existing
 * setup keeps its dock, status-line and launch choices when it moves to the desktop app.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DOCK_EDGES, DOCK_PERCENT, EDGE_AXIS, PERMISSION_MODES, SHELL_CHOICES, THEME_MODES } from "./constants.js";
import { homePaths } from "./paths.js";
import type { DockConfig, DockEdge, LaunchConfig, PermissionMode, ShellChoice, StatusConfig, ThemeMode, UiConfig } from "./types.js";

export const SECTION = { dock: "dock", status: "status", launch: "launch", ui: "ui" } as const;
export const DOCK_MONITORS_KEY = "monitors";
export const DOCK_FLOOR_KEY = "floor";
export { DOCK_EDGES, DOCK_PERCENT, EDGE_AXIS, PERMISSION_MODES, SHELL_CHOICES, THEME_MODES } from "./constants.js";

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  try {
    // Strip a BOM first: PowerShell's `-Encoding utf8` writes one, and JSON.parse throws on it —
    // which would silently look like "no settings yet" and reset every choice in the file.
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};                                   // absent or hand-edited into nonsense: use defaults
  }
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/** A remembered pixel width, or 0 for "let the layout decide". */
function pixels(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/** A remembered window rectangle, or null when there is none worth restoring. */
function windowBounds(value: unknown): UiConfig["window"] {
  const raw = asRecord(value);
  const numbers = ["x", "y", "width", "height"].map((key) => Number(raw[key]));
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = numbers as [number, number, number, number];
  // A zero-sized window is not a position anyone wants restored.
  return width > 0 && height > 0 ? { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export class ConfigStore {
  readonly file: string;

  constructor(home?: string) {
    this.file = homePaths(home).managerConfig;
  }

  private all(): Json {
    return readJson(this.file);
  }

  section(name: string): Json {
    return asRecord(this.all()[name]);
  }

  saveSection(name: string, value: Json): void {
    const config = this.all();
    config[name] = value;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  // -- dock -------------------------------------------------------------------------------------
  /**
   * Dock settings for `device` (default: the last one used). Each monitor keeps its own edge, size
   * and on/off, because a band that suits a portrait panel is wrong on a wide one.
   */
  dock(device?: string | null): DockConfig {
    const raw = this.section(SECTION.dock);
    const perDevice = asRecord(raw[DOCK_MONITORS_KEY]);
    const chosen = device ?? (typeof raw["device"] === "string" ? (raw["device"] as string) : null);
    const merged = { ...raw, ...(chosen ? asRecord(perDevice[chosen]) : {}) };
    const percent = Number(merged["percent"]);
    const edge = merged["edge"];
    return {
      enabled: merged["enabled"] === true,
      device: chosen,
      edge: DOCK_EDGES.includes(edge as DockEdge) ? (edge as DockEdge) : "top",
      percent: Number.isFinite(percent) ? clamp(Math.round(percent), DOCK_PERCENT.min, DOCK_PERCENT.max) : DOCK_PERCENT.default,
    };
  }

  saveDock(config: DockConfig): void {
    const raw = this.section(SECTION.dock);
    const perDevice = asRecord(raw[DOCK_MONITORS_KEY]);
    if (config.device) {
      perDevice[config.device] = { edge: config.edge, percent: config.percent, enabled: config.enabled };
    }
    this.saveSection(SECTION.dock, { ...raw, ...config, [DOCK_MONITORS_KEY]: perDevice });
  }

  /** Monitors with remembered settings — shown as "saved" so the list is not a guess. */
  dockDevices(): string[] {
    return Object.keys(asRecord(this.section(SECTION.dock)[DOCK_MONITORS_KEY]));
  }

  /** Smallest band the window manager accepted on this axis, 0 when never measured. */
  dockFloor(edge: DockEdge): number {
    const floors = asRecord(this.section(SECTION.dock)[DOCK_FLOOR_KEY]);
    const value = Number(floors[EDGE_AXIS[edge]]);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  saveDockFloor(edge: DockEdge, pixels: number): void {
    const raw = this.section(SECTION.dock);
    const floors = asRecord(raw[DOCK_FLOOR_KEY]);
    floors[EDGE_AXIS[edge]] = Math.round(pixels);
    this.saveSection(SECTION.dock, { ...raw, [DOCK_FLOOR_KEY]: floors });
  }

  // -- status line -------------------------------------------------------------------------------
  status(): StatusConfig {
    const chosen = this.section(SECTION.status)["mcp"];
    return { mcp: Array.isArray(chosen) ? chosen.map(String) : null };
  }

  saveStatus(config: StatusConfig): void {
    this.saveSection(SECTION.status, { mcp: config.mcp });
  }

  // -- launching sessions --------------------------------------------------------------------------
  launch(): LaunchConfig {
    const raw = this.section(SECTION.launch);
    const shell = raw["shell"];
    const permission = raw["permission"];
    return {
      shell: SHELL_CHOICES.includes(shell as ShellChoice) ? (shell as ShellChoice) : "auto",
      permission: PERMISSION_MODES.includes(permission as PermissionMode) ? (permission as PermissionMode) : "default",
      terminal: typeof raw["terminal"] === "string" ? (raw["terminal"] as string) : "",
    };
  }

  saveLaunch(config: LaunchConfig): void {
    this.saveSection(SECTION.launch, { ...config });
  }

  // -- where the user was ---------------------------------------------------------------------------
  ui(): UiConfig {
    const raw = this.section(SECTION.ui);
    const cursor = Number(raw["cursor"]);
    const theme = raw["theme"];
    return {
      project: typeof raw["project"] === "string" ? (raw["project"] as string) : null,
      cursor: Number.isFinite(cursor) && cursor > 0 ? Math.round(cursor) : 0,
      theme: THEME_MODES.includes(theme as ThemeMode) ? (theme as ThemeMode) : "system",
      monitor: raw["monitor"] !== false,          // on unless it was explicitly turned off
      window: windowBounds(raw["window"]),
      navWidth: pixels(raw["navWidth"]),
      asideWidth: pixels(raw["asideWidth"]),
    };
  }

  saveUi(config: UiConfig): void {
    this.saveSection(SECTION.ui, { ...config });
  }

  // -- project aliases ------------------------------------------------------------------------------
  aliases(): Record<string, string> {
    const file = homePaths(dirname(dirname(this.file))).aliases;
    const raw = readJson(file);
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  }

  saveAliases(aliases: Record<string, string>): void {
    const file = homePaths(dirname(dirname(this.file))).aliases;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(aliases, null, 2)}\n`, "utf8");
  }
}

/**
 * Smallest percentage that still clears a measured floor, rounded up: below it every value produces
 * the same window, which is indistinguishable from the setting being broken.
 */
export function percentFloor(floorPx: number, spanPx: number): number {
  if (floorPx <= 0 || spanPx <= 0) return DOCK_PERCENT.min;
  return clamp(Math.ceil((floorPx * 100) / spanPx), DOCK_PERCENT.min, DOCK_PERCENT.max);
}

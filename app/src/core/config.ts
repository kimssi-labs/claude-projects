/**
 * The one settings file, `config/manager.json`, with a section per feature.
 *
 * The terminal version of this app wrote the same file and the same section names, so an existing
 * setup keeps its dock, status-line and launch choices when it moves to the desktop app.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_PASTE_HOTKEY, DOCK_EDGES, DOCK_PERCENT, EDGE_AXIS, LAYOUT_MODES, PERMISSION_MODES, SHELL_CHOICES, STACK_BELOW, THEME_MODES } from "./constants.js";
import { homePaths } from "./paths.js";
import type { DockConfig, DockEdge, LaunchConfig, LayoutMode, PermissionMode, ShellChoice, StatusConfig, ThemeMode, UiConfig } from "./types.js";

export const SECTION = { dock: "dock", status: "status", launch: "launch", ui: "ui" } as const;
export const DOCK_MONITORS_KEY = "monitors";
export const DOCK_SETUPS_KEY = "setups";
export const DOCK_FLOOR_KEY = "floor";
export { DEFAULT_PASTE_HOTKEY, DOCK_EDGES, DOCK_PERCENT, EDGE_AXIS, LAYOUT_MODES, PERMISSION_MODES, SHELL_CHOICES, STACK_BELOW, THEME_MODES } from "./constants.js";

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

/**
 * A remembered pane size as a fraction of the window, or 0 for "let the layout decide".
 *
 * Sizes used to be kept in pixels, which is only right until the window changes: a divider set in
 * a tall window put the pane below it eight pixels tall in a docked band. Anything above 1 is a
 * pixel count from an older settings file and is dropped — the layout picks again, once.
 */
function fraction(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) return 0;
  return Math.round(number * 1000) / 1000;
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
   * Dock settings for `device`, or for the monitors currently attached.
   *
   * Two levels, because both questions matter. Each monitor keeps its own edge, size and on/off —
   * a band that suits a portrait panel is wrong on a wide one. And each ARRANGEMENT of monitors
   * (`setup`: every attached monitor, sorted) remembers which of them was docked, so plugging the
   * laptop into its two screens brings back the screen you had it on, not just its size.
   */
  dock(device?: string | null, setup?: string | null): DockConfig {
    const raw = this.section(SECTION.dock);
    const perDevice = asRecord(raw[DOCK_MONITORS_KEY]);
    const perSetup = setup ? asRecord(asRecord(raw[DOCK_SETUPS_KEY])[setup]) : {};
    const chosen = device
      ?? (typeof perSetup["device"] === "string" ? (perSetup["device"] as string) : null)
      ?? (typeof raw["device"] === "string" ? (raw["device"] as string) : null);
    const merged = { ...raw, ...(chosen ? asRecord(perDevice[chosen]) : {}), ...perSetup };
    const percent = Number(merged["percent"]);
    const edge = merged["edge"];
    return {
      enabled: merged["enabled"] === true,
      device: chosen,
      edge: DOCK_EDGES.includes(edge as DockEdge) ? (edge as DockEdge) : "top",
      percent: Number.isFinite(percent) ? clamp(Math.round(percent), DOCK_PERCENT.min, DOCK_PERCENT.max) : DOCK_PERCENT.default,
    };
  }

  saveDock(config: DockConfig, setup?: string | null): void {
    const raw = this.section(SECTION.dock);
    const perDevice = asRecord(raw[DOCK_MONITORS_KEY]);
    const setups = asRecord(raw[DOCK_SETUPS_KEY]);
    if (config.device) {
      perDevice[config.device] = { edge: config.edge, percent: config.percent, enabled: config.enabled };
    }
    if (setup) {
      setups[setup] = { device: config.device, edge: config.edge, percent: config.percent, enabled: config.enabled };
    }
    this.saveSection(SECTION.dock, {
      ...raw, ...config, [DOCK_MONITORS_KEY]: perDevice, [DOCK_SETUPS_KEY]: setups,
    });
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
    const raw = this.section(SECTION.status);
    const chosen = raw["windows"];
    // Null unless a choice was written down: every window Claude Code reports, which on a machine
    // it reports none for is nothing either way.
    return { windows: Array.isArray(chosen) ? chosen.map(String) : null };
  }

  saveStatus(config: StatusConfig): void {
    this.saveSection(SECTION.status, { ...config });
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
      customShell: typeof raw["customShell"] === "string" ? (raw["customShell"] as string) : "",
      pasteHotkey: typeof raw["pasteHotkey"] === "string"
        ? (raw["pasteHotkey"] as string)
        : DEFAULT_PASTE_HOTKEY,
      autoClipPath: raw["autoClipPath"] !== false,      // on unless it has been turned off
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
      layout: LAYOUT_MODES.includes(raw["layout"] as LayoutMode) ? (raw["layout"] as LayoutMode) : "auto",
      stackBelow: Number.isFinite(Number(raw["stackBelow"])) && Number(raw["stackBelow"]) > 0
        ? clamp(Math.round(Number(raw["stackBelow"])), STACK_BELOW.min, STACK_BELOW.max)
        : STACK_BELOW.default,
      window: windowBounds(raw["window"]),
      navWidth: fraction(raw["navWidth"]),
      asideWidth: fraction(raw["asideWidth"]),
      stackTop: fraction(raw["stackTop"]),
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

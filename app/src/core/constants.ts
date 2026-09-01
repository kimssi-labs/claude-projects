/**
 * Values both the machine side and the page need.
 *
 * Kept free of any `node:` import on purpose: the renderer bundles whatever it imports, and pulling
 * `fs` into the page is how a browser build breaks (and how a preload boundary gets blurred).
 */
import type { DockEdge, LayoutMode, PermissionMode, ShellChoice, ThemeMode } from "./types.js";

export const DOCK_EDGES: DockEdge[] = ["left", "top", "right", "bottom"];
export const DOCK_PERCENT = { min: 5, max: 60, default: 20 } as const;
export const SHELL_CHOICES: ShellChoice[] = ["auto", "pwsh", "powershell", "cmd", "bash", "custom", "none"];
export const PERMISSION_MODES: PermissionMode[] = ["default", "bypass", "accept", "plan", "auto"];
/** Which axis an edge measures, so a floor learned on one edge applies to its opposite. */
export const EDGE_AXIS: Record<DockEdge, "width" | "height"> = {
  left: "width", right: "width", top: "height", bottom: "height",
};

export const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
export const LAYOUT_MODES: LayoutMode[] = ["auto", "horizontal", "vertical"];
/** Ctrl+Alt+V: near the paste it assists, and not a shortcut a terminal or editor already wants. */
export const DEFAULT_PASTE_HOTKEY = "CommandOrControl+Alt+V";
/** The stacking width is a real window width, so the useful range is a real window's range. */
export const STACK_BELOW = { min: 360, max: 1600, default: 520, step: 20 } as const;

/**
 * Rate-limit buckets Claude Code reports, in the order they are shown.
 *
 * Only the two it actually sends. Per-model weekly windows (seven_day_opus, seven_day_sonnet) were
 * listed here for a while and never once arrived — verified against the real status-line payload
 * with Fable 5 running, which carried exactly these two keys — so the gauges for them could never
 * draw and only made the settings list lie about what the strip can show.
 */
export const RATE_WINDOWS: { key: string; label: string; short: string }[] = [
  { key: "five_hour", label: "5h", short: "5h" },
  { key: "seven_day", label: "7d", short: "7d" },
];

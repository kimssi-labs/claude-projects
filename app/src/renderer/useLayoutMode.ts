/**
 * How much room the window has, as one word.
 *
 * Docked as a band the window is either short and wide (top/bottom edge) or tall and narrow
 * (left/right edge), and both have to work without a scrollbar — so the mode is decided per axis
 * rather than by one breakpoint.
 */
import { useEffect, useState } from "react";

import type { LayoutMode } from "@core/types";

export type LayoutShape = "full" | "compact" | "band" | "column";

/** Below this height the window is a horizontal band: one strip, nothing stacked. */
export const BAND_MAX_HEIGHT = 420;
/** Below this width it is a vertical column: the lists stack instead of sitting side by side. */
export const COLUMN_MAX_WIDTH = 520;
/** Below this width the detail panel has to go — it would squeeze the list to nothing. */
export const COMPACT_MAX_WIDTH = 960;

/** Smallest a stacked pane may be and still be a list rather than a sliver. */
export const STACK_MIN = 120;
/** The divider between the two stacked panes (`h-1`). */
const STACK_DIVIDER = 4;

/**
 * How tall the upper stacked pane should actually be, given the room the two panes share.
 *
 * The remembered height is in pixels, and a band is often far shorter than the window it was set
 * in: 661 px of project list in a 762 px band left the sessions with nothing, so entering a project
 * showed no sessions at all. The saved value is kept — it fits again in a taller window — but what
 * is drawn never takes so much that the pane below it disappears.
 *
 * `available` is the height of the pair, measured, not the window's: header and toolbar came to
 * 149 px here, and a guessed constant was the difference between a list and a sliver.
 */
export function stackedTopHeight(saved: number, available: number): number {
  if (!saved || !available) return 0;                     // 0 means "share the space evenly"
  // The divider sits between the two panes and is part of what was measured, so it comes off too.
  const most = Math.max(STACK_MIN, available - STACK_MIN - STACK_DIVIDER);
  return Math.min(saved, most);
}

export function layoutFor(
  width: number,
  height: number,
  mode: LayoutMode = "auto",
  stackBelow: number = COLUMN_MAX_WIDTH,
): LayoutShape {
  if (mode === "vertical") return "column";       // stacked, whatever the window is doing
  if (mode !== "horizontal" && width <= stackBelow) return "column";
  // Narrow wins over short: a 400x300 window is a column with a tiny list, not a strip of columns.
  if (height <= BAND_MAX_HEIGHT) return "band";
  if (width <= COMPACT_MAX_WIDTH) return "compact";
  return "full";
}

export function useLayoutMode(
  mode: LayoutMode = "auto",
  stackBelow: number = COLUMN_MAX_WIDTH,
): { mode: LayoutShape; width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { mode: layoutFor(size.width, size.height, mode, stackBelow), ...size };
}

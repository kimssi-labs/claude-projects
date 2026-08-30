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

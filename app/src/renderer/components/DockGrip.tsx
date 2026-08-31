/**
 * The one side of a docked band you may drag.
 *
 * While docked the window frame does not resize — Windows draws the resize cursor for every side of
 * a frame at once, and three of those sides are against the screen, so offering a resize there was
 * offering something that could not happen. The frame is fixed instead and this strip stands in for
 * the one side that is free, with the cursor only where the drag is real.
 */
import { useRef } from "react";

import type { DockEdge } from "@core/types";

/** Which way the band grows when this edge is dragged, and where the grip sits. */
const GRIP: Record<DockEdge, { place: string; cursor: string; vertical: boolean; sign: 1 | -1 }> = {
  top: { place: "left-0 right-0 bottom-0 h-1.5", cursor: "cursor-ns-resize", vertical: false, sign: 1 },
  bottom: { place: "left-0 right-0 top-0 h-1.5", cursor: "cursor-ns-resize", vertical: false, sign: -1 },
  left: { place: "top-0 bottom-0 right-0 w-1.5", cursor: "cursor-ew-resize", vertical: true, sign: 1 },
  right: { place: "top-0 bottom-0 left-0 w-1.5", cursor: "cursor-ew-resize", vertical: true, sign: -1 },
};

/** Smaller than this and the band is not a band; the main process clamps the far end. */
const MINIMUM = 60;

export function DockGrip({ edge, onDrag }: {
  edge: DockEdge;
  /** Each step of the drag, and once more when the hand lets go. */
  onDrag: (thickness: number, done: boolean) => void;
}) {
  const grip = GRIP[edge];
  const start = useRef({ at: 0, thickness: 0 });
  const latest = useRef(0);

  const thicknessNow = (): number => (grip.vertical ? window.innerWidth : window.innerHeight);

  return (
    <div
      role="separator"
      aria-orientation={grip.vertical ? "vertical" : "horizontal"}
      aria-label="Resize the docked band"
      className={`no-drag absolute z-20 ${grip.place} ${grip.cursor} bg-transparent hover:bg-accent/40 active:bg-accent/60 transition-colors`}
      onPointerDown={(event) => {
        start.current = { at: grip.vertical ? event.screenX : event.screenY, thickness: thicknessNow() };
        latest.current = start.current.thickness;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        // Screen coordinates, not client ones: the window is moving under the pointer as we drag,
        // so a client offset would chase its own tail.
        const moved = (grip.vertical ? event.screenX : event.screenY) - start.current.at;
        latest.current = Math.max(MINIMUM, Math.round(start.current.thickness + moved * grip.sign));
        onDrag(latest.current, false);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        onDrag(latest.current, true);
      }}
    />
  );
}

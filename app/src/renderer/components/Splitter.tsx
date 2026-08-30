/**
 * A drag handle between two panes.
 *
 * Pointer capture rather than window listeners: the drag keeps working when the pointer leaves the
 * 4-pixel handle, which it does immediately, and it ends even if the button is released off-window.
 */
import { useRef } from "react";

export interface SplitterProps {
  /** Current width of the pane being sized, in pixels. */
  width: number;
  /** Which side the pane is on — the direction a drag has to grow it. */
  side: "left" | "right";
  min: number;
  max: number;
  onDrag: (width: number) => void;
  /** Called once when the drag ends, for whoever wants to remember the size. */
  onCommit?: (width: number) => void;
}

export function Splitter({ width, side, min, max, onDrag, onCommit }: SplitterProps) {
  const start = useRef({ x: 0, width: 0 });

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/40 active:bg-accent/60 transition-colors"
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = event.clientX - start.current.x;
        const next = start.current.width + (side === "left" ? delta : -delta);
        onDrag(Math.max(min, Math.min(max, Math.round(next))));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit?.(width);
      }}
      onDoubleClick={() => {
        // A double-click is the usual "give me the default back" for a splitter.
        onDrag(0);
        onCommit?.(0);
      }}
    />
  );
}

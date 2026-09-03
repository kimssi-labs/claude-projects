/**
 * A drag handle between two panes.
 *
 * Pointer capture rather than window listeners: the drag keeps working when the pointer leaves the
 * 4-pixel handle, which it does immediately, and it ends even if the button is released off-window.
 */
import { useRef } from "react";
import { useText } from "../useText";

export interface SplitterProps {
  /** Current width — or height, for a horizontal divider — of the pane being sized, in pixels. */
  width: number;
  /** Which side the pane is on — the direction a drag has to grow it. */
  side: "left" | "right" | "top" | "bottom";
  min: number;
  max: number;
  onDrag: (width: number) => void;
  /** Called once when the drag ends, for whoever wants to remember the size. */
  onCommit?: (width: number) => void;
}

export function Splitter({ width, side, min, max, onDrag, onCommit }: SplitterProps) {
  const t = useText();
  const start = useRef({ position: 0, width: 0 });
  const vertical = side === "left" || side === "right";
  const grows = side === "left" || side === "top";

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={t("tip.resizePane")}
      className={`shrink-0 bg-transparent hover:bg-accent/40 active:bg-accent/60 transition-colors ${
        vertical ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}`}
      onPointerDown={(event) => {
        start.current = { position: vertical ? event.clientX : event.clientY, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = (vertical ? event.clientX : event.clientY) - start.current.position;
        const next = start.current.width + (grows ? delta : -delta);
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

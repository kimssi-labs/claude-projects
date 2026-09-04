/**
 * Docking — the page side.
 *
 * The state (is the window a band, and on which edge) is asked for once and then pushed by main on
 * every change, so nothing here can drift from what the window is actually doing. The caption
 * button and the band's resize grip live here too: they are dock's, and the chrome that shows
 * them only offers a slot.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { DockConfig, DockEdge } from "@core/types";

import { api, type SettingsPayload } from "../../renderer/api";
import { useText } from "../../renderer/useText";
import type { DisplayInfo, DockState } from "./contract";

export interface DockUi extends DockState {
  /** Dock to the remembered edge, or undock. Answers with the state as it then stands. */
  toggle(): Promise<DockState>;
  /** Each step of a grip drag, and once more when the hand lets go. */
  drag(thickness: number, done: boolean): void;
  /** From the settings screen: give the edge back. Answers with the settings as saved. */
  release(): Promise<SettingsPayload>;
  /** From the settings screen: apply this band. */
  apply(config: DockConfig): Promise<{ ok: boolean; message?: string; settings?: SettingsPayload }>;
  displays(): Promise<DisplayInfo[]>;
}

export function useDock(): DockUi {
  const [state, setState] = useState<DockState>({ docked: false, edge: "top" });
  useEffect(() => { void api.dockState().then(setState); }, []);
  useEffect(() => api.onDockState(setState), []);

  const toggle = useCallback(async () => {
    const next = await api.dockToggle();
    setState(next);
    return next;
  }, []);
  const drag = useCallback((thickness: number, done: boolean) => api.dragDock({ thickness, done }), []);
  const release = useCallback(() => api.releaseDock(), []);
  const apply = useCallback((config: DockConfig) => api.applyDock(config), []);
  const displays = useCallback(() => api.displays(), []);

  return { ...state, toggle, drag, release, apply, displays };
}

/** The top-edge glyph, turned to put the wall on the configured side. */
const EDGE_ROTATION: Record<DockEdge, number> = { top: 0, right: 90, bottom: 180, left: 270 };

/** The wall on one side, and an arrow into it (dock) or out of it (undock). */
function DockGlyph({ edge, releasing }: { edge: DockEdge; releasing: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <g transform={`rotate(${EDGE_ROTATION[edge]} 5 5)`}>
        <path d="M0.6 0.6h8.8" strokeWidth="1.6" />
        {releasing ? (
          <>
            <path d="M5 3.2v5.6" />
            <path d="M2.6 6.4L5 8.8l2.4-2.4" />
          </>
        ) : (
          <>
            <path d="M5 8.8V3.2" />
            <path d="M2.6 5.6L5 3.2l2.4 2.4" />
          </>
        )}
      </g>
    </svg>
  );
}

const BUTTON = "no-drag grid h-8 w-11 place-items-center text-bone-400 transition-colors";

/** The caption button: the wall sits on the configured edge and the arrow points into or out of it. */
export function DockButton({ docked, edge, onToggle }: { docked: boolean; edge: DockEdge; onToggle: () => void }) {
  const t = useText();
  const edgeName = t(`edge.${edge}` as "edge.top");
  return (
    <button
      type="button"
      aria-label={docked ? t("tip.undock") : t("tip.dock")}
      title={docked ? t("tip.undockEdge", { edge: edgeName }) : t("tip.dockEdge", { edge: edgeName })}
      onClick={onToggle}
      className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100 ${docked ? "text-accent" : ""}`}
    >
      <DockGlyph edge={edge} releasing={docked} />
    </button>
  );
}

/** Which way the band grows when this edge is dragged, and where the grip sits. */
const GRIP: Record<DockEdge, { place: string; cursor: string; vertical: boolean; sign: 1 | -1 }> = {
  top: { place: "left-0 right-0 bottom-0 h-1.5", cursor: "cursor-ns-resize", vertical: false, sign: 1 },
  bottom: { place: "left-0 right-0 top-0 h-1.5", cursor: "cursor-ns-resize", vertical: false, sign: -1 },
  left: { place: "top-0 bottom-0 right-0 w-1.5", cursor: "cursor-ew-resize", vertical: true, sign: 1 },
  right: { place: "top-0 bottom-0 left-0 w-1.5", cursor: "cursor-ew-resize", vertical: true, sign: -1 },
};

/** Smaller than this and the band is not a band; the main process clamps the far end. */
const MINIMUM = 60;

/**
 * The one side of a docked band you may drag.
 *
 * While docked the window frame does not resize — Windows draws the resize cursor for every side of
 * a frame at once, and three of those sides are against the screen, so offering a resize there was
 * offering something that could not happen. The frame is fixed instead and this strip stands in for
 * the one side that is free, with the cursor only where the drag is real.
 */
export function DockGrip({ edge, onDrag }: {
  edge: DockEdge;
  /** Each step of the drag, and once more when the hand lets go. */
  onDrag: (thickness: number, done: boolean) => void;
}) {
  const t = useText();
  const grip = GRIP[edge];
  const start = useRef({ at: 0, thickness: 0 });
  const latest = useRef(0);

  const thicknessNow = (): number => (grip.vertical ? window.innerWidth : window.innerHeight);

  return (
    <div
      role="separator"
      aria-orientation={grip.vertical ? "vertical" : "horizontal"}
      aria-label={t("tip.resizeBand")}
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

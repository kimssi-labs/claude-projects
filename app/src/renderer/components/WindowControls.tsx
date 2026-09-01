/**
 * The caption buttons, drawn by us.
 *
 * Four, not three: docking and maximising are different things and used to share a button, so
 * "restore" sometimes gave the edge back and sometimes gave the window its old size. The dock
 * button now toggles the band, and maximise means what it says everywhere else.
 *
 * The dock glyph is drawn for the edge that is actually configured: the wall sits on that side and
 * the arrow points into it — or away from it, when pressing the button would let the edge go.
 */
import type { DockEdge } from "@core/types";

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

export interface WindowControlsProps {
  /** The window is maximised (not docked): the middle button offers its old size back. */
  maximized: boolean;
  /** The band is reserved: the dock button offers to let the edge go. */
  docked: boolean;
  /** Which edge this window docks to — the side the glyph draws its wall on. */
  edge: DockEdge;
  onMinimize: () => void;
  /** Maximise, or restore when already maximised. */
  onMaximize: () => void;
  /** Dock to the remembered edge, or undock. */
  onDock: () => void;
  onClose: () => void;
}

const BUTTON = "no-drag grid h-8 w-11 place-items-center text-bone-400 transition-colors";

export function WindowControls({ maximized, docked, edge, onMinimize, onMaximize, onDock, onClose }: WindowControlsProps) {
  return (
    <div className="flex shrink-0 self-start">
      <button
        type="button"
        aria-label={docked ? "Undock" : "Dock to the edge"}
        title={docked
          ? `Undock — release the ${edge} edge`
          : `Dock — reserve a band on the ${edge} edge`}
        onClick={onDock}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100 ${docked ? "text-accent" : ""}`}
      >
        <DockGlyph edge={edge} releasing={docked} />
      </button>

      <button type="button" aria-label="Minimise" title="Minimise" onClick={onMinimize}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100`}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximise"}
        title={maximized ? "Restore — back to the last window size" : "Maximise — fill the screen"}
        onClick={onMaximize}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100`}
      >
        {maximized ? (
          // Two overlapping frames: the same glyph Windows uses for "restore down".
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2.5 2.5V0.5h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>

      <button type="button" aria-label="Close" title="Close" onClick={onClose}
        className={`${BUTTON} hover:bg-bad hover:text-white`}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" stroke="currentColor" strokeWidth="1">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}

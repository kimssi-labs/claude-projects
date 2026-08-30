/**
 * The caption buttons, drawn by us.
 *
 * Windows can draw them itself over a hidden title bar, but then their glyph follows the window's
 * real state — and a docked band IS the maximised state as far as this app is concerned, so the
 * middle button has to show "restore" while docked and undock when pressed. That is a decision only
 * this side knows about.
 */
export interface WindowControlsProps {
  /** Docked, or actually maximised: either way the middle button offers to restore. */
  restorable: boolean;
  onMinimize: () => void;
  onToggle: () => void;
  onClose: () => void;
}

const BUTTON = "no-drag grid h-8 w-11 place-items-center text-bone-400 transition-colors";

export function WindowControls({ restorable, onMinimize, onToggle, onClose }: WindowControlsProps) {
  return (
    <div className="flex shrink-0 self-start">
      <button type="button" aria-label="Minimise" title="Minimise" onClick={onMinimize}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100`}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      <button
        type="button"
        aria-label={restorable ? "Restore" : "Maximise"}
        title={restorable ? "Restore" : "Maximise"}
        onClick={onToggle}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100`}
      >
        {restorable ? (
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

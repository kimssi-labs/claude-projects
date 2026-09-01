/**
 * The strip along the top: what the program is, and the caption buttons.
 *
 * It used to carry the usage bars as well, which meant a narrow window cut them off — and half a
 * percentage is worse than none. Usage now sits with the machine graphs, where it is read as the
 * gauge it is, and this strip does the one job a title bar has.
 */
import { Truncated } from "./Truncated";

export function TitleBar({ version, draggable = true, controls }: {
  version: string;
  /** False while docked: a band is not a window to be dragged around. */
  draggable?: boolean;
  /** The caption buttons, drawn at the right end. */
  controls?: React.ReactNode;
}) {
  return (
    <header
      className={`${draggable ? "drag" : ""} flex h-8 shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-800/60 pl-2 backdrop-blur`}
    >
      {/* The app's own mark, so a docked band still says whose band it is. */}
      <img src="./icon.png" alt="" className="h-4 w-4 shrink-0 rounded-sm" />
      <Truncated as="span" className="text-xs font-semibold tracking-wide text-bone-100">Hangar</Truncated>
      <span className="text-[11px] text-bone-500 tabular-nums">v{version}</span>
      <div className="flex-1" />
      {controls}
    </header>
  );
}

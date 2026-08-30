/**
 * The strip along the top: usage windows on the left, health on the right.
 *
 * Each segment appears only when its source exists on this machine, which is what makes the same
 * build usable by someone who has neither the wiki MCP nor the Outlook probe.
 *
 * Every usage window is the same fixed-width column, so the labels line up with each other and the
 * percentages line up with each other however many windows the machine reports.
 */
import type { RateWindow, StatusSnapshot } from "@core/types";

import { formatClock, formatPercent, usageTone } from "../format";
import { Truncated } from "./Truncated";

function barTone(percent: number): string {
  return percent >= 80 ? "bg-bad" : percent >= 50 ? "bg-warn" : "bg-ok";
}

/** The bar itself: a track that is always full width, and a fill that is the number. */
function Bar({ percent, className = "" }: { percent: number; className?: string }) {
  return (
    <div className={`h-1.5 rounded-full bg-ink-600 overflow-hidden ${className}`}>
      <div
        className={`h-full rounded-full ${barTone(percent)}`}
        // A window at 0 % still shows a sliver, so the bar reads as a bar and not as a missing one.
        style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
      />
    </div>
  );
}

/**
 * Full height: the name and its reset time on top, the bar and its number together underneath.
 *
 * The percentage belongs beside the bar it describes. Putting it on the label row pushed it to the
 * far side of the column, half an inch from the thing it is a reading of.
 */
function UsageColumn({ window: usage }: { window: RateWindow }) {
  return (
    <div className="w-44 shrink-0" title={`${usage.label} usage`}>
      {/* Both belong to the label, so they sit together — pushed apart, the reset time reads as if
          it belonged to the next window along. */}
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[11px] uppercase tracking-wide text-bone-500 shrink-0">{usage.label}</span>
        <Truncated
          as="span"
          title={usage.resetsAt ? `Resets ${formatClock(usage.resetsAt)}` : undefined}
          className="text-[10px] text-bone-500 tabular-nums"
        >
          {usage.resetsAt ? `↻ ${formatClock(usage.resetsAt)}` : ""}
        </Truncated>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <Bar percent={usage.usedPercent} className="flex-1" />
        {/* Fixed width, right-aligned: the numbers still line up down the strip. */}
        <span className={`text-xs tabular-nums w-9 text-right ${usageTone(usage.usedPercent)}`}>
          {formatPercent(usage.usedPercent)}
        </span>
      </div>
    </div>
  );
}

/** Docked band: one line, but still three fixed columns, so nothing wanders as numbers change. */
function UsageRow({ window: usage }: { window: RateWindow }) {
  return (
    <div className="flex items-center gap-1 shrink-0" title={`${usage.label} usage`}>
      <span className="text-[11px] uppercase tracking-wide text-bone-500 whitespace-nowrap">{usage.label}</span>
      <Bar percent={usage.usedPercent} className="w-14" />
      <span className={`text-xs tabular-nums w-9 text-right ${usageTone(usage.usedPercent)}`}>
        {formatPercent(usage.usedPercent)}
      </span>
    </div>
  );
}

export function StatusBar({ status, appVersion, compact = false, onRefresh, controls }: {
  status: StatusSnapshot | null;
  appVersion: string;
  /** The caption buttons, drawn at the right end of this strip. */
  controls?: React.ReactNode;
  /** Re-read the usage cache now, instead of waiting for the next poll. */
  onRefresh?: () => void;
  /** A docked band has no room for two lines per window; the bar and the number still fit on one. */
  compact?: boolean;
}) {
  const hasAnything = !!status && (status.windows.length || status.health.length || !!status.ponytail);
  return (
    <header className={`drag flex items-center border-b border-ink-600 bg-ink-800/60 backdrop-blur ${compact ? "h-8 gap-3 pl-5 pr-0" : "h-14 gap-4 pl-3 pr-0"}`}
      // The caption buttons are drawn over the right end of this strip.
      >
      {/* No wordmark here: the title bar already says Hangar, and the strip needs the width. */}
      {/* More windows than the width can show is normal in a band: scroll them sideways rather
          than hide the ones that did not fit. The page itself still never scrolls. */}
      <div className={`flex items-center gap-4 flex-1 min-w-0 ${compact ? "overflow-x-auto no-bar" : "overflow-hidden"}`}>
        {(status?.windows ?? []).map((usage) => (
          compact
            ? <UsageRow key={usage.key} window={usage} />
            : <UsageColumn key={usage.key} window={usage} />
        ))}
      </div>

      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          title="Refresh usage"
          aria-label="Refresh usage"
          className="no-drag shrink-0 rounded-md px-1.5 py-0.5 text-bone-500 hover:text-bone-100 hover:bg-ink-700 transition-colors"
        >
          ↻
        </button>
      ) : null}

      <div className="flex items-center gap-3 shrink-0">
        {(status?.health ?? []).map((item) => (
          <span key={item.key} className="flex items-center gap-1 text-xs text-bone-400 min-w-0" title={item.detail}>
            <span className={item.ok === true ? "text-ok" : item.ok === false ? "text-bad" : "text-bone-500"}>
              {item.ok === true ? "●" : item.ok === false ? "▲" : "○"}
            </span>
            <Truncated as="span" className="max-w-[12rem]">{item.label}</Truncated>
          </span>
        ))}
        {status?.ponytail ? <span className="chip">ponytail {status.ponytail}</span> : null}
        {!hasAnything ? <span className="text-xs text-bone-500">no status sources on this machine</span> : null}
        {compact ? null : <span className="text-[11px] text-bone-500 tabular-nums pr-1">v{appVersion}</span>}
      </div>
      {controls}
    </header>
  );
}

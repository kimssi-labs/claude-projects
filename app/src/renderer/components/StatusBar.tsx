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

/** Softens the right edge when the strip has more windows than the width can show. */
const FADE = "linear-gradient(to right, #000 88%, transparent 100%)";

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

/** Full height: label and percentage on one line, the bar under them, reset time beside it. */
function UsageColumn({ window: usage }: { window: RateWindow }) {
  return (
    <div className="w-44 shrink-0" title={`${usage.label} usage`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-bone-500 truncate">{usage.label}</span>
        <span className={`text-xs tabular-nums ${usageTone(usage.usedPercent)}`}>
          {formatPercent(usage.usedPercent)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Bar percent={usage.usedPercent} className="flex-1" />
        <span className="text-[10px] text-bone-500 tabular-nums w-16 text-right">
          {usage.resetsAt ? `↻ ${formatClock(usage.resetsAt)}` : ""}
        </span>
      </div>
    </div>
  );
}

/** Docked band: one line, but still three fixed columns, so nothing wanders as numbers change. */
function UsageRow({ window: usage }: { window: RateWindow }) {
  return (
    <div className="flex items-center gap-2 shrink-0" title={`${usage.label} usage`}>
      <span className="text-[11px] uppercase tracking-wide text-bone-500 w-12 truncate">{usage.label}</span>
      <Bar percent={usage.usedPercent} className="w-16" />
      <span className={`text-xs tabular-nums w-9 text-right ${usageTone(usage.usedPercent)}`}>
        {formatPercent(usage.usedPercent)}
      </span>
    </div>
  );
}

export function StatusBar({ status, appVersion, compact = false }: {
  status: StatusSnapshot | null;
  appVersion: string;
  /** A docked band has no room for two lines per window; the bar and the number still fit on one. */
  compact?: boolean;
}) {
  if (!status) return null;
  const hasAnything = status.windows.length || status.health.length || status.ponytail;
  return (
    <header className={`flex items-center gap-4 px-3 border-b border-ink-600 bg-ink-800/60 backdrop-blur ${compact ? "h-8" : "h-14"}`}>
      {/* No wordmark here: the title bar already says Hangar, and the strip needs the width. */}
      {/* Too many windows for a narrow band is normal; fade the edge so the last one reads as
          "there is more" instead of as a half-drawn widget. */}
      <div
        className="flex items-center gap-4 flex-1 min-w-0 overflow-hidden"
        style={compact ? { maskImage: FADE, WebkitMaskImage: FADE } : undefined}
      >
        {status.windows.map((usage) => (
          compact
            ? <UsageRow key={usage.key} window={usage} />
            : <UsageColumn key={usage.key} window={usage} />
        ))}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {status.health.map((item) => (
          <span key={item.key} className="flex items-center gap-1 text-xs text-bone-400" title={item.detail}>
            <span className={item.ok === true ? "text-ok" : item.ok === false ? "text-bad" : "text-bone-500"}>
              {item.ok === true ? "●" : item.ok === false ? "▲" : "○"}
            </span>
            {item.label}
          </span>
        ))}
        {status.ponytail ? <span className="chip">ponytail {status.ponytail}</span> : null}
        {!hasAnything ? <span className="text-xs text-bone-500">no status sources on this machine</span> : null}
        {compact ? null : <span className="text-[11px] text-bone-500 tabular-nums">v{appVersion}</span>}
      </div>
    </header>
  );
}

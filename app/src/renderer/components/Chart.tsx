/**
 * The two chart shapes this app needs, drawn on a canvas.
 *
 * A charting library would be a dependency and a bundle for two shapes: a sparkline in a row and
 * one area chart per resource. Canvas keeps it to a few lines and, more importantly, keeps the
 * drawing pixel-exact at any DPI, which a stretched SVG does not.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MetricSample, RateWindow } from "@core/types";

import { formatClock, formatPercent, resetLabel, usageTone } from "../format";
import { Truncated } from "./Truncated";

const ACCENT = "#d97757";
const ACCENT_SOFT = "rgba(217, 119, 87, 0.18)";

/** A palette token as a canvas colour — the grid has to invert with the theme like everything else. */
function token(name: string, alpha: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const channels = raw ? raw.split(/\s+/).join(", ") : "128, 128, 128";
  return `rgba(${channels}, ${alpha})`;
}

function useCanvas(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void): React.RefObject<HTMLCanvasElement> {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    canvas.width = Math.max(1, Math.round(clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(clientHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, clientWidth, clientHeight);
    draw(context, clientWidth, clientHeight);
  });
  return ref;
}

function path(
  context: CanvasRenderingContext2D,
  values: number[],
  width: number,
  height: number,
  max: number,
): void {
  const step = values.length > 1 ? width / (values.length - 1) : width;
  values.forEach((value, index) => {
    const x = index * step;
    const y = height - (Math.min(value, max) / max) * height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
}

export function Sparkline({ samples, field = "cpu", max = 100, className = "w-24" }: {
  samples: MetricSample[];
  /** What to plot. Memory is plotted against its own peak — the shape, with the number beside it. */
  field?: "cpu" | "memoryBytes";
  max?: number;
  className?: string;
}) {
  const ref = useCanvas((context, width, height) => {
    // A shared floor, so the two sparklines of a row read as one instrument: without it, an idle
    // CPU line sat ON the bottom border while a flat memory line sat ON the top one, and the pair
    // looked broken rather than merely different.
    context.strokeStyle = token("--text", 0.18);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height - 0.5);
    context.lineTo(width, height - 0.5);
    context.stroke();

    if (samples.length < 2) return;
    const values = samples.map((s) => (field === "cpu" ? s.cpu : s.memoryBytes));
    // CPU is absolute. Memory has no ceiling a row this small can honour, so it is drawn to its
    // own peak — with headroom, or a steady footprint is a line pinned to the canvas's top edge.
    const ceiling = field === "cpu"
      ? Math.max(max, ...values) || 1
      : (Math.max(...values) || 1) * 1.25;
    const pad = 1.5;                               // keep the stroke inside the canvas at 0 and 100 %
    const usable = Math.max(1, height - pad * 2);
    const step = values.length > 1 ? width / (values.length - 1) : width;
    context.beginPath();
    values.forEach((value, index) => {
      const x = index * step;
      const y = pad + (1 - Math.min(value, ceiling) / ceiling) * usable;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = ACCENT;
    context.lineWidth = 1.5;
    context.stroke();
  });
  return <canvas ref={ref} className={`h-6 ${className}`} />;
}

/**
 * How wide the element actually is, so a card can decide its own shape.
 *
 * A card in the aside is a different width in every layout, and in a docked band the user drags
 * that width while looking at it — a breakpoint on the window would be measuring the wrong thing.
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Under this, a label and its number cannot sit on one line without touching. */
export const NARROW_CARD = 132;

/** The upright bar a card falls back to when it is too narrow to read across. */
function UprightBar({ percent, tone }: { percent: number; tone: string }) {
  return (
    <div className="mt-1 flex justify-center">
      <div className="h-14 w-3 rounded-full bg-ink-600 overflow-hidden flex items-end">
        <div className={`w-full rounded-full ${tone}`} style={{ height: `${Math.max(3, Math.min(100, percent))}%` }} />
      </div>
    </div>
  );
}

export interface AreaChartProps {
  samples: MetricSample[];
  /** Which field to plot, and the ceiling it is measured against. */
  field: "cpu" | "memoryBytes";
  max: number;
  label: string;
  value: string;
  /** What the value is out of — the machine's memory, say. Dropped first when room runs short. */
  total?: string;
  /** The label a narrow card uses instead; the full one stays in the tooltip. */
  short?: string;
  className?: string;
  /** Half-height, tighter padding — for the bottom strip of a docked column. */
  compact?: boolean;
}

export function AreaChart({ samples, field, max, label, value, total, short, className = "", compact = false }: AreaChartProps) {
  const [box, boxWidth] = useElementWidth<HTMLDivElement>();
  const narrow = boxWidth > 0 && boxWidth < NARROW_CARD;
  const ref = useCanvas((context, width, height) => {
    context.strokeStyle = token("--text", 0.08);
    context.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (height / 4) * i;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    if (samples.length < 2) return;
    const values = samples.map((s) => (field === "cpu" ? s.cpu : s.memoryBytes));
    const ceiling = Math.max(max, ...values) || 1;

    context.beginPath();
    path(context, values, width, height, ceiling);
    context.strokeStyle = ACCENT;
    context.lineWidth = 1.8;
    context.stroke();

    context.lineTo(width, height);
    context.lineTo(0, height);
    context.closePath();
    context.fillStyle = ACCENT_SOFT;
    context.fill();
  });

  const latest = samples.length ? samples[samples.length - 1] : null;
  const percent = latest
    ? Math.min(100, ((field === "cpu" ? latest.cpu : latest.memoryBytes) / (max || 1)) * 100)
    : 0;

  // Too narrow to read a label and a number across: stand the reading up instead of overlapping it.
  if (narrow) {
    return (
      <div ref={box} className={`card p-1 ${className}`} title={`${label} — ${value}${total ? ` of ${total}` : ""}`}>
        <div className="text-[10px] text-bone-400 text-center whitespace-nowrap">{short ?? label}</div>
        <UprightBar percent={percent} tone="bg-accent" />
        <div className="mt-1 text-[10px] font-medium text-bone-100 tabular-nums text-center">
          {value.split(" · ")[0]}
        </div>
      </div>
    );
  }

  return (
    <div ref={box} className={`card ${compact ? "p-1.5" : "p-3"} ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Truncated as="span" className={`${compact ? "text-[11px]" : "text-xs"} text-bone-400`}>{label}</Truncated>
        <span className={`${compact ? "text-xs" : "text-sm"} font-medium text-bone-100 tabular-nums whitespace-nowrap`}>
          {value}
          {total ? <span className="text-bone-500"> / {total}</span> : null}
        </span>
      </div>
      <canvas ref={ref} className={`${compact ? "mt-1 h-7" : "mt-2 h-16"} w-full`} />
    </div>
  );
}

/**
 * One rate-limit window, in the same card as the machine graphs.
 *
 * It used to live in the title bar, where a narrow window cut it off — and a percentage you cannot
 * read is worse than none. Here it sits with CPU and memory, which is what it is: a gauge.
 */
export function UsageCard({ window: usage, className = "", compact = false }: {
  window: RateWindow;
  className?: string;
  compact?: boolean;
}) {
  const [box, boxWidth] = useElementWidth<HTMLDivElement>();
  const narrow = boxWidth > 0 && boxWidth < NARROW_CARD;
  const tone = usage.usedPercent >= 80 ? "bg-bad" : usage.usedPercent >= 50 ? "bg-warn" : "bg-ok";
  const reset = usage.resetsAt ? resetLabel(usage.resetsAt) : "";
  const title = `${usage.label} — ${formatPercent(usage.usedPercent)} used${
    usage.resetsAt ? `, ${resetLabel(usage.resetsAt)} left, resets ${formatClock(usage.resetsAt)}` : ""}`;

  if (narrow) {
    return (
      <div ref={box} className={`card p-1 ${className}`} title={title}>
        <div className="text-[10px] text-bone-400 text-center whitespace-nowrap">{usage.short}</div>
        <UprightBar percent={usage.usedPercent} tone={tone} />
        <div className={`mt-1 text-[10px] font-medium tabular-nums text-center ${usageTone(usage.usedPercent)}`}>
          {formatPercent(usage.usedPercent)}
        </div>
      </div>
    );
  }

  return (
    <div ref={box} className={`card ${compact ? "p-1.5" : "p-3"} ${className}`} title={title}>
      <div className="flex items-baseline justify-between gap-2">
        <Truncated as="span" className={`${compact ? "text-[11px]" : "text-xs"} text-bone-400`}>{usage.label}</Truncated>
        <span className={`${compact ? "text-xs" : "text-sm"} font-semibold tabular-nums ${usageTone(usage.usedPercent)}`}>
          {formatPercent(usage.usedPercent)}
        </span>
      </div>
      <div className={`${compact ? "mt-1" : "mt-2"} h-2.5 rounded-full bg-ink-600 overflow-hidden`}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, usage.usedPercent))}%` }} />
      </div>
      {reset ? (
        <Truncated className={`${compact ? "mt-0.5" : "mt-1"} text-[11px] text-bone-400 tabular-nums`}>
          ↻ {reset}
        </Truncated>
      ) : null}
    </div>
  );
}

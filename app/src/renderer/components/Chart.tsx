/**
 * The two chart shapes this app needs, drawn on a canvas.
 *
 * A charting library would be a dependency and a bundle for two shapes: a sparkline in a row and
 * one area chart per resource. Canvas keeps it to a few lines and, more importantly, keeps the
 * drawing pixel-exact at any DPI, which a stretched SVG does not.
 */
import { useEffect, useRef } from "react";

import type { MetricSample } from "@core/types";

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

export function Sparkline({ samples, max = 100, className = "" }: { samples: MetricSample[]; max?: number; className?: string }) {
  const ref = useCanvas((context, width, height) => {
    if (samples.length < 2) return;
    const values = samples.map((s) => s.cpu);
    const ceiling = Math.max(max, ...values) || 1;
    context.beginPath();
    path(context, values, width, height, ceiling);
    context.strokeStyle = ACCENT;
    context.lineWidth = 1.5;
    context.stroke();
  });
  return <canvas ref={ref} className={`h-6 w-24 ${className}`} />;
}

export interface AreaChartProps {
  samples: MetricSample[];
  /** Which field to plot, and the ceiling it is measured against. */
  field: "cpu" | "memoryBytes";
  max: number;
  label: string;
  value: string;
  className?: string;
  /** Half-height, tighter padding — for the bottom strip of a docked column. */
  compact?: boolean;
}

export function AreaChart({ samples, field, max, label, value, className = "", compact = false }: AreaChartProps) {
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

  return (
    <div className={`card ${compact ? "p-1.5" : "p-3"} ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Truncated as="span" className={`${compact ? "text-[11px]" : "text-xs"} text-bone-400`}>{label}</Truncated>
        <span className={`${compact ? "text-xs" : "text-sm"} font-medium text-bone-100 tabular-nums`}>{value}</span>
      </div>
      <canvas ref={ref} className={`${compact ? "mt-1 h-7" : "mt-2 h-16"} w-full`} />
    </div>
  );
}

/**
 * The two lists — projects and their sessions — and the detail panel beside them.
 *
 * A row is a row whichever list it is in: a live mark, a name, and the few numbers worth scanning.
 * Selection is a value passed in, not internal state, because the keyboard drives it.
 */
import { useEffect, useRef } from "react";

import type { MetricSample, ProjectInfo, SessionInfo } from "@core/types";

import { Sparkline, useElementWidth } from "./Chart";
import { Truncated } from "./Truncated";
import { formatBytes, formatSince, formatTime } from "../format";

/**
 * Below these widths a row cannot hold its name and its numbers on one line.
 *
 * They differ because the rows carry different fixed content, measured: a project row spends about
 * 110 px on the session count and the time, while a LIVE session row spends 324 — a 96 px
 * sparkline, 96 px of CPU and memory, and a 112 px size-and-time column. At a 460 px row that left
 * the name 90 px and "Claude Projects" became "Claude Pro…", which is the half a reader needs.
 * Narrow, the numbers drop to a second line: the row is taller and all of it is legible.
 */
const PROJECT_STACK_WIDTH = 300;
const SESSION_STACK_WIDTH = 300;
const LIVE_SESSION_STACK_WIDTH = 520;

function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${live ? "bg-ok shadow-[0_0_6px] shadow-ok/60" : "bg-ink-500"}`}
      title={live ? "running" : "idle"}
    />
  );
}

/** Keeps the selected row in view when the keyboard moves it off screen. */
function useScrollIntoView(selected: boolean): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return ref;
}

export function ProjectRow({
  project, selected, onSelect, onOpen,
}: {
  project: ProjectInfo;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const ref = useScrollIntoView(selected);
  const [box, width] = useElementWidth<HTMLDivElement>();
  const stacked = width > 0 && width < PROJECT_STACK_WIDTH;
  return (
    <div
      ref={ref}
      className={`row ${selected ? "row-selected" : "hover:bg-ink-700/60"} ${stacked ? "flex-wrap" : ""}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <div ref={box} className="absolute inset-x-0 h-0" aria-hidden="true" />
      <LiveDot live={project.liveCount > 0} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Truncated
            as="span"
            title={project.cwd ?? project.dir}
            className={`text-sm ${project.exists ? "text-bone-100" : "text-bad"}`}
          >
            {project.name}
          </Truncated>
          {project.hasMemory ? <span className="chip">memory</span> : null}
        </div>
        <Truncated className="text-[11px] text-bone-500">{project.cwd ?? "folder unknown"}</Truncated>
      </div>
      <div className={`shrink-0 tabular-nums ${stacked ? "w-full pl-5 flex gap-2 text-[11px] text-bone-400" : "text-right"}`}>
        <div className={stacked ? "" : "text-xs text-bone-300"}>{project.sessions.length} sessions</div>
        <div className={stacked ? "text-bone-500" : "text-[11px] text-bone-500"}>{formatSince(project.lastUsed)}</div>
      </div>
    </div>
  );
}

export function SessionRow({
  session, selected, samples, onSelect, onOpen,
}: {
  session: SessionInfo;
  selected: boolean;
  samples: MetricSample[];
  onSelect: () => void;
  onOpen: () => void;
}) {
  const ref = useScrollIntoView(selected);
  const [box, width] = useElementWidth<HTMLDivElement>();
  const stacked = width > 0 && width < (session.live ? LIVE_SESSION_STACK_WIDTH : SESSION_STACK_WIDTH);
  const latest = samples.length ? samples[samples.length - 1] : null;
  return (
    <div
      ref={ref}
      className={`row ${selected ? "row-selected" : "hover:bg-ink-700/60"} ${stacked ? "flex-wrap" : ""}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <div ref={box} className="absolute inset-x-0 h-0" aria-hidden="true" />
      <LiveDot live={session.live} />
      <div className="min-w-0 flex-1">
        <Truncated className="text-sm text-bone-100">{session.title}</Truncated>
        <Truncated className="text-[11px] text-bone-500">
          {session.named && session.prompt ? session.prompt : session.id}
        </Truncated>
      </div>
      {session.live ? (
        // CPU and memory are different questions, so each gets its own line and its own number.
        <div className={`flex items-center gap-3 shrink-0 ${stacked ? "w-full pl-5" : ""}`}>
          <span className="flex items-center gap-1.5" title="CPU — this session's whole process tree">
            <Sparkline samples={samples} field="cpu" className="w-16" />
            <span className="text-[11px] text-bone-400 tabular-nums">
              {latest ? `${latest.cpu.toFixed(0)}%` : "—"}
            </span>
          </span>
          <span className="flex items-center gap-1.5" title="Memory — this session's whole process tree">
            <Sparkline samples={samples} field="memoryBytes" className="w-16" />
            <span className="text-[11px] text-bone-400 tabular-nums">
              {latest ? formatBytes(latest.memoryBytes) : "—"}
            </span>
          </span>
        </div>
      ) : null}
      <div className={`shrink-0 tabular-nums ${stacked ? "w-full pl-5 flex gap-2 text-[11px] text-bone-400" : "text-right w-28"}`}>
        <div className={stacked ? "" : "text-xs text-bone-300"}>{formatBytes(session.bytes)}</div>
        <div className={stacked ? "text-bone-500" : "text-[11px] text-bone-500"}>{formatTime(session.modifiedAt)}</div>
      </div>
    </div>
  );
}

function Field({ label, children, tone = "" }: { label: string; children: React.ReactNode; tone?: string }) {
  // Stacked, not two columns: the panel is narrow, and a value column that narrow turns a path
  // into one character per line. The label reads as a caption above its value instead.
  return (
    <div className="py-1 text-xs">
      <div className="text-[11px] text-bone-500">{label}</div>
      <div className={`break-all ${tone || "text-bone-200"}`}>{children}</div>
    </div>
  );
}

export function ProjectDetail({ project }: { project: ProjectInfo }) {
  return (
    <div className="p-4">
      <h2 className="text-sm font-medium text-bone-100 mb-2">{project.name}</h2>
      {project.alias ? <Field label="Folder name">{project.cwd?.split(/[\\/]/).pop()}</Field> : null}
      <Field label="Path" tone={project.exists ? "" : "text-bad"}>
        {project.cwd ?? "unknown — no transcript carries a cwd"}
        {project.cwd && !project.exists ? " (folder is gone)" : ""}
      </Field>
      <Field label="Sessions">
        {project.sessions.length}
        {project.liveCount ? ` · ${project.liveCount} running` : ""}
        {project.sessions.length ? ` · ${formatBytes(project.totalBytes)}` : ""}
      </Field>
      <Field label="Last used">{formatTime(project.lastUsed)}</Field>
      <Field label="Memory" tone={project.hasMemory ? "text-warn" : ""}>
        {project.hasMemory ? "yes — deleting the project deletes it too" : "no"}
      </Field>
      <Field label="Directory">{project.dir}</Field>
    </div>
  );
}

export function SessionDetail({ session, samples }: { session: SessionInfo; samples: MetricSample[] }) {
  const latest = samples.length ? samples[samples.length - 1] : null;
  return (
    <div className="p-4">
      <h2 className="text-sm font-medium text-bone-100 mb-2">{session.title}</h2>
      <Field label="Title from">{session.named ? "a name you set (also shown by /resume)" : "the session's first prompt"}</Field>
      {session.named && session.prompt ? <Field label="First prompt">{session.prompt}</Field> : null}
      <Field label="Id">{session.id}</Field>
      <Field label="Started">{formatTime(session.startedAt)}</Field>
      <Field label="Last written">{formatTime(session.modifiedAt)}</Field>
      <Field label="Transcript">{formatBytes(session.bytes)}</Field>
      <Field label="State" tone={session.live ? "text-ok" : ""}>
        {session.live ? `running (pid ${session.pid})` : "idle"}
      </Field>
      {session.live && latest ? (
        <Field label="Using">{`${latest.cpu.toFixed(0)}% CPU · ${formatBytes(latest.memoryBytes)}`}</Field>
      ) : null}
      <Field label="File">{session.file}</Field>
    </div>
  );
}

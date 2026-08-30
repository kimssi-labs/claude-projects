/**
 * The two lists — projects and their sessions — and the detail panel beside them.
 *
 * A row is a row whichever list it is in: a live mark, a name, and the few numbers worth scanning.
 * Selection is a value passed in, not internal state, because the keyboard drives it.
 */
import { useEffect, useRef } from "react";

import type { MetricSample, ProjectInfo, SessionInfo } from "@core/types";

import { Sparkline } from "./Chart";
import { formatBytes, formatSince, formatTime } from "../format";

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
  return (
    <div
      ref={ref}
      className={`row ${selected ? "row-selected" : "hover:bg-ink-700/60"}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <LiveDot live={project.liveCount > 0} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-sm ${project.exists ? "text-bone-100" : "text-bad"}`}>{project.name}</span>
          {project.hasMemory ? <span className="chip">memory</span> : null}
        </div>
        <div className="truncate text-[11px] text-bone-500">{project.cwd ?? "folder unknown"}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs text-bone-300 tabular-nums">{project.sessions.length} sessions</div>
        <div className="text-[11px] text-bone-500 tabular-nums">{formatSince(project.lastUsed)}</div>
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
  const latest = samples.length ? samples[samples.length - 1] : null;
  return (
    <div
      ref={ref}
      className={`row ${selected ? "row-selected" : "hover:bg-ink-700/60"}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <LiveDot live={session.live} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-bone-100">{session.title}</div>
        <div className="truncate text-[11px] text-bone-500">
          {session.named && session.prompt ? session.prompt : session.id}
        </div>
      </div>
      {session.live ? (
        <div className="flex items-center gap-2 shrink-0">
          <Sparkline samples={samples} />
          <span className="text-[11px] text-bone-400 tabular-nums w-24 text-right">
            {latest ? `${latest.cpu.toFixed(0)}% · ${formatBytes(latest.memoryBytes)}` : "—"}
          </span>
        </div>
      ) : null}
      <div className="text-right shrink-0 w-28">
        <div className="text-xs text-bone-300 tabular-nums">{formatBytes(session.bytes)}</div>
        <div className="text-[11px] text-bone-500 tabular-nums">{formatTime(session.modifiedAt)}</div>
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

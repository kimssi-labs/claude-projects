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
import { formatBytes, formatTime, sinceParts } from "../format";
import { useText } from "../useText";
import { gitLabel, gitTitle } from "@core/git";

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
  const t = useText();
  const label = { running: t("list.running"), idle: t("list.idle") };
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${live ? "bg-ok shadow-[0_0_6px] shadow-ok/60" : "bg-ink-500"}`}
      title={live ? label.running : label.idle}
    />
  );
}

/** The mark of a pinned row: a pushpin, drawn rather than an emoji so it takes the theme's colour. */
function Pin() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0 text-accent" fill="currentColor" aria-label="pinned" role="img">
      <path d="M9.6 1.2 14.8 6.4l-1.9.5-2.5 2.5.4 3.2-1.2 1.2-3-3-4 4-.9-.9 4-4-3-3 1.2-1.2 3.2.4 2.5-2.5z" />
    </svg>
  );
}

/** "3 min ago" in whichever language the window is in, or a date once that stops meaning much. */
function since(t: ReturnType<typeof useText>, ms: number): string {
  const { key, vars } = sinceParts(ms);
  return key === "since.absolute" ? formatTime(ms) : t(key, vars as Record<string, number>);
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
  project, selected, onSelect, onOpen, onContextMenu,
}: {
  project: ProjectInfo;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu?: () => void;
}) {
  const t = useText();
  const ref = useScrollIntoView(selected);
  const [box, width] = useElementWidth<HTMLDivElement>();
  const stacked = width > 0 && width < PROJECT_STACK_WIDTH;
  return (
    <div
      ref={ref}
      className={`row ${selected ? "row-selected" : "hover:bg-ink-700/60"} ${stacked ? "flex-wrap" : ""}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(); }}
    >
      <div ref={box} className="absolute inset-x-0 h-0" aria-hidden="true" />
      <LiveDot live={project.liveCount > 0} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {project.pinned ? <Pin /> : null}
          <Truncated
            as="span"
            title={project.cwd ?? project.dir}
            className={`text-sm ${project.exists ? "text-bone-100" : "text-bad"}`}
          >
            {project.name}
          </Truncated>
          {project.hasMemory ? <span className="chip">{t("list.memory")}</span> : null}
          {project.worktree ? <span className="chip text-accent">{t("list.worktree")}</span> : null}
        </div>
        <Truncated className="text-[11px] text-bone-500">{project.cwd ?? t("list.folderUnknown")}</Truncated>
        {/* One line, and only where there is a repository: the branch is the thing you check before
            resuming a session, and opening a terminal to find it out is the friction this removes. */}
        {project.git ? (
          <Truncated title={gitTitle(project.git, t)} className="text-[11px] text-bone-400">
            <span className="text-accent">⌥</span> {gitLabel(project.git)}
          </Truncated>
        ) : null}
      </div>
      <div className={`shrink-0 tabular-nums ${stacked ? "w-full pl-5 flex gap-2 text-[11px] text-bone-400" : "text-right"}`}>
        <div className={stacked ? "" : "text-xs text-bone-300"}>{t("list.sessions", { count: project.sessions.length })}</div>
        <div className={stacked ? "text-bone-500" : "text-[11px] text-bone-500"}>{since(t, project.lastUsed)}</div>
      </div>
    </div>
  );
}

export function SessionRow({
  session, selected, samples, onSelect, onOpen, onContextMenu,
}: {
  session: SessionInfo;
  selected: boolean;
  samples: MetricSample[];
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu?: () => void;
}) {
  const t = useText();
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
      onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(); }}
    >
      <div ref={box} className="absolute inset-x-0 h-0" aria-hidden="true" />
      <LiveDot live={session.live} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {session.pinned ? <Pin /> : null}
          <Truncated as="span" className="text-sm text-bone-100">{session.title}</Truncated>
        </div>
        <Truncated className="text-[11px] text-bone-500">
          {session.named && session.prompt ? session.prompt : session.id}
        </Truncated>
      </div>
      {session.live ? (
        // CPU and memory are different questions, so each gets its own line and its own number.
        <div className={`flex items-center gap-3 shrink-0 ${stacked ? "w-full pl-5" : ""}`}>
          <span className="flex items-center gap-1.5" title={t("tip.rowCpu")}>
            <Sparkline samples={samples} field="cpu" className="w-16" />
            <span className="text-[11px] text-bone-400 tabular-nums">
              {latest ? `${latest.cpu.toFixed(0)}%` : "—"}
            </span>
          </span>
          <span className="flex items-center gap-1.5" title={t("tip.rowMemory")}>
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
  const t = useText();
  return (
    <div className="p-4">
      <h2 className="text-sm font-medium text-bone-100 mb-2">{project.name}</h2>
      {project.alias ? <Field label={t("detail.folderName")}>{project.cwd?.split(/[\\/]/).pop()}</Field> : null}
      <Field label={t("detail.path")} tone={project.exists ? "" : "text-bad"}>
        {project.cwd ?? t("detail.pathUnknown")}
        {project.cwd && !project.exists ? t("detail.folderGone") : ""}
      </Field>
      <Field label={t("detail.sessions")}>
        {project.sessions.length}
        {project.liveCount ? ` · ${t("app.running", { count: project.liveCount })}` : ""}
        {project.sessions.length ? ` · ${formatBytes(project.totalBytes)}` : ""}
      </Field>
      {project.git ? (
        <Field label={t("detail.git")}>{gitTitle(project.git, t).replace(/^Git: /, "")}</Field>
      ) : null}
      <Field label={t("detail.lastUsed")}>{formatTime(project.lastUsed)}</Field>
      <Field label={t("detail.memory")} tone={project.hasMemory ? "text-warn" : ""}>
        {project.hasMemory ? t("detail.memory.yes") : t("detail.memory.no")}
      </Field>
      <Field label={t("detail.directory")}>{project.dir}</Field>
    </div>
  );
}

export function SessionDetail({ session, samples }: { session: SessionInfo; samples: MetricSample[] }) {
  const t = useText();
  const latest = samples.length ? samples[samples.length - 1] : null;
  return (
    <div className="p-4">
      <h2 className="text-sm font-medium text-bone-100 mb-2">{session.title}</h2>
      <Field label={t("detail.titleFrom")}>{session.named ? t("detail.titleFrom.named") : t("detail.titleFrom.prompt")}</Field>
      {session.named && session.prompt ? <Field label={t("detail.firstPrompt")}>{session.prompt}</Field> : null}
      <Field label={t("detail.id")}>{session.id}</Field>
      <Field label={t("detail.started")}>{formatTime(session.startedAt)}</Field>
      <Field label={t("detail.lastWritten")}>{formatTime(session.modifiedAt)}</Field>
      <Field label={t("detail.transcript")}>{formatBytes(session.bytes)}</Field>
      <Field label={t("detail.state")} tone={session.live ? "text-ok" : ""}>
        {session.live ? t("detail.state.running", { pid: String(session.pid) }) : t("detail.state.idle")}
      </Field>
      {session.live && latest ? (
        <Field label={t("detail.using")}>{`${latest.cpu.toFixed(0)}% CPU · ${formatBytes(latest.memoryBytes)}`}</Field>
      ) : null}
      <Field label={t("detail.file")}>{session.file}</Field>
    </div>
  );
}

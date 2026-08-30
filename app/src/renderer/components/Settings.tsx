/**
 * Settings, as cards: Dock, Status line, Launch, Permissions.
 *
 * The terminal version showed all four at once and moved between them with Tab; that survives —
 * the focused card is the one Tab lands on, and every choice is one Space or Enter away.
 */
import { useEffect, useMemo, useState } from "react";

import { DOCK_EDGES, DOCK_PERCENT } from "@core/constants";
import type { DockEdge, PermissionMode, ShellChoice, ThemeMode } from "@core/types";

import type { DisplayInfo, SettingsPayload } from "../api";

export const SETTINGS_SECTIONS = ["appearance", "dock", "status", "launch", "permissions"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const THEMES: { key: ThemeMode; label: string; note: string }[] = [
  { key: "system", label: "System", note: "follows the OS setting, and changes with it" },
  { key: "light", label: "Light", note: "" },
  { key: "dark", label: "Dark", note: "" },
];

const SHELLS: { key: ShellChoice; label: string; note: string }[] = [
  { key: "auto", label: "Auto", note: "PowerShell 7 when installed, else the system shell" },
  { key: "pwsh", label: "PowerShell 7", note: "pwsh" },
  { key: "powershell", label: "Windows PowerShell", note: "powershell.exe" },
  { key: "cmd", label: "Command Prompt", note: "cmd.exe /k" },
  { key: "bash", label: "bash", note: "bash -lc" },
  { key: "none", label: "No shell", note: "claude directly — the window closes when it exits" },
];

const PERMISSIONS: { key: PermissionMode; label: string; note: string }[] = [
  { key: "default", label: "Ask (default)", note: "the normal prompts" },
  { key: "bypass", label: "Bypass permissions", note: "--dangerously-skip-permissions" },
  { key: "accept", label: "Accept edits", note: "file edits go through, other tools still ask" },
  { key: "plan", label: "Plan", note: "plan first, change nothing until you approve" },
  { key: "auto", label: "Auto", note: "claude decides per tool call" },
];

function Card({
  title, section, focused, children, hint,
}: {
  title: string;
  section: SettingsSection;
  focused: SettingsSection;
  children: React.ReactNode;
  hint?: string;
}) {
  const active = section === focused;
  return (
    <section className={`card p-4 transition-colors ${active ? "ring-1 ring-accent/50" : "opacity-80"}`}>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-bone-100">{title}</h3>
        {hint ? <span className="text-[11px] text-bone-500">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Choice({
  label, note, selected, onSelect, disabled = false,
}: {
  label: string;
  note?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
        selected ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-ink-700/60"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-3.5 h-3.5 rounded-full border ${selected ? "border-accent bg-accent" : "border-ink-500"}`} />
        <span className="text-sm text-bone-100">{label}</span>
      </div>
      {note ? <div className="pl-5 text-[11px] text-bone-500">{note}</div> : null}
    </button>
  );
}

export interface SettingsViewProps {
  settings: SettingsPayload;
  displays: DisplayInfo[];
  focused: SettingsSection;
  onFocus: (section: SettingsSection) => void;
  onChange: (next: SettingsPayload) => void;
  onApplyDock: (enabled: boolean) => void;
  onClose: () => void;
}

export function SettingsView({ settings, displays, focused, onFocus, onChange, onApplyDock, onClose }: SettingsViewProps) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);

  const span = useMemo(() => {
    const display = displays.find((d) => d.id === draft.dock.device) ?? displays.find((d) => d.primary);
    if (!display) return 0;
    return draft.dock.edge === "left" || draft.dock.edge === "right" ? display.bounds.width : display.bounds.height;
  }, [displays, draft.dock.device, draft.dock.edge]);

  const update = (next: SettingsPayload): void => {
    setDraft(next);
    onChange(next);
  };

  const setDock = (patch: Partial<SettingsPayload["dock"]>): void =>
    update({ ...draft, dock: { ...draft.dock, ...patch } });

  const minPercent = Math.max(DOCK_PERCENT.min, draft.minPercent);
  const bandPx = Math.round((span * draft.dock.percent) / 100);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-3" onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <Card title="Appearance" section="appearance" focused={focused} hint="Tab moves between cards">
        <div className="space-y-1" onMouseEnter={() => onFocus("appearance")}>
          {THEMES.map((theme) => (
            <Choice
              key={theme.key}
              label={theme.label}
              note={theme.note}
              selected={draft.ui.theme === theme.key}
              onSelect={() => update({ ...draft, ui: { ...draft.ui, theme: theme.key } })}
            />
          ))}
        </div>
      </Card>

      <Card title="Dock" section="dock" focused={focused} hint="Tab moves between cards">
        <div className="space-y-3" onMouseEnter={() => onFocus("dock")}>
          <div>
            <div className="text-[11px] text-bone-500 mb-1">Monitor</div>
            <div className="space-y-1">
              {displays.map((display) => (
                <Choice
                  key={display.id}
                  label={`${display.label}  ${display.bounds.width}×${display.bounds.height}`}
                  note={`${display.primary ? "primary" : ""}${display.saved ? (display.primary ? " · saved" : "saved") : ""}`}
                  selected={draft.dock.device === display.id || (!draft.dock.device && display.primary)}
                  onSelect={() => setDock({ device: display.id })}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-bone-500 w-16">Edge</span>
            {DOCK_EDGES.map((edge: DockEdge) => (
              <button
                key={edge}
                type="button"
                onClick={() => setDock({ edge })}
                className={`btn ${draft.dock.edge === edge ? "btn-accent" : ""}`}
              >
                {edge}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] text-bone-500 w-16">Size</span>
            <input
              type="range"
              min={minPercent}
              max={DOCK_PERCENT.max}
              value={Math.max(minPercent, draft.dock.percent)}
              onChange={(event) => setDock({ percent: Number(event.target.value) })}
              className="flex-1 accent-accent"
            />
            <span className="text-xs tabular-nums text-bone-200 w-28 text-right">
              {draft.dock.percent}% · {bandPx} px
            </span>
          </div>
          {draft.dockFloor > 0 ? (
            <div className="text-[11px] text-warn">
              This window manager would not go below {draft.dockFloor} px, so the minimum here is {minPercent}%.
            </div>
          ) : null}

          <div className="flex gap-2">
            <button type="button" className={`btn ${draft.dock.enabled ? "" : "btn-accent"}`} onClick={() => onApplyDock(true)}>
              Dock now
            </button>
            <button type="button" className="btn" onClick={() => onApplyDock(false)}>
              Undock
            </button>
          </div>
        </div>
      </Card>

      <Card title="Status line" section="status" focused={focused} hint="which MCP servers to report">
        <div className="space-y-1" onMouseEnter={() => onFocus("status")}>
          {draft.mcpServers.length === 0 ? (
            <div className="text-xs text-bone-500">No MCP server is configured on this machine.</div>
          ) : null}
          {draft.mcpServers.map((server) => {
            const chosen = draft.status.mcp;
            const on = chosen === null || chosen.includes(server);
            return (
              <label key={server} className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const current = chosen ?? draft.mcpServers;
                    const next = on ? current.filter((s) => s !== server) : [...current, server];
                    update({ ...draft, status: { mcp: next } });
                  }}
                  className="accent-accent"
                />
                <span className="text-sm text-bone-100">{server}</span>
              </label>
            );
          })}
          {draft.mcpServers.length ? (
            <button type="button" className="btn mt-2" onClick={() => update({ ...draft, status: { mcp: null } })}>
              Report every server
            </button>
          ) : null}
        </div>
      </Card>

      <Card title="Launch" section="launch" focused={focused} hint="the shell that hosts a session">
        <div className="space-y-1" onMouseEnter={() => onFocus("launch")}>
          {SHELLS.map((shell) => (
            <Choice
              key={shell.key}
              label={shell.label}
              note={shell.note}
              selected={draft.launch.shell === shell.key}
              onSelect={() => update({ ...draft, launch: { ...draft.launch, shell: shell.key } })}
            />
          ))}
        </div>
      </Card>

      <Card title="Permissions" section="permissions" focused={focused} hint="how a session starts">
        <div className="space-y-1" onMouseEnter={() => onFocus("permissions")}>
          {PERMISSIONS.map((mode) => (
            <Choice
              key={mode.key}
              label={mode.label}
              note={mode.note}
              selected={draft.launch.permission === mode.key}
              onSelect={() => update({ ...draft, launch: { ...draft.launch, permission: mode.key } })}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

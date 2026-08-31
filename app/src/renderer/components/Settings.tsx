/**
 * Settings, as cards: Dock, Status line, Launch, Permissions.
 *
 * The terminal version showed all four at once and moved between them with Tab; that survives —
 * the focused card is the one Tab lands on, and every choice is one Space or Enter away.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_PASTE_HOTKEY, DOCK_EDGES, DOCK_PERCENT, STACK_BELOW } from "@core/constants";

import { Truncated } from "./Truncated";
import type { DockEdge, LayoutMode, PermissionMode, ShellChoice, ThemeMode } from "@core/types";

import type { DisplayInfo, SettingsPayload } from "../api";

export const SETTINGS_SECTIONS = ["appearance", "layout", "monitor", "dock", "status", "launch", "permissions"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const THEMES: { key: ThemeMode; label: string; note: string }[] = [
  { key: "system", label: "System", note: "follows the OS setting, and changes with it" },
  { key: "light", label: "Light", note: "" },
  { key: "dark", label: "Dark", note: "" },
];

const LAYOUTS: { key: LayoutMode; label: string; note: string }[] = [
  { key: "auto", label: "Auto", note: "side by side, stacked once the window is narrower than the width below" },
  { key: "horizontal", label: "Side by side", note: "lists beside each other, whatever the size" },
  { key: "vertical", label: "Stacked", note: "project list, sessions and graphs one under the other" },
];

const SHELLS: { key: ShellChoice; label: string; note: string }[] = [
  { key: "auto", label: "Auto", note: "PowerShell 7 when installed, else the system shell" },
  { key: "pwsh", label: "PowerShell 7", note: "pwsh" },
  { key: "powershell", label: "Windows PowerShell", note: "powershell.exe" },
  { key: "cmd", label: "Command Prompt", note: "cmd.exe /k" },
  { key: "bash", label: "bash", note: "bash -lc" },
  { key: "custom", label: "Custom program", note: "a path you name, started with the claude command" },
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
  // What we last sent, so a push that is only the echo of our own save does not reset the draft
  // out from under someone mid-drag. Anything genuinely new — main undocking us, say — still does.
  const sent = useRef(JSON.stringify(settings));
  useEffect(() => {
    const incoming = JSON.stringify(settings);
    if (incoming === sent.current) return;
    sent.current = incoming;
    setDraft(settings);
  }, [settings]);

  const span = useMemo(() => {
    const display = displays.find((d) => d.id === draft.dock.device) ?? displays.find((d) => d.primary);
    if (!display) return 0;
    return draft.dock.edge === "left" || draft.dock.edge === "right" ? display.bounds.width : display.bounds.height;
  }, [displays, draft.dock.device, draft.dock.edge]);

  const update = (next: SettingsPayload): void => {
    setDraft(next);
    sent.current = JSON.stringify(next);
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

      <Card title="Layout" section="layout" focused={focused} hint="Tab moves between cards">
        <div className="space-y-3" onMouseEnter={() => onFocus("layout")}>
          <div className="space-y-1">
            {LAYOUTS.map((option) => (
              <Choice
                key={option.key}
                label={option.label}
                note={option.note}
                selected={draft.ui.layout === option.key}
                onSelect={() => update({ ...draft, ui: { ...draft.ui, layout: option.key } })}
              />
            ))}
          </div>
          <div className={`flex items-center gap-3 ${draft.ui.layout === "auto" ? "" : "opacity-40"}`}>
            <span className="text-[11px] text-bone-500 shrink-0">Stack below</span>
            <input
              type="range"
              min={STACK_BELOW.min}
              max={STACK_BELOW.max}
              step={STACK_BELOW.step}
              value={draft.ui.stackBelow}
              disabled={draft.ui.layout !== "auto"}
              onChange={(event) => update({ ...draft, ui: { ...draft.ui, stackBelow: Number(event.target.value) } })}
              className="flex-1 min-w-0 accent-accent"
            />
            <span className="text-xs tabular-nums text-bone-200 shrink-0 whitespace-nowrap">
              {draft.ui.stackBelow} px
            </span>
          </div>
        </div>
      </Card>

      <Card title="Monitoring" section="monitor" focused={focused} hint="Tab moves between cards">
        <div className="space-y-1" onMouseEnter={() => onFocus("monitor")}>
          <Choice
            label="On"
            note="CPU and memory sampled once a second, in-process"
            selected={draft.ui.monitor}
            onSelect={() => update({ ...draft, ui: { ...draft.ui, monitor: true } })}
          />
          <Choice
            label="Off"
            note="no sampling at all — the graphs disappear and nothing is measured"
            selected={!draft.ui.monitor}
            onSelect={() => update({ ...draft, ui: { ...draft.ui, monitor: false } })}
          />
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

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-bone-500 shrink-0">Edge</span>
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
            <span className="text-[11px] text-bone-500 shrink-0">Size</span>
            {/* min-w-0 on the slider and shrink-0 on the number: without both, a narrow card lets
                the two overlap instead of letting the slider give way. */}
            <input
              type="range"
              min={minPercent}
              max={DOCK_PERCENT.max}
              value={Math.max(minPercent, draft.dock.percent)}
              onChange={(event) => setDock({ percent: Number(event.target.value) })}
              className="flex-1 min-w-0 accent-accent"
            />
            <span className="text-xs tabular-nums text-bone-200 shrink-0 whitespace-nowrap">
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
          {/* The other things the strip can show. Each appears only when its source exists, so a
              switch here is "show it when there is one", not "invent one". */}
          <div className="text-[11px] text-bone-500 pt-1">Segments</div>
          {([
            ["usage", "Usage bars", "5 h / 7 d limits from Claude Code's cache"],
            ["outlook", "Outlook", "reachability, from the Outlook probe's cache"],
            ["ponytail", "Ponytail", "the mode flag, when one is set"],
          ] as const).map(([key, label, note]) => (
            <label key={key} className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
              <input
                type="checkbox"
                checked={draft.status[key] !== false}
                onChange={() => update({ ...draft, status: { ...draft.status, [key]: draft.status[key] === false } })}
                className="accent-accent"
              />
              <Truncated as="span" className="text-sm text-bone-100">{label}</Truncated>
              <Truncated as="span" className="text-[11px] text-bone-500">{note}</Truncated>
            </label>
          ))}

          <div className="text-[11px] text-bone-500 pt-2">MCP servers</div>
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
                    update({ ...draft, status: { ...draft.status, mcp: next } });
                  }}
                  className="accent-accent"
                />
                <span className="text-sm text-bone-100">{server}</span>
              </label>
            );
          })}
          {draft.mcpServers.length ? (
            <div className="flex flex-wrap gap-2 mt-2">
              {/* "All" ticks the servers this machine has right now; "Every server" keeps following
                  the list, so one installed later is reported without coming back here. */}
              <button
                type="button"
                className="btn"
                onClick={() => update({ ...draft, status: { ...draft.status, mcp: [...draft.mcpServers] } })}
              >
                Select all
              </button>
              <button type="button" className="btn" onClick={() => update({ ...draft, status: { ...draft.status, mcp: [] } })}>
                Select none
              </button>
              <button
                type="button"
                className={`btn ${draft.status.mcp === null ? "btn-accent" : ""}`}
                onClick={() => update({ ...draft, status: { ...draft.status, mcp: null } })}
              >
                Every server, always
              </button>
            </div>
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

          <div className={`flex items-center gap-2 pt-1 ${draft.launch.shell === "custom" ? "" : "opacity-40"}`}>
            <span className="text-[11px] text-bone-500 shrink-0">Program</span>
            <input
              type="text"
              spellCheck={false}
              value={draft.launch.customShell}
              disabled={draft.launch.shell !== "custom"}
              placeholder="C:\tools\my-terminal.exe   (or a name on PATH)"
              onChange={(event) =>
                update({ ...draft, launch: { ...draft.launch, customShell: event.target.value } })}
              className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-xs placeholder:text-bone-500 focus:border-accent/60"
            />
          </div>
          {draft.launch.shell === "custom" && !draft.launch.customShell.trim() ? (
            <div className="text-[11px] text-warn">
              Without a path this behaves as Auto, so a session still opens.
            </div>
          ) : null}

          {/* A terminal cannot paste a picture, but it can paste a path — this shortcut turns the
              one into the other wherever the cursor happens to be. */}
          <div className="pt-3 text-[11px] text-bone-500">Paste a screenshot into a session</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              spellCheck={false}
              value={draft.launch.pasteHotkey}
              placeholder="off"
              onChange={(event) =>
                update({ ...draft, launch: { ...draft.launch, pasteHotkey: event.target.value } })}
              className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-xs placeholder:text-bone-500 focus:border-accent/60"
            />
            <button
              type="button"
              className="btn shrink-0"
              onClick={() =>
                update({ ...draft, launch: { ...draft.launch, pasteHotkey: DEFAULT_PASTE_HOTKEY } })}
            >
              Default
            </button>
            <button
              type="button"
              className="btn shrink-0"
              onClick={() => update({ ...draft, launch: { ...draft.launch, pasteHotkey: "" } })}
            >
              Off
            </button>
          </div>
          <div className="text-[11px] text-bone-500">
            Copy a screenshot, press it in the terminal: the image is written out and its path is
            pasted where the cursor is, ready for Claude Code to open.
          </div>
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

/**
 * Settings, as cards: Dock, Status line, Launch, Permissions.
 *
 * The terminal version showed all four at once and moved between them with Tab; that survives —
 * the focused card is the one Tab lands on, and every choice is one Space or Enter away.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_PASTE_HOTKEY, DOCK_EDGES, DOCK_PERCENT, RATE_WINDOWS } from "@core/constants";


import { Truncated } from "./Truncated";
import { formatTime, sinceParts } from "../format";
import { AUTO_DEFAULTS, AUTO_MODES, MIN_INTERVAL_MINUTES } from "@core/gitAuto";
import { LANGUAGES, resolveLanguage } from "@core/i18n";
import { useText } from "../useText";
import { MERGE_STRATEGIES } from "@core/gitSync";
import { actionLabel, describe as describeUpdate, type UpdateState } from "@core/updates";

/** Named here so the screen can say exactly which file it writes. */
const HOOK_SCRIPT_NAME = navigator.userAgent.includes("Windows") ? "hangar-usage.cmd" : "hangar-usage.sh";
import type { DockEdge, LayoutMode, PermissionMode, ShellChoice, ThemeMode } from "@core/types";

import type { DisplayInfo, SettingsPayload } from "../api";

export const SETTINGS_SECTIONS = ["appearance", "language", "layout", "monitor", "dock", "status", "usage", "git", "updates", "launch", "permissions"] as const;
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
  { key: "custom", label: "Custom program", note: "an editor like VS Code, opened on the project folder" },
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
  /** Install or remove the Stop hook that publishes Claude Code's usage figures. */
  onCollectUsage: (on: boolean) => void;
  /** What the machine's language is, so "System" can say which one that is. */
  locale: string;
  /** Open one of the app's known pages in a browser. */
  onOpenPage: (page: "git" | "claudeCode" | "releases") => void;
  /** How the updater stands right now, pushed from the main process as it moves. */
  updateState: UpdateState;
  onUpdateAction: (command: "check" | "download" | "install") => void;
  onClose: () => void;
}

/** When the figures were last written, in the language on screen. */
function usageWhen(t: ReturnType<typeof useText>, ms: number): string {
  const { key, vars } = sinceParts(ms);
  return key === "since.absolute" ? formatTime(ms) : t(key, vars as Record<string, number>);
}

export function SettingsView({ settings, displays, focused, onFocus, onChange, onApplyDock, onCollectUsage, onOpenPage, locale, updateState, onUpdateAction, onClose }: SettingsViewProps) {
  const t = useText();
  const [draft, setDraft] = useState(settings);
  /** The update switch: saved like every other setting, through the same update(). */
  const setAutomatic = (automatic: boolean): void =>
    update({ ...draft, updates: { ...draft.updates, automatic } });
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
      {/* Esc still closes the screen; a button is for the times the keyboard is not where the hand
          is, and for anyone who never learns that Esc goes back. */}
      <div className="flex items-center gap-2 min-w-0">
        <button type="button" className="btn shrink-0" title={t("settings.back.title")} onClick={onClose} aria-label={t("settings.back")}>
          ← {t("settings.back")}
        </button>
        <Truncated as="span" className="text-[11px] text-bone-500">
          {t("settings.saved")}
        </Truncated>
      </div>

      <Card title={t("settings.appearance")} section="appearance" focused={focused} hint={t("settings.tabHint")}>
        <div className="space-y-1" onMouseEnter={() => onFocus("appearance")}>
          {THEMES.map((theme) => (
            <Choice
              key={theme.key}
              label={t(`settings.appearance.${theme.key}` as "settings.appearance.system")}
              note={theme.key === "system" ? t("settings.appearance.system.note") : undefined}
              selected={draft.ui.theme === theme.key}
              onSelect={() => update({ ...draft, ui: { ...draft.ui, theme: theme.key } })}
            />
          ))}
        </div>
      </Card>

      <Card title={t("settings.language")} section="language" focused={focused} hint={t("settings.language.hint")}>
        <div className="space-y-1" onMouseEnter={() => onFocus("language")}>
          {LANGUAGES.map((language) => (
            <Choice
              key={language.key}
              label={language.label}
              note={language.key === "system"
                ? t("settings.language.system.note", {
                  resolved: resolveLanguage("system", locale) === "ko" ? "한국어" : "English",
                })
                : undefined}
              selected={draft.ui.language === language.key}
              onSelect={() => update({ ...draft, ui: { ...draft.ui, language: language.key } })}
            />
          ))}
          <div className="text-[11px] text-bone-500">{t("settings.language.note")}</div>
        </div>
      </Card>

      <Card title={t("settings.layout")} section="layout" focused={focused} hint={t("settings.layout.hint")}>
        <div className="space-y-3" onMouseEnter={() => onFocus("layout")}>
          <div className="space-y-1">
            {LAYOUTS.map((option) => (
              <Choice
                key={option.key}
                label={t(`settings.layout.${option.key}` as "settings.layout.auto")}
                note={t(`settings.layout.${option.key}.note` as "settings.layout.auto.note")}
                selected={draft.ui.layout === option.key}
                onSelect={() => update({ ...draft, ui: { ...draft.ui, layout: option.key } })}
              />
            ))}
          </div>
        </div>
      </Card>

      <Card title={t("settings.monitor")} section="monitor" focused={focused} hint={t("settings.monitor.hint")}>
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

      <Card title={t("settings.dock")} section="dock" focused={focused} hint={t("settings.tabHint")}>
        <div className="space-y-3" onMouseEnter={() => onFocus("dock")}>
          <div>
            <div className="text-[11px] text-bone-500 mb-1">{t("settings.dock.monitor")}</div>
            <div className="space-y-1">
              {displays.map((display) => (
                <Choice
                  key={display.id}
                  label={`${display.label}  ${display.bounds.width}×${display.bounds.height}`}
                  note={[display.primary ? t("settings.dock.primary") : "", display.saved ? t("settings.dock.saved") : ""]
                    .filter(Boolean).join(" · ")}
                  selected={draft.dock.device === display.id || (!draft.dock.device && display.primary)}
                  onSelect={() => setDock({ device: display.id })}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-bone-500 shrink-0">{t("settings.dock.edge")}</span>
            {DOCK_EDGES.map((edge: DockEdge) => (
              <button
                key={edge}
                type="button"
                onClick={() => setDock({ edge })}
                className={`btn ${draft.dock.edge === edge ? "btn-accent" : ""}`}
              >
                {t(`edge.${edge}` as "edge.top")}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] text-bone-500 shrink-0">{t("settings.dock.size")}</span>
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
              {t("settings.dock.floor", { px: draft.dockFloor, percent: minPercent })}
            </div>
          ) : null}

          <div className="flex gap-2">
            <button type="button" className={`btn ${draft.dock.enabled ? "" : "btn-accent"}`} onClick={() => onApplyDock(true)}>
              {t("settings.dock.now")}
            </button>
            <button type="button" className="btn" onClick={() => onApplyDock(false)}>
              {t("settings.dock.release")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t("settings.status")} section="status" focused={focused} hint={t("settings.status.hint")}>
        <div className="space-y-1" onMouseEnter={() => onFocus("status")}>
          {/* The other things the strip can show. Each appears only when its source exists, so a
              switch here is "show it when there is one", not "invent one". */}
          {/* Which gauges appear beside the machine graphs. Unticking them all is how the
              usage segment is turned off — there is no separate switch to disagree with. */}
          <div className="text-[11px] text-bone-500 pt-1">{t("settings.status.windows")}</div>
          {RATE_WINDOWS.map(({ key, label }) => {
            const chosen = draft.status.windows;
            const on = chosen === null || chosen.includes(key);
            return (
              <label key={key} className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const current = chosen ?? RATE_WINDOWS.map((w) => w.key);
                    const next = on ? current.filter((k) => k !== key) : [...current, key];
                    update({ ...draft, status: { ...draft.status, windows: next } });
                  }}
                  className="accent-accent"
                />
                <Truncated as="span" className="text-sm text-bone-100">{label}</Truncated>
              </label>
            );
          })}
          <div className="text-[11px] text-bone-500">{t("settings.status.note")}</div>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              type="button"
              className={`btn ${draft.status.windows === null ? "btn-accent" : ""}`}
              onClick={() => update({ ...draft, status: { ...draft.status, windows: null } })}
            >
              {t("settings.status.all")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => update({ ...draft, status: { ...draft.status, windows: [] } })}
            >
              {t("settings.status.none")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t("settings.usage")} section="usage" focused={focused} hint={t("settings.usage.hint")}>
        <div className="space-y-2" onMouseEnter={() => onFocus("usage")}>
          <div className="text-xs text-bone-300">{t("settings.usage.what")}</div>
          <div className="flex items-center gap-2">
            <span className={`chip ${settings.usage.collecting ? "text-ok" : ""}`}>
              {settings.usage.collecting ? t("settings.usage.collecting") : t("settings.usage.off")}
            </span>
            <span className="text-[11px] text-bone-500">
              {settings.usage.updatedAt
                ? t("settings.usage.state", {
                  count: settings.usage.reported,
                  when: usageWhen(t, settings.usage.updatedAt),
                })
                : t("settings.usage.never")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`btn ${settings.usage.collecting ? "" : "btn-accent"}`}
              onClick={() => onCollectUsage(!settings.usage.collecting)}
            >
              {settings.usage.collecting ? t("settings.usage.stop") : t("settings.usage.start")}
            </button>
          </div>
          {/* Saying exactly what is written where: this edits a file the user owns. */}
          <div className="text-[11px] text-bone-500">
            {t("settings.usage.writes", { file: HOOK_SCRIPT_NAME })}
          </div>
          {settings.usage.portable && settings.usage.collecting ? (
            <div className="text-[11px] text-warn">{t("settings.usage.portable")}</div>
          ) : null}
          {settings.usage.collecting && !settings.usage.updatedAt ? (
            <div className="text-[11px] text-warn">{t("settings.usage.waiting")}</div>
          ) : null}
        </div>
      </Card>

      <Card title={t("settings.git")} section="git" focused={focused} hint={t("settings.git.hint")}>
        <div className="space-y-1" onMouseEnter={() => onFocus("git")}>
          <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
            <input
              type="checkbox"
              checked={draft.git.enabled}
              onChange={() => update({ ...draft, git: { ...draft.git, enabled: !draft.git.enabled } })}
              className="accent-accent"
            />
            <span className="text-sm text-bone-100">{t("settings.git.show")}</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
            <input
              type="checkbox"
              checked={draft.git.countChanges}
              disabled={!draft.git.enabled}
              onChange={() => update({ ...draft, git: { ...draft.git, countChanges: !draft.git.countChanges } })}
              className="accent-accent"
            />
            <span className={`text-sm ${draft.git.enabled ? "text-bone-100" : "text-bone-500"}`}>
              {t("settings.git.count")}
            </span>
          </label>
          <div className="text-[11px] text-bone-500">{t("settings.git.note")}</div>

          <div className="text-[11px] text-bone-500 pt-2">{t("settings.git.updating")}</div>
          <label className="block px-3 py-1.5">
            <span className="text-[11px] text-bone-500">{t("settings.git.base")}</span>
            <input
              value={draft.git.base}
              onChange={(event) => update({ ...draft, git: { ...draft.git, base: event.target.value } })}
              placeholder={t("settings.git.base.placeholder")}
              spellCheck={false}
              className="mt-1 w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm placeholder:text-bone-500 focus:border-accent/60"
            />
          </label>
          {MERGE_STRATEGIES.map((strategy) => (
            <Choice
              key={strategy.key}
              label={strategy.label}
              note={strategy.note}
              selected={draft.git.strategy === strategy.key}
              onSelect={() => update({ ...draft, git: { ...draft.git, strategy: strategy.key } })}
            />
          ))}
          <div className="text-[11px] text-bone-500">{t("settings.git.runNote")}</div>

          <div className="text-[11px] text-bone-500 pt-2">{t("settings.git.auto")}</div>
          {AUTO_MODES.map((mode) => (
            <Choice
              key={mode.key}
              label={mode.label}
              note={mode.note}
              selected={draft.git.auto.mode === mode.key}
              onSelect={() => update({ ...draft, git: { ...draft.git, auto: { ...draft.git.auto, mode: mode.key } } })}
            />
          ))}
          {draft.git.auto.mode === "off" ? null : (
            <label className="flex items-center gap-2 px-3 py-1.5">
              <span className="text-[11px] text-bone-500">{t("settings.git.every")}</span>
              <input
                type="number"
                min={MIN_INTERVAL_MINUTES}
                value={draft.git.auto.everyMinutes}
                onChange={(event) => update({
                  ...draft,
                  git: {
                    ...draft.git,
                    auto: { ...draft.git.auto, everyMinutes: Number(event.target.value) || AUTO_DEFAULTS.everyMinutes },
                  },
                })}
                className="w-20 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-sm focus:border-accent/60"
              />
              <span className="text-[11px] text-bone-500">
                {t("settings.git.minutes", { min: MIN_INTERVAL_MINUTES })}
              </span>
            </label>
          )}
          {draft.git.auto.mode === "full" ? (
            <div className="text-[11px] text-warn">{t("settings.git.fullWarning")}</div>
          ) : null}
          {/* The branch line is read from .git and needs nothing installed; everything below it
              shells out, so say which half is unavailable rather than failing quietly later. */}
          {settings.gitAvailable ? null : (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11px] text-warn flex-1">{t("settings.git.missing")}</span>
              <button type="button" className="btn btn-accent shrink-0" onClick={() => onOpenPage("git")}>
                {t("settings.git.install")}
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card title={t("settings.updates")} section="updates" focused={focused} hint={t("settings.updates.hint")}>
        <div className="space-y-2" onMouseEnter={() => onFocus("updates")}>
          <Choice
            label={t("settings.updates.auto")}
            note={t("settings.updates.auto.note")}
            selected={draft.updates.automatic}
            onSelect={() => setAutomatic(true)}
          />
          <Choice
            label={t("settings.updates.manual")}
            note={t("settings.updates.manual.note")}
            selected={!draft.updates.automatic}
            onSelect={() => setAutomatic(false)}
          />
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              className={`btn ${updateState.phase === "ready" ? "btn-accent" : ""}`}
              disabled={updateState.phase === "checking" || updateState.phase === "downloading"
                || updateState.phase === "unsupported"}
              onClick={() => onUpdateAction(updateState.phase === "ready"
                ? "install"
                : updateState.phase === "available" ? "download" : "check")}
            >
              {t(actionLabel(updateState))}
            </button>
            <Truncated className="text-[11px] text-bone-400 flex-1">{t(describeUpdate(updateState).key, describeUpdate(updateState).vars)}</Truncated>
          </div>
        </div>
      </Card>

      <Card title={t("settings.launch")} section="launch" focused={focused} hint={t("settings.tabHint")}>
        <div className="space-y-1" onMouseEnter={() => onFocus("launch")}>
          {SHELLS.map((shell) => (
            <Choice
              key={shell.key}
              label={t(`settings.shell.${shell.key}` as "settings.shell.auto")}
              // Two of these explain themselves; the rest name an executable, which is not translated.
              note={shell.key === "auto" || shell.key === "custom" || shell.key === "none"
                ? t(`settings.shell.${shell.key}.note` as "settings.shell.auto.note")
                : shell.note}
              selected={draft.launch.shell === shell.key}
              onSelect={() => update({ ...draft, launch: { ...draft.launch, shell: shell.key } })}
            />
          ))}

          <div className={`flex items-center gap-2 pt-1 ${draft.launch.shell === "custom" ? "" : "opacity-40"}`}>
            <span className="text-[11px] text-bone-500 shrink-0">{t("settings.launch.program")}</span>
            <input
              type="text"
              spellCheck={false}
              value={draft.launch.customShell}
              disabled={draft.launch.shell !== "custom"}
              placeholder={t("settings.launch.programPlaceholder")}
              onChange={(event) =>
                update({ ...draft, launch: { ...draft.launch, customShell: event.target.value } })}
              className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-xs placeholder:text-bone-500 focus:border-accent/60"
            />
          </div>
          {draft.launch.shell === "custom" && !draft.launch.customShell.trim() ? (
            <div className="text-[11px] text-warn">{t("settings.launch.noPath")}</div>
          ) : null}

          {/* A terminal cannot paste a picture, but it can paste a path. Rather than intercept
              anyone's paste key, the path is put on the clipboard beside the image. */}
          <div className="pt-3 text-[11px] text-bone-500">{t("settings.launch.paste")}</div>
          <label className="flex items-center gap-2 px-1 py-1 rounded-lg hover:bg-ink-700/60">
            <input
              type="checkbox"
              checked={draft.launch.autoClipPath}
              onChange={() =>
                update({ ...draft, launch: { ...draft.launch, autoClipPath: !draft.launch.autoClipPath } })}
              className="accent-accent"
            />
            <Truncated as="span" className="text-sm text-bone-100">{t("settings.launch.autoPath")}</Truncated>
          </label>
          <div className="text-[11px] text-bone-500">{t("settings.launch.autoPathNote")}</div>

          {/* A separate, secondary thing: reading it as "the shortcut for the checkbox above" is
              exactly the misreading this heading exists to prevent. */}
          <div className="pt-2 text-[11px] text-bone-500">{t("settings.launch.fallback")}</div>
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
              {t("settings.launch.default")}
            </button>
            <button
              type="button"
              className="btn shrink-0"
              onClick={() => update({ ...draft, launch: { ...draft.launch, pasteHotkey: "" } })}
            >
              {t("settings.launch.off")}
            </button>
          </div>
          <div className="text-[11px] text-bone-500">{t("settings.launch.fallbackNote")}</div>
          {draft.launch.pasteHotkey.trim() && !draft.pasteHotkeyActive ? (
            <div className="text-[11px] text-bad">
              {t("settings.launch.taken", { key: draft.launch.pasteHotkey })}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title={t("settings.permissions")} section="permissions" focused={focused} hint={t("settings.tabHint")}>
        <div className="space-y-1" onMouseEnter={() => onFocus("permissions")}>
          {PERMISSIONS.map((mode) => (
            <Choice
              key={mode.key}
              label={t(`settings.permission.${mode.key}` as "settings.permission.default")}
              // The bypass note is the flag itself, which stays as it is written on the command line.
              note={mode.key === "bypass"
                ? mode.note
                : t(`settings.permission.${mode.key}.note` as "settings.permission.default.note")}
              selected={draft.launch.permission === mode.key}
              onSelect={() => update({ ...draft, launch: { ...draft.launch, permission: mode.key } })}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

/**
 * Settings, as cards.
 *
 * The terminal version showed everything at once and moved between cards with Tab; that survives —
 * the focused card is the one Tab lands on, and every choice is one Space or Enter away. Each card's
 * body is its feature's, from that feature's `ui.tsx`; this file owns the order of the cards, the
 * draft they all edit, and the three cards that are the window's own.
 */
import { useEffect, useRef, useState } from "react";

import { LANGUAGES, resolveLanguage } from "@core/i18n";
import type { LayoutMode, ThemeMode } from "@core/types";

import { PasteSettings } from "../../features/clipboard/ui";
import { DockSettings } from "../../features/dock/ui";
import { GitSettings } from "../../features/git/ui";
import { MonitorSettings } from "../../features/metrics/ui";
import { LaunchSettings, PermissionSettings } from "../../features/projects/ui";
import { UpdatesSettings, type Updates } from "../../features/updates/ui";
import { StatusSettings, UsageSettings } from "../../features/usage/ui";
import type { DisplayInfo, SettingsPayload } from "../api";
import { useText } from "../useText";
import { Card, Choice, SETTINGS_SECTIONS, type SettingsSection } from "./SettingsCard";
import { Truncated } from "./Truncated";

export { SETTINGS_SECTIONS, type SettingsSection };

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
  /** The updater, as the updates feature keeps it. */
  updates: Updates;
  onClose: () => void;
}

export function SettingsView({ settings, displays, focused, onFocus, onChange, onApplyDock, onCollectUsage, onOpenPage, locale, updates, onClose }: SettingsViewProps) {
  const t = useText();
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

  const update = (next: SettingsPayload): void => {
    setDraft(next);
    sent.current = JSON.stringify(next);
    onChange(next);
  };
  /** One section of the draft, replaced; every card writes through this. */
  const section = <K extends keyof SettingsPayload>(key: K) => (value: SettingsPayload[K]): void =>
    update({ ...draft, [key]: value });

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

      <Card title={t("settings.appearance")} section="appearance" focused={focused} onFocus={onFocus} hint={t("settings.tabHint")}>
        {THEMES.map((theme) => (
          <Choice
            key={theme.key}
            label={t(`settings.appearance.${theme.key}` as "settings.appearance.system")}
            note={theme.key === "system" ? t("settings.appearance.system.note") : undefined}
            selected={draft.ui.theme === theme.key}
            onSelect={() => section("ui")({ ...draft.ui, theme: theme.key })}
          />
        ))}
      </Card>

      <Card title={t("settings.language")} section="language" focused={focused} onFocus={onFocus} hint={t("settings.language.hint")}>
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
            onSelect={() => section("ui")({ ...draft.ui, language: language.key })}
          />
        ))}
        <div className="text-[11px] text-bone-500">{t("settings.language.note")}</div>
      </Card>

      <Card title={t("settings.layout")} section="layout" focused={focused} onFocus={onFocus} hint={t("settings.layout.hint")} body="space-y-3">
        <div className="space-y-1">
          {LAYOUTS.map((option) => (
            <Choice
              key={option.key}
              label={t(`settings.layout.${option.key}` as "settings.layout.auto")}
              note={t(`settings.layout.${option.key}.note` as "settings.layout.auto.note")}
              selected={draft.ui.layout === option.key}
              onSelect={() => section("ui")({ ...draft.ui, layout: option.key })}
            />
          ))}
        </div>
      </Card>

      <Card title={t("settings.monitor")} section="monitor" focused={focused} onFocus={onFocus} hint={t("settings.monitor.hint")}>
        <MonitorSettings on={draft.ui.monitor} onChange={(monitor) => section("ui")({ ...draft.ui, monitor })} />
      </Card>

      <Card title={t("settings.dock")} section="dock" focused={focused} onFocus={onFocus} hint={t("settings.tabHint")} body="space-y-3">
        <DockSettings
          dock={draft.dock}
          floor={draft.dockFloor}
          minPercent={draft.minPercent}
          displays={displays}
          onChange={section("dock")}
          onApply={onApplyDock}
        />
      </Card>

      <Card title={t("settings.status")} section="status" focused={focused} onFocus={onFocus} hint={t("settings.status.hint")}>
        <StatusSettings status={draft.status} onChange={section("status")} />
      </Card>

      <Card title={t("settings.usage")} section="usage" focused={focused} onFocus={onFocus} hint={t("settings.usage.hint")} body="space-y-2">
        <UsageSettings usage={settings.usage} onCollect={onCollectUsage} />
      </Card>

      <Card title={t("settings.git")} section="git" focused={focused} onFocus={onFocus} hint={t("settings.git.hint")}>
        <GitSettings git={draft.git} available={settings.gitAvailable} onChange={section("git")} onInstall={() => onOpenPage("git")} />
      </Card>

      <Card title={t("settings.updates")} section="updates" focused={focused} onFocus={onFocus} hint={t("settings.updates.hint")} body="space-y-2">
        <UpdatesSettings
          automatic={draft.updates.automatic}
          onChange={(automatic) => section("updates")({ ...draft.updates, automatic })}
          updates={updates}
        />
      </Card>

      <Card title={t("settings.launch")} section="launch" focused={focused} onFocus={onFocus} hint={t("settings.tabHint")}>
        <LaunchSettings launch={draft.launch} onChange={section("launch")} />
        <PasteSettings launch={draft.launch} hotkeyActive={draft.pasteHotkeyActive} onChange={section("launch")} />
      </Card>

      <Card title={t("settings.permissions")} section="permissions" focused={focused} onFocus={onFocus} hint={t("settings.tabHint")}>
        <PermissionSettings launch={draft.launch} onChange={section("launch")} />
      </Card>
    </div>
  );
}

/**
 * Settings — the page side: the payload as last loaded or pushed, and the two ways it changes.
 *
 * The screen that edits it stays in `renderer/components/Settings.tsx`, which is the shell's: it
 * owns the order of the cards and the three that are the window's own, and each other card's body
 * comes from its feature's `ui.tsx`.
 */
import { useCallback, useEffect, useState } from "react";

import { api, type SettingsPayload } from "../../renderer/api";
import type { SettingsPatch } from "./contract";

export interface SettingsUi {
  /** Null until the first load has answered. */
  settings: SettingsPayload | null;
  /** For answers that carry the payload back on their own — docking, the usage switch. */
  setSettings(next: SettingsPayload): void;
  load(): Promise<SettingsPayload>;
  save(patch: SettingsPatch): Promise<SettingsPayload>;
}

export function useSettings(): SettingsUi {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  // Main can change the settings on its own — undocking when the window is dragged out of its band.
  useEffect(() => api.onSettings(setSettings), []);
  const load = useCallback(async (): Promise<SettingsPayload> => {
    const loaded = await api.loadSettings();
    setSettings(loaded);
    return loaded;
  }, []);
  const save = useCallback(async (patch: SettingsPatch): Promise<SettingsPayload> => {
    const saved = await api.saveSettings(patch);
    setSettings(saved);
    return saved;
  }, []);
  return { settings, setSettings, load, save };
}

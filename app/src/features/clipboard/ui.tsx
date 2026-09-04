/**
 * Screenshots into terminals — the page side.
 *
 * The shortcut runs in the main process and reports back; the window shows the result as a toast,
 * and holds the settings card body that configures it.
 */
import { useEffect } from "react";

import { DEFAULT_PASTE_HOTKEY } from "@core/constants";
import type { LaunchConfig } from "@core/types";

import { api } from "../../renderer/api";
import { Truncated } from "../../renderer/components/Truncated";
import { useText } from "../../renderer/useText";

/** Show what the system-wide paste shortcut did, each time it does it. */
export function usePasteResults(notify: (result: { ok: boolean; message?: string }) => void): void {
  useEffect(() => api.onPasteResult(notify), [notify]);
}

/**
 * The settings card body, inside Launch: the automatic path and the fallback shortcut.
 *
 * A terminal cannot paste a picture, but it can paste a path. Rather than intercept anyone's paste
 * key, the path is put on the clipboard beside the image.
 */
export function PasteSettings({ launch, hotkeyActive, onChange }: {
  launch: LaunchConfig;
  /** Whether the system-wide shortcut is actually held right now; false when something else owns it. */
  hotkeyActive: boolean;
  onChange(launch: LaunchConfig): void;
}) {
  const t = useText();
  const set = (patch: Partial<LaunchConfig>): void => onChange({ ...launch, ...patch });
  return (
    <>
      <div className="pt-3 text-[11px] text-bone-500">{t("settings.launch.paste")}</div>
      <label className="flex items-center gap-2 px-1 py-1 rounded-lg hover:bg-ink-700/60">
        <input
          type="checkbox"
          checked={launch.autoClipPath}
          onChange={() => set({ autoClipPath: !launch.autoClipPath })}
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
          value={launch.pasteHotkey}
          placeholder="off"
          onChange={(event) => set({ pasteHotkey: event.target.value })}
          className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-xs placeholder:text-bone-500 focus:border-accent/60"
        />
        <button type="button" className="btn shrink-0" onClick={() => set({ pasteHotkey: DEFAULT_PASTE_HOTKEY })}>
          {t("settings.launch.default")}
        </button>
        <button type="button" className="btn shrink-0" onClick={() => set({ pasteHotkey: "" })}>
          {t("settings.launch.off")}
        </button>
      </div>
      <div className="text-[11px] text-bone-500">{t("settings.launch.fallbackNote")}</div>
      {launch.pasteHotkey.trim() && !hotkeyActive ? (
        <div className="text-[11px] text-bad">
          {t("settings.launch.taken", { key: launch.pasteHotkey })}
        </div>
      ) : null}
    </>
  );
}

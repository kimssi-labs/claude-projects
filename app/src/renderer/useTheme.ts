/**
 * Light, dark, or whatever the system says.
 *
 * "system" is not a one-off read: the OS setting can change while the app is open (a schedule, a
 * hotkey), and the window should follow it without a restart.
 */
import { useEffect, useState } from "react";

import type { ThemeMode } from "@core/types";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** Applies `mode` to the document and reports the palette actually in use. */
export function useTheme(mode: ThemeMode): "light" | "dark" {
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  useEffect(() => {
    document.documentElement.dataset["theme"] = resolved;
    // Tells the browser which scrollbar and form-control colours to use — without it the native
    // widgets stay dark on a light page.
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);
  return resolved;
}

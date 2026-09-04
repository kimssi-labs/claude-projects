/**
 * Screenshots into terminals — the page side.
 *
 * The shortcut runs in the main process and reports back; the window's only part is to show the
 * result as a toast. The menu entry that does the same on demand stays with the session menu.
 */
import { useEffect } from "react";

import { api } from "../../renderer/api";

/** Show what the system-wide paste shortcut did, each time it does it. */
export function usePasteResults(notify: (result: { ok: boolean; message?: string }) => void): void {
  useEffect(() => api.onPasteResult(notify), [notify]);
}

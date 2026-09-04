/**
 * Claude Code's usage figures — the page side.
 *
 * Owns the snapshot the gauges draw from and the two ways it changes: a re-read, and the hook
 * being switched on or off. The gauges themselves (UsageCard) and the settings card that holds the
 * switch stay where they are until those screens are taken apart; this is the state behind them.
 */
import { useCallback, useState } from "react";

import type { StatusSnapshot } from "@core/types";

import { api, type SettingsPayload } from "../../renderer/api";

export interface Usage {
  /** The windows as last read; null until the first read has answered. */
  status: StatusSnapshot | null;
  /** Read the figures again. Stable, so a caller may list it as a dependency. */
  refresh(): Promise<void>;
  /**
   * Turn collection on or off, then read what it did or did not find. Answers with the result and
   * the settings payload the toggle came back with — the settings state belongs to the caller.
   */
  collect(on: boolean): Promise<{ ok: boolean; message?: string; settings: SettingsPayload }>;
}

export function useUsage(): Usage {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const refresh = useCallback(async () => { setStatus(await api.status()); }, []);
  const collect = useCallback(async (on: boolean) => {
    const result = await api.setUsageHook(on);
    await refresh();
    return result;
  }, [refresh]);
  return { status, refresh, collect };
}

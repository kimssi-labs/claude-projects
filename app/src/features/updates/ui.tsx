/**
 * Updates — the page side.
 *
 * The updater's state as main pushes it, the three commands, and the settings card that shows
 * them. The state is held at the window's level rather than the card's: a download runs while the
 * settings screen is closed, and the card should show where it got to when it is opened again.
 */
import { useCallback, useEffect, useState } from "react";

import { actionLabel, describe as describeUpdate, initialState, type UpdateState } from "@core/updates";

import { api } from "../../renderer/api";
import { Choice } from "../../renderer/components/SettingsCard";
import { Truncated } from "../../renderer/components/Truncated";
import { useText } from "../../renderer/useText";
import type { UpdateCommand } from "./contract";

export interface Updates {
  state: UpdateState;
  /** Check, download, or restart into what was downloaded. The answer replaces the state. */
  act(command: UpdateCommand): void;
}

/** `version` is the app's own, known once appInfo has answered; the state names it as "current". */
export function useUpdates(version: string | undefined): Updates {
  const [state, setState] = useState<UpdateState>(() => initialState("", true));
  // A download runs for a while; the screen learns about it as it happens rather than on reopen.
  useEffect(() => api.onUpdate(setState), []);
  useEffect(() => {
    if (version) setState((previous) => ({ ...previous, current: version }));
  }, [version]);
  const act = useCallback((command: UpdateCommand) => { void api.updateAction(command).then(setState); }, []);
  return { state, act };
}

/** The settings card body: the switch, and the one button that does whatever comes next. */
export function UpdatesSettings({ automatic, onChange, updates }: {
  automatic: boolean;
  onChange(automatic: boolean): void;
  updates: Updates;
}) {
  const t = useText();
  const { state, act } = updates;
  const next: UpdateCommand = state.phase === "ready" ? "install" : state.phase === "available" ? "download" : "check";
  return (
    <>
      <Choice
        label={t("settings.updates.auto")}
        note={t("settings.updates.auto.note")}
        selected={automatic}
        onSelect={() => onChange(true)}
      />
      <Choice
        label={t("settings.updates.manual")}
        note={t("settings.updates.manual.note")}
        selected={!automatic}
        onSelect={() => onChange(false)}
      />
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className={`btn ${state.phase === "ready" ? "btn-accent" : ""}`}
          disabled={state.phase === "checking" || state.phase === "downloading" || state.phase === "unsupported"}
          onClick={() => act(next)}
        >
          {t(actionLabel(state))}
        </button>
        <Truncated className="text-[11px] text-bone-400 flex-1">{t(describeUpdate(state).key, describeUpdate(state).vars)}</Truncated>
      </div>
    </>
  );
}

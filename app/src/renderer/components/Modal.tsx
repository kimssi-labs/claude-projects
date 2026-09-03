/**
 * The app's own dialog: asking a question in the window rather than in a box the OS drew.
 *
 * Two reasons it exists. Electron does not implement `window.prompt` at all, so asking for a branch
 * name that way returned nothing and the feature quietly did not work. And the native message box
 * is the system's own light or dark, which beside a dark window looks like a different program.
 *
 * It is deliberately small: a question, an optional field, two buttons. Anything more elaborate is a
 * screen, not a dialog.
 */
import { useEffect, useRef, useState } from "react";

import { useText } from "../useText";

export interface Ask {
  title: string;
  /** The sentence under the title; may be several lines. */
  detail?: string;
  /** Present when the dialog asks for a value rather than a yes or no. */
  input?: { placeholder?: string; initial?: string };
  confirm: string;
  /** Red confirm button, for a question whose yes cannot be taken back. */
  danger?: boolean;
}

/**
 * Resolves with the typed value, `true` for a plain confirmation, or null when dismissed.
 *
 * One resolution type for both shapes keeps the caller to a single `if`.
 */
export type AskResult = string | true | null;

export function Modal({ ask, onDone }: { ask: Ask; onDone: (result: AskResult) => void }) {
  const t = useText();
  const [value, setValue] = useState(ask.input?.initial ?? "");
  const field = useRef<HTMLInputElement>(null);

  // The field, or the confirm button, has focus the moment the dialog appears: a dialog that has to
  // be clicked before it can be typed into is a dialog that interrupts twice.
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);

  // Escape closes and Enter confirms, wherever the focus happens to be.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); onDone(null); }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (ask.input) { if (value.trim()) onDone(value.trim()); }
        else onDone(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ask.input, value, onDone]);

  return (
    <div
      className="absolute inset-0 z-50 bg-ink-900/80 flex items-center justify-center p-6"
      onClick={() => onDone(null)}
    >
      <div className="card p-4 w-[26rem] max-w-full" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-sm font-medium text-bone-100">{ask.title}</h2>
        {ask.detail ? (
          <p className="mt-2 text-xs text-bone-400 whitespace-pre-line break-words">{ask.detail}</p>
        ) : null}
        {ask.input ? (
          <input
            ref={field}
            value={value}
            spellCheck={false}
            placeholder={ask.input.placeholder}
            onChange={(event) => setValue(event.target.value)}
            className="mt-3 w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm placeholder:text-bone-500 focus:border-accent/60"
          />
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => onDone(null)}>{t("dialog.cancel")}</button>
          <button
            type="button"
            ref={ask.input ? undefined : (node) => node?.focus()}
            className={`btn ${ask.danger ? "bg-bad/90 text-ink-900 border-transparent font-medium hover:bg-bad" : "btn-accent"}`}
            disabled={Boolean(ask.input) && !value.trim()}
            onClick={() => onDone(ask.input ? value.trim() : true)}
          >
            {ask.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

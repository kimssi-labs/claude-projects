/**
 * The pieces every settings card is made of, and the list of cards.
 *
 * Shared by the shell's cards and the features' own, so the screen reads as one whoever drew each
 * card. The order here is the order on screen and the order Tab walks.
 */
import type { ReactNode } from "react";

export const SETTINGS_SECTIONS = ["appearance", "language", "layout", "monitor", "dock", "status", "usage", "git", "updates", "launch", "permissions"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function Card({
  title, section, focused, onFocus, hint, body = "space-y-1", children,
}: {
  title: string;
  section: SettingsSection;
  focused: SettingsSection;
  /** The pointer is over this card: it becomes the one Tab moves from. */
  onFocus(section: SettingsSection): void;
  hint?: string;
  /** The body's spacing class; the cards differ in how much air their rows want. */
  body?: string;
  children: ReactNode;
}) {
  const active = section === focused;
  return (
    <section className={`card p-4 transition-colors ${active ? "ring-1 ring-accent/50" : "opacity-80"}`}>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-bone-100">{title}</h3>
        {hint ? <span className="text-[11px] text-bone-500">{hint}</span> : null}
      </div>
      <div className={body} onMouseEnter={() => onFocus(section)}>{children}</div>
    </section>
  );
}

export function Choice({
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

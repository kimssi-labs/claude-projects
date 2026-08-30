/**
 * Every keyboard shortcut, in one table.
 *
 * The terminal version was driven entirely from the keyboard and that has to survive the move to a
 * window: the same keys do the same things here, and the mouse is an addition rather than a
 * replacement. Keeping the mapping pure means the bindings are testable without a browser.
 */
export type Screen = "projects" | "sessions" | "settings";

export type Action =
  | "moveUp" | "moveDown" | "pageUp" | "pageDown" | "moveFirst" | "moveLast"
  | "enter" | "openNewWindow"
  | "rename" | "delete" | "back" | "refresh" | "settings" | "quit"
  | "search" | "help" | "nextSection" | "previousSection";

export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Shown in the help overlay; the order is the order they appear there. */
export const SHORTCUTS: { keys: string; action: Action; description: string; screens: Screen[] }[] = [
  { keys: "↑ ↓", action: "moveDown", description: "Move through the list", screens: ["projects", "sessions", "settings"] },
  { keys: "PgUp PgDn", action: "pageDown", description: "Move a page at a time", screens: ["projects", "sessions"] },
  { keys: "Home End", action: "moveLast", description: "First / last row", screens: ["projects", "sessions"] },
  { keys: "Enter", action: "enter", description: "Open sessions / resume a session", screens: ["projects", "sessions"] },
  { keys: "O", action: "openNewWindow", description: "Open in a new window", screens: ["projects", "sessions"] },
  { keys: "F2", action: "rename", description: "Rename (alias for a project)", screens: ["projects", "sessions"] },
  { keys: "Del", action: "delete", description: "Delete, after a confirmation", screens: ["projects", "sessions"] },
  { keys: "← Esc", action: "back", description: "Back to the projects", screens: ["sessions"] },
  { keys: "Tab", action: "nextSection", description: "Next settings section", screens: ["settings"] },
  { keys: "S", action: "settings", description: "Settings", screens: ["projects", "sessions"] },
  { keys: "F5", action: "refresh", description: "Refresh", screens: ["projects", "sessions", "settings"] },
  { keys: "/", action: "search", description: "Search", screens: ["projects", "sessions"] },
  { keys: "?", action: "help", description: "This list", screens: ["projects", "sessions", "settings"] },
  { keys: "Ctrl+Q", action: "quit", description: "Quit", screens: ["projects", "sessions", "settings"] },
];

const NAVIGATION: Record<string, Action> = {
  ArrowUp: "moveUp",
  ArrowDown: "moveDown",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "moveFirst",
  End: "moveLast",
};

/**
 * The action a keystroke means on `screen`, or null.
 *
 * `typing` is true while a text field has focus: only Enter and Escape survive that, so a name with
 * an "o" in it cannot open a window.
 */
export function resolveAction(event: KeyEventLike, screen: Screen, typing = false): Action | null {
  const key = event.key;
  if (typing) {
    if (key === "Enter") return "enter";
    if (key === "Escape") return "back";
    return null;
  }
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "q") return "quit";
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const navigation = NAVIGATION[key];
  if (navigation) return navigation;
  if (key === "Tab") return event.shiftKey ? "previousSection" : "nextSection";
  if (key === "Enter") return "enter";
  if (key === "ArrowRight") return screen === "projects" ? "enter" : null;
  if (key === "ArrowLeft" || key === "Escape") return "back";
  if (key === "Delete") return "delete";
  if (key === "F2") return "rename";
  if (key === "F5") return "refresh";
  if (key === "/") return "search";
  if (key === "?") return "help";

  switch (key.toLowerCase()) {
    case "o": return "openNewWindow";
    case "s": return "settings";
    default: return null;
  }
}

/** Next index for a movement action, clamped to the list — `pageSize` is what a page means here. */
export function nextIndex(action: Action, current: number, count: number, pageSize: number): number {
  if (!count) return 0;
  const last = count - 1;
  switch (action) {
    case "moveUp": return Math.max(0, current - 1);
    case "moveDown": return Math.min(last, current + 1);
    case "pageUp": return Math.max(0, current - pageSize);
    case "pageDown": return Math.min(last, current + pageSize);
    case "moveFirst": return 0;
    case "moveLast": return last;
    default: return current;
  }
}

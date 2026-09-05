/** Formatting shared by every view — one definition each, so two panels cannot disagree. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return sameYear
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * When a rate-limit window rolls over, spelled the way a person would say it.
 *
 * The clock time alone made the reader do arithmetic to answer the only question they had — how
 * long until this frees up — so the remaining time leads and the absolute time follows it.
 */
export function resetRemaining(resetsAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60000));
  const hours = Math.floor(minutes / 60);
  // Every unit that is not zero-by-construction, largest first: "2d 5h 30m", "3h 5m", "42m".
  // Past a day, hours alone stop meaning anything — "167h" is a number to be decoded.
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ${minutes % 60}m`;
  return hours >= 1 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function resetLabel(resetsAt: number, now = Date.now()): string {
  return `${resetRemaining(resetsAt, now)} left · ${formatClock(resetsAt)}`;
}

/** "3 minutes ago" — for a list where the exact second never matters. */
export function formatSince(ms: number, now = Date.now()): string {
  const { key, vars } = sinceParts(ms, now);
  return key === "since.absolute" ? formatTime(ms) : EN_SINCE[key](vars.count ?? 0);
}

/**
 * The same reckoning, as a message and its number.
 *
 * Split out so a translated screen can say it in its own language: "3분 전" is not "3" pasted into
 * an English sentence, and a component that has the translator can put the pieces together itself.
 */
export function sinceParts(ms: number, now = Date.now()): {
  key: "since.now" | "since.minutes" | "since.hours" | "since.days" | "since.absolute";
  vars: { count?: number };
} {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return { key: "since.now", vars: {} };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { key: "since.minutes", vars: { count: minutes } };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { key: "since.hours", vars: { count: hours } };
  const days = Math.round(hours / 24);
  return days < 30 ? { key: "since.days", vars: { count: days } } : { key: "since.absolute", vars: {} };
}

/** English, for the callers that have no translator to hand — tests, and anything outside the tree. */
const EN_SINCE = {
  "since.now": () => "just now",
  "since.minutes": (n: number) => `${n} min ago`,
  "since.hours": (n: number) => `${n} h ago`,
  "since.days": (n: number) => `${n} d ago`,
  "since.absolute": () => "",
} as const;

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** Colour for a usage percentage, matching what the status line used to say with colour. */
export function usageTone(percent: number): string {
  if (percent >= 80) return "text-bad";
  if (percent >= 50) return "text-warn";
  return "text-ok";
}

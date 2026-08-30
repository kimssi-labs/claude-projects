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

/** "3 minutes ago" — for a list where the exact second never matters. */
export function formatSince(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : formatTime(ms);
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** Colour for a usage percentage, matching what the status line used to say with colour. */
export function usageTone(percent: number): string {
  if (percent >= 80) return "text-bad";
  if (percent >= 50) return "text-warn";
  return "text-ok";
}

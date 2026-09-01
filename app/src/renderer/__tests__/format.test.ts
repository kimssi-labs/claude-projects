/**
 * Renderer: how a rate-limit window's reset is worded.
 *
 * The strip used to print the reset as a bare clock time, and the docked band — the shape the app is
 * left in all day — printed nothing at all. "When does this free up" is the question the number
 * beside it provokes, so the answer leads with the time remaining.
 */
import { describe, expect, it } from "vitest";

import { resetLabel } from "../format";

// Built from today, not a fixed date: formatClock drops the date for a time on the same day, so a
// hard-coded NOW made these tests pass until midnight and fail afterwards.
const NOW = new Date(new Date().setHours(14, 0, 0, 0));
const CLOCK = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const sameDay = d.toDateString() === NOW.toDateString();
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const minutes = (n: number): number => NOW.getTime() + n * 60_000;

describe("resetLabel", () => {
  it("leads with the time left, then says when", () => {
    expect(resetLabel(minutes(42), NOW.getTime())).toBe(`42m left · ${CLOCK(minutes(42))}`);
  });

  it("breaks an hour or more into hours and minutes", () => {
    expect(resetLabel(minutes(185), NOW.getTime())).toBe(`3h 5m left · ${CLOCK(minutes(185))}`);
    expect(resetLabel(minutes(60), NOW.getTime())).toBe(`1h 0m left · ${CLOCK(minutes(60))}`);
  });

  it("carries the date when the window rolls on another day", () => {
    expect(resetLabel(minutes(20 * 60), NOW.getTime())).toBe(`20h 0m left · ${CLOCK(minutes(20 * 60))}`);
  });

  it("counts a weekly window in days, not in three-digit hours", () => {
    // The seven-day window read "167h 47m left", which is a number to be decoded rather than read.
    expect(resetLabel(minutes(167 * 60 + 47), NOW.getTime())).toBe(`6d 23h left · ${CLOCK(minutes(167 * 60 + 47))}`);
  });

  it("never counts backwards past zero", () => {
    // A window whose reset has just gone by reads as due, not as negative time.
    expect(resetLabel(minutes(-5), NOW.getTime())).toBe(`0m left · ${CLOCK(minutes(-5))}`);
  });
});

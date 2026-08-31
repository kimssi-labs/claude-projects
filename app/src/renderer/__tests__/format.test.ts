/**
 * Renderer: how a rate-limit window's reset is worded.
 *
 * The strip used to print the reset as a bare clock time, and the docked band — the shape the app is
 * left in all day — printed nothing at all. "When does this free up" is the question the number
 * beside it provokes, so the answer leads with the time remaining.
 */
import { describe, expect, it } from "vitest";

import { resetLabel } from "../format";

const NOW = new Date("2026-08-31T14:00:00").getTime();
const minutes = (n: number): number => NOW + n * 60_000;

describe("resetLabel", () => {
  it("leads with the time left, then says when", () => {
    expect(resetLabel(minutes(42), NOW)).toBe("42m left · 14:42");
  });

  it("breaks an hour or more into hours and minutes", () => {
    expect(resetLabel(minutes(185), NOW)).toBe("3h 5m left · 17:05");
    expect(resetLabel(minutes(60), NOW)).toBe("1h 0m left · 15:00");
  });

  it("carries the date when the window rolls on another day", () => {
    expect(resetLabel(minutes(20 * 60), NOW)).toBe("20h 0m left · 09/01 10:00");
  });

  it("counts a weekly window in days, not in three-digit hours", () => {
    // The seven-day window read "167h 47m left", which is a number to be decoded rather than read.
    expect(resetLabel(minutes(167 * 60 + 47), NOW)).toBe("6d 23h left · 09/07 13:47");
  });

  it("never counts backwards past zero", () => {
    // A window whose reset has just gone by reads as due, not as negative time.
    expect(resetLabel(minutes(-5), NOW)).toBe("0m left · 13:55");
  });
});

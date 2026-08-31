/**
 * Core: when a copied screenshot gets a path, and which saved ones are thrown away.
 *
 * The rule that matters is the loop: adding a path is itself a clipboard write, so a watcher that
 * did not recognise its own work would rewrite the clipboard forever.
 */
import { describe, expect, it } from "vitest";
import { CLIP_KEEP, clipsToPrune, shouldAddPath } from "../clipboardRules.js";

const IMAGE = ["image/png"];
const IMAGE_AND_PATH = ["text/plain", "image/png"];

describe("shouldAddPath", () => {
  it("adds a path to a freshly copied screenshot", () => {
    expect(shouldAddPath({ formats: IMAGE, sequence: 7 }, 6)).toBe(true);
  });

  it("leaves the clipboard alone once the path is on it", () => {
    // Our own write. Reacting to it would put us in a loop, writing a file every poll.
    expect(shouldAddPath({ formats: IMAGE_AND_PATH, sequence: 8 }, 7)).toBe(false);
  });

  it("ignores a clipboard nothing has touched", () => {
    expect(shouldAddPath({ formats: IMAGE, sequence: 7 }, 7)).toBe(false);
  });

  it("ignores copied text", () => {
    expect(shouldAddPath({ formats: ["text/plain", "text/html"], sequence: 9 }, 8)).toBe(false);
  });

  it("ignores an empty clipboard", () => {
    expect(shouldAddPath({ formats: [], sequence: 9 }, 8)).toBe(false);
  });
});

describe("clipsToPrune", () => {
  const named = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `clip-2026083${i % 10}-1200${String(i).padStart(2, "0")}-000.png`);

  it("keeps everything while there is room", () => {
    expect(clipsToPrune(named(CLIP_KEEP))).toEqual([]);
  });

  it("throws away the oldest when there is not", () => {
    const all = named(CLIP_KEEP + 3).sort();
    expect(clipsToPrune(all)).toEqual(all.slice(0, 3));
  });

  it("touches nothing else in the folder", () => {
    expect(clipsToPrune(["notes.txt", "clip-keep.png.bak", ...named(2)], 0))
      .toEqual(named(2).sort());
  });
});

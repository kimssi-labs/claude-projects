/**
 * Main process: the paste keystroke.
 *
 * The bug this guards: the shortcut is Ctrl+Alt+V, and the Ctrl+V we send was arriving while the
 * user still had Alt down — so the terminal saw Ctrl+Alt+V and pasted nothing. Measured: an
 * instant release pasted the path, a 250 ms hold pasted nothing at all.
 */
import { describe, expect, it } from "vitest";
import { MODIFIER_WAIT_CAP_MS, whenModifiersReleased } from "../keystroke.js";

/** A clock that never really sleeps, so the test runs at full speed. */
function fakeClock() {
  let elapsed = 0;
  return {
    get elapsed() {
      return elapsed;
    },
    delay: async (ms: number) => {
      elapsed += ms;
    },
  };
}

describe("whenModifiersReleased", () => {
  it("does not wait at all when the keyboard is already clear", async () => {
    const clock = fakeClock();
    expect(await whenModifiersReleased(() => false, clock.delay)).toBe(true);
    expect(clock.elapsed).toBe(0);
  });

  it("waits out a human-length hold on Ctrl+Alt", async () => {
    const clock = fakeClock();
    // A person holds the modifiers about a quarter of a second after the shortcut fires.
    const held = () => clock.elapsed < 250;

    expect(await whenModifiersReleased(held, clock.delay)).toBe(true);
    expect(clock.elapsed).toBeGreaterThanOrEqual(250);
    expect(clock.elapsed).toBeLessThan(MODIFIER_WAIT_CAP_MS);
  });

  it("gives up rather than swallowing the paste when a key is stuck down", async () => {
    const clock = fakeClock();
    expect(await whenModifiersReleased(() => true, clock.delay)).toBe(false);
    expect(clock.elapsed).toBeGreaterThanOrEqual(MODIFIER_WAIT_CAP_MS);
  });
});

/**
 * The window's frame, tested without a window or a desktop.
 *
 * What DWM and Electron do with the values is proven by the e2e pixel tests; what is pinned here is
 * that the frame is told the right values at the right moments: the border as Electron's accent
 * colour (which it keeps across shows and activation changes — the fact that shipped a grey ring in
 * v2.11.4 and a flash in v2.12.1 while every other test passed), the corners to DWM.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Electron's nativeTheme, as the tests can drive it: a theme source that can be read back, a machine
// switch that can be flipped, and the "updated" listeners that flipping it calls. Hoisted above the
// imports (that is where vi.mock runs), so it cannot use anything imported — hence no EventEmitter.
const theme = vi.hoisted(() => {
  const state = { themeSource: "system" as string, shouldUseDarkColors: false };
  const listeners = new Set<() => void>();
  return {
    state,
    listeners,
    flip(dark: boolean): void {
      state.shouldUseDarkColors = dark;
      for (const fn of [...listeners]) fn();
    },
  };
});
vi.mock("electron", () => ({
  nativeTheme: {
    get themeSource() { return theme.state.themeSource; },
    set themeSource(value: string) { theme.state.themeSource = value; },
    get shouldUseDarkColors() { return theme.state.shouldUseDarkColors; },
    on: (_event: string, fn: () => void) => { theme.listeners.add(fn); },
    removeListener: (_event: string, fn: () => void) => { theme.listeners.delete(fn); },
  },
}));

import { SURFACE } from "../../core/constants.js";
import {
  DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT, DWMWCP_DONOTROUND, lookFor, resolveTheme, RESETS_THE_FRAME, surfaceFor, WindowChrome,
} from "../chrome.js";

/** A window that can be shown, restored and closed, says whether it is gone, and records its accent. */
class FakeWindow extends EventEmitter {
  destroyed = false;
  accents: (string | boolean | null)[] = [];
  isDestroyed(): boolean { return this.destroyed; }
  setAccentColor(value: string | boolean | null): void { this.accents.push(value); }
}

/** A chrome over a fake window and a fake DWM; `corners` is every corner preference DWM was told. */
function chrome(): { chrome: WindowChrome; window: FakeWindow; corners: number[] } {
  const corners: number[] = [];
  const window = new FakeWindow();
  const instance = new WindowChrome(
    window as unknown as Electron.BrowserWindow,
    { set: (_hwnd, attribute, value) => { if (attribute === DWMWA_WINDOW_CORNER_PREFERENCE) corners.push(value); } },
    () => 0x1234,
  );
  return { chrome: instance, window, corners };
}

beforeEach(() => {
  theme.state.themeSource = "system";
  theme.state.shouldUseDarkColors = false;
  theme.listeners.clear();
});

describe("the page's colour for a theme", () => {
  it("is the surface of the palette, with 'system' resolved by the machine", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(surfaceFor("dark", false)).toBe(SURFACE.dark);
    expect(surfaceFor("system", false)).toBe(SURFACE.light);
  });
});

describe("what the frame is told", () => {
  it("is square corners and the page's colour as the accent for a band; the system's own look for a window", () => {
    expect(lookFor(true, SURFACE.dark)).toEqual({ corners: DWMWCP_DONOTROUND, accent: SURFACE.dark });
    expect(lookFor(false, SURFACE.dark)).toEqual({ corners: DWMWCP_DEFAULT, accent: false });
  });
});

describe("a window's chrome", () => {
  it("dresses a band in the page's colour through Electron's accent, and mirrors the theme into Chromium", () => {
    const { chrome: c, window, corners } = chrome();
    c.theme("dark");
    expect(theme.state.themeSource).toBe("dark");
    c.flush(true);
    expect(window.accents.at(-1)).toBe(SURFACE.dark);
    expect(corners.at(-1)).toBe(DWMWCP_DONOTROUND);
  });

  it("does not write the border colour to DWM itself — Electron would undo it on the next show or click elsewhere", () => {
    const told: number[] = [];
    const window = new FakeWindow();
    const c = new WindowChrome(window as unknown as Electron.BrowserWindow, { set: (_h, attribute) => { told.push(attribute); } }, () => 1);
    c.theme("dark");
    c.flush(true);
    expect(told.every((attribute) => attribute === DWMWA_WINDOW_CORNER_PREFERENCE)).toBe(true);
  });

  it("tells the frame again after a show or restore, in case Chromium redrew it", () => {
    const { chrome: c, window, corners } = chrome();
    c.theme("dark");
    c.flush(true);
    expect([...RESETS_THE_FRAME]).toEqual(["show", "restore"]);
    for (const event of RESETS_THE_FRAME) {
      corners.length = 0;
      window.accents.length = 0;
      window.emit(event);
      expect(corners, `corners after ${event}`).toEqual([DWMWCP_DONOTROUND]);
      expect(window.accents, `accent after ${event}`).toEqual([SURFACE.dark]);
    }
  });

  it("gives the window its own look back when it is no longer a band", () => {
    const { chrome: c, window, corners } = chrome();
    c.flush(true);
    c.flush(false);
    expect(window.accents.at(-1)).toBe(false);
    expect(corners.at(-1)).toBe(DWMWCP_DEFAULT);
  });

  it("follows the machine's own switch while the theme is 'system'", () => {
    const { chrome: c, window } = chrome();
    c.theme("system");
    c.flush(true);
    expect(window.accents.at(-1)).toBe(SURFACE.light);
    theme.flip(true);
    expect(window.accents.at(-1), "re-coloured on the machine's switch").toBe(SURFACE.dark);
  });

  it("re-colours a band the moment the theme changes", () => {
    const { chrome: c, window } = chrome();
    c.theme("light");
    c.flush(true);
    c.theme("dark");
    expect(window.accents.at(-1)).toBe(SURFACE.dark);
  });

  it("leaves a destroyed window alone, and stops listening to the machine once it is closed", () => {
    const { chrome: c, window, corners } = chrome();
    c.flush(true);
    window.destroyed = true;
    corners.length = 0;
    window.accents.length = 0;
    window.emit("show");
    c.theme("dark");
    expect(corners).toEqual([]);
    expect(window.accents).toEqual([]);
    window.emit("closed");
    expect(theme.listeners.size).toBe(0);
  });

  it("still colours the border where there is no DWM binding", () => {
    const window = new FakeWindow();
    const c = new WindowChrome(window as unknown as Electron.BrowserWindow, null, () => 1, "win32");
    c.theme("dark");
    c.flush(true);
    expect(window.accents.at(-1)).toBe(SURFACE.dark);
  });

  it("never touches the accent colour off Windows — the call is not implemented there and stopped start-up on Linux", () => {
    const window = new FakeWindow();
    const c = new WindowChrome(window as unknown as Electron.BrowserWindow, null, () => 1, "linux");
    c.theme("dark");
    c.flush(true);
    window.emit("show");
    expect(window.accents).toEqual([]);
  });
});

/**
 * The window's frame, tested without a window or a desktop.
 *
 * What DWM does with the values is proven by the e2e pixel tests; what is pinned here is that the
 * frame is told the right values at the right moments — above all again after every `show`, which
 * is the fact that shipped a grey ring in v2.11.4 while every other test passed.
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
  colourRef, DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT, DWMWA_WINDOW_CORNER_PREFERENCE, lookFor, resolveTheme, RESETS_THE_FRAME, surfaceFor, WindowChrome,
} from "../chrome.js";

const LIGHT = colourRef(SURFACE.light);
const DARK = colourRef(SURFACE.dark);

/** A window that can be shown, restored and closed, and says whether it is gone. */
class FakeWindow extends EventEmitter {
  destroyed = false;
  isDestroyed(): boolean { return this.destroyed; }
}

/** Every attribute the frame was told, in order, as `[attribute, value]`. */
function chrome(): { chrome: WindowChrome; window: FakeWindow; told: [number, number][] } {
  const told: [number, number][] = [];
  const window = new FakeWindow();
  const instance = new WindowChrome(
    window as unknown as Electron.BrowserWindow,
    { set: (_hwnd, attribute, value) => void told.push([attribute, value]) },
    () => 0x1234,
  );
  return { chrome: instance, window, told };
}

const band = (colour: number): [number, number][] => [[DWMWA_WINDOW_CORNER_PREFERENCE, 1], [DWMWA_BORDER_COLOR, colour]];
const plain: [number, number][] = [[DWMWA_WINDOW_CORNER_PREFERENCE, 0], [DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT]];

beforeEach(() => {
  theme.state.themeSource = "system";
  theme.state.shouldUseDarkColors = false;
  theme.listeners.clear();
});

describe("colourRef", () => {
  it("is the COLORREF DWM takes: 0x00BBGGRR", () => {
    expect(colourRef("#ff0000")).toBe(0x0000ff);
    expect(colourRef("#141413")).toBe(0x131414);
    expect(colourRef("faf9f7")).toBe(0xf7f9fa);
  });
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
  it("is square corners and the given colour for a band, and the system's own look for a window", () => {
    expect(lookFor(true, DARK)).toEqual({ corners: 1, border: DARK });
    expect(lookFor(false, DARK)).toEqual({ corners: 0, border: DWMWA_COLOR_DEFAULT });
  });
});

describe("a window's chrome", () => {
  it("dresses a band in the page's colour, and mirrors the theme into Chromium", () => {
    const { chrome: c, told } = chrome();
    c.theme("dark");
    expect(theme.state.themeSource).toBe("dark");
    told.length = 0;
    c.flush(true);
    expect(told).toEqual(band(DARK));
  });

  it("tells the frame again after every event Chromium writes its own colour on — the v2.11.4 and v2.12.0 regressions", () => {
    const { chrome: c, window, told } = chrome();
    c.theme("dark");
    c.flush(true);
    // show/restore: the band restored at start-up wore a grey ring (v2.11.4). focus/blur: the ring
    // was right until another window was clicked (v2.12.0).
    expect([...RESETS_THE_FRAME]).toEqual(["show", "restore", "focus", "blur"]);
    for (const event of RESETS_THE_FRAME) {
      told.length = 0;
      window.emit(event);
      expect(told, `after ${event}`).toEqual(band(DARK));
    }
  });

  it("gives the window its own look back when it is no longer a band", () => {
    const { chrome: c, window, told } = chrome();
    c.flush(true);
    c.flush(false);
    expect(told.slice(-2)).toEqual(plain);
    told.length = 0;
    window.emit("show");
    expect(told, "a window stays a window through a show").toEqual(plain);
  });

  it("follows the machine's own switch while the theme is 'system'", () => {
    const { chrome: c, told } = chrome();
    c.theme("system");
    c.flush(true);
    expect(told.slice(-2)).toEqual(band(LIGHT));
    theme.flip(true);
    expect(told.slice(-2), "re-coloured on the machine's switch").toEqual(band(DARK));
  });

  it("re-colours a band the moment the theme changes", () => {
    const { chrome: c, told } = chrome();
    c.theme("light");
    c.flush(true);
    c.theme("dark");
    expect(told.slice(-2)).toEqual(band(DARK));
  });

  it("leaves a destroyed window alone, and stops listening to the machine once it is closed", () => {
    const { chrome: c, window, told } = chrome();
    c.flush(true);
    window.destroyed = true;
    told.length = 0;
    window.emit("show");
    c.theme("dark");
    expect(told).toEqual([]);
    window.emit("closed");
    expect(theme.listeners.size).toBe(0);
  });

  it("does nothing at all where there is no DWM", () => {
    const window = new FakeWindow();
    const c = new WindowChrome(window as unknown as Electron.BrowserWindow, null, () => 1);
    expect(() => { c.theme("dark"); c.flush(true); window.emit("show"); }).not.toThrow();
  });
});

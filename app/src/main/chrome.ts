/**
 * How the window's frame looks — the one pixel of window that is not page.
 *
 * Owned here and nowhere else, because it kept breaking from the outside: every change to where a
 * band is placed moved a hairline, and every place the window was shown from reset its colour. Three
 * facts, each measured on Windows 11 26200 with Electron 43, and each one a release that looked fine
 * in every geometry test:
 *
 * 1. DWM draws a 1 px border around a frameless window, top row included, and `DWMWA_COLOR_NONE`
 *    does not remove it — it paints #f3f3f3 (DEFAULT paints #474747). A real COLORREF is honoured,
 *    so a band's border is painted in the page's own background and cannot be told from it.
 * 2. Showing the window — the first show at start-up, a hide and show, a minimise and restore — and
 *    every change of activation — another window clicked, this one clicked again — hands the frame
 *    back to Chromium, which writes its own colour over the one DWM was given (measured: a band was
 *    right while focused and grey the moment another window was chosen). So the frame is told again
 *    on every `show`, `restore`, `focus` and `blur`, by this module's own listeners; nothing outside
 *    has to remember to.
 * 3. On a scaled display there is a second ring pixel that Chromium draws and no attribute reaches;
 *    it follows Chromium's own light/dark, which `nativeTheme.themeSource` sets. The page's theme is
 *    therefore mirrored into Chromium, and the window's background is the page's colour too.
 *
 * The geometry of a band lives in `dock.ts`; all it asks of this module is `flush(true)` when the
 * window becomes a band and `flush(false)` when it is a window again. The shell tells it the theme.
 * Guards: the unit tests beside this file, the boundaries test (this module imports no feature and
 * not dock), and the e2e pixel tests — "every monitor, every edge" and "restored at start-up".
 */
import { nativeTheme, type BrowserWindow } from "electron";

import { SURFACE } from "../core/constants.js";
import type { ThemeMode } from "../core/types.js";

/** DwmSetWindowAttribute: the corner preference, and its values. */
export const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_DEFAULT = 0;
const DWMWCP_DONOTROUND = 1;
/** DwmSetWindowAttribute: the border colour, and "the system's own" — what an undocked window wears. */
export const DWMWA_BORDER_COLOR = 34;
export const DWMWA_COLOR_DEFAULT = 0xffffffff;

/** A CSS `#rrggbb` as the COLORREF (0x00BBGGRR) DWM takes. */
export function colourRef(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return (((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0;
}

/** Which palette `mode` puts the page in, resolving "system" the way the page does. */
export function resolveTheme(mode: ThemeMode, systemIsDark = nativeTheme.shouldUseDarkColors): "light" | "dark" {
  if (mode === "system") return systemIsDark ? "dark" : "light";
  return mode;
}

/** The page's background for `mode` — what a window is painted in, and what a band's border is. */
export function surfaceFor(mode: ThemeMode, systemIsDark = nativeTheme.shouldUseDarkColors): string {
  return SURFACE[resolveTheme(mode, systemIsDark)];
}

/**
 * Tell Chromium which side the app is on, so what IT draws agrees with the page: native menus and
 * dialogs, and the frame pixel of fact 3 above. The setting's own values are what `themeSource`
 * takes. Returns the page's colour for the same theme.
 */
export function followTheme(mode: ThemeMode): string {
  nativeTheme.themeSource = mode;
  return surfaceFor(mode);
}

/** What the frame is told — both attributes, as values a test can read back. */
export interface FrameLook {
  corners: number;
  border: number;
}

/** Square corners and a border in `colour` for a band; the system's own look for a window. */
export function lookFor(flush: boolean, colour: number): FrameLook {
  return flush
    ? { corners: DWMWCP_DONOTROUND, border: colour }
    : { corners: DWMWCP_DEFAULT, border: DWMWA_COLOR_DEFAULT };
}

/** The window events after which Chromium has written its own frame colour (fact 2 above). */
export const RESETS_THE_FRAME = ["show", "restore", "focus", "blur"] as const;

/** The one DWM call this needs, as something a test can stand in for. */
export interface FrameSetter {
  set(hwnd: number, attribute: number, value: number): void;
}

let frameSetter: FrameSetter | null | undefined;

/** Bound lazily and never off Windows, so a missing native dependency costs the look, not the app. */
function loadFrameSetter(): FrameSetter | null {
  if (frameSetter !== undefined) return frameSetter;
  if (process.platform !== "win32") return (frameSetter = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    // The convention goes in koffi's FIRST argument (see dock.ts for the trap).
    const DwmSetWindowAttribute = koffi.load("dwmapi.dll").func("__stdcall", "DwmSetWindowAttribute", "int32", [
      "intptr", "uint32", koffi.pointer("uint32"), "uint32",
    ]);
    // A DWORD by pointer; koffi wants that as a one-element array.
    frameSetter = { set: (hwnd, attribute, value) => void DwmSetWindowAttribute(hwnd, attribute, [value], 4) };
  } catch (error) {
    console.error("[hangar] window frame attributes unavailable:", (error as Error).message);
    frameSetter = null;
  }
  return frameSetter;
}

/** The window handle as the number Win32 wants. */
export function nativeHandle(window: BrowserWindow): number {
  const buffer = window.getNativeWindowHandle();
  return buffer.length === 8 ? Number(buffer.readBigUInt64LE(0)) : buffer.readUInt32LE(0);
}

/**
 * The frame of one window, kept as it should look for as long as the window lives.
 *
 * Two inputs — is it a band (`flush`), and which theme is the page in (`theme`) — and the frame is
 * told the answer now and again every time Chromium could have forgotten it.
 */
export class WindowChrome {
  private flushed = false;
  private mode: ThemeMode = "system";

  constructor(
    private readonly window: BrowserWindow,
    private readonly frame: FrameSetter | null = loadFrameSetter(),
    private readonly handleOf: (window: BrowserWindow) => number = nativeHandle,
  ) {
    const again = (): void => this.apply();
    // Fact 2. Through the plain emitter: BrowserWindow's per-event overloads take one literal, not a list.
    for (const event of RESETS_THE_FRAME) (window as NodeJS.EventEmitter).on(event, again);
    nativeTheme.on("updated", again);             // "system" follows the machine's own switch
    window.once("closed", () => nativeTheme.removeListener("updated", again));
  }

  /** A band (`true`): square corners, border in the page's colour. A window again (`false`). */
  flush(on: boolean): void {
    this.flushed = on;
    this.apply();
  }

  /** The page's theme, known for the first time or changed: mirrored into Chromium, and re-coloured. */
  theme(mode: ThemeMode): void {
    this.mode = mode;
    followTheme(mode);
    this.apply();
  }

  private apply(): void {
    if (!this.frame || this.window.isDestroyed()) return;
    const look = lookFor(this.flushed, colourRef(surfaceFor(this.mode)));
    const hwnd = this.handleOf(this.window);
    this.frame.set(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, look.corners);
    this.frame.set(hwnd, DWMWA_BORDER_COLOR, look.border);
  }
}

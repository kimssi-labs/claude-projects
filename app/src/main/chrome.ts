/**
 * How the window's frame looks — the one pixel of window that is not page.
 *
 * Owned here and nowhere else, because it kept breaking from the outside: every change to where a
 * band is placed moved a hairline, and every place the window was shown from reset its colour. Three
 * facts, each measured on Windows 11 26200 with Electron 43, and each one a release that looked fine
 * in every geometry test:
 *
 * 1. DWM draws a 1 px border around a frameless window, top row included, and `DWMWA_COLOR_NONE`
 *    does not remove it — it paints #f3f3f3 (DEFAULT paints a translucent grey). A real colour is
 *    honoured, so a band's border is painted in the page's own background and cannot be told from it.
 * 2. Electron writes that colour itself — from the window's ACCENT colour — on every show and every
 *    change of activation. A colour written straight to DWM behind its back was therefore undone by
 *    the next show (a grey ring on every band restored at start-up) and by the next click elsewhere;
 *    writing it again from the `blur` event put it back two frames later, which is a flash. So the
 *    colour is not written to DWM at all: it is handed to Electron as the accent colour, and Electron
 *    keeps it (measured: no change of the border pixel at all across losing focus, or a hide/show).
 *    `false` is the system's own grey — what a window that is not a band wears.
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
export const DWMWCP_DEFAULT = 0;
export const DWMWCP_DONOTROUND = 1;

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

/** What the frame is told — as values a test can read back. */
export interface FrameLook {
  /** The DWM corner preference. */
  corners: number;
  /** Electron's accent colour for the window: the page's colour for a band, `false` for a window. */
  accent: string | false;
}

/** Square corners and a border in the page's colour for a band; the system's own look for a window. */
export function lookFor(flush: boolean, surface: string): FrameLook {
  return flush ? { corners: DWMWCP_DONOTROUND, accent: surface } : { corners: DWMWCP_DEFAULT, accent: false };
}

/** The window events after which the frame is told again (fact 2 — the colour is Electron's to keep). */
export const RESETS_THE_FRAME = ["show", "restore"] as const;

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
 * told the answer: the border colour to Electron, which keeps it; the corners to DWM, again on each
 * show in case Chromium redrew the frame.
 */
export class WindowChrome {
  private flushed = false;
  private mode: ThemeMode = "system";

  constructor(
    private readonly window: BrowserWindow,
    private readonly frame: FrameSetter | null = loadFrameSetter(),
    private readonly handleOf: (window: BrowserWindow) => number = nativeHandle,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    // On the next turn of the loop, never in the event itself. A window event arrives from inside a
    // Windows message, and that message may have been sent by one of our own native calls — placing a
    // minimised band restores it, which is `restore`. A second koffi call nested inside the first
    // jumped to address 4 and took the process down (dump: rip = 4, on koffi's own stack). A fresh
    // turn is outside every native call.
    const again = (): void => { setImmediate(() => this.apply()); };
    // Through the plain emitter: BrowserWindow's per-event overloads take one literal, not a list.
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
    if (this.window.isDestroyed()) return;
    const look = lookFor(this.flushed, surfaceFor(this.mode));
    // Windows only: elsewhere there is no such border, and the accent call is not implemented — it
    // threw on Linux, from inside start-up, and the app never got a window (CI, Electron 43).
    if (this.platform === "win32") this.window.setAccentColor(look.accent);
    this.frame?.set(this.handleOf(this.window), DWMWA_WINDOW_CORNER_PREFERENCE, look.corners);
  }
}

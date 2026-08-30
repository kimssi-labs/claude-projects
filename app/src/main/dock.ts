/**
 * Reserving a screen edge for the window — the feature the terminal version had, kept.
 *
 * Windows: a real AppBar (SHAppBarMessage), so other windows maximise around us instead of under
 * us. Linux/X11: `_NET_WM_STRUT_PARTIAL`, which is what the window manager reads for the same
 * purpose. Wayland has no equivalent a normal app may use, so there the window is only positioned.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserWindow, Rectangle } from "electron";
import { screen } from "electron";

import type { DockConfig, DockEdge } from "../core/types.js";

const run = promisify(execFile);

/** ABE_* values Windows expects, by edge name. */
const ABE = { left: 0, top: 1, right: 2, bottom: 3 } as const;
const ABM = { new: 0, remove: 1, queryPos: 2, setPos: 3 } as const;
const APPBAR_CALLBACK_MESSAGE = 0x8000 + 1;      // WM_APP + 1: we never read it, it just must be set
/** How long the shell is allowed to argue about the placement before a move means the user. */
const SETTLE_MS = 1500;
/** A docked band is a strip, not a window: its own minimum size must not fight the thickness. */
const BAND_MINIMUM = 60;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
// Without this, Chromium sees WM_WINDOWPOSCHANGING and drags the window back inside the work
// area — the very area the reservation just took away, so the band could never be filled.
const SWP_NOSENDCHANGING = 0x0400;

export interface DockPlacement {
  bounds: Rectangle;
  /** What the window actually got — smaller than asked means the platform refused. */
  applied: Rectangle;
  note: string | null;
}

/** The band `percent` of the way along `edge` inside `area`. */
export function bandRect(area: Rectangle, edge: DockEdge, percent: number): Rectangle {
  const thickness = Math.max(1, Math.round((edge === "left" || edge === "right" ? area.width : area.height) * percent / 100));
  if (edge === "top") return { x: area.x, y: area.y, width: area.width, height: thickness };
  if (edge === "bottom") return { x: area.x, y: area.y + area.height - thickness, width: area.width, height: thickness };
  if (edge === "left") return { x: area.x, y: area.y, width: thickness, height: area.height };
  return { x: area.x + area.width - thickness, y: area.y, width: thickness, height: area.height };
}

export function bandThickness(rect: Rectangle, edge: DockEdge): number {
  return edge === "left" || edge === "right" ? rect.width : rect.height;
}

/** Monitor the config points at, falling back to the primary one and saying which is missing. */
export function pickDisplay(device: string | null): { display: Electron.Display; missing: string | null } {
  const displays = screen.getAllDisplays();
  const wanted = device ? displays.find((d) => String(d.id) === device || d.label === device) : undefined;
  if (wanted) return { display: wanted, missing: null };
  return { display: screen.getPrimaryDisplay(), missing: device };
}

interface AppBarData {
  cbSize: number;
  hWnd: number;
  uCallbackMessage: number;
  uEdge: number;
  rc: { left: number; top: number; right: number; bottom: number };
  lParam: number;
}

interface Win32Api {
  /** koffi writes the shell's answer back into `data`, which is what QUERYPOS is for. */
  SHAppBarMessage: (message: number, data: AppBarData) => number;
  /** Physical-pixel placement. Electron's setBounds speaks DIP and keeps the window out of the
   *  work area it just shrank; an appbar has to sit in exactly the rectangle it reserved. */
  setWindowPos: (hwnd: number, rect: Rectangle) => void;
  make: (hwnd: number, edge: number, rect?: Rectangle) => AppBarData;
}

let win32: Win32Api | null = null;

/**
 * Bind the two shell calls an AppBar needs. Loaded lazily and never on Linux, so a missing native
 * dependency degrades to "no docking" instead of stopping the app from starting.
 */
function loadWin32(): Win32Api | null {
  if (win32) return win32;
  if (process.platform !== "win32") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const shell32 = koffi.load("shell32.dll");
    const user32 = koffi.load("user32.dll");
    const RECT = koffi.struct("RECT", { left: "long", top: "long", right: "long", bottom: "long" });
    // hWnd as an integer, not a pointer type: the value IS the handle, and koffi marshals intptr
    // straight through — which also keeps the struct layout right on both 32- and 64-bit.
    const APPBARDATA = koffi.struct("APPBARDATA", {
      cbSize: "uint32", hWnd: "intptr", uCallbackMessage: "uint32", uEdge: "uint32", rc: RECT, lParam: "intptr",
    });
    // The convention belongs in koffi's FIRST argument; written inside a prototype string it is
    // rejected with "Unknown or invalid type name '__stdcall'" and the whole binding is lost.
    const SHAppBarMessage = shell32.func("__stdcall", "SHAppBarMessage", "uintptr_t", [
      "uint32_t", koffi.inout(koffi.pointer(APPBARDATA)),
    ]);
    const SetWindowPos = user32.func("__stdcall", "SetWindowPos", "bool", [
      "intptr", "intptr", "int", "int", "int", "int", "uint32",
    ]);
    win32 = {
      SHAppBarMessage: (message, data) => Number(SHAppBarMessage(message, data)),
      setWindowPos: (hwnd, rect) =>
        void SetWindowPos(hwnd, 0, rect.x, rect.y, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING),
      make: (hwnd, edge, rect) => ({
        cbSize: koffi.sizeof(APPBARDATA),
        hWnd: hwnd,
        uCallbackMessage: APPBAR_CALLBACK_MESSAGE,
        uEdge: edge,
        rc: rect
          ? { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
          : { left: 0, top: 0, right: 0, bottom: 0 },
        lParam: 0,
      }),
    };
    return win32;
  } catch (error) {
    // Worth saying out loud: without this binding the window still moves, but nothing is reserved,
    // and "other windows cover the band" is exactly the symptom that follows.
    console.error("[hangar] AppBar unavailable:", (error as Error).message);
    return null;
  }
}

/** The window handle as the number Win32 wants. */
function nativeHandle(window: BrowserWindow): number {
  const buffer = window.getNativeWindowHandle();
  return buffer.length === 8 ? Number(buffer.readBigUInt64LE(0)) : buffer.readUInt32LE(0);
}

export class Dock {
  private registered = false;
  private current: DockConfig | null = null;
  /**
   * The handle the AppBar was registered with, kept separately from the window.
   *
   * Removal has to work while the window is closing, and by then `getNativeWindowHandle()` may
   * already throw — a reservation released with the wrong handle, or not at all, leaves the
   * desktop permanently short of that band.
   */
  private hwnd = 0;
  /** The physical rectangle the shell was told to keep free, for the placement report. */
  private reserved: Rectangle | null = null;
  /** The window's normal minimum, restored when the band is given up. */
  private readonly minimum: number[];
  /** Set while we are the ones moving the window, so re-asserting the band cannot recurse. */
  private placing = false;
  /**
   * How long after a placement a move still counts as the system's doing rather than the user's.
   *
   * Windows nudges an appbar out of the work area right after it is placed, so the band has to be
   * re-asserted; but a drag or a resize a second later is the user asking for their window back,
   * and the answer to that is to give the edge up, not to snap the window into place again.
   */
  private assertUntil = 0;
  /** Told when a user move undocked us, so the setting and the screen can agree. */
  onUserUndock: (() => void) | null = null;

  constructor(private readonly window: BrowserWindow) {
    this.minimum = window.getMinimumSize();
    // Windows moves an appbar out of the work area it just shrank — and does it after the call
    // returns, so the only reliable answer is to put the band back whenever something moves it.
    const reassert = (): void => {
      if (this.placing || !this.reserved || !this.registered) return;
      const current = this.window.getBounds();
      const want = screen.screenToDipRect(this.window, this.reserved);
      if (current.x === want.x && current.y === want.y
        && current.width === want.width && current.height === want.height) return;
      if (Date.now() > this.assertUntil) {
        void this.release().then(() => this.onUserUndock?.());
        return;
      }
      this.place(this.reserved);
    };
    window.on("move", reassert);
    window.on("resize", reassert);
  }

  /** Put the window exactly on `rect` (physical pixels), without anyone second-guessing it. */
  private place(rect: Rectangle): void {
    const api = process.platform === "win32" ? loadWin32() : null;
    this.placing = true;
    try {
      if (api) api.setWindowPos(nativeHandle(this.window), rect);
      else this.window.setBounds(rect);
    } finally {
      this.placing = false;
    }
  }

  get isDocked(): boolean {
    return this.current?.enabled === true;
  }

  /** Place the window in its band and reserve that space; returns what actually happened. */
  async apply(config: DockConfig): Promise<DockPlacement> {
    const { display, missing } = pickDisplay(config.device);
    const band = bandRect(display.workArea, config.edge, config.percent);
    this.current = config;

    // Before anything is placed: a 15 % band is thinner than the window's usual minimum height, and
    // Windows enforces that minimum, which would leave the window overlapping its own reservation.
    this.window.setMinimumSize(BAND_MINIMUM, BAND_MINIMUM);

    let note = missing ? `Saved monitor ${missing} is not connected — using ${display.label}.` : null;
    if (process.platform === "win32") note = this.reserveWindows(band, config.edge) ?? note;
    else note = (await this.reserveX11(band, config.edge, display.bounds)) ?? note;

    // Set the bounds AFTER reserving: SETPOS can slide the band away from the taskbar, and the
    // window has to land where the reservation actually is, not where it was asked for.
    // Straight to the shell in physical pixels. Going through setBounds pushes the window out of
    // the work area the reservation just shrank, leaving the band empty and the window beside it.
    this.assertUntil = Date.now() + SETTLE_MS;
    this.place(this.reserved ?? band);
    const target = this.reserved && process.platform === "win32"
      ? screen.screenToDipRect(this.window, this.reserved)
      : band;
    const applied = this.window.getBounds();
    return { bounds: target, applied, note };
  }

  /**
   * Give the Windows reservation back, without awaiting anything.
   *
   * This runs on the window's `close`, where a promise would not be waited for: Electron does not
   * await event listeners, so an async removal races the process exit and loses.
   */
  releaseSync(): void {
    if (process.platform !== "win32" || !this.registered) return;
    const api = loadWin32();
    if (!api) return;
    api.SHAppBarMessage(ABM.remove, api.make(this.hwnd, ABE.top));
    this.registered = false;
    this.reserved = null;
    this.current = null;
    this.restoreMinimum();
  }

  /** Undocked, the window is a window again — including how small it may be made. */
  private restoreMinimum(): void {
    if (this.window.isDestroyed()) return;
    this.window.setMinimumSize(this.minimum[0] ?? 1, this.minimum[1] ?? 1);
  }

  /** Give the space back; safe to call when nothing was reserved. */
  async release(): Promise<void> {
    this.releaseSync();
    if (process.platform !== "win32") {
      await this.clearX11();
      this.restoreMinimum();
    }
    this.current = null;
  }

  private reserveWindows(band: Rectangle, edge: DockEdge): string | null {
    const api = loadWin32();
    if (!api) return "Docking without reserving space — the native helper did not load.";
    const hwnd = nativeHandle(this.window);
    // Electron speaks DIP; the shell speaks physical pixels. On a scaled display the difference is
    // the whole point: a 20 % band asked for in DIP reserves 16 % of the screen at 125 %.
    const physical = screen.dipToScreenRect(this.window, band);

    if (!this.registered) {
      api.SHAppBarMessage(ABM.new, api.make(hwnd, ABE[edge]));
      this.registered = true;
      this.hwnd = hwnd;
    }
    // QUERYPOS slides the band clear of the taskbar and any other appbar, but does not preserve
    // thickness — restore it before SETPOS or the band grows into whatever room it was offered.
    const query = api.make(hwnd, ABE[edge], physical);
    api.SHAppBarMessage(ABM.queryPos, query);
    const offered = {
      x: query.rc.left, y: query.rc.top,
      width: query.rc.right - query.rc.left, height: query.rc.bottom - query.rc.top,
    };
    const kept = keepThickness(offered, physical, edge);
    api.SHAppBarMessage(ABM.setPos, api.make(hwnd, ABE[edge], kept));
    this.reserved = kept;
    return null;
  }

  /** X11 struts: the same reservation, expressed the way a Linux window manager reads it. */
  private async reserveX11(band: Rectangle, edge: DockEdge, screenBounds: Rectangle): Promise<string | null> {
    if (process.env["WAYLAND_DISPLAY"]) {
      return "Wayland does not let an application reserve screen space — the window is only positioned.";
    }
    const id = `0x${nativeHandle(this.window).toString(16)}`;
    const strut = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (edge === "left") { strut[0] = band.width; strut[4] = band.y; strut[5] = band.y + band.height; }
    if (edge === "right") { strut[1] = band.width; strut[6] = band.y; strut[7] = band.y + band.height; }
    if (edge === "top") { strut[2] = band.height; strut[8] = band.x; strut[9] = band.x + band.width; }
    if (edge === "bottom") { strut[3] = band.height; strut[10] = band.x; strut[11] = band.x + band.width; }
    void screenBounds;
    try {
      await run("xprop", ["-id", id, "-f", "_NET_WM_STRUT_PARTIAL", "32c", "-set", "_NET_WM_STRUT_PARTIAL", strut.join(", ")]);
      return null;
    } catch {
      return "xprop is not available — the window is positioned but no space is reserved.";
    }
  }

  private async clearX11(): Promise<void> {
    if (process.env["WAYLAND_DISPLAY"]) return;
    const id = `0x${nativeHandle(this.window).toString(16)}`;
    try {
      await run("xprop", ["-id", id, "-remove", "_NET_WM_STRUT_PARTIAL"]);
    } catch {
      /* nothing was set */
    }
  }
}

/** Keep `band`'s thickness on `edge` while taking the position the platform offered. */
export function keepThickness(offered: Rectangle, band: Rectangle, edge: DockEdge): Rectangle {
  const thickness = bandThickness(band, edge);
  if (edge === "top") return { ...offered, height: thickness };
  if (edge === "bottom") return { ...offered, y: offered.y + offered.height - thickness, height: thickness };
  if (edge === "left") return { ...offered, width: thickness };
  return { ...offered, x: offered.x + offered.width - thickness, width: thickness };
}

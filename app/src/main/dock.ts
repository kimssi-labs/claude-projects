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
import { nativeHandle, type WindowChrome } from "./chrome.js";

const run = promisify(execFile);

/** ABE_* values Windows expects, by edge name. */
const ABE = { left: 0, top: 1, right: 2, bottom: 3 } as const;
const ABM = { new: 0, remove: 1, queryPos: 2, setPos: 3 } as const;
const APPBAR_CALLBACK_MESSAGE = 0x8000 + 1;      // WM_APP + 1: we never read it, it just must be set
/** Long enough for Chromium to notice the window is on a monitor with a different scale factor. */
const DPI_SETTLE_MS = 80;
/** How long the shell is allowed to argue about the placement before a move means the user. */
const SETTLE_MS = 1500;
/** A docked band is a strip, not a window: its own minimum size must not fight the thickness. */
const BAND_MINIMUM = 60;
/**
 * DWM attributes that decide what Windows 11 paints around a window.
 *
 * Measured on a docked band: the top row, the bottom row and about three columns at each side were
 * the desktop showing through — the 1 px border and the rounded corners. Against a screen edge that
 * reads as the band not quite fitting, and anything behind it glows through the gap.
 */
/** The rectangle DWM actually paints, which is inside the window's own by the invisible border. */
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
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

/** A band of exactly `thickness` pixels, flush against `edge` of `area`. */
export function bandOfThickness(area: Rectangle, edge: DockEdge, thickness: number): Rectangle {
  const deep = Math.max(1, Math.round(thickness));
  if (edge === "top") return { x: area.x, y: area.y, width: area.width, height: deep };
  if (edge === "bottom") return { x: area.x, y: area.y + area.height - deep, width: area.width, height: deep };
  if (edge === "left") return { x: area.x, y: area.y, width: deep, height: area.height };
  return { x: area.x + area.width - deep, y: area.y, width: deep, height: area.height };
}

/** The band `percent` of the way along `edge` inside `area`. */
export function bandRect(area: Rectangle, edge: DockEdge, percent: number): Rectangle {
  const span = edge === "left" || edge === "right" ? area.width : area.height;
  return bandOfThickness(area, edge, span * percent / 100);
}

/**
 * The one side of a docked band that is not against the screen edge.
 *
 * A band docked to the top occupies the whole width and is flush with three sides of the screen;
 * only its bottom is free. Dragging any of the other three cannot make a band — it can only pull
 * the window off the edge it is reserving.
 */
export const OPEN_FACE: Record<DockEdge, string> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/**
 * Whether a resize that grabbed `grabbed` is one a band docked to `edge` should accept.
 *
 * Only the open face, and only on its own: a corner grip ("bottom-left") moves two sides at once,
 * one of which is pinned to the screen.
 */
export function resizeAllowed(edge: DockEdge | undefined, grabbed: string | undefined): boolean {
  if (!edge) return true;                       // not docked: an ordinary window resizes anywhere
  return grabbed === OPEN_FACE[edge];
}

export function bandThickness(rect: Rectangle, edge: DockEdge): number {
  return edge === "left" || edge === "right" ? rect.width : rect.height;
}

/**
 * How many physical pixels make a whole number of DIP at `scale` — the period of the DIP grid.
 *
 * 1 at 100 %; 5 at 125 % (four DIP); 3 at 150 %; 7 at 175 %; 2 at 200 %. Only positions that are a
 * multiple of this from the monitor's origin are whole in both units.
 */
export function gridStep(scale: number): number {
  for (let dip = 1; dip <= 64; dip += 1) {
    const px = dip * scale;
    if (Math.abs(px - Math.round(px)) < 1e-6) return Math.round(px);
  }
  return 1;                                        // an odd scale: give up on alignment rather than fail
}

/**
 * The window that shows `band`: the same size, `lift` rows higher.
 *
 * At a fractional scale, everything a window draws lands a whole DIP below where the window is —
 * measured at 125 % as two rows, at every position tried, on and off the DIP grid: a band docked to
 * the bottom showed the desktop through its top two rows and painted its bottom two under the
 * taskbar, border and page alike shifted down together. Zero at 100 %, and zero for a window whose
 * top is the screen's own. So the window is placed those rows above the band it shows: the shifted
 * drawing then covers the band exactly, and the rows the window does not draw sit over the work
 * area, where nothing of ours is missing.
 */
export function windowFor(band: Rectangle, lift: number): Rectangle {
  return lift ? { ...band, y: band.y - lift } : band;
}

/** The band a window shows, given how far down it draws. */
export function bandOf(window: Rectangle, lift: number): Rectangle {
  return lift ? { ...window, y: window.y + lift } : window;
}

/**
 * How many rows below its own rectangle a window draws on a display of `scale`, when its top is not
 * the screen's: the one DIP of frame room Chromium keeps at a fractional scale, as whole rows.
 *
 * Measured two at 125 % — at every position tried, on and off the DIP grid — and none at 100 %; other
 * fractional scales are assumed to keep the same one DIP. Decided from the scale and NOT read back
 * from the window: `getBounds()` against `getContentBounds()` said one DIP or none for the very same
 * shifted window depending on when it was asked, and a band placed on the wrong answer showed
 * whatever was behind it through its top two rows.
 */
export function insetFor(scale: number): number {
  return Number.isInteger(scale) ? 0 : Math.ceil(scale);
}

/**
 * `band` (physical) with its open face moved inward until it sits on the DIP grid of the monitor
 * whose origin is `origin`.
 *
 * Electron pins the window's size in DIP and the shell places it in pixels; where the two are not
 * both whole numbers each one's rounding undoes the other's — measured at 125 % as a band that grew
 * back off its reservation by a pixel on the shell's next move. The three screen-facing edges sit
 * on the monitor's own edges and are on the grid by construction; only the open face can be off
 * it, so only the open face moves, and only inward: a band is never thicker than it was asked to
 * be. At 100 % the step is one pixel and this is the identity.
 */
export function snapToGrid(band: Rectangle, edge: DockEdge, origin: { x: number; y: number }, step: number): Rectangle {
  if (step <= 1) return band;
  const down = (v: number, from: number): number => from + Math.floor((v - from) / step) * step;
  const up = (v: number, from: number): number => from + Math.ceil((v - from) / step) * step;
  if (edge === "top") {
    const bottom = down(band.y + band.height, origin.y);
    return { ...band, height: Math.max(1, bottom - band.y) };
  }
  if (edge === "bottom") {
    const top = up(band.y, origin.y);
    return { ...band, y: top, height: Math.max(1, band.y + band.height - top) };
  }
  if (edge === "left") {
    const right = down(band.x + band.width, origin.x);
    return { ...band, width: Math.max(1, right - band.x) };
  }
  const left = up(band.x, origin.x);
  return { ...band, x: left, width: Math.max(1, band.x + band.width - left) };
}

/**
 * A name for a monitor that is the same on the next run.
 *
 * Electron's `display.id` is NOT: measured here, the same two monitors were 2043045714 and
 * 2636662435 one run and 3621328712 and 456769406 the next — which is why a dock saved for the
 * second monitor quietly came back on the first. Where it is and how big it is does not change
 * unless the monitors really do.
 */
export function displayKey(display: Electron.Display): string {
  const { x, y, width, height } = display.bounds;
  return `${x},${y} ${width}x${height}`;
}

/**
 * A name for the whole set of attached monitors.
 *
 * Sorted, so the same three screens are the same setup whichever order Windows enumerates them in.
 * Docking is remembered against this as well as against each monitor: the screen you dock to at
 * your desk is not the one you dock to on the laptop alone.
 */
export function setupKey(displays: Electron.Display[] = screen.getAllDisplays()): string {
  return displays.map(displayKey).sort().join(" + ");
}

/** Where a display sits, as a looser fallback for a monitor that was resized but not moved. */
export function displayOrigin(display: Electron.Display): string {
  return `${display.bounds.x},${display.bounds.y}`;
}

/**
 * Monitor the config points at, falling back to the primary one and saying which is missing.
 *
 * Keys are tried most specific first: the stable key, then an id from an older config, then the
 * device name, then just the position. A saved dock that silently moves to the primary display is
 * the confusing kind of wrong.
 */
export function pickDisplay(device: string | null): { display: Electron.Display; missing: string | null } {
  const displays = screen.getAllDisplays();
  const wanted = device
    ? displays.find((d) => displayKey(d) === device)
      ?? displays.find((d) => String(d.id) === device)          // configs written before the key
      ?? displays.find((d) => d.label && d.label === device)
      ?? displays.find((d) => displayOrigin(d) === device)
    : undefined;
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
  /**
   * The same call on a worker thread.
   *
   * Registering or removing an appbar makes the shell change the desktop work area and tell every
   * top-level window about it, waiting on each — measured at 300-400 ms on an idle desktop and far
   * worse with a lot of windows open. On the main thread that is the window going grey.
   */
  SHAppBarMessageAsync: (message: number, data: AppBarData) => Promise<number>;
  /** Physical-pixel placement. Electron's setBounds speaks DIP and keeps the window out of the
   *  work area it just shrank; an appbar has to sit in exactly the rectangle it reserved. */
  setWindowPos: (hwnd: number, rect: Rectangle) => void;
  /**
   * The window's rectangle, the part of it Windows paints, and the part the page fills — physical.
   *
   * Three rectangles, one inside the next. A window carries an invisible resize border — measured
   * here at seven pixels left, right and bottom — that belongs to the window but shows the desktop
   * through; Electron 33 painted to the outer edge anyway, 43 paints only inside it. And since 43
   * the client area sits inside the painted frame by one more pixel on those three sides: the room
   * for the system's 1 px border, which a docked band switches off — so that pixel too was the
   * desktop, showing as a thin line along the band. The page is the band: it is the client area
   * that has to land on the reservation.
   */
  frames: (hwnd: number) => { outer: Rectangle; painted: Rectangle; client: Rectangle } | null;
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
    const dwmapi = koffi.load("dwmapi.dll");
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
    const GetWindowRect = user32.func("__stdcall", "GetWindowRect", "bool", [
      "intptr", koffi.out(koffi.pointer(RECT)),
    ]);
    const POINT = koffi.struct("POINT", { x: "long", y: "long" });
    const GetClientRect = user32.func("__stdcall", "GetClientRect", "bool", [
      "intptr", koffi.out(koffi.pointer(RECT)),
    ]);
    const ClientToScreen = user32.func("__stdcall", "ClientToScreen", "bool", [
      "intptr", koffi.inout(koffi.pointer(POINT)),
    ]);
    const DwmGetWindowAttribute = dwmapi.func("__stdcall", "DwmGetWindowAttribute", "int32", [
      "intptr", "uint32", koffi.out(koffi.pointer(RECT)), "uint32",
    ]);
    win32 = {
      SHAppBarMessage: (message, data) => Number(SHAppBarMessage(message, data)),
      SHAppBarMessageAsync: (message, data) => new Promise((resolve, reject) => {
        SHAppBarMessage.async(message, data, (error: Error | null, result: number | bigint) => {
          if (error) reject(error);
          else resolve(Number(result));               // koffi fills `data` before calling back
        });
      }),
      setWindowPos: (hwnd, rect) =>
        void SetWindowPos(hwnd, 0, rect.x, rect.y, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING),
      frames: (hwnd) => {
        // koffi fills the structs that are passed in, the same way SHAppBarMessage's is filled.
        const box = (rc: { left: number; top: number; right: number; bottom: number }): Rectangle =>
          ({ x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top });
        const outer = { left: 0, top: 0, right: 0, bottom: 0 };
        if (!GetWindowRect(hwnd, outer)) return null;
        const painted = { left: 0, top: 0, right: 0, bottom: 0 };
        // Non-zero means DWM has no answer — before the window is composited, for one. The outer
        // rectangle is then the best guess, and the corrections below become no-ops.
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, painted, 16) !== 0) {
          return { outer: box(outer), painted: box(outer), client: box(outer) };
        }
        // GetClientRect answers with a size only; its origin has to be asked for separately.
        const size = { left: 0, top: 0, right: 0, bottom: 0 };
        const origin = { x: 0, y: 0 };
        const client = GetClientRect(hwnd, size) && ClientToScreen(hwnd, origin)
          ? { x: origin.x, y: origin.y, width: size.right, height: size.bottom }
          : box(painted);
        return { outer: box(outer), painted: box(painted), client };
      },
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
  /**
   * Set while our own SHAppBarMessage is running on its worker thread.
   *
   * The shell answers by moving every window on the desktop, ours included, and each of those moves
   * raises an event here. Acting on them — asking Windows about the window, placing it — while the
   * shell is still inside a call that talks to the same window took the process down. The placement
   * that follows the call puts the band where it belongs anyway.
   */
  private reserving = false;
  /** The window's normal minimum, restored when the band is given up. */
  private readonly minimum: number[];
  /** The lift the current band was placed with: `insetFor` its display, or zero on the screen's top. */
  private lift = 0;
  /** Set while we are the ones moving the window, so re-asserting the band cannot recurse. */
  private placing = false;
  /**
   * Set while the user is dragging the band's grip.
   *
   * Re-asserting exists to undo what the shell does to a band behind our back, and it puts the
   * window back to the last RESERVED rectangle. Mid-drag that rectangle is the size the band had
   * before the drag started, so every preview was immediately undone: a 120 px drag on a left-hand
   * band moved it 48 px, the few steps that happened to land between two corrections.
   */
  private dragging = false;
  /** Undocked work area per display, captured while nothing of ours was reserved. */
  private readonly baseAreas = new Map<string, Rectangle>();
  /**
   * How long after a placement a move still counts as the system's doing rather than the user's.
   *
   * Windows nudges an appbar out of the work area right after it is placed, so the band has to be
   * re-asserted; but a drag or a resize a second later is the user asking for their window back,
   * and the answer to that is to give the edge up, not to snap the window into place again.
   */
  private assertUntil = 0;
  /** Told when we let go of the edge, so the setting and the screen can agree. */
  onUserUndock: (() => void) | null = null;
  /**
   * Told when the user dragged the band's inner edge: the new thickness in DIP.
   *
   * Dragging that edge is the obvious way to ask for a different band size, so it sets the size
   * rather than undocking; dragging the window somewhere else still undocks.
   */
  onUserResize: ((thickness: number) => void) | null = null;

  /** `chrome` is the frame's look: told when the window is a band and when it is a window again. */
  constructor(private readonly window: BrowserWindow, private readonly chrome: WindowChrome) {
    this.minimum = window.getMinimumSize();
    // NOT on a work-area change: that is usually our own band, and forgetting the undocked area
    // because we just docked is how a 12 % band became a 26 % one.
    screen.on("display-metrics-changed", (_event, _display, changed) => {
      if (changed.some((metric) => metric !== "workArea")) this.baseAreas.clear();
    });
    screen.on("display-added", () => this.baseAreas.clear());
    screen.on("display-removed", () => this.baseAreas.clear());
    // Windows moves an appbar out of the work area it just shrank — and does it after the call
    // returns, so the only reliable answer is to put the band back whenever something moves it.
    const reassert = (): void => {
      if (this.placing || this.dragging || this.reserving || !this.reserved || !this.registered) return;
      // A minimised band is not a band out of place; it comes back where it was on restore. Putting
      // it back while minimised un-minimises it from inside our own SetWindowPos, and the `restore`
      // that fires inside that call was what nested a second native call (see chrome.ts) and
      // crashed the process (exit 0xC0000005, minimise then restore, 100 %).
      if (this.window.isMinimized()) return;
      // Asked of Windows, and compared against the reservation in the physical pixels both are
      // expressed in. Electron 43 answers getBounds() with the DWM visible frame instead of the
      // window rectangle, so it is short by the invisible resize border — seven or eight pixels a
      // side — and can never equal what setWindowPos was told. The comparison below would then
      // always fail, re-place the band, and be re-entered by the event that placement raises.
      const native = this.nativeRect();
      const current = native ?? this.window.getBounds();
      const want = native ? this.reserved : screen.screenToDipRect(null, this.reserved);
      if (current.x === want.x && current.y === want.y
        && current.width === want.width && current.height === want.height) return;
      if (Date.now() > this.assertUntil) {
        const edge = this.current?.edge;
        // Still spanning its whole edge? Then only the thickness changed, and that is a size.
        const alongEdge = edge && (edge === "left" || edge === "right"
          ? current.y === want.y && current.height === want.height
          : current.x === want.x && current.width === want.width);
        if (edge && alongEdge && this.onUserResize) {
          // The saved percentage is of a DIP work area, so the thickness handed back must be DIP.
          const dip = native ? screen.screenToDipRect(null, native) : current;
          this.onUserResize(bandThickness(dip, edge));
          return;
        }
        // Moved, not resized — dragged by its title bar, or maximised. A docked window is a band,
        // so it goes back to its band. Undocking is a deliberate act: restoring the window from
        // maximised, or the Undock button.
        this.place(this.reserved);
        return;
      }
      this.place(this.reserved);
    };
    // On the next turn of the loop: `move`/`resize` are emitted from inside Windows messages, which
    // can be inside one of our own native calls (chrome.ts explains the crash); the checks above
    // are made when it runs, so our own placement — `placing` is over by then — finds the window on
    // its reservation and does nothing.
    const reassertLater = (): void => { setImmediate(reassert); };
    window.on("move", reassertLater);
    window.on("resize", reassertLater);

    // Refusing the gesture beats undoing it. `reassert` above puts a dragged band back, but the
    // window has already moved by then, so the user sees it jump and return. These two events are
    // emitted before the window manager acts and only for a real drag, so nothing moves at all.
    window.on("will-move", (event) => {
      if (this.isDocked && !this.placing) event.preventDefault();
    });
    window.on("will-resize", (event, _newBounds, details) => {
      if (!this.isDocked || this.placing) return;
      if (!resizeAllowed(this.current?.edge, details?.edge)) event.preventDefault();
    });
  }

  /**
   * The band's own rectangle in physical pixels, or null off Windows (and if the binding did not
   * load).
   *
   * The only reading that can be compared with a reservation. Everything Electron reports is DIP,
   * and from 43 `getBounds()` is not even the window rectangle any more. The painted frame, which
   * is every pixel the window puts on the screen: the page is one pixel inside it on three sides,
   * and that pixel is the border — painted in the page's colour, so it belongs to the band.
   */
  private nativeRect(): Rectangle | null {
    if (process.platform !== "win32") return null;
    const painted = loadWin32()?.frames(nativeHandle(this.window))?.painted;
    return painted ? bandOf(painted, this.lift) : null;
  }

  /** Put the WINDOW exactly on `rect` (physical), without anyone second-guessing it. */
  private placeWindow(rect: Rectangle): void {
    const api = process.platform === "win32" ? loadWin32() : null;
    if (!api) {
      this.window.setBounds(rect);
      return;
    }
    const hwnd = nativeHandle(this.window);
    // `rect` is where the band has to APPEAR. SetWindowPos takes the window's own rectangle, which
    // is bigger by the invisible resize border, so asking for the band exactly leaves the painted
    // edge seven pixels inside it and the desktop showing through. Grow the request by that
    // difference. Where the runtime paints to the outer edge the difference is zero and this is
    // the old call.
    //
    // The painted frame and not the client area: the client is one pixel further in on three
    // sides, and placing by it would push the border that pixel OUT of the band — over the
    // desktop, and over the neighbouring monitor for a band docked against a shared edge.
    const f = api.frames(hwnd);
    api.setWindowPos(hwnd, f ? {
      x: rect.x - (f.painted.x - f.outer.x),
      y: rect.y - (f.painted.y - f.outer.y),
      width: rect.width + (f.outer.width - f.painted.width),
      height: rect.height + (f.outer.height - f.painted.height),
    } : rect);
  }

  /**
   * Show the band `band` (physical pixels): the window goes `lift` rows above it, so that what it
   * draws begins exactly at the band's top.
   */
  private place(band: Rectangle): void {
    this.placing = true;
    try {
      this.placeWindow(windowFor(band, this.lift));
    } finally {
      this.placing = false;
    }
  }

  /**
   * Pin the window's size to the band's, in DIP, so nothing the shell does to the window changes it.
   *
   * A docked window is not resizable, and Electron implements that on a frameless window by setting
   * the minimum and maximum size to the current one. Left alone that is the size the window had
   * BEFORE it was docked; this keeps it at the size the band is about to have.
   */
  private fixSize(band: Rectangle): void {
    const width = Math.max(BAND_MINIMUM, Math.round(band.width));
    const height = Math.max(BAND_MINIMUM, Math.round(band.height));
    this.window.setMinimumSize(width, height);
    this.window.setMaximumSize(width, height);
  }

  get isDocked(): boolean {
    return this.current?.enabled === true;
  }

  /**
   * The display's work area as if we were not docked to it.
   *
   * `display.workArea` already excludes our own band, so sizing a band from it shrinks the band
   * every time it is applied: 20 % of a work area that is itself 20 % smaller.
   *
   * The undocked area is REMEMBERED rather than reconstructed. Reconstructing it — adding our own
   * band back — races the shell: Electron's copy of the work area updates a moment after SETPOS, so
   * a second apply could add a new band back to an area that still had the old one taken out. On a
   * 125 % display that turned a 12 % band into a 132 px one where 112 px was right.
   */
  workArea(display: Electron.Display): Rectangle {
    const key = displayKey(display);
    const seen = this.baseAreas.get(key);
    if (!this.registered) {
      // Nothing of ours is reserved, so what the display reports is the undocked area — unless it
      // is smaller than something already seen, which means Electron has not caught up with a
      // release yet. A work area only shrinks because something reserved space, so the largest
      // reading is the honest one, and a stale small reading heals itself on the next look.
      const area = display.workArea;
      if (!seen || area.width * area.height >= seen.width * seen.height) {
        this.baseAreas.set(key, area);
        return area;
      }
    }
    return seen ?? display.workArea;
  }

  /** Place the window in its band and reserve that space; returns what actually happened. */
  async apply(config: DockConfig): Promise<DockPlacement> {
    const { display, missing } = pickDisplay(config.device);
    // Measured against the undocked work area, so 20 % means the same thing every time it is asked
    // for — not 20 % of whatever is left after the last band.
    const asked = bandRect(this.workArea(display), config.edge, config.percent);
    const band = this.plan(asked, config.edge, display);
    this.current = config;

    // A band IS the window at its full extent: there is nothing left to maximise into, and it may
    // not be dragged off its edge. Snapping it back on every move event fought the window manager's
    // own drag loop; refusing the move outright is what actually keeps the band on its edge.
    if (this.window.isMaximized()) this.window.unmaximize();
    this.window.setMaximizable(false);
    this.window.setMovable(false);
    // Not resizable either. Windows draws the resize cursor from the frame, for every side at once —
    // there is no per-edge control — so the only way to stop three sides offering a resize that
    // cannot happen is to stop the frame resizing, and put a grip in the page for the fourth.
    this.window.setResizable(false);
    // …which on a frameless window pins the minimum AND maximum size to whatever the window measured
    // at that moment — the undocked window. Our own placements slip past that (SWP_NOSENDCHANGING),
    // but the shell's do not: every time it moved the appbar, Windows clamped it back to that stale
    // size — a 1180 × 760 window flashing over the desktop and the band snapping to its old
    // thickness. The pin has to say what the band is about to be.
    this.fixSize(band.dip);
    this.chrome.flush(true);                        // a band's frame: square, border in the page's colour

    // Move to the target monitor BEFORE reserving anything.
    //
    // The placement below uses SWP_NOSENDCHANGING, which is what stops Chromium dragging the window
    // back out of its own band — but it also means Chromium never learns it changed monitors, and
    // on a display with a different scale factor it then reports and lays out at the old one. A
    // normal move first, while nothing is reserved and nothing will clamp it, teaches it the DPI.
    const currentDisplay = screen.getDisplayMatching(this.window.getBounds());
    if (currentDisplay.id !== display.id) {
      this.window.setBounds(band.dip);
      await new Promise((resolve) => setTimeout(resolve, DPI_SETTLE_MS));
    }

    // The settle window opens BEFORE the reservation, not after it — `resizeTo` has always done it
    // this way. Reserving takes the best part of half a second and moves every window on the
    // desktop, ours included, so `reassert` runs while the window is still the old band and
    // `this.reserved` is already the new one. Both bands span the same edge, so it reads that as
    // the user having dragged the thickness, and answers a request for 20 % by saving back 12 %.
    this.assertUntil = Date.now() + SETTLE_MS;
    this.lift = band.lift;
    let note = missing ? `Saved monitor ${missing} is not connected — using ${display.label}.` : null;
    if (process.platform === "win32") note = (await this.reserveWindows(band.band, config.edge, display)) ?? note;
    else note = (await this.reserveX11(band.dip, config.edge, display.bounds)) ?? note;

    // Set the bounds AFTER reserving: SETPOS can slide the band away from the taskbar, and the
    // window has to land where the reservation actually is, not where it was asked for.
    // Straight to the shell in physical pixels. Going through setBounds pushes the window out of
    // the work area the reservation just shrank, leaving the band empty and the window beside it.
    this.assertUntil = Date.now() + SETTLE_MS;
    this.place(this.reserved ?? band.band);
    const target = this.reserved && process.platform === "win32"
      ? screen.screenToDipRect(null, this.reserved)
      : band.dip;
    // The band as it really is, in DIP because the caller measures it against a DIP work area to
    // learn the floor. Taken from Windows and converted, not from getBounds(), which since
    // Electron 43 reports the visible frame and would under-measure the band by the border.
    const here = this.nativeRect();
    const applied = here ? screen.screenToDipRect(null, here) : this.window.getBounds();
    return { bounds: target, applied, note };
  }

  /**
   * Re-reserve the edge at the size the band already has, leaving the window where it is.
   *
   * The alternative — re-applying the dock — recomputes the band from a percentage rounded to a
   * whole number, so a drag settled at 487 px was answered by placing the window at 480: the band
   * visibly jumped once, at the end of every resize. One percent of a tall screen is twenty pixels.
   * The shell only needs to be told the new extent; the window is already correct.
   */
  /**
   * Move the band to a new thickness without telling the shell — for a drag in progress.
   *
   * Reserving costs the best part of half a second (the shell notifies every top-level window), so
   * doing it per mouse-move would make the grip unusable. The reservation is updated once, on
   * release, by `resizeTo`.
   */
  preview(thickness: number): void {
    const config = this.current;
    if (!config?.enabled) return;
    const { display } = pickDisplay(config.device);
    const band = this.plan(bandOfThickness(this.workArea(display), config.edge, thickness), config.edge, display);
    this.dragging = true;
    this.lift = band.lift;
    this.fixSize(band.dip);
    this.place(band.band);
  }

  async resizeTo(thickness: number): Promise<void> {
    const config = this.current;
    this.dragging = false;                        // the hand is off; re-asserting may resume
    if (!config?.enabled) return;
    const { display } = pickDisplay(config.device);
    // Anchored to the edge, at exactly the thickness the drag ended on — not at a rounded
    // percentage of it, and not wherever the shell would rather put it.
    const band = this.plan(bandOfThickness(this.workArea(display), config.edge, thickness), config.edge, display);
    this.assertUntil = Date.now() + SETTLE_MS;
    this.lift = band.lift;
    this.fixSize(band.dip);
    if (process.platform === "win32") await this.reserveWindows(band.band, config.edge, display, false);
    else await this.reserveX11(band.dip, config.edge, display.bounds);
    // Physical against physical where Windows can be asked, for the same reason `reassert` does it:
    // Electron's idea of the window's rectangle no longer is the window's rectangle.
    const native = this.reserved ? this.nativeRect() : null;
    const want = native ? this.reserved as Rectangle
      : this.reserved && process.platform === "win32" ? screen.screenToDipRect(null, this.reserved)
        : band.dip;
    const now = native ?? this.window.getBounds();
    // Only if the shell put the reservation somewhere else — otherwise nothing moves at all.
    if (want.x !== now.x || want.y !== now.y || want.width !== now.width || want.height !== now.height) {
      this.place(this.reserved ?? band.band);
    }
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

  /** Undocked, the window is a window again — including how small and how large it may be made. */
  private restoreMinimum(): void {
    if (this.window.isDestroyed()) return;
    this.window.setMinimumSize(this.minimum[0] ?? 1, this.minimum[1] ?? 1);
    this.window.setMaximumSize(0, 0);                 // no maximum: the pin above was the band's
    this.window.setMaximizable(true);
    this.window.setMovable(true);
    this.window.setResizable(true);
    this.chrome.flush(false);
  }

  /** Give the space back; safe to call when nothing was reserved. */
  async release(): Promise<void> {
    if (process.platform === "win32") {
      const api = this.registered ? loadWin32() : null;
      if (api) {
        const hwnd = this.hwnd;
        this.registered = false;                    // nothing may re-enter while the shell works
        this.reserved = null;
        await api.SHAppBarMessageAsync(ABM.remove, api.make(hwnd, ABE.top));
      }
      this.restoreMinimum();
    } else {
      await this.clearX11();
      this.restoreMinimum();
    }
    this.current = null;
  }

  /**
   * `band` (DIP, as asked for) as what will actually be reserved and placed.
   *
   * Electron speaks DIP; the shell speaks physical pixels. On a scaled display the difference is the
   * whole point: a 20 % band asked for in DIP reserves 16 % of the screen at 125 %. The window is
   * deliberately NOT the reference: dipToScreenRect(window, …) scales by the display the WINDOW is
   * on, so docking from a 100 % monitor onto a 125 % one used the wrong scale. The physical rectangle
   * is then snapped so every edge is a whole pixel in both units (see `snapToGrid`), and handed back
   * with its own DIP reading — the size the window is pinned to has to be THAT one: pinned to the
   * band as asked for, the shell's next move grew the window back off the grid by the difference.
   */
  private plan(band: Rectangle, edge: DockEdge, display: Electron.Display): { window: Rectangle; band: Rectangle; dip: Rectangle; lift: number } {
    if (process.platform !== "win32") return { window: band, band, dip: band, lift: 0 };
    const monitor = screen.dipToScreenRect(null, display.bounds);
    // The band is what is reserved and what is seen; the window that shows it sits `lift` rows above
    // — except against the top of the screen, where the window draws where it is (measured), and
    // where a lifted window would start above the monitor.
    const snapped = snapToGrid(screen.dipToScreenRect(null, band), edge, monitor, gridStep(display.scaleFactor));
    const lift = snapped.y === monitor.y ? 0 : insetFor(display.scaleFactor);
    return { window: windowFor(snapped, lift), band: snapped, dip: this.dipOf(snapped, display), lift };
  }

  /**
   * A physical rectangle in DIP, with its SIZE divided by the scale factor rather than converted.
   *
   * Electron's own conversion is off by a pixel or two on this machine's 125 % monitor — it has the
   * monitor at 1202 px tall where Windows has 1200, and the work area ending at 1848 where Windows
   * ends it at 1846 — so a size that is a whole DIP in truth (135 px = 108 DIP) comes back as 109.
   * The window's size is pinned to this, and a pin one DIP off is what un-snapped the band. The
   * position only steers a cross-monitor move and may be approximate.
   */
  private dipOf(physical: Rectangle, display: Electron.Display): Rectangle {
    const where = screen.screenToDipRect(null, physical);
    return {
      x: where.x, y: where.y,
      width: Math.round(physical.width / display.scaleFactor),
      height: Math.round(physical.height / display.scaleFactor),
    };
  }

  /**
   * Reserve `physical` (already planned) with the shell, and remember what it actually reserved.
   *
   * The shell corrects the position to the real work area — the one Electron's copy is off from —
   * so the band is snapped again on the way out, and its size re-pinned if it changed.
   */
  private async reserveWindows(physical: Rectangle, edge: DockEdge, display: Electron.Display, ask = true): Promise<string | null> {
    const api = loadWin32();
    if (!api) return "Docking without reserving space — the native helper did not load.";
    const hwnd = nativeHandle(this.window);

    if (!this.registered) {
      await api.SHAppBarMessageAsync(ABM.new, api.make(hwnd, ABE[edge]));
      this.registered = true;
      this.hwnd = hwnd;
    }
    // QUERYPOS slides the band clear of the taskbar and any other appbar, but does not preserve
    // thickness — restore it before SETPOS or the band grows into whatever room it was offered.
    //
    // It is skipped when re-sizing an existing band. Measured here: with our own 580 px band already
    // reserved at the top of the screen, QUERYPOS answers a 680 px request with the free space
    // BELOW it — y = 499 — and the band walks down the screen by its own height on every resize.
    // The shell does not exclude the caller's own reservation, so on a resize the anchored rectangle
    // we already computed is the better answer, and SETPOS still adjusts it if it has to.
    let kept = physical;
    this.reserving = true;
    try {
      if (ask) {
        const query = api.make(hwnd, ABE[edge], physical);
        await api.SHAppBarMessageAsync(ABM.queryPos, query);
        const offered = {
          x: query.rc.left, y: query.rc.top,
          width: query.rc.right - query.rc.left, height: query.rc.bottom - query.rc.top,
        };
        // Anchored to the work area the shell knows, which is not quite the one Electron reports,
        // then back onto the grid — the move can have taken it off.
        const monitor = screen.dipToScreenRect(null, display.bounds);
        kept = snapToGrid(keepThickness(offered, physical, edge), edge, monitor, gridStep(display.scaleFactor));
      }
      // Written down BEFORE the call, not after it: anything that puts the band back while the shell
      // is at work must put it where the band is going, not where it was.
      this.reserved = kept;
      await api.SHAppBarMessageAsync(ABM.setPos, api.make(hwnd, ABE[edge], kept));
    } finally {
      this.reserving = false;
    }
    // The pin was set for the plan; if the shell settled on a different band, it has to say so.
    if (kept.width !== physical.width || kept.height !== physical.height) this.fixSize(this.dipOf(kept, display));
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

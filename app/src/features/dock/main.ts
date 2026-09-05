/**
 * Docking — the main side.
 *
 * The reservation itself (Windows AppBar, X11 struts) and the geometry are main/dock.ts's `Dock`.
 * This is the feature's edge: it owns the one `Dock` instance and everything main used to do around
 * it — applying a saved band at start-up, re-applying when monitors come and go, saving a dragged
 * thickness, and answering the settings screen. Whether the window is a band is pushed from here on
 * every change, so the caption button can never again show a state nobody told it about.
 *
 * It borrows the window from the shell and hands back to the shell the one thing that is the
 * shell's: giving an undocked window a window's shape (`placeFloating`).
 */
import { screen, type BrowserWindow } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { percentFloor } from "../../core/config.js";
import { DOCK_PERCENT } from "../../core/constants.js";
import type { DockConfig } from "../../core/types.js";
import type { WindowChrome } from "../../main/chrome.js";
import { bandRect, bandThickness, Dock, displayKey, pickDisplay, setupKey } from "../../main/dock.js";
import type { ActionResult, SettingsPayload } from "../../main/ipc.js";
import { dockContract, type DisplayInfo, type DockState } from "./contract.js";

/** How long a drag has to stop before its new thickness is written down. */
const DOCK_RESIZE_SETTLE_MS = 400;
/** A band within this many pixels of what was asked for counts as "the platform agreed". */
const FLOOR_SLACK_PX = 4;

/** What this feature needs from the rest of main. */
export interface DockDeps {
  /** The whole settings payload — several answers here carry it. */
  settingsPayload(): SettingsPayload;
  /** Tell the page the settings changed without being asked. */
  pushSettings(): void;
  /** Give an undocked window a window's shape and place, wholly on screen. The shell's. */
  placeFloating(): void;
  /** A line for the page about how start-up went — "saved monitor X is not connected", say. */
  appNote(text: string): void;
}

/** The settings-payload fields that are dock's. */
export interface DockSlice {
  dock: DockConfig;
  dockDevices: string[];
  dockFloor: number;
  minPercent: number;
}

/** What the rest of main may do with this feature once it is registered. */
export interface DockFeature {
  /** The window exists now: take it, and wire what a band listens to. */
  attach(window: BrowserWindow, chrome: WindowChrome): void;
  /** Apply the band this arrangement of monitors remembers, if any. After the first paint. */
  restore(): Promise<void>;
  isDocked(): boolean;
  /**
   * Maximise means fill the screen, and never the band: a docked window gives the edge back first,
   * so the two states cannot be held at once. It is placed as a window before it is maximised, so
   * the restore AFTER the maximise has a window shape to come back to.
   */
  undockForMaximize(): Promise<void>;
  /** Remember this band for the current arrangement of monitors, without applying it. */
  save(config: DockConfig): void;
  slice(): DockSlice;
  /** Give the reservation back synchronously — on close and on the way out. */
  releaseSync(): void;
  /**
   * On quit. Windows is already handled synchronously; X11 needs an `xprop` call, which does need
   * waiting for. Answers with what to await before quitting, or null when there is nothing.
   */
  releaseOnQuit(): Promise<void> | null;
}

export function register(ctx: MainContext, wire: Wire, deps: DockDeps): DockFeature {
  let dock: Dock | null = null;
  let resizeTimer: NodeJS.Timeout | null = null;
  let clearingStruts = false;

  const current = (): DockConfig => ctx.config.dock(null, setupKey());
  const state = (): DockState => ({ docked: dock?.isDocked === true, edge: current().edge });
  const emitState = (): void => wire.emit(dockContract.onDockState, state());

  /** Put the window in the band `wanted` describes, and report what the platform actually gave. */
  async function applyConfig(wanted: DockConfig): Promise<ActionResult & { settings?: SettingsPayload }> {
    if (!ctx.window() || !dock) return { ok: false, message: "No window." };
    const { display } = pickDisplay(wanted.device);
    // Apply exactly what was asked for. Forcing the percentage up to a previously measured floor
    // made the next measurement bigger again, and the floor climbed with it — 12 % became 26 %,
    // then 35 %. The floor is what the slider stops at, not what the band is set to.
    const applied: DockConfig = { ...wanted };
    ctx.config.saveDock(applied, setupKey());
    const placement = await dock.apply(applied);
    // What the window really got is the floor for this axis: remember it so the slider can stop
    // there. A band that came back the size it asked for proves there is no floor above it, which
    // is what un-learns a floor measured when something else was wrong.
    const got = bandThickness(placement.applied, applied.edge);
    const asked = bandThickness(bandRect(dock.workArea(display), applied.edge, applied.percent), applied.edge);
    if (got > asked + FLOOR_SLACK_PX) ctx.config.saveDockFloor(applied.edge, got);
    else ctx.config.saveDockFloor(applied.edge, 0);   // it fitted, so nothing is stopping it here
    emitState();
    return { ok: true, message: placement.note ?? undefined, settings: deps.settingsPayload() };
  }

  /** Give the edge back and become a window again; the saved setting follows. */
  async function undock(): Promise<void> {
    if (!dock) return;
    await dock.release();
    deps.placeFloating();
    dock.onUserUndock?.();                        // saves the setting off and tells the page
  }

  /**
   * The monitors changed: another arrangement, with its own remembered dock. The band is released
   * either way first — the monitor it was on may be the one that just left.
   */
  async function reapplyForSetup(): Promise<void> {
    if (!ctx.window() || !dock) return;
    const wanted = current();
    await dock.release();
    if (wanted.enabled) {
      const placement = await dock.apply(wanted);
      if (placement.note) console.log(`[hangar] ${placement.note}`);
    }
    // Plugging a monitor in or out docks and undocks the window on its own; say so, on both paths.
    emitState();
    deps.pushSettings();
  }

  function displays(): DisplayInfo[] {
    const saved = new Set(ctx.config.dockDevices());
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((display, index) => {
      const key = displayKey(display);
      return {
        // The key, not the id: ids are reshuffled between runs, and the saved dock has to survive.
        id: key,
        // Windows leaves `label` empty for some monitors, and "" is not something to pick from a list.
        label: display.label || `Monitor ${index + 1}`,
        bounds: display.bounds,
        primary: display.id === primary.id,
        saved: saved.has(key) || saved.has(String(display.id)),
      };
    });
  }

  wire.bind(dockContract, {
    displays: () => displays(),
    applyDock: (wanted) => applyConfig(wanted),
    dockState: () => state(),
    dockToggle: async () => {
      if (dock?.isDocked) await undock();
      else await applyConfig({ ...current(), enabled: true });   // the band this arrangement remembers
      return state();
    },
    releaseDock: async () => {
      await dock?.release();
      deps.placeFloating();
      ctx.config.saveDock({ ...current(), enabled: false }, setupKey());
      emitState();
      return deps.settingsPayload();
    },
    // The band's own resize grip. The window frame does not resize while docked — that is what
    // takes the resize cursor off the three sides that are against the screen — so the one side
    // that may be dragged is a handle in the page. Each step only moves the window, which is cheap;
    // the shell is told once, at the end, because reserving costs the best part of half a second.
    dragDock: ({ thickness, done }) => {
      if (!dock?.isDocked) return;
      if (!done) {
        dock.preview(thickness);
        return;
      }
      const config = current();
      if (!config.enabled) return;
      const { display } = pickDisplay(config.device);
      const span = bandThickness(dock.workArea(display), config.edge);
      const percent = Math.max(DOCK_PERCENT.min, Math.min(DOCK_PERCENT.max, Math.round((thickness / span) * 100)));
      ctx.config.saveDock({ ...config, percent }, setupKey());
      void dock.resizeTo(thickness).then(() => deps.pushSettings());
    },
  });

  return {
    attach(window, chrome) {
      dock = new Dock(window, chrome);
      // setMaximizable(false) stops the caption button and the system menu, not the API or every
      // window-manager gesture. While docked the band already is the full state, so undo it.
      window.on("maximize", () => {
        if (dock?.isDocked && !window.isDestroyed()) window.unmaximize();
      });
      // Plugging a monitor in or out is a different arrangement, with its own remembered dock.
      const rearranged = (): void => void reapplyForSetup();
      screen.on("display-added", rearranged);
      screen.on("display-removed", rearranged);
      screen.on("display-metrics-changed", (_event, _display, changed) => {
        // A work-area change is usually OUR band being applied or released; reacting to it would
        // re-dock the window the moment the user undocked it. Resolution and scaling are real changes.
        if (changed.every((metric) => metric === "workArea")) return;
        rearranged();
      });
      // Applying a band talks to the shell, so a drag must not do it per mouse-move: settle first.
      dock.onUserResize = (thickness) => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          // The same drag can end in an undock; by the time this fires there may be no band to size.
          if (!dock?.isDocked) return;
          const config = current();
          if (!config.enabled) return;
          const { display } = pickDisplay(config.device);
          const span = bandThickness(dock.workArea(display), config.edge);
          const percent = Math.max(DOCK_PERCENT.min, Math.min(DOCK_PERCENT.max, Math.round((thickness / span) * 100)));
          ctx.config.saveDock({ ...config, percent }, setupKey());
          // Tell the shell the new extent, and nothing else. Re-applying the dock would place the
          // window at `percent` rounded to a whole number — up to twenty pixels away from where the
          // drag ended — which is the jump-and-flicker at the end of every resize.
          void dock.resizeTo(thickness).then(() => deps.pushSettings());
        }, DOCK_RESIZE_SETTLE_MS);
      };
      // Dragging a docked window out of its band is how you undock it; the saved setting follows.
      dock.onUserUndock = () => {
        if (resizeTimer) {                          // a pending size for a band that no longer exists
          clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        const config = current();
        if (!config.enabled) return;
        ctx.config.saveDock({ ...config, enabled: false }, setupKey());
        emitState();
        deps.pushSettings();
      };
    },

    async restore() {
      const saved = current();
      if (saved.enabled && dock) {
        const placement = await dock.apply(saved);
        if (placement.note) deps.appNote(placement.note);
      }
      // Told even when nothing was applied: the page asked for this state while it was first
      // rendering, which is before any band above could exist.
      emitState();
    },

    isDocked: () => dock?.isDocked === true,
    undockForMaximize: async () => { if (dock?.isDocked) await undock(); },
    // With the arrangement key: without it the per-arrangement entry keeps the old edge and size
    // and wins on the next read, so changing the dock in Settings looked like it did nothing.
    save: (wanted) => ctx.config.saveDock(wanted, setupKey()),

    slice() {
      const config = current();
      const { display } = pickDisplay(config.device);
      const span = bandThickness(display.workArea, config.edge);
      return {
        dock: config,
        dockDevices: ctx.config.dockDevices(),
        dockFloor: ctx.config.dockFloor(config.edge),
        minPercent: percentFloor(ctx.config.dockFloor(config.edge), span),
      };
    },

    releaseSync: () => dock?.releaseSync(),

    releaseOnQuit() {
      dock?.releaseSync();                          // never leave a reserved edge behind
      if (process.platform === "win32" || clearingStruts) return null;
      clearingStruts = true;
      return dock?.release() ?? Promise.resolve();
    },
  };
}

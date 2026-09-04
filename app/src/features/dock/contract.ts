/** Reserving a screen edge for the window, and everything the page asks or hears about it. */
import { event, invoke, send } from "../../bridge/contract.js";
import type { DockConfig, DockEdge } from "../../core/types.js";
import type { ActionResult, SettingsPayload } from "../../main/ipc.js";

/** One step of a drag on the band's grip: how thick the band should be, and whether the hand let go. */
export interface DockDrag {
  thickness: number;
  done: boolean;
}

export interface DisplayInfo {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  primary: boolean;
  saved: boolean;
}

/**
 * Whether the window is a band right now, and on which edge. Owned here and pushed from here on
 * every change, so the caption button can never again show a state nobody told it about.
 */
export interface DockState {
  docked: boolean;
  edge: DockEdge;
}

export const dockContract = {
  /** Every monitor, named the way the saved dock names them. */
  displays: invoke<void, DisplayInfo[]>("settings:displays"),
  /** Put the window in the band this config describes; answers with what the platform gave. */
  applyDock: invoke<DockConfig, ActionResult & { settings?: SettingsPayload }>("dock:apply"),
  /** The band's own grip, since the window frame no longer resizes. */
  dragDock: send<DockDrag>("dock:drag"),
  /** Give the edge back and become a window again. */
  releaseDock: invoke<void, SettingsPayload>("dock:release"),
  /** The caption button: dock to the remembered edge, or undock. */
  dockToggle: invoke<void, DockState>("dock:toggle"),
  /** As it stands — asked once when the page first renders. */
  dockState: invoke<void, DockState>("dock:state"),
  /** It changed: a button, a drag out of the band, a monitor plugged in or out. */
  onDockState: event<DockState>("dock:state-push"),
} as const;

/**
 * Screenshots into terminals — the main side.
 *
 * Claude Code takes an image by path and a terminal cannot paste a bitmap, so the clipboard's image
 * is written out and its PATH put back on the clipboard. Two ways in: a menu entry in the window,
 * and a system-wide shortcut pressed wherever the cursor is. A clipboard watch (main/clipboardWatch)
 * can do the same automatically. The keystroke that follows is main/keystroke's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipboard, globalShortcut } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { clipFileName } from "../../core/store.js";
import { startClipboardWatch, stopClipboardWatch } from "../../main/clipboardWatch.js";
import { sendPaste } from "../../main/keystroke.js";
import { clipboardContract, type PastedImage } from "./contract.js";

/** A moment for the clipboard write to settle before the paste is sent. */
const PASTE_KEY_DELAY_MS = 60;

/** What this feature needs from the rest of main. */
export interface ClipboardDeps {
  /**
   * A desktop notification. The shortcut is pressed in some other window, so the answer has to be
   * visible from there — a toast inside a window nobody is looking at is the same as saying nothing.
   */
  announce(title: string, body: string): void;
}

/** What the rest of main may do with this feature once it is registered. */
export interface ClipboardFeature {
  /** Register the shortcut and the watch again — the settings behind them may have changed. */
  rearm(): void;
  /** Whether the system-wide shortcut is actually held right now; the settings screen says so. */
  active(): boolean;
  /** Let the shortcut and the watch go, on the way out. */
  dispose(): void;
}

export function register(ctx: MainContext, wire: Wire, deps: ClipboardDeps): ClipboardFeature {
  let hotkeyActive = false;

  /** Write an image into the clips folder. Shared by the shortcut and the clipboard watch. */
  function saveClipImage(image: Electron.NativeImage): string | null {
    try {
      mkdirSync(ctx.store.paths.clips, { recursive: true });
      const file = join(ctx.store.paths.clips, clipFileName());
      writeFileSync(file, image.toPNG());
      return file;
    } catch (error) {
      console.error("[hangar] could not save the clipboard image:", (error as Error).message);
      return null;
    }
  }

  function pasteClipboardImage(): PastedImage {
    const image = clipboard.readImage();
    if (image.isEmpty()) return { ok: false, message: "No image on the clipboard." };
    const file = saveClipImage(image);
    if (!file) return { ok: false, message: "Could not save the image." };
    clipboard.writeText(file);
    return { ok: true, file, message: `Image ready to paste: ${file}` };
  }

  // Give copied screenshots a path, so the ordinary paste key works in a terminal. Nothing is
  // intercepted: the clipboard is left holding the picture AND the path, and each window takes the
  // one it understands.
  function applyClipboardWatch(): void {
    if (!ctx.config.launch().autoClipPath) {
      stopClipboardWatch();
      return;
    }
    startClipboardWatch({ save: saveClipImage, clipsDir: ctx.store.paths.clips });
  }

  // Register the system-wide paste shortcut, replacing whatever was registered before. Pressed in a
  // terminal, it turns the clipboard's image into a path and presses Ctrl+V there, so the path
  // arrives where the cursor already is.
  function registerPasteHotkey(): void {
    globalShortcut.unregisterAll();
    const accelerator = ctx.config.launch().pasteHotkey.trim();
    if (!accelerator) {
      hotkeyActive = false;                        // deliberately off
      return;
    }
    try {
      hotkeyActive = globalShortcut.register(accelerator, () => {
        const result = pasteClipboardImage();
        wire.emit(clipboardContract.onPasteResult, result);
        deps.announce(result.ok ? "Screenshot ready" : "Nothing to paste", result.message ?? "");
        // sendPaste waits for the user's fingers to leave Ctrl+Alt before it sends anything.
        if (result.ok) setTimeout(() => void sendPaste(), PASTE_KEY_DELAY_MS);
      });
    } catch (error) {
      console.error("[hangar] paste shortcut unavailable:", (error as Error).message);
      hotkeyActive = false;
    }
    if (!hotkeyActive) console.error(`[hangar] the paste shortcut ${accelerator} is held by something else`);
  }

  wire.bind(clipboardContract, {
    pasteImage: () => pasteClipboardImage(),
  });

  return {
    rearm() {
      registerPasteHotkey();
      applyClipboardWatch();
    },
    active: () => hotkeyActive,
    dispose() {
      globalShortcut.unregisterAll();
      stopClipboardWatch();
    },
  };
}

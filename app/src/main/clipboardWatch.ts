/**
 * Watching the clipboard so a copied screenshot arrives with its path attached.
 *
 * The alternative was to take over Ctrl+V, which would put every paste on the machine through this
 * application. This does not touch anyone's keys: it only adds a text format next to the image
 * that is already there, and the terminal picks that up by itself.
 */
import { clipboard, type NativeImage } from "electron";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { clipsToPrune, shouldAddPath } from "../core/clipboardRules.js";

/** Cheap enough to run often; a person notices a screenshot taking a second to be ready. */
const POLL_MS = 600;

type SequenceNumber = () => number;

let timer: NodeJS.Timeout | null = null;
let lastHandled = 0;
let sequenceNumber: SequenceNumber | null | undefined;

/**
 * Windows' clipboard sequence number: one call, no clipboard opened, changes on every write.
 *
 * Reading the formats every poll would be far more expensive, and reading the image itself would
 * be absurd — this is the cheap way to know nothing has happened.
 */
function loadSequenceNumber(): SequenceNumber | null {
  if (sequenceNumber !== undefined) return sequenceNumber;
  if (process.platform !== "win32") return (sequenceNumber = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    return (sequenceNumber = user32.func("__stdcall", "GetClipboardSequenceNumber", "uint32", []));
  } catch (error) {
    console.error("[hangar] clipboard watch unavailable:", (error as Error).message);
    return (sequenceNumber = null);
  }
}

export interface ClipboardWatchOptions {
  /** Writes the image to a file and returns its path; the existing save, shared with the shortcut. */
  save: (image: NativeImage) => string | null;
  /** Where the saved screenshots live, so the old ones can be cleared out. */
  clipsDir: string;
}

/** Start watching, or stop and start again with different options. */
export function startClipboardWatch(options: ClipboardWatchOptions): void {
  stopClipboardWatch();
  const sequence = loadSequenceNumber();
  if (!sequence) return;                       // no cheap way to watch: leave the clipboard alone
  lastHandled = sequence();                    // whatever is on there now was not copied for us
  timer = setInterval(() => tick(sequence, options), POLL_MS);
  timer.unref?.();
}

export function stopClipboardWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function tick(sequence: SequenceNumber, { save, clipsDir }: ClipboardWatchOptions): void {
  const now = sequence();
  if (now === lastHandled) return;             // nothing has been copied since we last looked
  if (!shouldAddPath({ formats: clipboard.availableFormats(), sequence: now }, lastHandled)) {
    lastHandled = now;                         // not ours, but we have seen it
    return;
  }
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    lastHandled = now;
    return;
  }
  const file = save(image);
  if (!file) {
    lastHandled = now;
    return;
  }
  // Both formats together: the terminal takes the path, an image editor still takes the picture.
  clipboard.write({ text: file, image });
  lastHandled = sequence();                    // our own write, so we do not react to it
  prune(clipsDir);
}

function prune(clipsDir: string): void {
  try {
    for (const name of clipsToPrune(readdirSync(clipsDir))) unlinkSync(join(clipsDir, name));
  } catch {
    /* the folder may not exist yet, and a screenshot is not worth failing over */
  }
}

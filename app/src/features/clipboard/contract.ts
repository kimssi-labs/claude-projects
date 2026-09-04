/** A screenshot on the clipboard, turned into a file a terminal session can be pointed at. */
import { event, invoke } from "../../bridge/contract.js";

/** What became of a clipboard image: where it was written, and what is on the clipboard now. */
export interface PastedImage {
  ok: boolean;
  message?: string;
  file?: string;
}

export const clipboardContract = {
  /** Save the clipboard's image and put its path on the clipboard, from a menu. */
  pasteImage: invoke<void, PastedImage>("clipboard:paste-image"),
  /** The system-wide shortcut did the same from another window; here is how it went. */
  onPasteResult: event<PastedImage>("clipboard:paste-result"),
} as const;

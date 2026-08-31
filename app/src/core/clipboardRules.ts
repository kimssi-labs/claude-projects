/**
 * When a copied screenshot should be given a path, and which saved ones to throw away.
 *
 * A terminal cannot paste a bitmap, but it can paste a path — and a clipboard may hold both at
 * once, each application taking the format it understands. So rather than intercepting anyone's
 * paste key, the screenshot is written to a file the moment it is copied and its path is added
 * alongside the image: Ctrl+V in a terminal gives the path, Ctrl+V in an image editor still gives
 * the picture.
 *
 * The rules live here, away from the clipboard itself, so they can be exercised without one.
 */

/** How many saved screenshots to keep. Copying a screenshot writes a file, so they accumulate. */
export const CLIP_KEEP = 50;

export interface ClipboardState {
  /** Formats the clipboard is offering, as Electron reports them. */
  formats: string[];
  /** Windows' clipboard sequence number, which changes on every write by anyone. */
  sequence: number;
}

/**
 * True when this clipboard holds a bare image that we have not already handled.
 *
 * An image that already comes with text is left alone: either someone else put both there, or we
 * did, and writing again would loop.
 */
export function shouldAddPath(state: ClipboardState, lastHandled: number): boolean {
  if (state.sequence === lastHandled) return false;
  const hasImage = state.formats.some((format) => format.startsWith("image/"));
  const hasText = state.formats.some((format) => format.startsWith("text/"));
  return hasImage && !hasText;
}

/**
 * The saved screenshots to delete, oldest first.
 *
 * File names carry their timestamp, so sorting by name is sorting by age.
 */
export function clipsToPrune(names: string[], keep = CLIP_KEEP): string[] {
  const clips = names.filter((name) => name.startsWith("clip-") && name.endsWith(".png")).sort();
  return clips.slice(0, Math.max(0, clips.length - keep));
}

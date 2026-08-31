/**
 * The dock geometry, tested without a window.
 *
 * The Win32 call itself is proven by running the app and watching the work area shrink; what is
 * worth pinning down here is the arithmetic that decides which rectangle it is asked to reserve.
 */
import { describe, expect, it } from "vitest";

import { bandOfThickness, bandRect, bandThickness, keepThickness, OPEN_FACE, resizeAllowed } from "../dock.js";

const AREA = { x: 0, y: 0, width: 2000, height: 1000 };

describe("bandRect", () => {
  it("hugs each edge and measures that edge's own axis", () => {
    expect(bandRect(AREA, "top", 20)).toEqual({ x: 0, y: 0, width: 2000, height: 200 });
    expect(bandRect(AREA, "bottom", 20)).toEqual({ x: 0, y: 800, width: 2000, height: 200 });
    expect(bandRect(AREA, "left", 25)).toEqual({ x: 0, y: 0, width: 500, height: 1000 });
    expect(bandRect(AREA, "right", 25)).toEqual({ x: 1500, y: 0, width: 500, height: 1000 });
  });

  it("respects an area that does not start at the origin", () => {
    const offset = { x: 100, y: 50, width: 800, height: 600 };
    expect(bandRect(offset, "right", 50)).toEqual({ x: 500, y: 50, width: 400, height: 600 });
  });

  it("never collapses to nothing", () => {
    expect(bandRect(AREA, "top", 0).height).toBe(1);
  });
});

describe("keepThickness", () => {
  it("takes the offered position but keeps the asked-for thickness", () => {
    const asked = bandRect(AREA, "top", 20);
    // The shell slid the band down past another appbar and offered the whole rest of the screen.
    const offered = { x: 0, y: 40, width: 2000, height: 960 };
    expect(keepThickness(offered, asked, "top")).toEqual({ x: 0, y: 40, width: 2000, height: 200 });
  });

  it("keeps a bottom band against the bottom of what it was offered", () => {
    const asked = bandRect(AREA, "bottom", 20);
    const offered = { x: 0, y: 0, width: 2000, height: 960 };
    expect(keepThickness(offered, asked, "bottom")).toEqual({ x: 0, y: 760, width: 2000, height: 200 });
  });

  it("does the same on the horizontal axis", () => {
    const asked = bandRect(AREA, "right", 25);
    const offered = { x: 0, y: 0, width: 1900, height: 1000 };
    expect(keepThickness(offered, asked, "right")).toEqual({ x: 1400, y: 0, width: 500, height: 1000 });
    expect(bandThickness(keepThickness(offered, asked, "right"), "right")).toBe(500);
  });
});

/**
 * A docked band is flush with three sides of the screen, so only its inner face can be dragged.
 *
 * This used to be handled after the fact — the band was put back where it belonged — which meant
 * the window visibly jumped and returned on every grab of a pinned edge.
 */
describe("which edges a docked band accepts", () => {
  it("takes only the face that is not against the screen", () => {
    expect(OPEN_FACE).toEqual({ top: "bottom", bottom: "top", left: "right", right: "left" });
    expect(resizeAllowed("top", "bottom")).toBe(true);
    expect(resizeAllowed("left", "right")).toBe(true);
  });

  it("refuses the three pinned sides", () => {
    for (const grabbed of ["top", "left", "right"]) {
      expect(resizeAllowed("top", grabbed), `top band, ${grabbed} grip`).toBe(false);
    }
    expect(resizeAllowed("right", "left")).toBe(true);      // the open face of a right-hand band
    expect(resizeAllowed("right", "bottom")).toBe(false);
  });

  it("refuses a corner, which would move a pinned side too", () => {
    expect(resizeAllowed("top", "bottom-left")).toBe(false);
    expect(resizeAllowed("top", "bottom-right")).toBe(false);
  });

  it("leaves an undocked window alone", () => {
    expect(resizeAllowed(undefined, "top-left")).toBe(true);
    expect(resizeAllowed(undefined, undefined)).toBe(true);
  });
});

/**
 * A resized band is anchored to its edge, at the pixel thickness the drag ended on.
 *
 * The bug this pins: the resize used to reserve "wherever the window is" and let the shell answer.
 * With our own 580 px band already reserved at the top of the screen, the shell offered the free
 * space BELOW it, so the band walked down the screen by its own height on every resize — measured
 * as y = -81 becoming y = 499.
 */
describe("bandOfThickness", () => {
  const AREA_2 = { x: -1080, y: -81, width: 1080, height: 1920 };

  it("stays flush with the edge whatever the thickness", () => {
    expect(bandOfThickness(AREA_2, "top", 680)).toEqual({ x: -1080, y: -81, width: 1080, height: 680 });
    expect(bandOfThickness(AREA_2, "top", 580).y).toBe(bandOfThickness(AREA_2, "top", 680).y);
  });

  it("grows inward from the far edges too", () => {
    expect(bandOfThickness(AREA_2, "bottom", 300)).toEqual({ x: -1080, y: 1539, width: 1080, height: 300 });
    expect(bandOfThickness(AREA_2, "right", 200)).toEqual({ x: -200, y: -81, width: 200, height: 1920 });
  });

  it("is what the percentage band is made of, so the two cannot drift", () => {
    expect(bandRect(AREA_2, "top", 25)).toEqual(bandOfThickness(AREA_2, "top", 480));
  });

  it("never reserves nothing", () => {
    expect(bandOfThickness(AREA_2, "top", 0).height).toBe(1);
  });
});

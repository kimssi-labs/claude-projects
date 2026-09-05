/**
 * The dock geometry, tested without a window.
 *
 * The Win32 call itself is proven by running the app and watching the work area shrink; what is
 * worth pinning down here is the arithmetic that decides which rectangle it is asked to reserve.
 */
import { describe, expect, it } from "vitest";

import { bandOf, bandOfThickness, bandRect, bandThickness, gridStep, insetFor, keepThickness, OPEN_FACE, resizeAllowed, snapToGrid, windowFor } from "../dock.js";

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

/**
 * Every edge anchors the same way, whatever the monitor's shape.
 *
 * Measured across both screens here — 2560x1440 and a portrait 1080x1920 at a negative origin —
 * where a left band was the case that went wrong in practice.
 */
describe("a band on any edge of any monitor", () => {
  const WIDE = { x: 0, y: 0, width: 2560, height: 1392 };          // primary, taskbar removed
  const TALL = { x: -1080, y: -81, width: 1080, height: 1872 };    // portrait, off to the left

  it("keeps its far edge on the work area, and only grows inward", () => {
    for (const area of [WIDE, TALL]) {
      const thin = 200;
      const thick = 320;
      expect(bandOfThickness(area, "top", thin).y).toBe(area.y);
      expect(bandOfThickness(area, "top", thick).y).toBe(area.y);
      expect(bandOfThickness(area, "left", thin).x).toBe(area.x);
      expect(bandOfThickness(area, "left", thick).x).toBe(area.x);

      // The far edges: bottom and right stay put while the band thickens.
      const bottom = (t: number) => bandOfThickness(area, "bottom", t);
      expect(bottom(thin).y + thin).toBe(area.y + area.height);
      expect(bottom(thick).y + thick).toBe(area.y + area.height);
      const right = (t: number) => bandOfThickness(area, "right", t);
      expect(right(thin).x + thin).toBe(area.x + area.width);
      expect(right(thick).x + thick).toBe(area.x + area.width);
    }
  });

  it("spans the whole of the other axis", () => {
    for (const area of [WIDE, TALL]) {
      expect(bandOfThickness(area, "top", 200).width).toBe(area.width);
      expect(bandOfThickness(area, "bottom", 200).width).toBe(area.width);
      expect(bandOfThickness(area, "left", 200).height).toBe(area.height);
      expect(bandOfThickness(area, "right", 200).height).toBe(area.height);
    }
  });
});

/**
 * On a scaled display a window can only be drawn where a whole DIP is a whole pixel.
 *
 * Measured at 125 %: a band docked to the bottom of a monitor whose top is y = 706, at y = 1708
 * (1002 px down, which is 801.6 DIP), was drawn from y = 1711 — the two rows above showed the
 * desktop through the window, and two rows were painted past its bottom. Every edge has to land on
 * the grid, and the only edge free to move is the open face; it moves inward.
 */
describe("the DIP grid", () => {
  it("has the period of each common scale", () => {
    expect(gridStep(1)).toBe(1);
    expect(gridStep(1.25)).toBe(5);
    expect(gridStep(1.5)).toBe(3);
    expect(gridStep(1.75)).toBe(7);
    expect(gridStep(2)).toBe(2);
  });

  const ORIGIN = { x: -1920, y: 706 };                     // the 125 % monitor, physical

  it("leaves a band alone at 100 %", () => {
    const band = { x: -1920, y: 1708, width: 1920, height: 138 };
    expect(snapToGrid(band, "bottom", ORIGIN, 1)).toEqual(band);
  });

  it("moves a bottom band's top edge down onto the grid — the measured case", () => {
    const band = { x: -1920, y: 1708, width: 1920, height: 138 };   // bottom edge 1846 is on the grid
    const snapped = snapToGrid(band, "bottom", ORIGIN, 5);
    expect(snapped).toEqual({ x: -1920, y: 1711, width: 1920, height: 135 });
    expect((snapped.y - ORIGIN.y) % 5).toBe(0);
    expect(snapped.y + snapped.height).toBe(band.y + band.height);  // still against the work area
  });

  it("shortens a top band so its open face is on the grid, and never moves its top", () => {
    const band = { x: -1920, y: 706, width: 1920, height: 138 };
    const snapped = snapToGrid(band, "top", ORIGIN, 5);
    expect(snapped.y).toBe(706);
    expect(snapped.height).toBe(135);
    expect((snapped.y + snapped.height - ORIGIN.y) % 5).toBe(0);
  });

  it("does the same on the horizontal axis", () => {
    const left = snapToGrid({ x: -1920, y: 706, width: 232, height: 1140 }, "left", ORIGIN, 5);
    expect(left).toEqual({ x: -1920, y: 706, width: 230, height: 1140 });
    const right = snapToGrid({ x: -232, y: 706, width: 232, height: 1140 }, "right", ORIGIN, 5);
    expect(right).toEqual({ x: -230, y: 706, width: 230, height: 1140 });
  });

  it("only ever moves inward, and never to nothing", () => {
    for (const edge of ["top", "bottom", "left", "right"] as const) {
      const band = { x: -1920, y: 706, width: 1920, height: 1140 };
      const snapped = snapToGrid(band, edge, ORIGIN, 5);
      expect(bandThickness(snapped, edge)).toBeLessThanOrEqual(bandThickness(band, edge));
    }
    expect(snapToGrid({ x: 0, y: 0, width: 2, height: 2 }, "top", { x: 0, y: 0 }, 5).height).toBe(1);
  });
});

/**
 * At a fractional scale the window draws a whole DIP below where it is — two rows at 125 %, at
 * every position measured. The window that shows a band therefore sits that far above it, the same
 * size; the band is what the shell reserves and what is seen.
 */
describe("the window that shows a band", () => {
  const band = { x: -1920, y: 1713, width: 1920, height: 133 };

  it("is the band moved up by the lift, no taller", () => {
    expect(windowFor(band, 2)).toEqual({ x: -1920, y: 1711, width: 1920, height: 133 });
    expect(bandOf(windowFor(band, 2), 2)).toEqual(band);
  });

  it("is the band itself where nothing shifts", () => {
    expect(windowFor(band, 0)).toBe(band);
    expect(bandOf(band, 0)).toBe(band);
  });

  it("lifts by the one DIP of frame room a fractional scale keeps, as whole rows — decided, not measured", () => {
    // Measured: two rows at 125 %, none at 100 %. Reading it back from the window said one DIP or
    // none for the same shifted window depending on when it was asked, and one band shipped with
    // its top two rows showing what was behind it.
    expect(insetFor(1)).toBe(0);
    expect(insetFor(1.25)).toBe(2);
    expect(insetFor(2)).toBe(0);
    expect(insetFor(1.5)).toBe(2);
    expect(insetFor(1.75)).toBe(2);
  });
});

import { describe, expect, it } from "vitest";

import { BAND_MAX_HEIGHT, COLUMN_MAX_WIDTH, COMPACT_MAX_WIDTH, layoutFor, STACK_MIN, stackedTopHeight } from "../useLayoutMode";

describe("layoutFor", () => {
  it("treats a wide, short dock as a band", () => {
    expect(layoutFor(2560, 278)).toBe("band");            // the band this machine actually docks to
    expect(layoutFor(1200, BAND_MAX_HEIGHT)).toBe("band");
  });

  it("treats a narrow, tall dock as a column", () => {
    expect(layoutFor(380, 1400)).toBe("column");          // a left/right dock on a portrait panel
    expect(layoutFor(COLUMN_MAX_WIDTH, 900)).toBe("column");
  });

  it("prefers the column when the window is both narrow and short", () => {
    expect(layoutFor(400, 300)).toBe("column");
  });

  it("drops the detail panel before the window gets tight", () => {
    expect(layoutFor(COMPACT_MAX_WIDTH, 900)).toBe("compact");
  });

  it("uses everything when there is room", () => {
    expect(layoutFor(1400, 800)).toBe("full");
  });
});

describe("layout modes", () => {
  it("stacks below the width the user chose, and only in auto", () => {
    expect(layoutFor(800, 900, "auto", 900)).toBe("column");
    expect(layoutFor(1000, 900, "auto", 900)).not.toBe("column");
    // Fixed choices ignore the size entirely.
    expect(layoutFor(1600, 1000, "vertical", 400)).toBe("column");
    expect(layoutFor(300, 900, "horizontal", 900)).not.toBe("column");
  });

  it("keeps the short-window band when the layout is not stacked", () => {
    expect(layoutFor(1600, 300, "auto", 520)).toBe("band");
    expect(layoutFor(1600, 300, "horizontal", 520)).toBe("band");
  });
});

/**
 * The stacked layout's upper pane, cut to what the window can spare.
 *
 * Reported from a docked band: the project list was remembered at 661 px and the band was 762 px
 * tall, so entering a project showed no sessions at all — they were below the bottom of the window.
 */
describe("stackedTopHeight", () => {
  // The reported case: a 762 px band, whose header and toolbar leave the panes 613 px between them.
  const BAND_PANES = 613;

  it("leaves room for the pane below it", () => {
    const top = stackedTopHeight(661, BAND_PANES);
    expect(top).toBeLessThan(661);
    expect(BAND_PANES - top).toBeGreaterThanOrEqual(STACK_MIN);
  });

  it("honours the remembered height when there is room for it", () => {
    expect(stackedTopHeight(661, 1250)).toBe(661);
  });

  it("keeps the upper pane a list rather than a sliver", () => {
    expect(stackedTopHeight(661, 150)).toBe(STACK_MIN);
  });

  it("leaves the even split alone, and waits until it has been measured", () => {
    expect(stackedTopHeight(0, BAND_PANES)).toBe(0);
    expect(stackedTopHeight(661, 0)).toBe(0);          // nothing measured yet: split evenly
  });
});

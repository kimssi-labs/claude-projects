import { describe, expect, it } from "vitest";

import { BAND_MAX_HEIGHT, COLUMN_MAX_WIDTH, COMPACT_MAX_WIDTH, layoutFor } from "../useLayoutMode";

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

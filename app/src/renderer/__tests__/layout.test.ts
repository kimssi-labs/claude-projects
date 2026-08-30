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

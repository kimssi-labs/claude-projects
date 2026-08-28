"""Generate the app icon: a project/session list with the running row marked.

Rows = the session list, the accented row = the cursor, the dot = a live session — the three
things the app is about. Drawn at 4x and downsampled so 16 px stays legible.

    python tools/make_icon.py          # writes assets/icon.ico + assets/icon.png
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 24, 32, 48, 64, 128, 256)
SUPERSAMPLE = 4
CANVAS = 256

BACKDROP = (28, 32, 40, 255)          # terminal-dark, so the rows read on any wallpaper
ROW = (150, 160, 176, 255)
ROW_CURSOR = (232, 236, 242, 255)
CURSOR_BAR = (219, 119, 87, 255)      # Claude-ish accent on the selected row
LIVE_DOT = (74, 200, 120, 255)

CORNER_RADIUS = 46
MARGIN = 30
ROW_HEIGHT = 30
ROW_GAP = 22
ROW_RADIUS = 12
CURSOR_INDEX = 1                      # which row is highlighted (0-based)
CURSOR_BAR_WIDTH = 14
DOT_RADIUS = 15


def draw_icon(size: int = CANVAS) -> Image.Image:
    scale = size / CANVAS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = lambda v: v * scale                                    # canvas units -> pixels

    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=s(CORNER_RADIUS), fill=BACKDROP)

    rows = 3
    block = rows * ROW_HEIGHT + (rows - 1) * ROW_GAP
    top = (CANVAS - block) / 2
    for i in range(rows):
        y = top + i * (ROW_HEIGHT + ROW_GAP)
        cursor = i == CURSOR_INDEX
        left = MARGIN + (CURSOR_BAR_WIDTH + 12 if cursor else 0)
        right = CANVAS - MARGIN - (DOT_RADIUS * 2 + 12 if cursor else [40, 0, 62][i])
        if cursor:                                             # the selection bar
            d.rounded_rectangle([s(MARGIN), s(y), s(MARGIN + CURSOR_BAR_WIDTH), s(y + ROW_HEIGHT)],
                                radius=s(CURSOR_BAR_WIDTH / 2), fill=CURSOR_BAR)
        d.rounded_rectangle([s(left), s(y), s(right), s(y + ROW_HEIGHT)],
                            radius=s(ROW_RADIUS), fill=ROW_CURSOR if cursor else ROW)
        if cursor:                                             # ● a session running on that row
            cx, cy = CANVAS - MARGIN - DOT_RADIUS, y + ROW_HEIGHT / 2
            d.ellipse([s(cx - DOT_RADIUS), s(cy - DOT_RADIUS), s(cx + DOT_RADIUS), s(cy + DOT_RADIUS)],
                      fill=LIVE_DOT)
    return img


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "assets"
    out.mkdir(exist_ok=True)
    master = draw_icon(CANVAS * SUPERSAMPLE)
    frames = [master.resize((n, n), Image.LANCZOS) for n in SIZES]
    frames[-1].save(out / "icon.png")
    frames[-1].save(out / "icon.ico", format="ICO", sizes=[(n, n) for n in SIZES])
    print(f"wrote {out/'icon.ico'} ({', '.join(f'{n}x{n}' for n in SIZES)}) and icon.png")


if __name__ == "__main__":
    main()

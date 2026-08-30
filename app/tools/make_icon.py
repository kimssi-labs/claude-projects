"""Generate the app icon.

The mark is ORIGINAL on purpose. Anthropic's Claude logo and its name are trademarks, so the icon
does not reproduce them: what it shows is what the app does — a folder of sessions, one of them
running. The palette is warm-neutral-plus-terracotta, which is a colour scheme, not a trademark.

    python tools/make_icon.py            # writes build/icon.ico and build/icon.png
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 24, 32, 48, 64, 128, 256)
CANVAS = 512
SUPERSAMPLE = 2

FOLDER_BACK = (217, 119, 87, 255)          # the accent, as the folder body
FOLDER_FRONT = (233, 156, 129, 255)        # a lighter face so the folder reads at 16 px
ROW = (250, 249, 247, 235)
ROW_DIM = (250, 249, 247, 175)
LIVE = (74, 200, 120, 255)

# No plate behind the mark: the background is transparent, so the folder takes the whole canvas.
# Without a plate the mark also has to be BIGGER than a plated icon to look the same size beside
# one — a filled square reads larger than an outline of equal bounds.
MARGIN = 16
TAB_WIDTH = 210
TAB_HEIGHT = 54
BODY_TOP = 104
BODY_BOTTOM = 496
ROW_HEIGHT = 42
ROW_GAP = 46
ROW_INSET = 52
DOT_RADIUS = 31


def draw_icon(size: int) -> Image.Image:
    scale = size / CANVAS
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = lambda value: value * scale                      # canvas units -> pixels

    # Folder: a tab, then the body over it, so the two shapes read as one object at any size.
    draw.rounded_rectangle(
        [s(MARGIN), s(BODY_TOP - TAB_HEIGHT - 20), s(MARGIN + TAB_WIDTH), s(BODY_TOP + 20)],
        radius=s(20), fill=FOLDER_BACK)
    draw.rounded_rectangle(
        [s(MARGIN), s(BODY_TOP), s(CANVAS - MARGIN), s(BODY_BOTTOM)],
        radius=s(38), fill=FOLDER_FRONT)

    # Three session rows on the folder face, centred in it; the first one is running.
    block = 3 * ROW_HEIGHT + 2 * ROW_GAP
    top = BODY_TOP + (BODY_BOTTOM - BODY_TOP - block) / 2
    for index in range(3):
        y = top + index * (ROW_HEIGHT + ROW_GAP)
        right = CANVAS - MARGIN - ROW_INSET - (0 if index else DOT_RADIUS * 2 + 18)
        draw.rounded_rectangle(
            [s(MARGIN + ROW_INSET), s(y), s(right), s(y + ROW_HEIGHT)],
            radius=s(ROW_HEIGHT / 2), fill=ROW if index == 0 else ROW_DIM)
    live_y = top + ROW_HEIGHT / 2
    live_x = CANVAS - MARGIN - ROW_INSET - DOT_RADIUS
    draw.ellipse([s(live_x - DOT_RADIUS), s(live_y - DOT_RADIUS), s(live_x + DOT_RADIUS), s(live_y + DOT_RADIUS)],
                 fill=LIVE)
    return image


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "build"
    out.mkdir(exist_ok=True)
    master = draw_icon(CANVAS * SUPERSAMPLE)
    frames = [master.resize((n, n), Image.LANCZOS) for n in SIZES]
    master.resize((512, 512), Image.LANCZOS).save(out / "icon.png")       # Linux wants 512
    frames[-1].save(out / "icon.ico", format="ICO", sizes=[(n, n) for n in SIZES])
    print(f"wrote {out/'icon.ico'} and {out/'icon.png'}")


if __name__ == "__main__":
    main()

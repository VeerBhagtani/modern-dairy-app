#!/usr/bin/env python3
"""Generate the Modern Drivers launcher icon from the Modern Dairy logo.

Why this exists: both apps install on the same phone, side by side. They
already have different application ids and different names, so neither
overwrites the other — but `npx cap add android` generates the stock Capacitor
icon for the driver app, which would put a meaningless grey default icon next
to the real Modern Dairy one. Two apps from the same company, one of them
looking like a developer sample.

The design brief is a launcher icon, not a logo: at 48dp nobody reads text, so
the thing that has to differ is the COLOUR BLOCK and the SHAPE.

  Modern Dairy    white tile, red mark, blue script  (unchanged)
  Modern Drivers  navy tile, white mark, route line

Same brand mark, inverted palette. Distinguishable across a room, and still
obviously the same company.

Run: python3 scripts/make-drivers-icon.py
Outputs driver-app/resources/{icon,icon-foreground,icon-background,splash,
splash-dark}.png, which `npx @capacitor/assets generate` turns into every
density Android needs.
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_LOGO = os.path.join(ROOT, "resources", "icon.png")
OUT_DIR = os.path.join(ROOT, "driver-app", "resources")

NAVY = (27, 42, 107, 255)        # --brand, same token the apps use
NAVY_DEEP = (16, 27, 73, 255)    # --brand-dark
WHITE = (255, 255, 255, 255)

SIZE = 1024
SPLASH = 2732


def extract_mark(path):
    """Cut the red 'M' mark out of the company logo and return it as a mask.

    The mark is the only strongly red thing in the logo — the script wordmark
    is blue and the background is white — so selecting red pixels isolates it
    without needing the shape hand-traced. The banner at the bottom is red too,
    so only the top half is considered.
    """
    logo = Image.open(path).convert("RGBA")
    w, h = logo.size
    top = logo.crop((0, 0, w, int(h * 0.45)))
    px = top.load()

    mask = Image.new("L", top.size, 0)
    mpx = mask.load()
    for y in range(top.size[1]):
        for x in range(top.size[0]):
            r, g, b, a = px[x, y]
            if a > 40 and r > 120 and r > g * 1.6 and r > b * 1.6:
                mpx[x, y] = 255

    bbox = mask.getbbox()
    if not bbox:
        sys.exit("Could not find the red mark in the logo — has the artwork changed?")
    return mask.crop(bbox)


def compose_icon(mark, size, with_route=True, safe_fraction=0.52):
    """Navy tile, white mark, and a route line that says 'tracking'.

    `safe_fraction` keeps the artwork inside the centre of the canvas, because
    Android adaptive icons crop to a circle, a squircle or a rounded square
    depending on the launcher, and anything near the edge can be cut off.
    """
    img = Image.new("RGBA", (size, size), NAVY)
    d = ImageDraw.Draw(img)

    # A soft deeper panel behind the mark, so the white shape has something to
    # sit on rather than floating on flat colour.
    pad = int(size * 0.14)
    d.rounded_rectangle([pad, pad, size - pad, size - pad],
                        radius=int(size * 0.16), fill=NAVY_DEEP)

    # The mark, scaled into the safe zone and nudged up to leave room for the
    # route line beneath it.
    target = int(size * safe_fraction)
    mw, mh = mark.size
    scale = min(target / mw, target / mh)
    nw, nh = max(1, int(mw * scale)), max(1, int(mh * scale))
    m = mark.resize((nw, nh), Image.LANCZOS)

    white = Image.new("RGBA", (nw, nh), WHITE)
    y_offset = int(size * (-0.10 if with_route else 0))
    img.paste(white, ((size - nw) // 2, (size - nh) // 2 + y_offset), m)

    if with_route:
        # A dashed line with a stop at each end: the journey the app records.
        y = int(size * 0.76)
        x0, x1 = int(size * 0.26), int(size * 0.74)
        dash, gap = int(size * 0.045), int(size * 0.028)
        x = x0
        while x < x1:
            d.line([(x, y), (min(x + dash, x1), y)], fill=WHITE, width=max(2, int(size * 0.018)))
            x += dash + gap
        r = int(size * 0.032)
        for cx in (x0, x1):
            d.ellipse([cx - r, y - r, cx + r, y + r], fill=WHITE)

    return img


def main():
    if not os.path.exists(SOURCE_LOGO):
        sys.exit(f"Missing {SOURCE_LOGO}")
    os.makedirs(OUT_DIR, exist_ok=True)

    mark = extract_mark(SOURCE_LOGO)
    print(f"Extracted the brand mark: {mark.size[0]}x{mark.size[1]}")

    # The icon proper.
    compose_icon(mark, SIZE).save(os.path.join(OUT_DIR, "icon.png"))

    # Adaptive icon: Android composites foreground over background and crops to
    # the launcher's shape, so the foreground gets a smaller safe fraction and a
    # transparent ground, and the background is flat colour.
    fg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    art = compose_icon(mark, SIZE, with_route=False, safe_fraction=0.42)
    art_mark = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    # Re-render just the mark, without the tile, for the foreground layer.
    target = int(SIZE * 0.42)
    mw, mh = mark.size
    scale = min(target / mw, target / mh)
    nw, nh = int(mw * scale), int(mh * scale)
    m = mark.resize((nw, nh), Image.LANCZOS)
    art_mark.paste(Image.new("RGBA", (nw, nh), WHITE), ((SIZE - nw) // 2, (SIZE - nh) // 2), m)
    fg.alpha_composite(art_mark)
    fg.save(os.path.join(OUT_DIR, "icon-foreground.png"))
    Image.new("RGBA", (SIZE, SIZE), NAVY).save(os.path.join(OUT_DIR, "icon-background.png"))
    del art

    # Splash: the mark on navy, centred, with generous margin so it survives
    # every screen aspect ratio.
    for name, bg in (("splash.png", NAVY), ("splash-dark.png", NAVY_DEEP)):
        s = Image.new("RGBA", (SPLASH, SPLASH), bg)
        target = int(SPLASH * 0.22)
        scale = min(target / mw, target / mh)
        nw2, nh2 = int(mw * scale), int(mh * scale)
        m2 = mark.resize((nw2, nh2), Image.LANCZOS)
        s.paste(Image.new("RGBA", (nw2, nh2), WHITE), ((SPLASH - nw2) // 2, (SPLASH - nh2) // 2), m2)
        s.save(os.path.join(OUT_DIR, name))

    for f in sorted(os.listdir(OUT_DIR)):
        p = os.path.join(OUT_DIR, f)
        print(f"  {f:24} {os.path.getsize(p) // 1024:>5} KB")
    print(f"\nWrote {OUT_DIR}")


if __name__ == "__main__":
    main()

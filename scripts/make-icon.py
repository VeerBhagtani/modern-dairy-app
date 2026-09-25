#!/usr/bin/env python3
"""Generate every Modern Drivers image from the one logo file.

Source: app/resources/source-logo.png — the Modern Drivers lockup (red M mark,
blue "Modern" script, "DRIVERS", and the red "Melange of health and freshness"
banner) on white.

Writes:
  app/resources/icon.png, icon-foreground.png, icon-background.png,
    splash.png, splash-dark.png   (turned into every Android density by
                                   `npx @capacitor/assets generate`)
  app/www/logo.png, app/www/mark.png, dashboard/logo.png, dashboard/mark.png

The launcher icon is the logo itself on a white tile, as the office asked,
kept inside the centre of the canvas because Android crops adaptive icons to a
circle or squircle. The red M on its own (mark.png) is for the small places —
the 26 px header — where the lockup's text would be an unreadable smudge.

Run: python3 scripts/make-icon.py
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_LOGO = os.path.join(ROOT, "app", "resources", "source-logo.png")
RES = os.path.join(ROOT, "app", "resources")
WHITE = (255, 255, 255, 255)
SIZE = 1024
SPLASH = 2732


def transparent(img):
    """White background to transparent, keeping the anti-aliased edges."""
    img = img.convert("RGBA")
    px = img.load()
    for y in range(img.size[1]):
        for x in range(img.size[0]):
            r, g, b, a = px[x, y]
            lightness = min(r, g, b)
            if lightness >= 250:
                px[x, y] = (r, g, b, 0)
            elif lightness > 200:
                # Edge pixels: fade in proportion to how close to white they are.
                px[x, y] = (r, g, b, int(a * (250 - lightness) / 50))
    return img.crop(img.getbbox())


def red_mark(img):
    """The red M, cut out of the top part of the logo (the banner is red too)."""
    img = img.convert("RGBA")
    w, h = img.size
    top = img.crop((0, 0, w, int(h * 0.45)))
    px = top.load()
    out = Image.new("RGBA", top.size, (0, 0, 0, 0))
    opx = out.load()
    for y in range(top.size[1]):
        for x in range(top.size[0]):
            r, g, b, a = px[x, y]
            if r > 120 and r > g * 1.6 and r > b * 1.6:
                opx[x, y] = (r, g, b, 255)
    bbox = out.getbbox()
    if not bbox:
        sys.exit("Could not find the red mark in the logo — has the artwork changed?")
    return out.crop(bbox)


def fit(art, box):
    w, h = art.size
    s = min(box / w, box / h)
    return art.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)


def centred(canvas, art):
    canvas.alpha_composite(art, ((canvas.size[0] - art.size[0]) // 2, (canvas.size[1] - art.size[1]) // 2))
    return canvas


def main():
    if not os.path.exists(SOURCE_LOGO):
        sys.exit(f"Missing {SOURCE_LOGO}")
    source = Image.open(SOURCE_LOGO).convert("RGBA")
    logo = transparent(source)
    mark = red_mark(source)

    # Launcher icon: the whole logo on white, inside the adaptive safe zone.
    centred(Image.new("RGBA", (SIZE, SIZE), WHITE), fit(logo, int(SIZE * 0.84))).save(os.path.join(RES, "icon.png"))
    centred(Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), fit(logo, int(SIZE * 0.62))).save(os.path.join(RES, "icon-foreground.png"))
    Image.new("RGBA", (SIZE, SIZE), WHITE).save(os.path.join(RES, "icon-background.png"))
    # Splash: the logo on white, both themes — the blue script would vanish on
    # a dark ground.
    for name in ("splash.png", "splash-dark.png"):
        centred(Image.new("RGBA", (SPLASH, SPLASH), WHITE), fit(logo, int(SPLASH * 0.34))).save(os.path.join(RES, name))

    for d in (os.path.join(ROOT, "app", "www"), os.path.join(ROOT, "dashboard")):
        logo.save(os.path.join(d, "logo.png"), optimize=True)   # never upscaled
        fit(mark, 256).save(os.path.join(d, "mark.png"), optimize=True)

    print("Wrote icon, adaptive icon, splash, logo.png and mark.png")


if __name__ == "__main__":
    main()

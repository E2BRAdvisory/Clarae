#!/usr/bin/env python3
"""Generate every branding asset (web favicons, desktop icons, repository graphics) from the vector mark.

Sources (committed, drawn by hand from the brand board assets/clarae.png):
  assets/brand/mark.svg               the mark on a light background
  assets/brand/mark-on-dark.svg       the mark on Deep Navy
  assets/brand/icon.svg               the application icon: the mark on a Deep Navy tile
  assets/brand/safari-pinned-tab.svg  monochrome silhouette of the mark

Requirements: Python 3 with Pillow, rsvg-convert (librsvg); iconutil on macOS for the .icns. The
wordmark font is SF Pro (macOS) with a Helvetica/DejaVu fallback. Run from anywhere:

  python3 -m venv .venv && .venv/bin/pip install pillow
  .venv/bin/python scripts/brand/gen-brand-assets.py [--out <dir>]

--out writes the same tree under <dir> instead of the repository (a preview). The outputs are
committed: the build does not run this script.
"""

import argparse
import json
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BRAND = os.path.join(ROOT, "assets", "brand")

NAME = "Clarae notanda"
SHORT_NAME = "Clarae"
PAYOFF = "Your knowledge, carefully preserved in its clarity."

# The palette of the brand board.
NAVY = (16, 43, 58)  # #102B3A  identity, headers, text
TEAL = (21, 153, 146)  # #159992  accents and interactions
MINT = (114, 201, 189)  # #72C9BD  highlights
MIST = (233, 240, 239)  # #E9F0EF  surfaces and backgrounds
WHITE = (255, 255, 255)


def hexa(rgb):
    return "#%02X%02X%02X" % rgb


def svg_png(svg, px):
    """An SVG rendered on a px × px transparent canvas."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    subprocess.run(["rsvg-convert", "-w", str(px), "-h", str(px), svg, "-o", path], check=True)
    img = Image.open(path).convert("RGBA")
    img.load()
    os.unlink(path)
    return img


def macos_icon(icon_svg):
    """1024 canvas with the tile inside Apple's margin (824 px) and a soft drop shadow."""
    tile = svg_png(icon_svg, 824)
    out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), (100, 112), tile.getchannel("A"))
    out.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))
    out.alpha_composite(tile, (100, 100))
    return out


def square_icon(mark_svg, px, mark_share):
    """Opaque Deep Navy square, no rounding: the platform applies its own mask (iOS, Android
    maskable). mark_share is the side of the mark's box over the side of the icon."""
    out = Image.new("RGBA", (px, px), NAVY + (255,))
    m = round(px * mark_share)
    out.alpha_composite(svg_png(mark_svg, m), ((px - m) // 2, (px - m) // 2))
    return out.convert("RGB")


def write_icns(img, path):
    """All ten iconset entries (16 to 512 @1x/@2x); iconutil when present, Pillow otherwise."""
    if not shutil.which("iconutil"):
        img.save(path, append_images=[img.resize((px, px), Image.LANCZOS) for px in (16, 32, 64, 128, 256, 512)])
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.mkdir(iconset)
        for px in (16, 32, 128, 256, 512):
            img.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, f"icon_{px}x{px}.png"))
            img.resize((px * 2, px * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{px}x{px}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", path], check=True)


def font(size, weight):
    for path in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/HelveticaNeue.ttc",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(path):
            f = ImageFont.truetype(path, size)
            try:  # SF Pro axes: width, optical size, grade, weight
                f.set_variation_by_axes([100, min(96, max(17, size)), 400, weight])
            except (OSError, AttributeError):
                pass
            return f
    return ImageFont.load_default(size)


def card(size, mark_svg, mark_px, title_px):
    """Repository graphic, as the banner of the brand board: Deep Navy, the mark and the wordmark on
    the left with the payoff under it, the shapes of the mark enlarged and cropped on the right."""
    w, h = size
    bg = Image.new("RGBA", size, NAVY + (255,))
    decor_px = round(h * 2.1)
    decor = svg_png(mark_svg, decor_px)
    decor.putalpha(decor.getchannel("A").point(lambda a: a * 30 // 255))
    bg.alpha_composite(decor, (w - round(decor_px * 0.40), (h - decor_px) // 2))

    d = ImageDraw.Draw(bg)
    title_f = font(title_px, 590)
    payoff_f = font(round(title_px * 0.36), 400)
    tb = d.textbbox((0, 0), NAME, font=title_f)
    pb = d.textbbox((0, 0), PAYOFF, font=payoff_f)
    gap = round(mark_px * 0.20)
    x0 = round(w * 0.065)
    bg.alpha_composite(svg_png(mark_svg, mark_px), (x0, (h - mark_px) // 2))
    tx = x0 + mark_px + gap
    spacing = round(title_px * 0.34)
    y = (h - ((tb[3] - tb[1]) + spacing + (pb[3] - pb[1]))) // 2
    d.text((tx, y - tb[1]), NAME, font=title_f, fill=WHITE)
    d.text((tx + 2, y + (tb[3] - tb[1]) + spacing - pb[1]), PAYOFF, font=payoff_f, fill=MIST)
    return bg.convert("RGB")


def write_manifest(path):
    manifest = {
        "name": NAME,
        "short_name": SHORT_NAME,
        "description": PAYOFF,
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "theme_color": hexa(NAVY),
        "background_color": hexa(NAVY),
        "icons": [
            {"src": "/android-chrome-192x192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/android-chrome-512x512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/maskable-icon-512x512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
            {"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml"},
        ],
    }
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


def main():
    args = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    args.add_argument("--out", help="write under this directory instead of the repository")
    out = args.parse_args().out or ROOT

    def target(*parts):
        path = os.path.join(out, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path

    icon = os.path.join(BRAND, "icon.svg")
    on_dark = os.path.join(BRAND, "mark-on-dark.svg")
    pinned = os.path.join(BRAND, "safari-pinned-tab.svg")
    tile = {px: svg_png(icon, px) for px in (16, 32, 48, 64, 128, 192, 256, 512, 1024)}
    mac = macos_icon(icon)

    # Brand masters.
    tile[1024].save(target("assets", "brand", "icon-1024.png"))
    mac.save(target("assets", "brand", "icon-macos-1024.png"))

    # Web (cloud console and workbench).
    tile[16].save(target("web", "public", "favicon-16x16.png"))
    tile[32].save(target("web", "public", "favicon-32x32.png"))
    tile[48].save(target("web", "public", "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)],
                  append_images=[tile[16], tile[32]])
    square_icon(on_dark, 180, 0.80).save(target("web", "public", "apple-touch-icon.png"))
    tile[192].save(target("web", "public", "android-chrome-192x192.png"))
    tile[512].save(target("web", "public", "android-chrome-512x512.png"))
    # Maskable: everything that matters stays inside the central 80% circle.
    square_icon(on_dark, 512, 0.62).save(target("web", "public", "maskable-icon-512x512.png"))
    shutil.copyfile(icon, target("web", "public", "icon.svg"))
    shutil.copyfile(pinned, target("web", "public", "safari-pinned-tab.svg"))
    write_manifest(target("web", "public", "site.webmanifest"))

    # Desktop. The macOS bundle takes build/darwin/icon.icns (scripts/build-desktop-bin.sh), Windows
    # build/windows/icon.ico (exe resources and NSIS), Linux the two files installed in hicolor.
    mac.save(target("apps", "desktop", "build", "appicon.png"))
    write_icns(mac, target("apps", "desktop", "build", "darwin", "icon.icns"))
    ico = [tile[px] for px in (256, 128, 64, 48, 32, 16)]
    ico[0].save(target("apps", "desktop", "build", "windows", "icon.ico"),
                sizes=[(px, px) for px in (256, 128, 64, 48, 32, 16)], append_images=ico[1:])
    tile[512].save(target("apps", "desktop", "build", "linux", "clarae.png"))
    shutil.copyfile(icon, target("apps", "desktop", "build", "linux", "clarae.svg"))

    # Repository graphics.
    card((1280, 640), on_dark, 230, 96).save(target("assets", "brand", "social-preview.png"))
    card((1280, 320), on_dark, 150, 68).save(target("assets", "readme-banner.png"))


if __name__ == "__main__":
    main()

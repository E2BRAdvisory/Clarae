#!/usr/bin/env python3
"""Generate every branding asset (web favicons, desktop icons, repository graphics) from the artwork.

Sources (committed):
  assets/logo.png                   1024 px raster logo with the wordmark
  assets/brand/icon.svg             vector redraw of the mark (tile + brain)
  assets/brand/safari-pinned-tab.svg  monochrome silhouette of the mark

Requirements: Python 3 with Pillow and numpy, rsvg-convert (librsvg). The title font is SF Pro
(macOS) with a Helvetica/DejaVu fallback. Run from anywhere:

  python3 -m venv .venv && .venv/bin/pip install pillow numpy
  .venv/bin/python scripts/brand/gen-brand-assets.py

The outputs are committed: the build does not run this script.
"""

import json
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LOGO = os.path.join(ROOT, "assets", "logo.png")
BRAND = os.path.join(ROOT, "assets", "brand")
WEB = os.path.join(ROOT, "web", "public")
DESKTOP = os.path.join(ROOT, "apps", "desktop", "build")

# Geometry of the tile in logo.png (measured): outer edge of the light border and its corner radius.
TILE = (103, 103, 921, 921)
TILE_RADIUS = 177
BRAIN_CENTER = (511.5, 469)  # the brain sits above the wordmark in the source
BRAIN_BOX = (196, 156, 828, 776)
BRAIN_SCALE = 1.08
SS = 4  # supersampling for the anti-aliased masks

BG_DARK = (13, 18, 30)
TEXT = (241, 245, 249)
MUTED = (148, 163, 184)
CYAN = (34, 211, 238)
VIOLET = (139, 92, 246)


def rounded_mask(size, box, radius, blur=0):
    m = Image.new("L", (size[0] * SS, size[1] * SS), 0)
    ImageDraw.Draw(m).rounded_rectangle([v * SS for v in box], radius=radius * SS, fill=255)
    m = m.resize(size, Image.LANCZOS)
    return m.filter(ImageFilter.GaussianBlur(blur)) if blur else m


def tile_background(src):
    """The tile's vertical gradient, fitted on a strip left of the brain glow."""
    a = np.asarray(src).astype(float)
    ys = np.arange(170, 760)
    strip = a[170:760, 118:160].mean(1)
    yy = np.arange(src.height)
    cols = np.stack([np.polyval(np.polyfit(ys, strip[:, c], 2), yy) for c in range(3)], 1)
    bg = np.repeat(cols[:, None, :], src.width, 1)
    return Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))


def build_master(src):
    """logo.png without the wordmark, the brain re-centred in the tile; plus the bare background."""
    bg = tile_background(src)
    interior = rounded_mask(src.size, (116, 116, 907, 907), 164, blur=5)
    out = Image.composite(bg, src, interior)
    crop = src.crop(BRAIN_BOX)
    feather = rounded_mask(crop.size, (28, 28, crop.width - 28, crop.height - 28), 120, blur=22)
    size = (round(crop.width * BRAIN_SCALE), round(crop.height * BRAIN_SCALE))
    crop, feather = crop.resize(size, Image.LANCZOS), feather.resize(size, Image.LANCZOS)
    offset = (round(512 - (BRAIN_CENTER[0] - BRAIN_BOX[0]) * BRAIN_SCALE),
              round(512 - (BRAIN_CENTER[1] - BRAIN_BOX[1]) * BRAIN_SCALE))
    out.paste(crop, offset, feather)
    full = Image.composite(out, bg, interior)  # the brain on the gradient, edge to edge
    return out, full


def macos_icon(master, src):
    """1024 canvas, tile inside Apple's margin, transparent outside with the source's drop shadow."""
    tile = rounded_mask(master.size, TILE, TILE_RADIUS)
    lum = np.asarray(src.convert("L")).astype(float)
    shadow = np.clip(1 - lum / 21.0, 0, 1) * 255  # 21 = luminance of the flat page background
    alpha = np.maximum(np.asarray(tile).astype(float), shadow * (1 - np.asarray(tile) / 255.0))
    rgb = np.where(np.asarray(tile)[..., None] > 0, np.asarray(master), 0)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def tile_icon(master):
    """The tile alone, edge to edge, with transparent rounded corners (Windows, Linux, favicons)."""
    crop = master.crop(TILE)
    mask = rounded_mask(crop.size, (0, 0, crop.width, crop.height), TILE_RADIUS)
    out = crop.convert("RGBA")
    out.putalpha(mask)
    return out


def square_icon(full, inset):
    """Opaque square, no rounding: the platform applies its own mask (iOS, Android maskable)."""
    return full.crop((inset, inset, 1024 - inset, 1024 - inset)).convert("RGB")


def resized(img, px):
    return img.resize((px, px), Image.LANCZOS)


def write_icns(img, path):
    """All ten iconset entries (16 to 512 @1x/@2x); iconutil when present, Pillow otherwise."""
    if not shutil.which("iconutil"):
        img.save(path, append_images=[resized(img, px) for px in (16, 32, 64, 128, 256, 512)])
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.mkdir(iconset)
        for px in (16, 32, 128, 256, 512):
            resized(img, px).save(os.path.join(iconset, f"icon_{px}x{px}.png"))
            resized(img, px * 2).save(os.path.join(iconset, f"icon_{px}x{px}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", path], check=True)


def svg_png(svg, px):
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    subprocess.run(["rsvg-convert", "-w", str(px), "-h", str(px), svg, "-o", path], check=True)
    img = Image.open(path).convert("RGBA")
    img.load()
    os.unlink(path)
    return img


def font(size, weight):
    for path in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/HelveticaNeue.ttc",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            f = ImageFont.truetype(path, size)
            try:  # SF Pro axes: width, optical size, grade, weight
                f.set_variation_by_axes([100, min(96, max(17, size)), 400, weight])
            except (OSError, AttributeError):
                pass
            return f
    return ImageFont.load_default(size)


def glow_background(w, h, spots):
    a = np.zeros((h, w, 3), float) + BG_DARK
    yy, xx = np.mgrid[0:h, 0:w]
    a += np.linspace(0, 10, h)[:, None, None] * np.array([0.4, 0.5, 1.0])
    for (cx, cy, r, color, strength) in spots:
        d = np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r)))[..., None]
        a += d * strength * np.array(color)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert("RGBA")


def gradient_bar(w, h):
    t = np.linspace(0, 1, w)[None, :, None]
    rgb = (1 - t) * np.array(CYAN) + t * np.array(VIOLET)
    bar = Image.fromarray(np.repeat(rgb, h, 0).astype(np.uint8)).convert("RGBA")
    bar.putalpha(rounded_mask((w, h), (0, 0, w, h), h / 2))
    return bar


def card(size, icon, icon_px, title_px, lines, tagline=None):
    """Repository graphic: icon on the left, wordmark and tagline on the right, vertically centred."""
    w, h = size
    bg = glow_background(w, h, [(w * 0.18, h * 0.5, h * 0.55, CYAN, 0.10),
                                (w * 0.85, h * 0.25, h * 0.7, VIOLET, 0.12)])
    ic = resized(icon, icon_px)
    title_f = font(title_px, 700)
    sub_f = font(round(title_px * 0.40), 500)
    tag_f = font(round(title_px * 0.30), 500)
    d = ImageDraw.Draw(bg)
    title = "MemoBrain Notes"
    tb = d.textbbox((0, 0), title, font=title_f)
    gap = round(icon_px * 0.22)
    block_w = icon_px + gap + max(tb[2], *(d.textbbox((0, 0), l, font=sub_f)[2] for l in lines))
    x0 = (w - block_w) // 2
    bg.alpha_composite(ic, (x0, (h - icon_px) // 2))
    tx = x0 + icon_px + gap
    line_h = round(sub_f.size * 1.35)
    bar_h = max(4, title_px // 14)
    text_h = (tb[3] - tb[1]) + bar_h + round(title_px * 0.62) + line_h * len(lines)
    if tagline:
        text_h += round(tag_f.size * 2.2)
    y = (h - text_h) // 2
    d.text((tx, y - tb[1]), title, font=title_f, fill=TEXT)
    y += tb[3] - tb[1] + round(title_px * 0.28)
    bg.alpha_composite(gradient_bar(round(title_px * 2.2), bar_h), (tx + 2, y))
    y += bar_h + round(title_px * 0.34)
    for l in lines:
        d.text((tx, y), l, font=sub_f, fill=MUTED)
        y += line_h
    if tagline:
        y += round(tag_f.size * 0.9)
        d.text((tx, y), tagline, font=tag_f, fill=(110, 125, 150))
    return bg.convert("RGB")


def write_manifest(path):
    manifest = {
        "name": "MemoBrain Notes",
        "short_name": "MemoBrain",
        "description": "Local-first notes and knowledge base",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "theme_color": "#111624",
        "background_color": "#0d121e",
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
    src = Image.open(LOGO).convert("RGB")
    master, full = build_master(src)
    mac = macos_icon(master, src)
    tile = tile_icon(master)
    vector = os.path.join(BRAND, "icon.svg")
    pinned = os.path.join(BRAND, "safari-pinned-tab.svg")
    os.makedirs(BRAND, exist_ok=True)

    # Brand masters.
    mac.save(os.path.join(BRAND, "icon-macos-1024.png"))
    resized(tile, 1024).save(os.path.join(BRAND, "icon-1024.png"))

    # Web (cloud console and workbench): favicons up to 48 px come from the vector, whose strokes
    # are drawn for small sizes; larger ones from the raster artwork.
    small = {px: svg_png(vector, px) for px in (16, 32, 48)}
    small[16].save(os.path.join(WEB, "favicon-16x16.png"))
    small[32].save(os.path.join(WEB, "favicon-32x32.png"))
    small[48].save(os.path.join(WEB, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)],
                   append_images=[small[16], small[32]])
    resized(square_icon(full, 108), 180).save(os.path.join(WEB, "apple-touch-icon.png"))
    resized(tile, 192).save(os.path.join(WEB, "android-chrome-192x192.png"))
    resized(tile, 512).save(os.path.join(WEB, "android-chrome-512x512.png"))
    resized(square_icon(full, 0), 512).save(os.path.join(WEB, "maskable-icon-512x512.png"))
    shutil.copyfile(vector, os.path.join(WEB, "icon.svg"))
    shutil.copyfile(pinned, os.path.join(WEB, "safari-pinned-tab.svg"))
    write_manifest(os.path.join(WEB, "site.webmanifest"))

    # Desktop. Wails builds the macOS .icns from build/appicon.png at package time; icon.icns is the
    # same set for tools that want the file. Windows takes build/windows/icon.ico as it is.
    mac.save(os.path.join(DESKTOP, "appicon.png"))
    write_icns(mac, os.path.join(DESKTOP, "darwin", "icon.icns"))
    ico = [resized(tile, px) for px in (256, 128, 64)] + [small[48], small[32], small[16]]
    ico[0].save(os.path.join(DESKTOP, "windows", "icon.ico"),
                sizes=[(px, px) for px in (256, 128, 64, 48, 32, 16)], append_images=ico[1:])
    resized(tile, 512).save(os.path.join(DESKTOP, "linux", "memobrain.png"))
    shutil.copyfile(vector, os.path.join(DESKTOP, "linux", "memobrain.svg"))

    # Repository graphics.
    card((1280, 640), tile, 300, 92,
         ["Local-first notes and knowledge base"],
         "Markdown vaults  ·  Works offline  ·  End-to-end encrypted sync").save(
        os.path.join(BRAND, "social-preview.png"))
    card((1280, 320), tile, 176, 64, ["Local-first notes and knowledge base"]).save(
        os.path.join(ROOT, "assets", "readme-banner.png"))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Generates the brand / social / PWA images for Help Me Breathe.

Re-run after editing brand colors or copy:
    python tools/generate-images.py

Outputs (to images/):
    og-breathing-timer.jpg        1200x630  Open Graph (homepage)
    twitter-breathing-timer.jpg   1200x600  Twitter/X large card (homepage)
    4-7-8-breathing-guide-og.jpg  1200x630  Open Graph (blog post)
    logo.png                       512x512  Organization logo (schema.org)
    icon-192.png                   192x192  PWA icon
    icon-512.png                   512x512  PWA icon
    apple-touch-icon.png           180x180  iOS home-screen icon

Design matches the site's "4-7-8 Deep Sleep" indigo->violet theme.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = "images"
os.makedirs(OUT, exist_ok=True)

# --- Brand palette (from css/styles.css :root / .theme-478) -----------------
BG_STOPS = [(0.0, (30, 27, 75)), (0.5, (49, 46, 129)), (1.0, (67, 56, 202))]
CIRCLE_INNER = (210, 218, 255)   # light lavender highlight
CIRCLE_OUTER = (139, 92, 246)    # --theme-primary
GLOW = (139, 92, 246)
TEXT = (255, 255, 255)
TEXT_SOFT = (199, 210, 254)      # --theme-secondary

FONTS = "C:/Windows/Fonts/"
def font(name, size):
    return ImageFont.truetype(FONTS + name, size)

LIGHT = "segoeuil.ttf"      # Segoe UI Light  (~Quicksand 300)
SEMI = "segoeuisl.ttf"      # Segoe UI Semilight
REG = "segoeui.ttf"
BOLD = "segoeuib.ttf"


def vgradient(w, h, stops):
    ys = np.linspace(0, 1, h)
    pos = np.array([s[0] for s in stops])
    cols = np.array([s[1] for s in stops], dtype=float)
    r = np.interp(ys, pos, cols[:, 0])
    g = np.interp(ys, pos, cols[:, 1])
    b = np.interp(ys, pos, cols[:, 2])
    row = np.stack([r, g, b], axis=1)
    img = np.repeat(row[:, None, :], w, axis=1).astype(np.uint8)
    return Image.fromarray(img, "RGB")


def glow_circle(diameter, pad):
    """RGBA tile (diameter+2*pad square) with a soft-glowing breathing circle."""
    size = diameter + pad * 2
    cx = cy = size / 2.0
    R = diameter / 2.0
    yy, xx = np.mgrid[0:size, 0:size].astype(float)
    # offset light source up-left for a soft 3D sphere look (matches CSS radial)
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    lx, ly = cx - R * 0.30, cy - R * 0.30
    ldist = np.sqrt((xx - lx) ** 2 + (yy - ly) ** 2) / (R * 1.35)
    t = np.clip(ldist, 0, 1)
    inner = np.array(CIRCLE_INNER, float)
    outer = np.array(CIRCLE_OUTER, float)
    col = inner[None, None, :] * (1 - t[..., None]) + outer[None, None, :] * t[..., None]
    alpha = np.clip((R - dist) + 0.5, 0, 1) * 255          # crisp 1px-feathered edge
    circ = Image.fromarray(np.dstack([col, alpha]).astype(np.uint8), "RGBA")

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([cx - R, cy - R, cx + R, cy + R], fill=GLOW + (170,))
    glow = glow.filter(ImageFilter.GaussianBlur(pad * 0.45))

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out = Image.alpha_composite(out, glow)
    out = Image.alpha_composite(out, circ)
    return out


def stars(draw, w, h, coords):
    for (x, y, r) in coords:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 230))


def social(path, w, h, title_lines, title_font, subtitle, sub_lines=None,
           kicker=None, jpeg=True):
    base = vgradient(w, h, BG_STOPS).convert("RGBA")
    draw = ImageDraw.Draw(base)
    # subtle starfield (theme-478)
    stars(draw, w, h, [(int(w*0.62), int(h*0.18), 2), (int(w*0.74), int(h*0.30), 1.5),
                       (int(w*0.83), int(h*0.20), 2), (int(w*0.90), int(h*0.42), 1.5),
                       (int(w*0.69), int(h*0.55), 1.5), (int(w*0.55), int(h*0.12), 1.5)])

    # breathing circle, right side
    d = int(h * 0.66)
    pad = int(d * 0.42)
    tile = glow_circle(d, pad)
    cx = int(w * 0.80) - tile.width // 2
    cy = h // 2 - tile.height // 2
    base.alpha_composite(tile, (cx, cy))

    # text, left side
    x = int(w * 0.075)
    tf = font(title_font, int(h * 0.115))
    sf = font(SEMI, int(h * 0.052))
    kf = font(REG, int(h * 0.038))

    total_h = len(title_lines) * (tf.size + 8)
    if kicker:
        total_h += kf.size + 18
    sub_all = (sub_lines or [subtitle])
    total_h += 22 + len(sub_all) * (sf.size + 6)
    y = (h - total_h) // 2

    if kicker:
        draw.text((x, y), kicker, font=kf, fill=TEXT_SOFT)
        y += kf.size + 18
    for line in title_lines:
        draw.text((x, y), line, font=tf, fill=TEXT)
        y += tf.size + 8
    y += 22
    for line in sub_all:
        draw.text((x, y), line, font=sf, fill=TEXT_SOFT)
        y += sf.size + 6

    if jpeg:
        base.convert("RGB").save(os.path.join(OUT, path), "JPEG", quality=88, optimize=True)
    else:
        base.save(os.path.join(OUT, path))
    print("wrote", path, f"{w}x{h}")


def icon(path, size, wordmark=False):
    base = vgradient(size, size, BG_STOPS).convert("RGBA")
    d = int(size * 0.56)          # circle within central safe zone (maskable-safe)
    pad = int(d * 0.40)
    tile = glow_circle(d, pad)
    off_y = int(-size * 0.04) if wordmark else 0
    base.alpha_composite(tile, (size // 2 - tile.width // 2,
                                size // 2 - tile.height // 2 + off_y))
    if wordmark:
        draw = ImageDraw.Draw(base)
        f = font(SEMI, int(size * 0.10))
        txt = "BREATHE"
        bb = draw.textbbox((0, 0), txt, font=f)
        tw = bb[2] - bb[0]
        draw.text(((size - tw) // 2, int(size * 0.80)), txt, font=f, fill=TEXT)
    base.save(os.path.join(OUT, path))
    print("wrote", path, f"{size}x{size}")


# --- Generate ----------------------------------------------------------------
social("og-breathing-timer.jpg", 1200, 630,
       ["Help Me", "Breathe"], LIGHT,
       None, sub_lines=["Guided breathing exercises for",
                        "sleep, stress & focus — free"])

social("twitter-breathing-timer.jpg", 1200, 600,
       ["Help Me", "Breathe"], LIGHT,
       None, sub_lines=["Guided breathing exercises for",
                        "sleep, stress & focus — free"])

social("4-7-8-breathing-guide-og.jpg", 1200, 630,
       ["4-7-8 Breathing", "Technique"], LIGHT,
       None, kicker="STEP-BY-STEP GUIDE",
       sub_lines=["Fall asleep faster with a guided", "timer and audio cues"])

icon("logo.png", 512, wordmark=True)
icon("icon-512.png", 512)
icon("icon-192.png", 192)
icon("apple-touch-icon.png", 180)

print("done")

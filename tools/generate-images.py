#!/usr/bin/env python3
"""
Generates the brand / social / PWA images for Help Me Breathe.

Social (Open Graph / Twitter) images are MANIFEST-DRIVEN: to add an image for a
new page you only edit tools/og-manifest.json — never this file.

    python tools/generate-images.py                                  # everything
    python tools/generate-images.py --only images/og/box-breathing.jpg
    python tools/generate-images.py --check                          # CI freshness gate

Manifest entry (array of objects in tools/og-manifest.json):

    {
      "file": "images/og/box-breathing.jpg",   # path relative to the repo root
      "size": [1200, 630],                     # [width, height] in px
      "theme": "box",                          # see THEMES below
      "layout": "social",                      # "social" (default) or "pin"
      "kicker": "BOX BREATHING · 4-4-4-4",     # optional small-caps eyebrow
      "title_lines": ["Box Breathing", "Timer & Guide"],
      "sub_lines": ["one or two", "short lines"],
      "max_kb": 150                            # optional size budget (default 150)
    }

`theme` mirrors the body.theme-* palettes in css/styles.css, so an image always
matches the page it fronts: 478 | box | coherent | sigh | extended | triangle |
wim | neutral. Titles auto-shrink to stay clear of the glowing circle, so long
headlines are safe. Non-technique pages (about / pro / legal) use the extra
"neutral" dark-slate theme.

`layout` picks the composition:
    social  1200x630 landscape — text left, circle right (Open Graph / Twitter)
    pin     1000x1500 portrait — text top, circle centred, wordmark at the foot
            (Pinterest). Every pin carries the "helpmebreath.com" wordmark.

JPEGs are written with the highest quality that still fits `max_kb`, so a busy
image simply lands a little softer instead of blowing the budget.

Fixed (non-manifest) outputs, all in the 4-7-8 indigo theme:
    logo.png              512x512  Organization logo (schema.org)
    icon-192.png          192x192  PWA icon
    icon-512.png          512x512  PWA icon
    apple-touch-icon.png  180x180  iOS home-screen icon
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST_PATH = os.path.join(ROOT, "tools", "og-manifest.json")

TEXT = (255, 255, 255)

# --- Themes (from the body.theme-* blocks in css/styles.css) -----------------
# bg    : the 3 stops of the CSS linear-gradient(180deg, ...)
# accent: --theme-primary  (circle outer + glow)
# soft  : --theme-secondary (kicker / sub text)
# inner : circle highlight — a slightly lightened `soft`
THEMES = {
    "478": {
        "bg": [(30, 27, 75), (49, 46, 129), (67, 56, 202)],
        "accent": (139, 92, 246),
        "soft": (199, 210, 254),
        "inner": (210, 218, 255),
        "decor": "stars",
    },
    "box": {
        "bg": [(6, 78, 59), (6, 95, 70), (4, 120, 87)],
        "accent": (34, 197, 94),
        "soft": (167, 243, 208),
        "inner": (184, 246, 217),
        "decor": "leaves",
    },
    "coherent": {
        "bg": [(131, 24, 67), (159, 18, 57), (190, 18, 60)],
        "accent": (236, 72, 153),
        "soft": (254, 205, 211),
        "inner": (254, 215, 220),
        "decor": "ripples",
    },
    # #0c4a6e -> #075985 -> #0369a1 (the ramp ends one step darker than it used
    # to; see the contrast note above body.theme-triangle in css/styles.css)
    "triangle": {
        "bg": [(12, 74, 110), (7, 89, 133), (3, 105, 161)],
        "accent": (56, 189, 248),
        "soft": (186, 230, 253),
        "inner": (199, 235, 253),
        "decor": "clouds",
    },
    # #7f1d1d -> #9a3412 -> #b45309 (sunrise red-to-orange; the old light amber
    # ramp failed contrast and was replaced in css/styles.css)
    "wim": {
        "bg": [(127, 29, 29), (154, 52, 18), (180, 83, 9)],
        "accent": (251, 191, 36),
        "soft": (254, 215, 170),
        "inner": (254, 223, 186),
        "decor": "rays",
    },
    # #042f2e -> #134e4a -> #115e59
    "sigh": {
        "bg": [(4, 47, 46), (19, 78, 74), (17, 94, 89)],
        "accent": (45, 212, 191),
        "soft": (204, 251, 241),
        "inner": (214, 252, 245),
        "decor": "ripples",
    },
    # #431407 -> #7c2d12 -> #92400e
    "extended": {
        "bg": [(67, 20, 7), (124, 45, 18), (146, 64, 14)],
        "accent": (245, 158, 11),
        "soft": (252, 211, 77),
        "inner": (254, 226, 160),
        "decor": "rays",
    },
    "neutral": {
        "bg": [(15, 23, 42), (30, 41, 59), (51, 65, 85)],
        "accent": (139, 92, 246),
        "soft": (203, 213, 225),
        "inner": (215, 223, 235),
        "decor": "stars",
    },
}

# --- Fonts -------------------------------------------------------------------
# Segoe UI on Windows (~Quicksand), with graceful fallbacks so the script also
# runs on CI/Linux where those files do not exist.
FONT_DIRS = [
    "C:/Windows/Fonts/",
    os.path.expandvars("%LOCALAPPDATA%/Microsoft/Windows/Fonts/"),
    "/usr/share/fonts/truetype/dejavu/",
    "/usr/share/fonts/truetype/liberation/",
    "/usr/share/fonts/truetype/freefont/",
    "/usr/share/fonts/TTF/",
    "/Library/Fonts/",
    "/System/Library/Fonts/Supplemental/",
]
FONT_FILES = {
    "light": ["segoeuil.ttf", "DejaVuSans-ExtraLight.ttf", "LiberationSans-Regular.ttf",
              "DejaVuSans.ttf", "Helvetica.ttc"],
    "semilight": ["segoeuisl.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf",
                  "FreeSans.ttf", "Helvetica.ttc"],
    "regular": ["segoeui.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf",
                "FreeSans.ttf", "Helvetica.ttc"],
    "bold": ["segoeuib.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf",
             "FreeSansBold.ttf"],
}
_font_cache = {}
_font_warned = set()


def font(role, size):
    """Return a font for `role` at `size`, falling back to PIL's default."""
    size = max(8, int(size))
    key = (role, size)
    if key in _font_cache:
        return _font_cache[key]
    for name in FONT_FILES[role]:
        for directory in FONT_DIRS:
            path = os.path.join(directory, name)
            if os.path.isfile(path):
                try:
                    f = ImageFont.truetype(path, size)
                except OSError:
                    continue
                _font_cache[key] = f
                return f
    if role not in _font_warned:
        _font_warned.add(role)
        print(f"note: no font file found for '{role}' - using PIL default font",
              file=sys.stderr)
    try:
        f = ImageFont.load_default(size=size)      # Pillow >= 10.1
    except TypeError:
        f = ImageFont.load_default()
    _font_cache[key] = f
    return f


_measure = ImageDraw.Draw(Image.new("RGB", (8, 8)))


def text_width(text, f):
    return _measure.textlength(text, font=f)


def fit_size(lines, role, start, min_size, max_width):
    """Largest size <= start where every line fits in max_width."""
    size = int(start)
    lines = [l for l in lines if l]
    if not lines:
        return size
    while size > min_size:
        f = font(role, size)
        if max(text_width(l, f) for l in lines) <= max_width:
            break
        size -= 1
    return size


def wrap_to_width(lines, f, max_width):
    """Greedy word wrap; an unbreakable single word is left long."""
    out = []
    for line in lines:
        cur = ""
        for word in line.split():
            trial = f"{cur} {word}".strip()
            if cur and text_width(trial, f) > max_width:
                out.append(cur)
                cur = word
            else:
                cur = trial
        if cur:
            out.append(cur)
    return out


def fit_block(lines, role, start, min_size, max_width):
    """Shrink `lines` to fit max_width; word-wrap only as a last resort.

    Author-supplied line breaks win: the font shrinks first (down to
    min_size) and lines are only re-wrapped if they would still overflow.
    Returns (size, lines).
    """
    lines = [l for l in lines if l]
    if not lines:
        return int(start), []
    size = fit_size(lines, role, start, min_size, max_width)
    f = font(role, size)
    if max(text_width(l, f) for l in lines) > max_width:
        lines = wrap_to_width(lines, f, max_width)
        size = fit_size(lines, role, size, 10, max_width)
        f = font(role, size)
        lines = wrap_to_width(lines, f, max_width)
    return size, lines


# --- Painting ----------------------------------------------------------------
def vgradient(w, h, stops):
    ys = np.linspace(0, 1, h)
    pos = np.linspace(0, 1, len(stops))
    cols = np.array(stops, dtype=float)
    r = np.interp(ys, pos, cols[:, 0])
    g = np.interp(ys, pos, cols[:, 1])
    b = np.interp(ys, pos, cols[:, 2])
    row = np.stack([r, g, b], axis=1)
    img = np.repeat(row[:, None, :], w, axis=1).astype(np.uint8)
    return Image.fromarray(img, "RGB")


def glow_circle(diameter, pad, theme):
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
    inner = np.array(theme["inner"], float)
    outer = np.array(theme["accent"], float)
    col = inner[None, None, :] * (1 - t[..., None]) + outer[None, None, :] * t[..., None]
    alpha = np.clip((R - dist) + 0.5, 0, 1) * 255          # crisp 1px-feathered edge
    circ = Image.fromarray(np.dstack([col, alpha]).astype(np.uint8), "RGBA")

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([cx - R, cy - R, cx + R, cy + R], fill=tuple(theme["accent"]) + (170,))
    glow = glow.filter(ImageFilter.GaussianBlur(pad * 0.45))

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out = Image.alpha_composite(out, glow)
    out = Image.alpha_composite(out, circ)
    return out


def decorate(base, w, h, theme, layout="social"):
    """Faint background decoration, echoing the .nature-bg layer per theme.

    `layout` moves the decoration to suit the composition: on a landscape
    social card everything sits to the right of the text, on a portrait pin it
    orbits the centred circle instead.
    """
    kind = theme["decor"]
    soft = tuple(theme["soft"])
    pin = layout == "pin"
    # Where the circle sits, so ripples and rays radiate from it.
    fcx, fcy = (0.5, 0.60) if pin else (0.80, 0.5)
    ring = 0.22 if pin else 0.33

    if kind == "stars":
        draw = ImageDraw.Draw(base)
        spots = ([(0.16, 0.10, 2), (0.82, 0.14, 2), (0.26, 0.30, 1.5),
                  (0.88, 0.34, 1.5), (0.11, 0.62, 1.5), (0.90, 0.68, 2),
                  (0.20, 0.86, 1.5), (0.78, 0.90, 1.5)] if pin else
                 [(0.62, 0.18, 2), (0.74, 0.30, 1.5), (0.83, 0.20, 2),
                  (0.90, 0.42, 1.5), (0.69, 0.55, 1.5), (0.55, 0.12, 1.5)])
        for (fx, fy, r) in spots:
            x, y = int(w * fx), int(h * fy)
            draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 230))
        return

    # Everything else is painted through a blurred *mask* (blurring an RGBA
    # layer directly would bleed transparent black into the color channels and
    # the decoration would come out muddy).
    def stamp(color, alpha, blur, paint):
        mask = Image.new("L", (w, h), 0)
        paint(ImageDraw.Draw(mask))
        if blur:
            mask = mask.filter(ImageFilter.GaussianBlur(blur))
        if alpha < 255:
            mask = mask.point(lambda v: v * alpha // 255)
        base.paste(Image.new("RGB", (w, h), color), (0, 0), mask)

    unit = min(w, h) if pin else h

    if kind == "leaves":
        spots = ([(0.13, 0.12, 0.045, 0), (0.86, 0.20, 0.036, 1),
                  (0.20, 0.85, 0.040, 1), (0.88, 0.80, 0.034, 0),
                  (0.10, 0.45, 0.030, 1)] if pin else
                 [(0.60, 0.17, 0.055, 0), (0.74, 0.30, 0.040, 1),
                  (0.88, 0.19, 0.048, 1), (0.66, 0.80, 0.042, 0),
                  (0.91, 0.74, 0.036, 1)])

        def paint(d):
            for (fx, fy, fr, rot) in spots:
                r = unit * fr
                x, y = w * fx, h * fy
                box = ([x - r, y - r * 0.5, x + r, y + r * 0.5] if rot
                       else [x - r * 0.5, y - r, x + r * 0.5, y + r])
                d.ellipse(box, fill=255)
        stamp(soft, 40, unit * 0.006, paint)
    elif kind == "ripples":
        def paint(d):
            cx, cy = w * fcx, h * fcy
            for k in (1.10, 1.28, 1.48):
                r = min(w, h) * ring * k * (1.5 if pin else 1.0)
                d.ellipse([cx - r, cy - r, cx + r, cy + r],
                          outline=255, width=max(1, int(unit * 0.005)))
        stamp(soft, 52, unit * 0.003, paint)
    elif kind == "clouds":
        spots = ([(0.16, 0.11, 0.055), (0.84, 0.17, 0.045),
                  (0.22, 0.88, 0.050), (0.86, 0.82, 0.038)] if pin else
                 [(0.60, 0.16, 0.075), (0.86, 0.24, 0.060),
                  (0.70, 0.82, 0.065), (0.93, 0.70, 0.048)])

        def paint(d):
            for (fx, fy, fr) in spots:
                r = unit * fr
                x, y = w * fx, h * fy
                d.ellipse([x - r * 1.5, y - r * 0.6, x + r * 1.5, y + r * 0.6], fill=255)
                d.ellipse([x - r * 0.7, y - r, x + r * 0.7, y + r * 0.4], fill=255)
        stamp(soft, 34, unit * 0.014, paint)
    elif kind == "rays":
        def paint(d):
            cx, cy = w * fcx, h * fcy
            for i in range(12):
                a = math.radians(i * 30 + 15)
                if pin:
                    r0, r1 = min(w, h) * 0.36, min(w, h) * 0.58
                else:
                    r0, r1 = h * 0.40, h * 0.64
                d.line([cx + math.cos(a) * r0, cy + math.sin(a) * r0,
                        cx + math.cos(a) * r1, cy + math.sin(a) * r1],
                       fill=255, width=max(1, int(unit * 0.012)))
        stamp((255, 250, 235), 70, unit * 0.010, paint)


def entry_parts(entry):
    """Shared validation for both layouts."""
    rel = normalize(entry["file"])
    w, h = int(entry["size"][0]), int(entry["size"][1])
    theme_name = entry.get("theme", "478")
    if theme_name not in THEMES:
        raise SystemExit(f"{rel}: unknown theme '{theme_name}' "
                         f"(pick one of {', '.join(sorted(THEMES))})")
    title_lines = [l for l in entry.get("title_lines", []) if l]
    if not title_lines:
        raise SystemExit(f"{rel}: title_lines is required")
    return {
        "rel": rel,
        "w": w,
        "h": h,
        "theme": THEMES[theme_name],
        "title_lines": title_lines,
        "sub_lines": [l for l in (entry.get("sub_lines") or []) if l],
        "kicker_lines": [entry["kicker"]] if entry.get("kicker") else [],
        "max_bytes": int(entry.get("max_kb", 150)) * 1024,
    }


def render_entry(entry):
    """Render one manifest entry with the layout it asks for."""
    layout = str(entry.get("layout", "social")).lower()
    if layout == "pin":
        return render_pin(entry)
    if layout not in ("social", ""):
        raise SystemExit(f"{normalize(entry['file'])}: unknown layout '{layout}' "
                         f"(use 'social' or 'pin')")
    return render_social(entry)


def render_pin(entry):
    """Portrait Pinterest card: text at the top, circle centred, wordmark below."""
    p = entry_parts(entry)
    rel, w, h, theme = p["rel"], p["w"], p["h"], p["theme"]
    title_lines, sub_lines = p["title_lines"], p["sub_lines"]
    kicker_lines = p["kicker_lines"]

    base = vgradient(w, h, theme["bg"]).convert("RGBA")
    decorate(base, w, h, theme, layout="pin")

    # Circle, centred and low enough to leave the top third for the headline.
    d = int(w * 0.50)
    pad = int(d * 0.42)
    tile = glow_circle(d, pad, theme)
    circle_cy = int(h * 0.62)
    base.alpha_composite(tile, (w // 2 - tile.width // 2, circle_cy - tile.height // 2))

    draw = ImageDraw.Draw(base)
    max_text_w = int(w * 0.84)

    ts, title_lines = fit_block(title_lines, "light", int(w * 0.098),
                                int(w * 0.052), max_text_w)
    ss, sub_lines = fit_block(sub_lines, "semilight", int(w * 0.044),
                              int(w * 0.028), max_text_w)
    ks, kicker_lines = fit_block(kicker_lines, "regular", int(w * 0.030),
                                 int(w * 0.021), max_text_w)
    ws = int(w * 0.028)
    wf = font("regular", ws)

    def centered(lines, f, y, fill, leading):
        for line in lines:
            tw = text_width(line, f)
            draw.text(((w - tw) / 2, y), line, font=f, fill=fill)
            y += leading
        return y

    # The whole text block lives between the top margin and a clear gutter
    # above the circle. Long headlines shrink rather than crowd the circle.
    top_limit = int(h * 0.055)
    bottom_limit = circle_cy - d // 2 - int(h * 0.050)
    available = bottom_limit - top_limit

    def block_height(title_size):
        total = len(title_lines) * (title_size + 10)
        if kicker_lines:
            total += len(kicker_lines) * (ks + 6) + 16
        if sub_lines:
            total += 20 + len(sub_lines) * (ss + 8)
        return total

    while ts > int(w * 0.046) and block_height(ts) > available:
        ts -= 2

    tf, sf, kf = font("light", ts), font("semilight", ss), font("regular", ks)
    block = block_height(ts)
    y = top_limit + max(0, (available - block) // 2)

    if kicker_lines:
        y = centered(kicker_lines, kf, y, theme["soft"], ks + 6) + 16
    y = centered(title_lines, tf, y, TEXT, ts + 10)
    if sub_lines:
        y += 20
        centered(sub_lines, sf, y, theme["soft"], ss + 8)

    # Wordmark — every pin carries it, because pins get re-shared without a link.
    mark = "helpmebreath.com"
    mw = text_width(mark, wf)
    draw.text(((w - mw) / 2, h - int(h * 0.075)), mark, font=wf, fill=theme["soft"])

    save(base, rel, w, h, p["max_bytes"])
    return rel


def render_social(entry):
    """Landscape Open Graph card: text left, circle right."""
    p = entry_parts(entry)
    rel, w, h, theme = p["rel"], p["w"], p["h"], p["theme"]
    title_lines, sub_lines = p["title_lines"], p["sub_lines"]
    kicker_lines = p["kicker_lines"]

    base = vgradient(w, h, theme["bg"]).convert("RGBA")
    decorate(base, w, h, theme)

    # breathing circle, right side
    d = int(h * 0.66)
    pad = int(d * 0.42)
    tile = glow_circle(d, pad, theme)
    circle_cx = int(w * 0.80)
    base.alpha_composite(tile, (circle_cx - tile.width // 2, h // 2 - tile.height // 2))

    # --- text block, left side ---------------------------------------------
    x = int(w * 0.075)
    # stay inside the left 62% AND keep a clear gutter before the circle
    right_limit = min(w * 0.62, circle_cx - d / 2 - w * 0.045)
    max_text_w = right_limit - x

    title_start = int(h * 0.115)
    if len(title_lines) >= 3:
        title_start = int(title_start * 0.85)      # 3 lines: shrink to keep balance
    title_floor = int(h * 0.062)
    ts, title_lines = fit_block(title_lines, "light", title_start, title_floor, max_text_w)
    ss, sub_lines = fit_block(sub_lines, "semilight", int(h * 0.052),
                              int(h * 0.032), max_text_w)
    ks, kicker_lines = fit_block(kicker_lines, "regular", int(h * 0.038),
                                 int(h * 0.024), max_text_w)

    def block_height(title_size):
        total = len(title_lines) * (title_size + 8)
        if kicker_lines:
            total += len(kicker_lines) * (ks + 6) + 12
        if sub_lines:
            total += 22 + len(sub_lines) * (ss + 6)
        return total

    while ts > int(h * 0.045) and block_height(ts) > h * 0.90:
        ts -= 1                                     # clipping guard for tall blocks

    tf, sf, kf = font("light", ts), font("semilight", ss), font("regular", ks)
    draw = ImageDraw.Draw(base)
    y = (h - block_height(ts)) // 2
    if kicker_lines:
        for line in kicker_lines:
            draw.text((x, y), line, font=kf, fill=theme["soft"])
            y += ks + 6
        y += 12
    for line in title_lines:
        draw.text((x, y), line, font=tf, fill=TEXT)
        y += ts + 8
    if sub_lines:
        y += 22
        for line in sub_lines:
            draw.text((x, y), line, font=sf, fill=theme["soft"])
            y += ss + 6

    save(base, rel, w, h, p["max_bytes"])
    return rel


def render_icon(entry):
    rel = normalize(entry["file"])
    size = int(entry["size"][0])
    theme = THEMES[entry.get("theme", "478")]
    base = vgradient(size, size, theme["bg"]).convert("RGBA")
    d = int(size * 0.56)          # circle within central safe zone (maskable-safe)
    pad = int(d * 0.40)
    tile = glow_circle(d, pad, theme)
    wordmark = entry.get("wordmark", False)
    off_y = int(-size * 0.04) if wordmark else 0
    base.alpha_composite(tile, (size // 2 - tile.width // 2,
                                size // 2 - tile.height // 2 + off_y))
    if wordmark:
        draw = ImageDraw.Draw(base)
        f = font("semilight", int(size * 0.10))
        txt = "BREATHE"
        bb = draw.textbbox((0, 0), txt, font=f)
        tw = bb[2] - bb[0]
        draw.text(((size - tw) // 2, int(size * 0.80)), txt, font=f, fill=TEXT)
    save(base, rel, size, size)
    return rel


def save(img, rel, w, h, max_bytes=150 * 1024):
    """Write the image, staying inside `max_bytes` for JPEGs.

    Social images are fetched by crawlers on every share, so a 400 KB card is a
    real cost. Quality steps down from 90 until the file fits; a 1000x1500 pin
    normally lands around quality 80.
    """
    out = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.splitext(rel)[1].lower() in (".jpg", ".jpeg"):
        rgb = img.convert("RGB")
        quality = 90
        while True:
            rgb.save(out, "JPEG", quality=quality, optimize=True, progressive=True)
            size = os.path.getsize(out)
            if size <= max_bytes or quality <= 55:
                break
            quality -= 5
        note = f" {size // 1024}KB q{quality}"
        if size > max_bytes:
            print(f"warning: {rel} is {size // 1024}KB, over the "
                  f"{max_bytes // 1024}KB budget even at quality {quality}",
                  file=sys.stderr)
    else:
        img.save(out)
        note = f" {os.path.getsize(out) // 1024}KB"
    print(f"wrote {rel} {w}x{h}{note}")


# --- Fixed icon outputs (not manifest-driven) --------------------------------
ICONS = [
    {"file": "images/logo.png", "size": [512, 512], "theme": "478", "wordmark": True},
    {"file": "images/icon-512.png", "size": [512, 512], "theme": "478"},
    {"file": "images/icon-192.png", "size": [192, 192], "theme": "478"},
    {"file": "images/apple-touch-icon.png", "size": [180, 180], "theme": "478"},
]


def normalize(path):
    p = str(path).replace("\\", "/").lstrip("./")
    return p


def load_manifest(path):
    if not os.path.isfile(path):
        raise SystemExit(f"manifest not found: {path}")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            entries = json.load(fh)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path}: invalid JSON - {exc}")
    if not isinstance(entries, list):
        raise SystemExit(f"{path}: expected a JSON array of entries")
    seen = set()
    for e in entries:
        if not isinstance(e, dict):
            raise SystemExit(f"{path}: every entry must be an object, got {e!r}")
        rel = normalize(e.get("file", ""))
        if not rel or not isinstance(e.get("size"), list) or len(e["size"]) != 2:
            raise SystemExit(f"{path}: each entry needs 'file' and 'size': [w, h]. Got: {e}")
        if rel in seen:
            raise SystemExit(f"{path}: duplicate file '{rel}'")
        seen.add(rel)
    return entries


def check(entries, manifest_path):
    mtime = os.path.getmtime(manifest_path)
    problems = []
    for e in entries:
        rel = normalize(e["file"])
        full = os.path.join(ROOT, rel)
        if not os.path.isfile(full):
            problems.append(f"missing  {rel}")
        elif os.path.getmtime(full) < mtime:
            problems.append(f"stale    {rel}")
    if problems:
        print("\n".join(problems))
        print(f"{len(problems)} of {len(entries)} manifest outputs need regenerating "
              f"- run: python tools/generate-images.py")
        return 1
    print(f"ok: {len(entries)} manifest outputs present and newer than the manifest")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", action="append", metavar="PATH",
                    help="regenerate just this output (repeatable), "
                         "e.g. --only images/og/box-breathing.jpg")
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if a manifest output is missing or older "
                         "than the manifest (for CI)")
    ap.add_argument("--manifest", default=MANIFEST_PATH,
                    help="path to og-manifest.json")
    ap.add_argument("--list", action="store_true", help="list every output and exit")
    args = ap.parse_args(argv)

    entries = load_manifest(args.manifest)

    if args.check:
        return check(entries, args.manifest)

    jobs = [(render_entry, e) for e in entries] + [(render_icon, e) for e in ICONS]

    if args.list:
        for _, e in jobs:
            print(normalize(e["file"]))
        return 0

    if args.only:
        wanted = {normalize(p) for p in args.only}
        jobs = [j for j in jobs if normalize(j[1]["file"]) in wanted]
        found = {normalize(j[1]["file"]) for j in jobs}
        for miss in sorted(wanted - found):
            print(f"error: '{miss}' is not in the manifest or icon list "
                  f"(see --list)", file=sys.stderr)
        if not jobs:
            return 1

    for fn, entry in jobs:
        fn(entry)
    print(f"done - {len(jobs)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

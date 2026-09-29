"""Outline the "Help Me Breathe" wordmark to SVG path data.

Figtree is a variable font; this pins wght 500 (the wordmark weight) and
writes tools/brand/wordmark.json: one path in font units scaled to a 1px
font size, baseline at y=0, plus its advance width. mark.mjs scales it. Run
again only if the wordmark text, weight or tracking changes:

    python tools/brand/outline-wordmark.py
"""
import json, os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TEXT, WEIGHT, TRACKING = 'Help Me Breathe', 500, -0.012
SIZE = 100  # outline at 100 units per em; mark.mjs divides by 100

font = instantiateVariableFont(TTFont(os.path.join(ROOT, 'fonts', 'figtree-latin.woff2')), {'wght': WEIGHT})
gs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm
sc, x, parts = SIZE / upm, 0.0, []
for ch in TEXT:
    g = gs[cmap[ord(ch)]]
    pen = SVGPathPen(gs, ntos=lambda v: ('%.2f' % v).rstrip('0').rstrip('.'))
    g.draw(TransformPen(pen, (sc, 0, 0, -sc, x, 0)))
    if pen.getCommands():
        parts.append(pen.getCommands())
    x += g.width * sc + TRACKING * SIZE
json.dump({'text': TEXT, 'weight': WEIGHT, 'tracking': TRACKING, 'unitsPerEm': SIZE,
           'advance': round(x - TRACKING * SIZE, 2), 'capHeight': round(font['OS/2'].sCapHeight * sc, 2),
           'd': ' '.join(parts)}, open(os.path.join(HERE, 'wordmark.json'), 'w'))
print('wordmark.json written, advance', round(x, 2))

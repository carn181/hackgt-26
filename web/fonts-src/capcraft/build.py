"""Build Capcraft.ttf / .woff2 from the bitmap definitions in glyphs.py.

Rebuild (from web/fonts-src/capcraft):
    pip install fonttools brotli
    python build.py ../../public/fonts   # then delete the extra .ttf if you only want the woff2

Each lit pixel becomes a 128x128-unit square (UPM 1024 = 8 rows), shared edges
are cancelled, and the remaining edges are traced into clockwise outer /
counter-clockwise inner TrueType contours. At font-size 8n px every font
pixel is exactly n CSS px, so 16/24/32 px render pixel-crisp.
"""
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from glyphs import G, ALIASES, SPACE_ADVANCE, LETTER_SPACING

PX = 128
UPM = 8 * PX
ASC, DESC, GAP = 7 * PX, -1 * PX, 1 * PX


def trace(rows):
    """Directed boundary edges of the lit region -> list of closed loops (pixel units, y-up)."""
    edges = set()
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch != '#':
                continue
            x0, x1, y0, y1 = c, c + 1, 6 - r, 7 - r
            for e in (((x0, y0), (x0, y1)), ((x0, y1), (x1, y1)), ((x1, y1), (x1, y0)), ((x1, y0), (x0, y0))):
                rev = (e[1], e[0])
                if rev in edges:
                    edges.remove(rev)
                else:
                    edges.add(e)
    out = {}
    for a, b in edges:
        out.setdefault(a, []).append(b)
    loops = []
    while out:
        start = next(iter(out))
        loop = [start]
        prev, cur = None, start
        while True:
            nxts = out[cur]
            if len(nxts) == 1 or prev is None:
                nxt = nxts[0]
            else:
                # Diagonal touch: take the sharpest clockwise (right) turn so
                # corner-touching pixels stay separate contours.
                dx, dy = cur[0] - prev[0], cur[1] - prev[1]
                right = (dy, -dx)
                nxt = next((n for n in nxts if (n[0] - cur[0], n[1] - cur[1]) == right), nxts[0])
            nxts.remove(nxt)
            if not nxts:
                del out[cur]
            prev, cur = cur, nxt
            if cur == start:
                break
            loop.append(cur)
        # drop collinear points
        simp = []
        n = len(loop)
        for i in range(n):
            p, q, s = loop[i - 1], loop[i], loop[(i + 1) % n]
            if (q[0] - p[0]) * (s[1] - q[1]) - (q[1] - p[1]) * (s[0] - q[0]) != 0:
                simp.append(q)
        loops.append(simp)
    return loops


def glyph_from_loops(loops):
    pen = TTGlyphPen(None)
    for loop in loops:
        pen.moveTo((loop[0][0] * PX, loop[0][1] * PX))
        for p in loop[1:]:
            pen.lineTo((p[0] * PX, p[1] * PX))
        pen.closePath()
    return pen.glyph()


def main(outdir):
    names = {'.notdef': None, 'space': None}
    cmap = {0x20: 'space', 0xA0: 'space'}
    glyf, hmtx = {}, {}

    notdef = ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#####', '.....']
    glyf['.notdef'] = glyph_from_loops(trace(notdef))
    hmtx['.notdef'] = (6 * PX, 0)
    glyf['space'] = TTGlyphPen(None).glyph()
    hmtx['space'] = (SPACE_ADVANCE * PX, 0)

    for ch, rows in G.items():
        name = 'uni%04X' % ord(ch)
        names[name] = ch
        cmap[ord(ch)] = name
        glyf[name] = glyph_from_loops(trace(rows))
        w = len(rows[0])
        xmin = min((c for row in rows for c, v in enumerate(row) if v == '#'), default=0)
        hmtx[name] = ((w + LETTER_SPACING) * PX, xmin * PX)
    for alias, target in ALIASES.items():
        cmap[ord(alias)] = 'space' if target == ' ' else 'uni%04X' % ord(target)

    order = list(names)
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyf)
    fb.setupHorizontalMetrics(hmtx)
    fb.setupHorizontalHeader(ascent=ASC, descent=DESC, lineGap=GAP)
    fb.setupNameTable({
        'familyName': 'Capcraft',
        'styleName': 'Regular',
        'uniqueFontIdentifier': 'Capcraft-Regular-1.0',
        'fullName': 'Capcraft Regular',
        'psName': 'Capcraft-Regular',
        'version': 'Version 1.000',
        'description': 'Proportional 8-row pixel font for the hackgt-26 sound-awareness HUD.',
    })
    fb.setupOS2(sTypoAscender=ASC, sTypoDescender=DESC, sTypoLineGap=GAP,
                usWinAscent=ASC, usWinDescent=-DESC, sxHeight=5 * PX, sCapHeight=7 * PX,
                achVendID='HGT2', fsType=0)
    fb.setupPost()
    ttf = f'{outdir}/capcraft.ttf'
    fb.save(ttf)
    f = TTFont(ttf)
    f.flavor = 'woff2'
    f.save(f'{outdir}/capcraft.woff2')
    print(len(order), 'glyphs')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')

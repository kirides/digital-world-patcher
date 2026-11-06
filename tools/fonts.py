"""Bitmap fonts of Digimon World DS / Dawn / Dusk (dat/font/*.ntt) and glyph synthesis.

File: u32 size-4, u16 cell width, u16 cell height, u16 bytes per row, u16 0, then glyphs of
u16 advance width + 4bpp pixels stored as 8x8 tiles (row-major).  Pixel 0 = empty; fonts use
one value for the drop shadow and one or more values for ink (the bold fonts use a vertical
gradient, one value per row).
"""
import collections, struct, unicodedata

class Font:
    def __init__(self, data):
        self.data = bytearray(data)
        self.cw, self.ch, self.bpr = struct.unpack_from('<HHH', data, 4)
        self.gs = 2 + self.ch * self.bpr
        self.count = (len(data) - 8) // self.gs
        recs = [bytes(self.data[8 + self.gs * i: 8 + self.gs * (i + 1)]) for i in range(self.count)]
        self.placeholder = collections.Counter(recs).most_common(1)[0][0]
        self._shadow = None

    def raw(self, i): return bytes(self.data[8 + self.gs * i: 8 + self.gs * (i + 1)])
    def put_raw(self, i, rec): self.data[8 + self.gs * i: 8 + self.gs * (i + 1)] = rec
    def is_free(self, i): return i < self.count and self.raw(i) == self.placeholder
    def width(self, i): return struct.unpack_from('<H', self.data, 8 + self.gs * i)[0]

    def _off(self, i, x, y):
        tile = (y // 8) * (self.cw // 8) + x // 8
        return 8 + self.gs * i + 2 + tile * 32 + (y % 8) * 4 + (x % 8) // 2

    def get(self, i):
        """glyph i as (width, rows[y][x])"""
        rows = [[(self.data[self._off(i, x, y)] >> (4 * (x & 1))) & 15 for x in range(self.cw)] for y in range(self.ch)]
        return self.width(i), rows

    def put(self, i, width, rows):
        rec = bytearray(self.gs); struct.pack_into('<H', rec, 0, width)
        for y in range(self.ch):
            for x in range(self.cw):
                o = self._off(0, x, y) - 8
                rec[o] |= (rows[y][x] & 15) << (4 * (x & 1))
        self.put_raw(i, bytes(rec))

    # ---- style detection, from a reference glyph (a capital letter)
    def style(self, ref):
        """(shadow value, shadow offsets) that reproduce the reference glyph's shadow."""
        if self._shadow: return self._shadow
        _, rows = self.get(ref)
        vals = collections.Counter(v for r in rows for v in r if v)
        best = None
        for sv in vals:
            ink = [[v != 0 and v != sv for v in r] for r in rows]
            for offs in (((1, 1),), ((0, 1), (1, 1)), ((1, 0), (1, 1)), ((0, 1), (1, 0), (1, 1))):
                sh = self._cast(ink, offs)
                err = sum((rows[y][x] == sv) != sh[y][x] for y in range(self.ch) for x in range(self.cw))
                if best is None or err < best[0]: best = (err, sv, offs)
        self._shadow = best[1], best[2]
        return self._shadow

    def _cast(self, ink, offs):
        sh = [[False] * self.cw for _ in range(self.ch)]
        for y in range(self.ch):
            for x in range(self.cw):
                if ink[y][x]:
                    for dy, dx in offs:
                        yy, xx = y + dy, x + dx
                        if yy < self.ch and xx < self.cw and not ink[yy][xx]: sh[yy][xx] = True
        return sh

    def render(self, ink_vals, sv, offs):
        """ink_vals[y][x] = ink value or 0  ->  rows with the font's shadow added"""
        ink = [[v != 0 for v in r] for r in ink_vals]
        sh = self._cast(ink, offs)
        return [[ink_vals[y][x] or (sv if sh[y][x] else 0) for x in range(self.cw)] for y in range(self.ch)]


def _ink_rows(rows, sv):
    return [[v if v and v != sv else 0 for v in r] for r in rows]

def _row_colors(ink):
    """most common ink value of every row (None for empty rows)"""
    out = []
    for r in ink:
        c = collections.Counter(v for v in r if v)
        out.append(c.most_common(1)[0][0] if c else None)
    return out

def _span(ink):
    ys = [y for y, r in enumerate(ink) if any(r)]
    xs = [x for r in ink for x, v in enumerate(r) if v]
    return (min(ys), max(ys), min(xs), max(xs)) if ys else None

def _squash(ink, k):
    """drop k rows from the body (rows repeating the row above), keep the bottom fixed."""
    top, bot, _, _ = _span(ink)
    mask = [tuple(bool(v) for v in r) for r in ink]
    cand = [y for y in range(top + 2, bot - 1) if mask[y] == mask[y - 1]]
    mid = (top + bot) / 2
    cand.sort(key=lambda y: abs(y - mid))
    drop = set()
    for y in cand:
        if len(drop) == k: break
        if y - 1 not in drop and y + 1 not in drop: drop.add(y)
    if len(drop) < k: return None
    kept = [r for y, r in enumerate(ink) if y not in drop]
    return [[0] * len(ink[0]) for _ in range(k)] + kept

MARKS = {  # mark pattern per combining character, drawn centred above the letter ('#' = ink)
    '̈': None,                       # diaeresis: two dots over the letter's edges (special-cased)
    '́': ['.#', '#.'], '̀': ['#.', '.#'], '̂': ['.#.', '#.#'], '̃': ['.#.#', '#.#.'],
}

def synthesize(font, ch, base_slot, ref_caps, ref_asc, lang_art=None):
    """build glyph `ch` from the base letter in the same font (accented letters), or from pixel art.
    ref_caps / ref_asc: slots of 'A' and 'b' (style and gradient references)."""
    sv, offs = font.style(ref_caps)
    width, rows = font.get(base_slot)
    ink = _ink_rows(rows, sv)
    asc_colors = _row_colors(_ink_rows(font.get(ref_asc)[1], sv))
    caps_colors = _row_colors(_ink_rows(font.get(ref_caps)[1], sv))
    big = font.cw >= 16
    d = 2 if big else 1                                  # dot size
    mark = unicodedata.normalize('NFD', ch)[1:2]
    if mark not in MARKS: return None
    top, bot, x0, x1 = _span(ink)
    need = d + 1 + (1 if big else 0)                     # mark height + gap (+ shadow row)
    if top < need:
        k = need - top
        sq = _squash(ink, k)
        if sq is None: return None
        ink = sq
        top, bot, x0, x1 = _span(ink)
        # recolour by row like an ascender letter so the gradient still runs top to bottom
        if len(set(c for c in asc_colors if c)) > 1:
            ink = [[(asc_colors[y] or v) if v else 0 for v in r] for y, r in enumerate(ink)]
    mc = caps_colors[min(y for y, c in enumerate(caps_colors) if c) + 4] if big else \
        collections.Counter(v for r in ink for v in r if v).most_common(1)[0][0]
    y0 = top - (1 if not big else 2) - d
    if mark == '̈':
        wspan = x1 - x0 + 1
        left = x0 + (1 if wspan >= 5 + 2 * d else 0)
        right = x1 - (1 if wspan >= 5 + 2 * d else 0) - (d - 1)
        if big: right -= 1                                # leave room for the drop shadow column
        for yy in range(y0, y0 + d):
            for xx in list(range(left, left + d)) + list(range(right, right + d)):
                ink[yy][xx] = mc
    else:
        pat = MARKS[mark]
        cx = (x0 + x1) // 2 - len(pat[0]) // 2
        for dy, line in enumerate(pat):
            for dx, c in enumerate(line):
                if c == '#':
                    for sy in range(d if big else 1):
                        for sx in range(d if big else 1):
                            ink[y0 - len(pat) * (d if big else 1) + d + dy * (d if big else 1) + sy][cx + dx * (d if big else 1) + sx] = mc
    return width, font.render(ink, sv, offs)

def from_art(font, art, top, width, ref_caps, ref_asc):
    """pixel art ('#'/'@' = ink) coloured with the font's ascender gradient and shadow."""
    sv, offs = font.style(ref_caps)
    colors = _row_colors(_ink_rows(font.get(ref_asc)[1], sv))
    fallback = collections.Counter(c for c in colors if c).most_common(1)[0][0]
    ink = [[0] * font.cw for _ in range(font.ch)]
    for dy, line in enumerate(art):
        for x, c in enumerate(line[:font.cw]):
            if c in '#@': ink[top + dy][x] = colors[top + dy] or fallback
    return width, font.render(ink, sv, offs)

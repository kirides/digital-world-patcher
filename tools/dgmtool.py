#!/usr/bin/env python3
"""Digimon World DS / Dawn / Dusk translation tool (any Latin-script language).

    dgmtool.py extract   ROM WORKDIR                     dump all messages to WORKDIR/<set>/catalog.json
    dgmtool.py status    WORKDIR/<set> --lang de          translation progress
    dgmtool.py translate WORKDIR/<set> --lang de          machine-translate missing strings (API / local LLM)
    dgmtool.py check     ROM WORKDIR/<set> --lang de      report overflow / unencodable text
    dgmtool.py build     ROM WORKDIR/<set> OUT --lang de  write a patched ROM (for testing)
    dgmtool.py release   --lang de --workdir W --out DIR ROM...   build every ROM and write BPS patches (--mod DIR: add a data mod)
    dgmtool.py shorten   ROM WORKDIR/<set> --lang de      re-translate lines that overflow their box
    dgmtool.py export/import WORKDIR/<set> FILE.csv --lang de       review the table in a spreadsheet

Sets: "dawn" (Dawn and Dusk share identical message data) and "ds" (Digimon World DS).
Per language:  langs/<lang>.json            language profile (name, extra glyphs, style, glossary)
               WORKDIR/<set>/<lang>.json    {"english source": "translation"}
               WORKDIR/<set>/<lang>.overrides.json  optional {"container:index": "translation"}
Digimon World DS has no accented glyphs; they are copied from Dawn's font, so DS needs --dawn-rom.
"""
import argparse, json, os, re, struct, sys, threading, time, urllib.request, urllib.error, zlib, hashlib
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ndsfs import NDS
from fonts import Font, synthesize, from_art
import bps, unicodedata

# --------------------------------------------------------------------------- json helpers
def load(path, default=None):
    if default is not None and not os.path.exists(path): return default
    with open(path, encoding='utf-8') as f: return json.load(f)

def save(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(obj, f, ensure_ascii=False, indent=0)
    os.replace(tmp, path)

# --------------------------------------------------------------------------- language profiles
def load_lang(code):
    p = os.path.join(HERE, 'langs', code + '.json')
    if not os.path.exists(p): sys.exit('no language profile %s (copy langs/de.json and adapt it)' % p)
    lang = load(p); lang.setdefault('code', code)
    return lang

# --------------------------------------------------------------------------- charset
TOKEN = re.compile(r'\{([0-9A-Fa-f]{2,4})\}')
CTRL_NEWLINE, CTRL_PAGE, CTRL_END = 0xFFFD, 0xFFFE, 0xFFFF
NAME_TOKENS = {0xFFED: 48, 0xFFEC: 48}            # player name (estimated width)
VAR_TOKENS = {0xFFF0: 30, 0xFFF1: 30, 0xFFF2: 40}  # numbers / digimon names (estimated)

# Typographic characters no font has -> nearest available glyph (languages can add more)
NORMALIZE = {'’': "'", '‘': "'", '“': '"', '”': '"', '„': '"', '«': '"', '»': '"', '‹': "'", '›': "'",
             '–': '-', '—': '-', '…': '...', ' ': ' ', '→': '->', '€': 'EUR'}

# Accented Latin-1 block as laid out in Dawn/Dusk's font00 (glyph 0x80..), checked visually
LATIN_UPPER = 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ¡¿'      # 0x80..0x9E
LATIN_LOWER = 'àáâãäåæçèéêëìíîïðñòóôõöøùúûüý'         # 0xA0..0xBC
# Unused (placeholder) glyph slots, in allocation order, for a language's extra glyphs
FREE_SLOTS = {'pak': [0x9F, 0xBD, 0xBE, 0xBF, 0x5F] + list(range(0x6C, 0x78)),
              'sdb': [0xCF, 0xED, 0xEE, 0xEF] + list(range(0x84, 0xB0)) + list(range(0xF0, 0x1E0))}
SDB_SHIFT = 0x30          # DS letters (and the copied accent block) sit 0x30 higher than in Dawn

class Charset:
    """glyph index <-> character.  'pak' = Dawn/Dusk layout, 'sdb' = Digimon World DS layout."""
    def __init__(self, kind, lang=None):
        shift = 0 if kind == 'pak' else SDB_SHIFT
        dec = {0x00: ' ', 0x0b: '/', 0x0d: ':', 0x0e: "'", 0x0f: '"', 0x11: ',', 0x12: '.',
               0x13: '!', 0x14: '?', 0x15: '(', 0x16: ')', 0x17: '+', 0x18: '-', 0x19: '='}
        for i in range(10): dec[1 + i] = str(i)
        for i in range(26):
            dec[0x20 + shift + i] = chr(65 + i)
            dec[0x3a + shift + i] = chr(97 + i)
        if kind == 'pak': dec[0x6a] = ';'
        self.base = dict(dec)                           # what the unpatched ROM can show
        for i, c in enumerate(LATIN_UPPER): dec[0x80 + shift + i] = c
        for i, c in enumerate(LATIN_LOWER): dec[0xA0 + shift + i] = c
        self.extra = {}                                 # slot -> glyph spec
        self.letters = [c for c in (lang or {}).get('letters', '')]
        if lang:
            slots = iter(FREE_SLOTS[kind])
            for ch, spec in lang.get('glyphs', {}).items():
                if ch in dec.values(): continue
                s = next(slots); dec[s] = ch; self.extra[s] = spec
        self.dec = dec
        self.enc = {}
        for k, v in dec.items(): self.enc.setdefault(v, k)
        self.norm = str.maketrans({**NORMALIZE, **(lang or {}).get('normalize', {})})
        self.shift = shift

    def decode(self, units, base=True):
        d = self.base if base else self.dec
        return ''.join(d[u] if u in d else ('{%02X}' % u if u < 0x100 else '{%04X}' % u) for u in units)

    def encode(self, text):
        out = []; i = 0
        text = text.translate(self.norm)
        while i < len(text):
            m = TOKEN.match(text, i)
            if m: out.append(int(m.group(1), 16)); i = m.end(); continue
            c = text[i]
            if c not in self.enc: raise ValueError('character %r cannot be displayed' % c)
            out.append(self.enc[c]); i += 1
        return out

def make_glyph(spec):
    """spec: {"art": [rows of '.', '@' (ink), '+' (shadow)], "top": first row (3 = cap height),
              "width": advance, "shadow": auto-add the font's right/down-right shadow}"""
    rows = [[0] * 8 for _ in range(16)]
    for dy, line in enumerate(spec['art']):
        for x, c in enumerate(line[:8]):
            rows[spec.get('top', 3) + dy][x] = {'@': 1, '+': 2}.get(c, 0)
    if spec.get('shadow', True):
        for y in range(16):
            for x in range(8):
                if rows[y][x] == 1:
                    for sy, sx in ((y, x + 1), (y + 1, x + 1)):
                        if sy < 16 and sx < 8 and rows[sy][sx] == 0: rows[sy][sx] = 2
    width = spec.get('width') or 1 + max([x for r in rows for x in range(8) if r[x]] + [0]) + 1
    out = bytearray(struct.pack('<H', width))
    for y in range(16):
        for x in range(0, 8, 2): out.append(rows[y][x] | (rows[y][x + 1] << 4))
    return bytes(out)

# --------------------------------------------------------------------------- game profiles
GAMES = {'DS2_USA_DAWN': 'Digimon World Dawn', 'DS2_USA_DUSK': 'Digimon World Dusk',
         'DIGIMONWORLD': 'Digimon World DS'}

class Game:
    font_path = 'dat/font/font00.ntt'

    def __init__(self, nds, lang=None):
        self.nds = nds
        self.kind = 'pak' if 'dat/MSG.PAK' in nds.files else 'sdb'
        self.set = 'dawn' if self.kind == 'pak' else 'ds'
        self.cs = Charset(self.kind, lang)
        self.name = GAMES.get(nds.title, nds.title)

    # ---- containers -> {container_name: [units...]}
    def load(self):
        out = {}
        if self.kind == 'pak':
            d = self.nds.read('dat/MSG.PAK')
            cnt = struct.unpack_from('<I', d)[0]
            for i in range(cnt):
                o, s = struct.unpack_from('<II', d, 4 + i * 8); s &= 0x7FFFFFFF
                out['dat/MSG.PAK#%03d' % i] = self._split(d[o:o + s])
        else:
            for k in sorted(self.nds.files):
                # the game only loads /dat/msg/*.sdb; msg_new and msg_org are unused leftovers
                if k.startswith('dat/msg/') and k.endswith('.sdb'):
                    b = self.nds.read(k)
                    if self._is_table(b): out[k] = self._split(b)
        out.update(self.load_code())
        return out

    # ---- text compiled into the program (arm9 + overlays)
    # Strings are replaced in place.  A translation longer than its slot is moved into space freed
    # by shorter translations in the same region, and every pointer to the old address is updated.
    def code_regions(self):
        """[(name, rom start, rom end, ram address of start)]"""
        D = self.nds.data
        a9o, _, a9ram, a9s = struct.unpack_from('<4I', D, 0x20)
        regs = [('arm9', a9o, a9o + a9s, a9ram)]
        ovo, ovs = struct.unpack_from('<2I', D, 0x50)
        for i in range(ovs // 32):
            oid, ram, _, _, _, _, fid, flag = struct.unpack_from('<8I', D, ovo + i * 32)
            if flag >> 24 & 1: continue                     # compressed overlay: text not reachable
            s, e = self.nds.fat[fid]; regs.append(('ovl%02d' % oid, s, e, ram))
        return regs

    def load_code(self):
        """{'code:<gamecode>:<region>': [units...]}; self.code_meta[name] = [(rom offset, capacity in units)]"""
        if hasattr(self, '_code'): return {k: [list(u) for u in v] for k, v in self._code.items()}
        D = bytes(self.nds.data); ok = set(self.cs.dec)
        self._code, self.code_meta, self.code_region = {}, {}, {}
        for name, start, end, ram in self.code_regions():
            cand = []; i = start
            while i + 2 <= end:
                j = i; units = []
                while j + 2 <= end:
                    u = struct.unpack_from('<H', D, j)[0]; j += 2
                    if u not in ok and u < 0xFFE0: break
                    units.append(u)
                    if u in (CTRL_PAGE, CTRL_END): break
                aligned = i % 4 == 0 or struct.unpack_from('<H', D, i - 2)[0] in (CTRL_PAGE, CTRL_END, 0)
                if units and units[-1] in (CTRL_PAGE, CTRL_END) and aligned:
                    while units and units[0] == 0 and len(units) > 1: units.pop(0); i += 2   # leading padding
                    txt = self.cs.decode(units)
                    if looks_like_text(txt): cand.append([i, units, True]); i = j; continue
                    if looks_like_text(txt, short=True): cand.append([i, units, False]); i = j; continue
                i += 2
            # short words ("No", "OK") only count when they sit right next to certain text
            found = [c for k, c in enumerate(cand) if c[2] or any(
                0 <= k + d < len(cand) and cand[k + d][2] and abs(cand[k + d][0] - c[0]) <= 2 * len(c[1]) + 2 * len(cand[k + d][1]) + 8
                for d in (-1, 1))]
            meta, strings = [], []
            for k, (off, units, _) in enumerate(found):
                cap = len(units); nxt = found[k + 1][0] if k + 1 < len(found) else end
                p = off + 2 * cap
                while p + 2 <= nxt and D[p:p + 2] == b'\0\0': p += 2        # zero padding up to the next string
                if p == nxt: cap = (nxt - off) // 2
                meta.append((off, cap)); strings.append(units)
            if strings:
                key = 'code:%s:%s' % (self.nds.code, name)
                self._code[key] = strings; self.code_meta[key] = meta; self.code_region[key] = (start, end, ram)
        return self.load_code()

    def store_code(self, containers):
        """write translated program strings; returns [(container, index, problem)] for ones that could not be placed."""
        self.load_code(); D = self.nds.data; fails = []
        for name, meta in self.code_meta.items():
            start, end, ram = self.code_region[name]
            orig = self._code[name]; new = containers[name]
            free = []; longs = []
            for k, ((off, cap), u0, u) in enumerate(zip(meta, orig, new)):
                if u == u0:
                    if cap > len(u0): pass                  # untouched; its padding stays where it is
                    continue
                if len(u) <= cap:
                    D[off:off + 2 * cap] = struct.pack('<%dH' % cap, *(u + [0] * (cap - len(u))))
                    a = (off + 2 * len(u) + 3) & ~3          # freed tail of the slot, 4-aligned
                    if off + 2 * cap - a >= 4: free.append([a, off + 2 * cap])
                else: longs.append(k)
            for k in sorted(longs, key=lambda k: -len(new[k])):
                off, cap = meta[k]; u = new[k]; size = 2 * len(u)
                ptr = struct.pack('<I', ram + off - start)
                refs = []
                # overlays share RAM, so an overlay string can only be referenced from its own overlay
                where = self.code_regions() if name.endswith(':arm9') else [(None, start, end, None)]
                for _, s, e, _ in where:
                    p = D.find(ptr, s, e)
                    while p >= 0:
                        if p % 4 == 0: refs.append(p)
                        p = D.find(ptr, p + 1, e)
                slot = next((f for f in free if f[1] - f[0] >= size), None)
                if not refs or slot is None:
                    fails.append((name, k, 'too long for its code slot (%d > %d chars)%s' % (
                        len(u) - 1, cap - 1, '' if refs else ', no pointer found to move it')))
                    continue
                a = slot[0]
                D[a:a + size] = struct.pack('<%dH' % len(u), *u)
                slot[0] = (a + size + 3) & ~3
                for r in refs: struct.pack_into('<I', D, r, ram + a - start)
        return fails

    @staticmethod
    def _is_table(b):
        if len(b) < 4: return False
        n = struct.unpack_from('<I', b)[0] // 4
        if n == 0 or n * 4 > len(b): return False
        offs = struct.unpack_from('<%dI' % n, b)
        return offs[0] == n * 4 and all(x <= y for x, y in zip(offs, offs[1:])) and offs[-1] <= len(b)

    @staticmethod
    def _split(b):
        n = struct.unpack_from('<I', b)[0] // 4
        offs = list(struct.unpack_from('<%dI' % n, b)) + [len(b)]
        res = []
        for j in range(n):
            t = b[offs[j]:offs[j + 1]]
            res.append(list(struct.unpack('<%dH' % (len(t) // 2), t)))
        return res

    @staticmethod
    def _join(strings):
        n = len(strings); pos = n * 4; offs = []; body = bytearray()
        for u in strings:
            offs.append(pos + len(body)); body += struct.pack('<%dH' % len(u), *u)
        return struct.pack('<%dI' % n, *offs) + bytes(body)

    def store(self, containers):
        if self.kind == 'pak':
            old = self.nds.read('dat/MSG.PAK'); cnt = struct.unpack_from('<I', old)[0]
            pos = 4 + cnt * 8; table = bytearray(); body = bytearray()
            for i in range(cnt):
                b = self._join(containers['dat/MSG.PAK#%03d' % i])
                table += struct.pack('<II', pos + len(body), len(b) | 0x80000000)
                body += b + b'\0' * (-len(b) % 4)
            self.nds.write('dat/MSG.PAK', struct.pack('<I', cnt) + bytes(table) + bytes(body))
        else:
            for k, strings in containers.items():
                if not k.startswith('code:'): self.nds.write(k, self._join(strings))
        return self.store_code(containers)

    # ---- font
    def widths(self):
        f = self.nds.read(self.font_path)
        n = (len(f) - 8) // 66
        return [struct.unpack_from('<H', f, 8 + 66 * i)[0] for i in range(n)]

    # fonts that draw message text with the same glyph numbering as font00
    LETTER_FONTS = ['dat/font/font00.ntt', 'dat/font/font_dg.ntt',
                    'dat/font/font_b00.ntt', 'dat/font/font_b01.ntt', 'dat/font/font_b02.ntt']

    def patch_font(self, dawn=None):
        """Give every letter font the glyphs the language needs.
        8x16 fonts of DS: copy the accented block from Dawn's font of the same name.
        Fonts still missing a letter: synthesize it from its base letter (or the language's pixel art)."""
        sh = self.cs.shift; A, b = 0x20 + sh, 0x3b + sh
        needed = {self.cs.enc[c]: c for c in self.cs.letters}
        for path in self.LETTER_FONTS:
            if path not in self.nds.files: continue
            f = Font(self.nds.read(path))
            if self.kind == 'sdb' and f.cw == 8:
                if dawn is None: sys.exit("Digimon World DS needs --dawn-rom (accented glyphs come from Dawn's fonts).")
                if path in dawn.files:
                    src = Font(dawn.read(path))
                    for i in range(0x80, 0xBD):
                        if src.cw == f.cw and not src.is_free(i) and f.is_free(i + sh): f.put_raw(i + sh, src.raw(i))
            for slot, ch in sorted(needed.items()):
                if slot >= f.count or (slot not in self.cs.extra and not f.is_free(slot)): continue
                spec = self.cs.extra.get(slot)
                if spec:
                    art = spec.get('art16') if f.cw >= 16 else spec.get('art')
                    if not art: continue
                    top = spec.get('top16', 4) if f.cw >= 16 else spec.get('top', 3)
                    w = spec.get('width16', len(art[0]) + 1) if f.cw >= 16 else spec.get('width', len(art[0]) + 1)
                    if f.cw >= 16: g = from_art(f, art, top, w, A, b)
                    else: f.put_raw(slot, make_glyph(spec)); continue
                else:
                    base = unicodedata.normalize('NFD', ch)[0]
                    if base not in self.cs.enc: continue
                    g = synthesize(f, ch, self.cs.enc[base], A, b)
                if g: f.put(slot, *g)
                else: print('warning: %s has no glyph for %r' % (path, ch))
            self.nds.write(path, bytes(f.data))

# --------------------------------------------------------------------------- layout
def text_width(units, widths):
    w = 0
    for u in units:
        if u >= 0xFFE0: w += NAME_TOKENS.get(u, VAR_TOKENS.get(u, 0))
        else: w += widths[u] if u < len(widths) else 6
    return w

def split_lines(units):
    lines = [[]]
    for u in units:
        if u == CTRL_NEWLINE: lines.append([])
        elif u in (CTRL_PAGE, CTRL_END): pass
        else: lines[-1].append(u)
    return lines

def layout(units, widths, maxw, allow_wrap=True):
    """Re-flow a message so that no line is wider than maxw.  Returns (units, overflow_flag)."""
    term = [u for u in units if u in (CTRL_PAGE, CTRL_END)]
    term = term[-1:] or [CTRL_END]
    lines = split_lines(units)
    if all(text_width(l, widths) <= maxw for l in lines) or not allow_wrap:
        body = []
        for i, l in enumerate(lines):
            if i: body.append(CTRL_NEWLINE)
            body += l
        return body + term, any(text_width(l, widths) > maxw for l in lines)
    # re-wrap each paragraph (paragraph = text between blank lines)
    paras = [[]]
    for l in lines:
        if not l: paras.append([]); paras.append([]); continue
        if paras[-1]: paras[-1].append(0)
        paras[-1] += l
    out = []; overflow = False
    for pi, para in enumerate(paras):
        words = [[]]
        for u in para:
            if u == 0: words.append([])
            else: words[-1].append(u)
        cur = []; outl = []
        for w in words:
            if not w: continue
            cand = cur + ([0] if cur else []) + w
            if cur and text_width(cand, widths) > maxw: outl.append(cur); cur = list(w)
            else: cur = cand
        outl.append(cur)
        overflow |= any(text_width(l, widths) > maxw for l in outl)
        if pi: out.append(CTRL_NEWLINE)
        for i, l in enumerate(outl):
            if i: out.append(CTRL_NEWLINE)
            out += l
    return out + term, overflow

def file_limits(strings, widths):
    """Per-file box width = widest original line; h = most lines in one message."""
    maxw = 0; multi = 0; h = 1
    for u in strings:
        ls = split_lines(u)
        if len(ls) > 1: multi += 1
        h = max(h, len(ls))
        for l in ls: maxw = max(maxw, text_width(l, widths))
    return maxw, multi, h

# --------------------------------------------------------------------------- translation tables
def looks_like_text(s, short=False):
    """filter for strings found by scanning program code: real words, few odd tokens.
    short=True also accepts 2-letter words ("No", "OK"); the caller only keeps those next to real text."""
    plain = TOKEN.sub(' ', s)
    odd = [t for t in TOKEN.findall(s) if t.upper() not in ('FFFD', 'FFFE', 'FFFF', 'FFED', 'FFEC', 'FFEE', 'FFEA', 'FFEF',
                                                        'FFE9', 'FFF0', 'FFF1', 'FFF2', 'FFF3')]
    words = re.findall(r'[A-Za-z]{2,}' if short else r'[A-Za-z]{3,}', plain)
    if not words or len(odd) > 2: return False
    if short: return len(plain.strip()) <= 4 and any(re.search(r'[aeiouyAEIOUY]', w) or w.isupper() for w in words)
    if not any(re.search(r'[aeiouyAEIOUY]', w) and not re.fullmatch(r'(.)\1+', w) for w in words): return False
    letters = sum(c.isalpha() for c in plain)
    return letters >= 3 and letters >= 0.5 * len(plain.strip() or 'x')

def has_letters(s):
    return re.search(r'[A-Za-z]', TOKEN.sub('', s)) is not None

def tokens(s):
    """control tokens that must survive translation (line breaks and the final end code may change)."""
    t = [x.upper() for x in TOKEN.findall(s)]
    while t and t[-1] in ('FFFE', 'FFFF'): t.pop()
    return sorted(x for x in t if x != 'FFFD')

def table_paths(setdir, lang):
    return os.path.join(setdir, lang + '.json'), os.path.join(setdir, lang + '.overrides.json')

def unique_sources(cat):
    """translatable source strings in catalog order (keeps neighbouring dialogue together)."""
    out, seen = [], set()
    for fname, f in cat['files'].items():
        for s in f['src']:
            if s not in seen and has_letters(s): seen.add(s); out.append((fname, s))
    return out

def rigid(src):
    """menus / lists / labels: line breaks separate items, so they must be kept.
    True when every line starts a new item and either all lines are short (menu entries)
    or every line but the last ends a sentence."""
    lines = [l.strip() for l in TOKEN.sub(lambda m: '\n' if m.group(1).upper() == 'FFFD' else '', src).split('\n')]
    if len(lines) < 2 or not all(l and not l[0].islower() for l in lines): return False
    return all(len(l.split()) <= 3 for l in lines) or all(l[-1] in '.!?:)' for l in lines[:-1])

def validate(cs, src, dst):
    if not isinstance(dst, str) or not dst.strip(): return 'empty'
    if tokens(src) != tokens(dst): return 'control tokens differ from source'
    if rigid(src) and src.upper().count('{FFFD}') != dst.upper().count('{FFFD}'):
        return 'list/menu text must keep its %d line breaks' % src.upper().count('{FFFD}')
    try: cs.encode(dst)
    except ValueError as e: return str(e)
    return None

# --------------------------------------------------------------------------- commands
def cmd_extract(a):
    g = Game(NDS(a.rom))
    if g.nds.title == 'DS2_USA_DUSK': print('Dusk shares all message data with Dawn; extracting as set "dawn".')
    cont = g.load()
    outdir = os.path.join(a.workdir, g.set); os.makedirs(outdir, exist_ok=True)
    g2 = Game(NDS(a.rom)); g2.store(cont)                 # lossless round-trip check
    for path in g2.nds.pending:
        if g2.nds.pending[path] != g.nds.read(path): print('WARNING: round-trip of %s is not byte-identical' % path)
    widths = g.widths(); cat = {}
    for name, strings in cont.items():
        w, multi, h = file_limits(strings, widths)
        cat[name] = {'w': w, 'h': h, 'multi': multi, 'src': [g.cs.decode(u) for u in strings]}
    cp = os.path.join(outdir, 'catalog.json')
    if os.path.exists(cp):            # Dawn and Dusk share messages but not program code: keep the other ROM's code
        for k, v in load(cp)['files'].items():
            if re.match(r'code:[A-Z0-9]{4}:', k) and not k.startswith('code:%s:' % g.nds.code): cat[k] = v
    save(cp, {'kind': g.kind, 'set': g.set, 'files': cat})
    uniq = unique_sources({'files': cat})
    print('%d containers, %d strings, %d unique translatable strings (%d chars) -> %s' % (
        len(cont), sum(len(f['src']) for f in cat.values()), len(uniq), sum(len(s) for _, s in uniq), outdir))

def cmd_status(a):
    lang = load_lang(a.lang); cat = load(os.path.join(a.setdir, 'catalog.json'))
    tp, _ = table_paths(a.setdir, a.lang); tab = load(tp, {})
    cs = Charset(cat['kind'], lang)
    src = unique_sources(cat); done = [s for _, s in src if s in tab]
    bad = [(s, validate(cs, s, tab[s])) for s in done if validate(cs, s, tab[s])]
    chars = sum(len(s) for _, s in src); dchars = sum(len(s) for s in done)
    print('%s/%s: %d of %d strings (%.1f%% of text), %d invalid' % (
        cat['set'], a.lang, len(done), len(src), 100.0 * dchars / max(1, chars), len(bad)))
    for s, e in bad[:a.show]: print('  %s: %r' % (e, s[:80]))

SYSTEM_PROMPT = """You translate the English text of the Nintendo DS game {game} into {language}.
Rules:
- Keep tokens like {{FFED}} {{FFEE}} {{FFEA}} {{FFF0}} {{FFFD}} {{FFFE}} {{FFFF}} {{22}} exactly as they are, in a sensible position.
  {{FFED}}/{{FFEC}} = player name, {{FFF0}}-{{FFF2}} = variables (numbers, Digimon names), {{FFEE}}/{{FFEA}}/{{FFEF}} = highlight on/off
  (keep each pair around the matching words), {{FFFD}} = line break, {{FFFE}}/{{FFFF}} = end of message, two-digit tokens are icons.
- Flowing text (a sentence continues on the next line) may be re-broken freely; the tool re-wraps it to the box width.
  But when every line of the source starts a new item or sentence (menus, choices, lists, labels), keep exactly the same
  number of {{FFFD}} line breaks, one item per line.
- Keep Digimon names, attack names and place names as they are unless the glossary says otherwise.
- Each request gives the box: "w" = maximum line width in pixels (about 5 px per character), "h" = most lines a message
  in this box uses. Be concise. Single-line labels must fit "w"; abbreviate if needed.
- {style}
- Only use plain ASCII punctuation and these letters beyond A-Z: {letters}. No curly quotes, no em-dashes.
- Messages are in game order, so neighbouring lines are usually one conversation; keep speakers and terms consistent.
- Return ONLY a JSON object mapping every input id to its translation string."""

def build_prompt(lang, game, gloss):
    return SYSTEM_PROMPT.format(game=game, language=lang['name'], style=lang.get('style', ''),
                                letters=' '.join(lang.get('letters', ''))) + \
        '\n\nGlossary (English -> %s):\n%s' % (lang['name'], json.dumps(gloss, ensure_ascii=False, indent=0))

# USD per million tokens: input, output, cache write, cache read
PRICES = {'claude-opus-5-5': (4.0, 20.0, 5.0, 0.20), 'claude-sonnet-5-5': (2.0, 10.0, 2.5, 0.20),
          'claude-haiku-5-5': (0.10, 0.50, 0.125, 0.01), 'claude-fable-5-1': (10.0, 50.0, 12.5, 0.25)}

def api_key():
    k = os.environ.get('ANTHROPIC_API_KEY')
    p = os.path.join(HERE, '.api_key')
    if not k and os.path.exists(p): k = open(p, encoding='utf-8').read().strip()
    return k

class Ledger:
    """running API cost in WORKDIR/api_spend.json, shared by every set and language."""
    def __init__(self, path, model):
        self.path, self.price = path, PRICES.get(model, PRICES['claude-opus-5-5'])
        self.d = load(path, {'usd': 0.0, 'requests': 0, 'input': 0, 'output': 0})
    def add(self, u):
        p = self.price
        cw, cr = getattr(u, 'cache_creation_input_tokens', 0) or 0, getattr(u, 'cache_read_input_tokens', 0) or 0
        usd = (u.input_tokens * p[0] + u.output_tokens * p[1] + cw * p[2] + cr * p[3]) / 1e6
        d = self.d; d['usd'] += usd; d['requests'] += 1; d['input'] += u.input_tokens + cw + cr; d['output'] += u.output_tokens
        save(self.path, d)
        return usd

def claude_client(model, effort):
    try: import anthropic
    except ImportError: sys.exit('pip install anthropic')
    key = api_key() or sys.exit('No API key: set ANTHROPIC_API_KEY or put the key in %s' % os.path.join(HERE, '.api_key'))
    client = anthropic.Anthropic(api_key=key, max_retries=6, timeout=600)
    def ask(system, user, ledger):
        extra = {} if 'haiku' in model else {'betas': ['server-side-fallback-2026-07-01'], 'fallbacks': 'default'}
        r = client.beta.messages.create(
            model=model, max_tokens=32000, output_config={'effort': effort},
            system=[{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}],
            messages=[{'role': 'user', 'content': user}], **extra)
        cost = ledger.add(r.usage)
        if r.stop_reason == 'refusal': print('a batch was declined by the model; it stays untranslated'); return '', cost
        if r.stop_reason == 'max_tokens': print('a batch hit max_tokens; retry it with a smaller --batch')
        return ''.join(b.text for b in r.content if b.type == 'text'), cost
    return ask

def call_openai_compat(endpoint, model, system, user, key, retries=3):
    """Ollama (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1), OpenRouter, ..."""
    body = json.dumps({'model': model, 'messages': [
        {'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}).encode()
    hdr = {'content-type': 'application/json'}
    if key: hdr['authorization'] = 'Bearer ' + key
    for t in range(retries):
        try:
            req = urllib.request.Request(endpoint.rstrip('/') + '/chat/completions', body, hdr)
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.load(r)['choices'][0]['message']['content']
        except (urllib.error.URLError, TimeoutError, KeyError) as e:
            print('request failed (%s), retrying' % e); time.sleep(3 * (t + 1))
    raise SystemExit('endpoint unreachable: ' + endpoint)

def fill_from_memory(cat, cs, tab, setdir, lang):
    """translation memory: copy translations of identical source strings from the other sets in the workdir."""
    root = os.path.dirname(os.path.abspath(setdir)); n = 0
    for other in sorted(os.listdir(root)):
        od = os.path.join(root, other)
        if os.path.abspath(od) == os.path.abspath(setdir) or not os.path.isfile(os.path.join(od, lang + '.json')): continue
        mem = load(os.path.join(od, lang + '.json'))
        for _, src in unique_sources(cat):
            if src not in tab and src in mem and validate(cs, src, mem[src]) is None: tab[src] = mem[src]; n += 1
    return n

def make_batches(todo, size):
    """batches of at most `size` strings that never cross a file boundary."""
    out = []
    for f, s in todo:
        if not out or len(out[-1]) >= size or out[-1][0][0] != f: out.append([])
        out[-1].append((f, s))
    return out

def cmd_translate(a):
    lang = load_lang(a.lang)
    cat = load(os.path.join(a.setdir, 'catalog.json')); cs = Charset(cat['kind'], lang)
    tp, _ = table_paths(a.setdir, a.lang); tab = load(tp, {})
    gloss = dict(lang.get('glossary', {})); gloss.update(load(os.path.join(a.setdir, 'glossary.%s.json' % a.lang), {}))
    system = build_prompt(lang, 'Digimon World DS' if cat['set'] == 'ds' else 'Digimon World Dawn/Dusk', gloss)
    ledger = Ledger(os.path.join(os.path.dirname(os.path.abspath(a.setdir)), 'api_spend.json'), a.model)
    if a.endpoint:
        key = os.environ.get('OPENAI_API_KEY', '')
        ask = lambda s, u, l: (call_openai_compat(a.endpoint, a.model, s, u, key), 0.0)
    else:
        ask = claude_client(a.model, a.effort)
    reused = fill_from_memory(cat, cs, tab, a.setdir, a.lang)
    if reused: save(tp, tab); print('%d strings reused from other sets' % reused)
    todo = [(f, s) for f, s in unique_sources(cat) if s not in tab]
    if a.limit: todo = todo[:a.limit]
    batches = make_batches(todo, a.batch)
    print('%d strings in %d batches; spent so far $%.2f of $%.2f budget' % (len(todo), len(batches), ledger.d['usd'], a.budget))
    lock = threading.Lock(); done = [0]; costs = []
    def work(batch):
        with lock:
            avg = sum(costs) / len(costs) if costs else 0.5
            if ledger.d['usd'] + avg * a.threads > a.budget: return 'budget'
        f = cat['files'][batch[0][0]]
        items = {str(i): s for i, (_, s) in enumerate(batch)}
        if batch[0][0].startswith('code:'):
            user = ('These strings are compiled into the game program (menus, item, skill and status names, prompts).\n'
                    'Each translation must NOT be longer than its English text (count characters, a token counts as one); '
                    'abbreviate where needed. Keep Digimon names unchanged.\nTranslate each value:\n%s'
                    % json.dumps(items, ensure_ascii=False, indent=0))
        else:
            user = 'Box: w=%d px, h=%d lines (file %s)\nTranslate each value:\n%s' % (
                f['w'], f.get('h', 3), batch[0][0], json.dumps(items, ensure_ascii=False, indent=0))
        try: txt, cost = ask(system, user, ledger)
        except Exception as e: print('batch failed: %s' % e); return 'error'
        m = re.search(r'\{.*\}', txt, re.S)
        try: res = json.loads(m.group(0))
        except Exception: res = {}; print('bad JSON for a batch, skipped')
        with lock:
            costs.append(cost); ok = 0
            for i, (_, s) in enumerate(batch):
                t = res.get(str(i))
                if validate(cs, s, t) is None: tab[s] = t; ok += 1
            done[0] += len(batch); save(tp, tab)
            print('%d/%d strings (%d of %d accepted), $%.3f, total $%.2f' % (
                done[0], len(todo), ok, len(batch), cost, ledger.d['usd']), flush=True)
    with ThreadPoolExecutor(a.threads) as ex: res = list(ex.map(work, batches))
    if 'budget' in res: print('stopped: budget of $%.2f reached; translate the rest with batch.py' % a.budget)
    print('done; re-run to retry strings that failed validation.')

def cmd_export(a):
    """translation table -> CSV (UTF-8 with BOM, opens in Excel/LibreOffice) for native-speaker review."""
    import csv
    cat = load(os.path.join(a.setdir, 'catalog.json')); tp, _ = table_paths(a.setdir, a.lang); tab = load(tp, {})
    with open(a.csv, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f); w.writerow(['where', 'box_px', 'english', a.lang, 'notes'])
        for fname, src in unique_sources(cat):
            idx = cat['files'][fname]['src'].index(src)
            w.writerow(['%s:%d' % (fname, idx), cat['files'][fname]['w'], src, tab.get(src, ''), ''])
    print('wrote %s' % a.csv)

def cmd_import(a):
    """reviewed CSV -> translation table; rows that fail validation are reported and skipped."""
    import csv
    cat = load(os.path.join(a.setdir, 'catalog.json')); cs = Charset(cat['kind'], load_lang(a.lang))
    tp, _ = table_paths(a.setdir, a.lang); tab = load(tp, {})
    changed = bad = 0
    with open(a.csv, encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            src, t = row['english'], row.get(a.lang, '')
            if not t or tab.get(src) == t: continue
            e = validate(cs, src, t)
            if e: bad += 1; print('%s: %s / %s' % (row['where'], e, t)); continue
            tab[src] = t; changed += 1
    save(tp, tab)
    print('%d translations updated, %d rejected' % (changed, bad))

def box(f, units):
    """(max line width, max lines, single-line label?) for a message of file f"""
    single = len(split_lines(units)) == 1
    return (f['w'] if single else max(f['w'], 120)), (1 if single else f.get('h', 99)), single

def fit(cs, f, units, src, t, widths, cap=None):
    """lay translation t out like the original message; returns (units, problem or None)"""
    u = cs.encode(t)
    ends = [x for x in units if x in (CTRL_PAGE, CTRL_END)]
    if not any(x in (CTRL_PAGE, CTRL_END) for x in u): u = u + ends[-1:]
    if cap is not None:                                   # program code: placed (or moved) by store_code
        w = max(text_width(l, widths) for l in split_lines(u))
        ow = max(text_width(l, widths) for l in split_lines(units))
        if w > max(ow * 1.25, ow + 12): return u, 'too wide (%d px > %d)' % (w, max(ow * 1.25, ow + 12))
        return u, None
    maxw, maxh, single = box(f, units)
    lu, over_w = layout(u, widths, maxw, allow_wrap=not (single or rigid(src)))
    lines = split_lines(lu)
    if over_w: return lu, 'too wide (%d px > %d)' % (max(text_width(l, widths) for l in lines), maxw)
    if not single and len(lines) > maxh: return lu, 'too many lines (%d > %d)' % (len(lines), maxh)
    return lu, None

SHORTEN_PROMPT = """You shorten {language} text of a Nintendo DS game so it fits its text box.
For each item you get the English original, the current {language} text, the box limits and the current size.
Return a shorter {language} version with the same meaning that fits: at most max_chars characters (tokens like
{{FFFD}} count as one) when max_chars is given, otherwise every line at most max_px pixels wide
(about 5 px per character, spaces 3 px) and at most max_lines lines. Rephrase, drop filler words, use common
abbreviations if a label must be very short. Keep every {{XXXX}} token unchanged. {{FFFD}} is a line break; for
flowing text you may move or drop line breaks (the tool re-wraps), for menus/lists keep one item per line.
Only use plain ASCII punctuation and these letters beyond A-Z: {letters}.
Return ONLY a JSON object mapping every id to the new text."""

def cmd_shorten(a):
    """ask the model for shorter versions of translations that overflow their box (repeatable)."""
    lang = load_lang(a.lang)
    g, rep = prepare(a.rom, a.setdir, a.lang, a.dawn_rom)
    cat = load(os.path.join(a.setdir, 'catalog.json')); tp, _ = table_paths(a.setdir, a.lang); tab = load(tp, {})
    widths = g.widths(); g0 = Game(NDS(a.rom)); orig = g0.load()
    todo = {}
    for name, idx, err, t in rep:
        src = cat['files'][name]['src'][idx]
        if not err.startswith('too') or src not in tab or tab[src] != t: continue
        todo.setdefault(src, []).append((name, idx, err))
    items = list(todo.items())
    if a.limit: items = items[:a.limit]
    print('%d strings overflow their box' % len(items))
    ledger = Ledger(os.path.join(os.path.dirname(os.path.abspath(a.setdir)), 'api_spend.json'), a.model)
    ask = claude_client(a.model, a.effort)
    system = SHORTEN_PROMPT.format(language=lang['name'], letters=' '.join(lang.get('letters', '')))
    fixed = [0]; lock = threading.Lock()
    def work(chunk):
        if ledger.d['usd'] > a.budget: return
        req = {}
        for i, (src, places) in enumerate(chunk):
            name, idx, err = places[0]; f = cat['files'][name]
            maxw, maxh, _ = box(f, orig[name][idx])
            req[str(i)] = {'english': src, 'current': tab[src], 'max_px': maxw, 'max_lines': maxh, 'problem': err}
            if name.startswith('code:'):
                cap = min(g0.code_meta[n][k][1] for n, k, _ in places if n.startswith('code:'))
                req[str(i)] = {'english': src, 'current': tab[src], 'max_chars': cap - 1, 'problem': err}
        try: txt, _ = ask(system, json.dumps(req, ensure_ascii=False, indent=0), ledger)
        except Exception as e: print('batch failed: %s' % e); return
        m = re.search(r'\{.*\}', txt, re.S)
        try: res = json.loads(m.group(0))
        except Exception: return
        with lock:
            for i, (src, places) in enumerate(chunk):
                t = res.get(str(i))
                if validate(g.cs, src, t): continue
                if all(fit(g.cs, cat['files'][n], orig[n][k], src, t, widths,
                           g0.code_meta[n][k][1] if n.startswith('code:') else None)[1] is None for n, k, _ in places):
                    tab[src] = t; fixed[0] += 1
            save(tp, tab)
    chunks = [items[i:i + a.batch] for i in range(0, len(items), a.batch)]
    with ThreadPoolExecutor(a.threads) as ex: list(ex.map(work, chunks))
    print('%d of %d now fit; total API spend $%.2f' % (fixed[0], len(items), ledger.d['usd']))

def build_containers(g, cat, tab, over, widths, report):
    cont = g.load(); out = {}
    for name, strings in cont.items():
        f = cat['files'][name]; new = []
        for idx, units in enumerate(strings):
            src = f['src'][idx]
            t = over.get('%s:%d' % (name, idx)) or tab.get(src)
            if not t or t == src: new.append(units); continue
            err = validate(g.cs, src, t)
            if err: report.append((name, idx, err, t)); new.append(units); continue
            cap = g.code_meta[name][idx][1] if name.startswith('code:') else None
            lu, err = fit(g.cs, f, units, src, t, widths, cap)
            if err: report.append((name, idx, err, t))
            new.append(lu)
        out[name] = new
    return out

def prepare(rom, setdir, lang_code, dawn_rom=None):
    lang = load_lang(lang_code)
    g = Game(NDS(rom), lang)
    cat = load(os.path.join(setdir, 'catalog.json'))
    if cat['set'] != g.set: sys.exit('%s belongs to set %r, catalog is %r' % (rom, g.set, cat['set']))
    tp, op = table_paths(setdir, lang_code)
    tab, over = load(tp, {}), load(op, {})
    g.patch_font(NDS(dawn_rom) if dawn_rom else None)
    rep = []
    cont = build_containers(g, cat, tab, over, g.widths(), rep)
    for name, idx, err in g.store(cont):
        src = cat['files'][name]['src'][idx]; rep.append((name, idx, err, over.get('%s:%d' % (name, idx)) or tab.get(src)))
    return g, rep

def cmd_check(a):
    g, rep = prepare(a.rom, a.setdir, a.lang, a.dawn_rom)
    for r in rep[:a.show]: print('%s[%d] %s\n    %s' % r)
    print('%d problems' % len(rep))

def cmd_build(a):
    g, rep = prepare(a.rom, a.setdir, a.lang, a.dawn_rom)
    g.nds.save(a.out)
    print('wrote %s  (%d layout/encoding warnings; run "check" to list them)' % (a.out, len(rep)))

def cmd_release(a):
    lang = load_lang(a.lang)
    roms = {}
    for r in a.roms:
        t = NDS(r).title
        if t not in GAMES: sys.exit('%s: not a supported ROM (title %r)' % (r, t))
        roms[t] = r
    dawn = roms.get('DS2_USA_DAWN') or a.dawn_rom
    os.makedirs(a.out, exist_ok=True); lines = []
    for title, rom in roms.items():
        src = open(rom, 'rb').read()
        g, rep = prepare(rom, os.path.join(a.workdir, 'dawn' if title != 'DIGIMONWORLD' else 'ds'), a.lang, dawn)
        tag = lang.get('native', lang['name'])
        for md in a.mod:
            import mod as modlib
            m = modlib.load(md)
            if modlib.GAMES.get(g.nds.code) == m['game']: modlib.apply(g.nds, m); tag += ' + ' + os.path.basename(os.path.normpath(md))
        hints = [tuple(g.nds.fat[g.nds.files[p]]) for p in g.nds.pending]
        tgt = g.nds.build()
        patch = bps.create(src, tgt, hints)
        if bps.apply(src, patch) != tgt: sys.exit('internal error: patch does not reproduce the build')
        name = '%s (%s).bps' % (GAMES[title], tag)
        open(os.path.join(a.out, name), 'wb').write(patch)
        if a.keep_roms: open(os.path.join(a.out, name[:-4] + '.nds'), 'wb').write(tgt)
        lines.append('%s\n  for: %s (%s)\n  ROM CRC32 %08X  SHA-1 %s\n  patch %d bytes, %d text warnings\n' % (
            name, GAMES[title], g.nds.code, zlib.crc32(src), hashlib.sha1(src).hexdigest(), len(patch), len(rep)))
        print('%s: %d bytes, %d warnings' % (name, len(patch), len(rep)))
    with open(os.path.join(a.out, 'README.txt'), 'w', encoding='utf-8') as f:
        f.write(lang.get('readme', 'Apply the .bps patch that matches your game with RomPatcher.js, Flips or beat.') + '\n\n')
        f.write('\n'.join(lines))

def main():
    if hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest='cmd', required=True)
    x = sp.add_parser('extract'); x.add_argument('rom'); x.add_argument('workdir'); x.set_defaults(f=cmd_extract)
    s = sp.add_parser('status'); s.add_argument('setdir'); s.add_argument('--lang', required=True)
    s.add_argument('--show', type=int, default=20); s.set_defaults(f=cmd_status)
    t = sp.add_parser('translate'); t.add_argument('setdir'); t.add_argument('--lang', required=True)
    t.add_argument('--model', default='claude-opus-5-5'); t.add_argument('--effort', default='medium')
    t.add_argument('--budget', type=float, default=90.0, help='stop before total API spend (all sets) exceeds this many USD')
    t.add_argument('--batch', type=int, default=40); t.add_argument('--threads', type=int, default=4)
    t.add_argument('--limit', type=int, default=0)
    t.add_argument('--endpoint', help='OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio)')
    t.set_defaults(f=cmd_translate)
    for name, fn in (('check', cmd_check), ('build', cmd_build)):
        c = sp.add_parser(name); c.add_argument('rom'); c.add_argument('setdir')
        if name == 'build': c.add_argument('out')
        else: c.add_argument('--show', type=int, default=30)
        c.add_argument('--lang', required=True)
        c.add_argument('--dawn-rom', help='Dawn ROM (needed for Digimon World DS)'); c.set_defaults(f=fn)
    h = sp.add_parser('shorten'); h.add_argument('rom'); h.add_argument('setdir'); h.add_argument('--lang', required=True)
    h.add_argument('--dawn-rom'); h.add_argument('--model', default='claude-haiku-5-5'); h.add_argument('--effort', default='medium')
    h.add_argument('--budget', type=float, default=90.0); h.add_argument('--batch', type=int, default=25)
    h.add_argument('--threads', type=int, default=6); h.add_argument('--limit', type=int, default=0); h.set_defaults(f=cmd_shorten)
    for name, fn in (('export', cmd_export), ('import', cmd_import)):
        e = sp.add_parser(name); e.add_argument('setdir'); e.add_argument('csv'); e.add_argument('--lang', required=True)
        e.set_defaults(f=fn)
    r = sp.add_parser('release'); r.add_argument('roms', nargs='+'); r.add_argument('--lang', required=True)
    r.add_argument('--workdir', required=True); r.add_argument('--out', required=True)
    r.add_argument('--dawn-rom', help='Dawn ROM, if it is not among the ROMs being patched')
    r.add_argument('--keep-roms', action='store_true', help='also write the patched ROMs (for testing only)')
    r.add_argument('--mod', action='append', default=[], help='mod folder (mods/<name>) to build into the patch of its game; repeatable')
    r.set_defaults(f=cmd_release)
    a = p.parse_args(); a.f(a)

if __name__ == '__main__':
    main()

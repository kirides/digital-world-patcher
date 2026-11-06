"""BPS (beat) patch writer / reader, as understood by RomPatcher.js, Flips, beat.

    create(source, target, hints=())  -> patch bytes
    apply(source, patch)               -> target bytes (verifies all three CRC32s)

`hints` is a list of (start, end) ranges of the source where moved/rewritten data
probably came from (e.g. the original location of a file that was relocated).
Target bytes that also occur there are encoded as SourceCopy, so the patch stays
small and does not carry original game data it can take from the player's ROM.
"""
import zlib

SOURCE_READ, TARGET_READ, SOURCE_COPY, TARGET_COPY = range(4)
KEY = 8          # bytes per index key
MIN_COPY = 12    # shortest SourceCopy worth emitting
BLOCK = 4096


def _num(n, out):
    while True:
        x = n & 0x7F; n >>= 7
        if n == 0: out.append(0x80 | x); return
        out.append(x); n -= 1


def _rd(p, pos):
    n, shift = 0, 1
    while True:
        x = p[pos]; pos += 1
        n += (x & 0x7F) * shift
        if x & 0x80: return n, pos
        shift <<= 7; n += shift


def _index(src, hints):
    idx = {}
    for s, e in hints:
        for j in range(s, max(s, e - KEY + 1), 2):
            idx.setdefault(src[j:j + KEY], j)
    return idx


def create(source, target, hints=()):
    src, tgt = bytes(source), bytes(target)
    out = bytearray(b'BPS1')
    _num(len(src), out); _num(len(tgt), out); _num(0, out)
    idx = _index(src, hints)
    lit = bytearray()
    src_rel = 0
    i, n = 0, len(tgt)
    sr_start = None                     # start of a pending SourceRead run

    def flush_sr(end):
        nonlocal sr_start
        if sr_start is not None and end > sr_start:
            _num(((end - sr_start - 1) << 2) | SOURCE_READ, out)
        sr_start = None

    def flush_lit():
        if lit:
            _num(((len(lit) - 1) << 2) | TARGET_READ, out); out.extend(lit); lit.clear()

    while i < n:
        # fast path: whole aligned blocks identical to the source at the same offset
        if i % BLOCK == 0 and i + BLOCK <= len(src) and i + BLOCK <= n and tgt[i:i + BLOCK] == src[i:i + BLOCK]:
            if sr_start is None: flush_lit(); sr_start = i
            i += BLOCK; continue
        if i < len(src) and tgt[i] == src[i]:
            # require a few equal bytes before switching out of literal mode
            k = i
            while k < n and k < len(src) and tgt[k] == src[k] and k - i < 16: k += 1
            if k - i >= 4 or sr_start is not None or not lit:
                if sr_start is None: flush_lit(); sr_start = i
                i = k; continue
        if idx:
            j = idx.get(tgt[i:i + KEY])
            if j is not None:
                m = KEY
                while i + m < n and j + m < len(src) and tgt[i + m] == src[j + m]: m += 1
                if m >= MIN_COPY and not (i == j):
                    flush_sr(i); flush_lit()
                    _num(((m - 1) << 2) | SOURCE_COPY, out)
                    d = j - src_rel
                    _num((abs(d) << 1) | (d < 0), out)
                    src_rel = j + m
                    i += m; continue
        flush_sr(i)
        lit.append(tgt[i]); i += 1
    flush_sr(n); flush_lit()
    out += zlib.crc32(src).to_bytes(4, 'little')
    out += zlib.crc32(tgt).to_bytes(4, 'little')
    out += zlib.crc32(out).to_bytes(4, 'little')
    return bytes(out)


def apply(source, patch):
    p = bytes(patch)
    if p[:4] != b'BPS1': raise ValueError('not a BPS patch')
    if zlib.crc32(p[:-4]) != int.from_bytes(p[-4:], 'little'): raise ValueError('patch is corrupt')
    if zlib.crc32(source) != int.from_bytes(p[-12:-8], 'little'): raise ValueError('wrong source file (CRC32 mismatch)')
    pos = 4
    ssize, pos = _rd(p, pos); tsize, pos = _rd(p, pos); msize, pos = _rd(p, pos); pos += msize
    if ssize != len(source): raise ValueError('wrong source size')
    t = bytearray(); src_rel = tgt_rel = 0; end = len(p) - 12
    while pos < end:
        x, pos = _rd(p, pos); cmd, ln = x & 3, (x >> 2) + 1
        if cmd == SOURCE_READ:
            o = len(t); t += source[o:o + ln]
        elif cmd == TARGET_READ:
            t += p[pos:pos + ln]; pos += ln
        else:
            d, pos = _rd(p, pos); d = -(d >> 1) if d & 1 else d >> 1
            if cmd == SOURCE_COPY:
                src_rel += d; t += source[src_rel:src_rel + ln]; src_rel += ln
            else:
                tgt_rel += d
                for _ in range(ln): t.append(t[tgt_rel]); tgt_rel += 1
    if len(t) != tsize or zlib.crc32(t) != int.from_bytes(p[-8:-4], 'little'):
        raise ValueError('result does not match the expected target CRC32')
    return bytes(t)

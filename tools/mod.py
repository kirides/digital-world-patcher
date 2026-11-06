"""Apply a data mod (mods/<name>/mod.json) to a ROM. Mods are data-only: records are rewritten in place, nothing
moves, so a mod works on the English ROM and on any translated build of it.

    python mod.py <mod dir> <in.nds> <out.nds>          apply
    python mod.py <mod dir> --bps <in.nds> <out.bps>    write a BPS patch (in -> in + mod)

mod.json:
    game        "ds" | "dawn" | "dusk" (the ROM is checked)
    evolutions  [{from, slot (0-2), to, level, cond, value[, cond2, value2], set_degenerate}]
                writes digivolution route <slot> of species <from>; Dawn/Dusk routes have two conditions
    encounters  [{areas, species, chance}]   DS only: adds one single-Digimon formation with <chance>/10000 to every
                normal encounter group of these areas, taken from the group's most likely formation
Species ids are the game's own (see the editor on the web page, or mod.json files of existing mods).
"""
import json, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ndsfs import NDS

FF = 0xFFFFFFFF
GAMES = {'ADNE': 'ds', 'A3VE': 'dawn', 'A6RE': 'dusk'}
SK_SIZE = {'ds': 88, 'dawn': 112, 'dusk': 112}
EC_SIZE = 102


def records(nds, d, size):
    """[(path, offset in file, record bytes)] for dat/<d>/<n> files (u32 offset header, fixed-size records)"""
    out, n = [], 0
    while 'dat/%s/%d' % (d, n) in nds.files:
        p = 'dat/%s/%d' % (d, n); b = nds.read(p)
        offs = struct.unpack_from('<%dI' % (struct.unpack_from('<I', b)[0] // 4), b)
        out += [(p, o, b[o:o + size]) for o in offs]
        n += 1
    return out


def load(moddir):
    return json.load(open(os.path.join(moddir, 'mod.json'), encoding='utf-8'))


def edits(nds, mod):
    """[(path, offset, new bytes)] for every record the mod changes"""
    game = GAMES.get(nds.code)
    if game != mod['game']: raise SystemExit('mod is for %s, ROM is %s (%s)' % (mod['game'], game, nds.code))
    out = []
    sk = records(nds, 'sk', SK_SIZE[game]); n = SK_SIZE[game] // 4
    rec = {i: list(struct.unpack('<%dI' % n, r)) for i, (_, _, r) in enumerate(sk)}
    touched = set()
    for e in mod.get('evolutions', []):
        f = rec[e['from']]; k = e['slot']
        if game == 'ds':
            ti, bi, block, prev = k, 3 + 6 * k, [1, e['level'], e['cond'], e['value'], 0, 0], 21
        else:
            ti, bi, prev = k + 1, 4 + 6 * (k + 1), 0
            block = [1, e['level'], e['cond'], e['value'], e.get('cond2', 0), e.get('value2', 0)]
        if f[ti] not in (FF, e['to']): raise SystemExit('species %d route %d is used (%d)' % (e['from'], k, f[ti]))
        f[ti] = e['to']; f[bi:bi + 6] = block; touched.add(e['from'])
        if e.get('set_degenerate'):
            rec[e['to']][prev] = e['from']; touched.add(e['to'])
            if game != 'ds': rec[e['to']][4:10] = block_into(rec, e['from'])
    for i in sorted(touched):
        p, o, _ = sk[i]; out.append((p, o, struct.pack('<%dI' % n, *rec[i])))
    if mod.get('encounters'):
        if game != 'ds': raise SystemExit('encounter mods are only supported for Digimon World DS')
        for p, o, r in records(nds, 'ec', EC_SIZE):
            u = list(struct.unpack('<51H', r))
            for enc in mod['encounters']:
                if u[0] not in enc['areas'] or u[2] != 400: continue    # only the normal field groups of these areas
                used = [s for s in range(8) if u[3 + 6 * s] not in (0, 0xFFFF)]
                if len(used) < 2 or len(used) == 8: continue
                big = max(used, key=lambda s: u[3 + 6 * s])
                if u[3 + 6 * big] <= enc['chance']: continue
                u[3 + 6 * big] -= enc['chance']
                new = len(used)
                if new in used: raise SystemExit('unexpected slot layout in %s' % p)
                u[3 + 6 * new:9 + 6 * new] = [enc['chance'], 0xFFFF, 0xFFFF, enc['species'], 0xFFFF, 0xFFFF]
            nb = struct.pack('<51H', *u)
            if nb != r: out.append((p, o, nb))
    return out


def block_into(rec, sp):
    """Dawn/Dusk: block 0 of a record holds the requirement of its 'degenerates to' Digimon"""
    prev = rec[sp][0]
    if prev != FF:
        f = rec[prev]
        for k in (1, 2, 3):
            if f[k] == sp: return f[4 + 6 * k:10 + 6 * k]
    return [0] * 6


def apply(nds, mod):
    for p, o, b in edits(nds, mod):
        d = bytearray(nds.read(p)); d[o:o + len(b)] = b; nds.write(p, d)


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 4 and a[1] == '--bps':
        import bps
        mod = load(a[0]); src = open(a[2], 'rb').read(); r = NDS(a[2]); apply(r, mod); tgt = r.build()
        p = bps.create(src, tgt, [])
        if bps.apply(src, p) != tgt: raise SystemExit('internal error: patch does not reproduce the build')
        open(a[3], 'wb').write(p); print('%d bytes -> %s' % (len(p), a[3]))
    elif len(a) == 3:
        mod = load(a[0]); r = NDS(a[1]); n = len(edits(r, mod)); apply(r, mod); r.save(a[2])
        print('%d records changed -> %s' % (n, a[2]))
    else:
        print(__doc__)

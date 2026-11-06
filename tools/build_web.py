"""Build the web patcher data: web/data/meta.json and web/patches/*.bps, or one self-contained HTML file.

    python build_web.py --patches DIR ROM...                 write web/data/meta.json + web/patches/ (for GitHub Pages)
    python build_web.py --patches DIR --single OUT.html ROM...   one file with everything inlined (local use)

ROM...      the original USA ROMs (Digimon World DS, Dawn, Dusk); only read, to compute checksums and find tables
--patches   folder with the language patches from `dgmtool.py release` (e.g. "Digimon World DS (Deutsch).bps")
Mods in ../mods/<name>/mod.json become presets in the editor of their game.
The page itself (web/index.html, style.css, core.js, app.js) is plain source, not generated.
"""
import base64, json, os, struct, sys, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ndsfs import NDS
import bps, dgmtool, mod as modlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NAME_TABLE = 0x0211F4E0       # arm9: u32 offsets (relative to the table) to 0xFFFF-terminated names, one per species
SPRITE_TABLE = 0x02111C00     # arm9: 16 bytes per species, u16 +0 = battle sprite set dat/BTCHR/<n>
KEY_ITEMS = ['Digivice', 'Return Chip', 'Digi-Cake', 'Star Piece', 'Card Key', 'Miracle DF', 'Miracle DE', "Touma's Sig",
    'Digi-Hot Dog', 'Concert Tckt', 'Digi-Flour', 'Yum Butter', 'Guilmon Bun', 'Metal Brush', 'T-Paper', 'FriendshipDE',
    'Medicine', 'Pillow', 'Gear', 'Digi-Seed', 'Inarizushi', 'Love Charm', 'Cool Shirt', 'GekomonHorn', 'C. Digizoid',
    'Sincerity DE', 'Samba CD', 'P. Recipe', "Etemon's Mic", 'Garbage', 'Slingshot', 'Natto', 'Makeup Set', 'Herb Tea',
    'Digi-Oil', 'Dental Set', 'Digi-Milk', 'Mummy Wrap', 'Digi-Carrot', 'D-1 Ticket', 'Mamemon CD', 'Letter', 'Digi-Cream',
    'Odd Find', 'Snowboard', 'Chilly Ice', 'Digi-Pearl', 'Contacts', 'Digi-Caviar', 'MagmaStone', 'Energy Pack', 'Light DE',
    'Courage DE', 'Kindness DE', 'Hope DE', 'KnowledgeDE', 'Core Piece', 'Antidote Nut', 'Old Key', 'Round Chip',
    'Square Chip', 'Code Key 1', 'Code Key 2', 'Code Key 3', "Masaru's DV", 'Aquinaques', 'Trench Coat', 'Gray Sword',
    'Medal of Honor', 'Miracle DM']   # item ids 429..498
# Digimon you can get without a second player in the original game: normal wild encounters (GameFAQs location guide,
# without boss/arena fights), Tamer Point rewards, passwords and quest rewards. Used only for the page's check.
SOURCES_NAMES = '''Koromon Tsunomon Poyomon Tokomon Tanemon Calumon Dorimon Agumon Betamon Gabumon Patamon Palmon Gotsumon
Otamamon Tapirmon DemiDevimon Hagurumon Wormmon Terriermon Lopmon Renamon Impmon Penguinmon Goburimon Kotemon Crabmon
Floramon Gizamon ToyAgumon(Black) PawnChessmon(Black) Kamemon DotFalcomon DotAgumon BlackAgumon Tyrannomon Devimon
Airdramon Seadramon Veggiemon Ogremon Bakemon Sukamon Kokatorimon Leomon Kuwagamon Raremon Gekomon Wizardmon Togemon
Guardromon Stingmon Birdramon Growlmon Seasarmon Vilemon Aquilamon Roachmon Dinohumon Hookmon Grizzmon Dorugamon
Reptiledramon Apemon Starmon Kiwimon Unimon Sorcerymon DarkTyrannomon PlatinumSukamon Ikkakumon Minotarumon Icemon
DarkLizardmon Diatrymon Monzaemon MetalMamemon Andromon Etemon Megadramon Piximon Angewomon MegaSeadramon Dragomon
WereGarurumon(Black) Myotismon LadyDevimon Blossomon MegaKabuterimon(Red) Cyberdramon Arukenimon Mummymon Rapidmon
Taomon Parrotmon Infermon BlackRapidmon Divermon Triceramon Deramon Silphymon SuperStarmon BlackWarGrowlmon Zudomon
Whamon(Ultimate) Mamemon Meteormon Yatakaramon Garbagemon SaberLeomon MetalEtemon MarineAngemon GigaSeadramon Piedmon
Creepymon Phoenixmon Puppetmon Machinedramon VenomMyotismon Ghoulmon HiAndromon Diaboromon Plesiomon PrinceMamemon
BlackMegaGargomon Jijimon Babamon Parasimon Cannondramon Eaglemon Darkdramon Ghoulmon(Black) Kuzuhamon MetalSeadramon
BlackWarGreymon GranKuwagamon Beelzemon'''.split()
# dex entries that are NPCs: not obtainable in the original game in any way (not even through matching)
NPC_NAMES = {'Koemon', 'Bokomon', 'Neemon', 'Tortomon'}


def species_names(nds):
    g = dgmtool.Game(nds); D = nds.data
    a9o, _, a9ram, _ = struct.unpack_from('<4I', D, 0x20)
    t = NAME_TABLE - a9ram + a9o; first = struct.unpack_from('<I', D, t)[0]
    names = []
    for off in struct.unpack_from('<%dI' % (first // 4), D, t):
        q, u = t + off, []
        while struct.unpack_from('<H', D, q)[0] != 0xFFFF: u.append(struct.unpack_from('<H', D, q)[0]); q += 2
        names.append(g.cs.decode(u))
    return names


EXP = ['dragon', 'beast', 'aquan', 'bird', 'insect', 'machine', 'dark', 'holy']
# [condition type, text key in web/i18n/<lang>.json, scale (stored value * scale = shown value) | 'item' | 'species']
CONDS_DS = [[0, 'cond.0', 1]] + [[2 + i, 'cond.exp.' + e, 10] for i, e in enumerate(EXP)] + [[10, 'cond.exp.total', 10],
    [11, 'cond.atk', 1], [12, 'cond.def', 1], [13, 'cond.spi', 1], [14, 'cond.apt', 1], [15, 'cond.stressMin', 1],
    [16, 'cond.stressMax', 1], [17, 'cond.friendMin', 1], [18, 'cond.friendMax', 1], [19, 'cond.item', 'item'],
    [20, 'cond.party', 'species'], [21, 'cond.befriended', 'species'], [23, 'cond.hours', 1]]
# Dawn/Dusk store values as shown in game (no /10); checked against StrategyWiki's requirement tables
CONDS_PAK = [[0, 'cond.0', 1]] + [[2 + i, 'cond.exp.' + e, 1] for i, e in enumerate(EXP)] + [[10, 'cond.exp.total', 1],
    [11, 'cond.atk', 1], [12, 'cond.def', 1], [13, 'cond.spi', 1], [14, 'cond.spd', 1], [15, 'cond.apt', 1],
    [18, 'cond.friendMin', 1], [21, 'cond.party', 'species'], [22, 'cond.befriended', 'species']]
# sound (dat/*/sound_data.sdat): sequences without a loop are jingles; labels can be added to 'music' as they are identified
# Found by disassembly (Dawn/Dusk: battle music table at 0x0212EB44 indexed by battle type; the DigiLab and the
# digivolution animation set track 31). DS: digivolution track not identified yet, its jingles are 30, 31, 33.
BATTLE = {36 + 0: 1, 37: 2, 41: 3, 38: 4, 42: 5, 39: 6, 43: 7, 40: 8, 44: 9}
SOUND = {'ds': {'jingles': [30, 31, 33], 'digivolveSound': {'seq': 31, 'seconds': 8}, 'defaultTheme': 0, 'music': {}},
         'pak': {'jingles': [32], 'digivolveSound': {'seq': 31, 'seconds': 7}, 'defaultTheme': 0,
                 'music': {31: {'de': 'Digitation', 'en': 'Digivolution'},
                           **{n: {'de': 'Kampf %d' % k, 'en': 'Battle %d' % k} for n, k in BATTLE.items()}}}}
TITLES = {'DIGIMONWORLD': ('ds', 'Digimon World DS'), 'DS2_USA_DAWN': ('dawn', 'Digimon World Dawn'),
          'DS2_USA_DUSK': ('dusk', 'Digimon World Dusk')}


def meta_ds(nds):
    names = species_names(nds)
    g = dgmtool.Game(nds)
    dex_text = g._split(nds.read('dat/msg/DigZknHelp.sdb'))
    dex = [i for i, u in enumerate(dex_text) if g.cs.decode(u).replace('{FFE9}', '').replace('{FFFF}', '').strip()]
    want = set(SOURCES_NAMES) | {'ChronomonHolyMode'}
    return {**SOUND['ds'], 'layout': 'ds', 'skSize': 88, 'nconds': 1, 'conds': CONDS_DS, 'befriended': 21,
            'charset': dgmtool.Charset('sdb', dgmtool.load_lang('de')).dec, 'nameTable': NAME_TABLE, 'spriteTable': SPRITE_TABLE,
            'sources': sorted(i for i in dex if names[i].replace(' ', '') in want),
            'npc': [i for i in dex if names[i] in NPC_NAMES],
            'items': {429 + i: n for i, n in enumerate(KEY_ITEMS)}}


# Dawn/Dusk: same data, the version decides which dungeons can be entered. Encounter areas (dat/ec/enctbl.bin) that a
# version cannot enter, identified by their wild Digimon and checked against the GameFAQs list of version exclusives.
LOCKED_AREAS = {'dawn': [22, 23, 24, 25, 37, 38, 39, 40, 41, 59, 60],   # Magnet Mine, Process Factory, Shadow Abyss
                'dusk': [31, 32, 33, 34, 35, 36, 55, 56, 57, 58]}       # Task Canyon, Highlight Haven


def pak_wild(nds, game):
    """{efile path: [species]} and the set of efile paths a version can reach"""
    e = nds.read('dat/ec/enctbl.bin'); rows = [struct.unpack_from('<4H', e, 8 * i) for i in range(len(e) // 8)]
    efiles = sorted(p for p in nds.files if p.startswith('dat/ec/e') and p[8:11].isdigit())
    species = {}
    for p in efiles:
        b = nds.read(p); n = struct.unpack_from('<H', b)[0]
        species[p] = [struct.unpack_from('<H', b, 16 + 24 * k)[0] for k in range(n)]
    reach = {efiles[r[1]] for r in rows if r[0] != 0xFFFF and r[1] < len(efiles) and r[0] not in LOCKED_AREAS[game]}
    return species, reach


def meta_pak(nds):
    g = dgmtool.Game(nds)
    pat = struct.pack('<10H', *g.cs.encode('Chicchimon')) + bytes([255, 255])   # first name of the species block
    start = bytes(nds.data).find(pat)
    if start < 0: raise SystemExit('name block not found')
    game = TITLES[nds.title][0]; species, reach = pak_wild(nds, game)
    return {**SOUND['pak'], 'layout': 'pak', 'skSize': 112, 'nconds': 2, 'conds': CONDS_PAK, 'befriended': 22, 'idBase': 65,
            'charset': dgmtool.Charset('pak', dgmtool.load_lang('de')).dec, 'nameStart': start,
            'sources': sorted({s for p in reach for s in species[p]}), 'reachFiles': sorted(reach),
            'reachNote': 'reach.notePak'}


def decode_sk(rec, game):
    """one digivolution record -> page state {s: [slot|None]*3, p, (pb)} (same as loadModel in web/core.js)"""
    FF = 0xFFFFFFFF
    if game == 'ds':
        f = struct.unpack('<22I', rec)
        return {'s': [None if f[k] == FF else [f[k], f[4 + 6 * k], f[5 + 6 * k], f[6 + 6 * k]] for k in range(3)],
                'p': None if f[21] == FF else f[21]}
    f = struct.unpack('<28I', rec)
    return {'s': [None if f[k] == FF else [f[k]] + list(f[5 + 6 * k:10 + 6 * k]) for k in (1, 2, 3)],
            'p': None if f[0] == FF else f[0], 'pb': list(f[4:10])}


def add_mods(meta, roms):
    """mods/<name>/mod.json -> a preset per game: the route changes are computed by applying the mod (tools/mod.py)
    to the game's ROM and diffing the digivolution table; encounter additions are passed on as rules"""
    for name in sorted(os.listdir(os.path.join(ROOT, 'mods'))):
        p = os.path.join(ROOT, 'mods', name, 'mod.json')
        if not os.path.exists(p): continue
        m = json.load(open(p, encoding='utf-8'))
        for game in (m['game'] if isinstance(m['game'], list) else [m['game']]):
            g = meta['games'].get(game)
            if not g: continue
            nds = roms[game]; size = modlib.SK_SIZE[game]
            orig = {(pp, o): r for pp, o, r in modlib.records(nds, 'sk', size)}
            idx = {k: i for i, k in enumerate(orig)}
            pre = {}
            for pp, o, nb in modlib.edits(nds, m):
                if (pp, o) not in idx: continue
                a, b = decode_sk(orig[(pp, o)], game), decode_sk(nb, game); ch = {}
                for k in range(3):
                    if a['s'][k] != b['s'][k]: ch['s%d' % k] = b['s'][k]
                for key in ('p', 'pb'):
                    if a.get(key) != b.get(key): ch[key] = b[key]
                if ch: pre[str(idx[(pp, o)])] = ch
            g.setdefault('presets', {})[name] = pre
            g.setdefault('presetNames', {})[name] = {'de': m['name'], 'en': m.get('name_en', m['name'])}
            if m.get('encounters'):
                g['encounters'] = g.get('encounters', []) + [[x['areas'], x['species'], x['chance'], x['where']] for x in m['encounters']]
                sp = [(x['species_name'], x['where']) for x in m['encounters']]
                g['encounterLabel'] = {'de': ' und '.join('%s (%s)' % p for p in sp) + ' als wilde Digimon',
                                       'en': ' and '.join('%s (%s)' % p for p in sp) + ' as wild Digimon'}
            if m.get('wild_copy'):
                g['wildCopy'] = [[w['to'], w['from'], w['species']] for w in m['wild_copy']]
                names = ', '.join(sorted({w['species_name'] for w in m['wild_copy']}))
                g['encounterLabel'] = {'de': 'Version-exklusive Digimon zusätzlich in den Dungeons der anderen Version (%s)' % names,
                                       'en': "Version-exclusive Digimon also in the other version's dungeons (%s)" % names}
            if m.get('sources'): g['sources'] = m['sources']


if __name__ == '__main__':
    a = sys.argv[1:]
    pdir = a[a.index('--patches') + 1]; single = a[a.index('--single') + 1] if '--single' in a else None
    roms = [x for i, x in enumerate(a) if x not in ('--patches', '--single') and (i == 0 or a[i - 1] not in ('--patches', '--single'))]
    meta = {'roms': {}, 'games': {}}; patches = {}; loaded = {}
    for rom in roms:
        nds = NDS(rom); game, title = TITLES[nds.title]; loaded[game] = nds
        name = '%s (Deutsch).bps' % title; patch = open(os.path.join(pdir, name), 'rb').read()   # German is the only translation so far
        src = open(rom, 'rb').read(); de = bps.apply(src, patch); patches[name] = patch
        meta['games'][game] = dict(meta_ds(nds) if game == 'ds' else meta_pak(nds), title=title, translations={'de': {'patch': name, 'name': 'Deutsch'}})
        for lang, data in (('en', src), ('de', de)):
            meta['roms']['%08X' % zlib.crc32(data)] = {'game': game, 'lang': lang, 'crc': '%08X' % zlib.crc32(data), 'patch': name}
    add_mods(meta, loaded)
    i18n = os.path.join(ROOT, 'web', 'i18n')
    langs = {f[:-5]: json.load(open(os.path.join(i18n, f), encoding='utf-8')) for f in sorted(os.listdir(i18n)) if f.endswith('.json')}
    meta['languages'] = {c: d['_name'] for c, d in langs.items()}
    web = os.path.join(ROOT, 'web')
    if single:
        rd = lambda f: open(os.path.join(web, f), encoding='utf-8').read()
        html = rd('index.html')
        html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + rd('style.css') + '</style>')
        pre = ('var DW_META = %s;\nvar DW_INLINE = %s;\nvar DW_I18N = %s;\n' % (json.dumps(meta, separators=(',', ':'), ensure_ascii=False),
               json.dumps({n: base64.b64encode(p).decode() for n, p in patches.items()}), json.dumps(langs, ensure_ascii=False)))
        html = html.replace('<script src="core.js"></script>', '<script>\n' + pre + '</script>\n<script id="core">\n' + rd('core.js') + '</script>')
        html = html.replace('<script src="app.js"></script>', '<script>\n' + rd('app.js') + '</script>')
        open(single, 'w', encoding='utf-8').write(html); print('%s: %d bytes' % (single, len(html)))
    else:
        os.makedirs(os.path.join(web, 'data'), exist_ok=True); os.makedirs(os.path.join(web, 'patches'), exist_ok=True)
        json.dump(meta, open(os.path.join(web, 'data', 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        for n, p in patches.items(): open(os.path.join(web, 'patches', n), 'wb').write(p)
        print('web/data/meta.json + %d patches, games %s' % (len(patches), ', '.join(meta['games'])))

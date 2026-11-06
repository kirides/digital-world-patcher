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


CONDS_DS = [[0, 'keine', 1], [2, 'Drachen-EP ≥', 10], [3, 'Tier-EP ≥', 10], [4, 'Wasser-EP ≥', 10], [5, 'Vogel-EP ≥', 10],
    [6, 'Insekt-EP ≥', 10], [7, 'Maschinen-EP ≥', 10], [8, 'Dunkel-EP ≥', 10], [9, 'Heilig-EP ≥', 10], [10, 'Gesamt-EP ≥', 10],
    [11, 'Angriff ≥', 1], [12, 'Verteidigung ≥', 1], [13, 'Geist ≥', 1], [14, 'Begabung ≥', 1], [15, 'Stress ≥ %', 1],
    [16, 'Stress ≤ %', 1], [17, 'Freundschaft ≥ %', 1], [18, 'Freundschaft ≤ %', 1], [19, 'hat Gegenstand', 'item'],
    [20, 'hat Digimon im Team', 'species'], [21, 'hat Digimon befreundet', 'species'], [23, 'Spielzeit ≥ Std.', 1]]
# Dawn/Dusk: values are stored as shown in game (no /10); checked against StrategyWiki's requirement tables
CONDS_PAK = [[0, 'keine', 1], [2, 'Drachen-EP ≥', 1], [3, 'Tier-EP ≥', 1], [4, 'Wasser-EP ≥', 1], [5, 'Vogel-EP ≥', 1],
    [6, 'Insekt-EP ≥', 1], [7, 'Maschinen-EP ≥', 1], [8, 'Dunkel-EP ≥', 1], [9, 'Heilig-EP ≥', 1], [10, 'Gesamt-EP ≥', 1],
    [11, 'Angriff ≥', 1], [12, 'Verteidigung ≥', 1], [13, 'Geist ≥', 1], [14, 'Tempo ≥', 1], [15, 'Begabung ≥', 1],
    [18, 'Freundschaft ≥ %', 1], [21, 'hat Digimon im Team', 'species'], [22, 'hat Digimon befreundet', 'species']]
TITLES = {'DIGIMONWORLD': ('ds', 'Digimon World DS'), 'DS2_USA_DAWN': ('dawn', 'Digimon World Dawn'),
          'DS2_USA_DUSK': ('dusk', 'Digimon World Dusk')}


def meta_ds(nds):
    names = species_names(nds)
    g = dgmtool.Game(nds)
    dex_text = g._split(nds.read('dat/msg/DigZknHelp.sdb'))
    dex = [i for i, u in enumerate(dex_text) if g.cs.decode(u).replace('{FFE9}', '').replace('{FFFF}', '').strip()]
    want = set(SOURCES_NAMES) | {'ChronomonHolyMode'}
    return {'layout': 'ds', 'skSize': 88, 'nconds': 1, 'conds': CONDS_DS, 'befriended': 21,
            'charset': dgmtool.Charset('sdb', dgmtool.load_lang('de')).dec, 'nameTable': NAME_TABLE, 'spriteTable': SPRITE_TABLE,
            'sources': sorted(i for i in dex if names[i].replace(' ', '') in want),
            'npc': [i for i in dex if names[i] in NPC_NAMES],
            'items': {429 + i: n for i, n in enumerate(KEY_ITEMS)}}


def meta_pak(nds):
    g = dgmtool.Game(nds)
    pat = struct.pack('<10H', *g.cs.encode('Chicchimon')) + bytes([255, 255])   # first name of the species block
    start = bytes(nds.data).find(pat)
    if start < 0: raise SystemExit('name block not found')
    return {'layout': 'pak', 'skSize': 112, 'nconds': 2, 'conds': CONDS_PAK, 'befriended': 22, 'idBase': 65,
            'charset': dgmtool.Charset('pak', dgmtool.load_lang('de')).dec, 'nameStart': start}


def add_mods(meta):
    """mods/<name>/mod.json -> presets (digivolution overrides) and encounter additions of their game"""
    for name in sorted(os.listdir(os.path.join(ROOT, 'mods'))):
        p = os.path.join(ROOT, 'mods', name, 'mod.json')
        if not os.path.exists(p): continue
        m = json.load(open(p, encoding='utf-8')); g = meta['games'].get(m['game'])
        if not g: continue
        pre = {}
        for e in m.get('evolutions', []):
            slot = [e['to'], e['level'], e['cond'], e['value']] + ([e.get('cond2', 0), e.get('value2', 0)] if g['nconds'] == 2 else [])
            pre.setdefault(str(e['from']), {})['s%d' % e['slot']] = slot
            if e.get('set_degenerate'): pre.setdefault(str(e['to']), {})['p'] = e['from']
        g.setdefault('presets', {})[name] = pre
        g.setdefault('presetNames', {})[name] = m['name']
        if m.get('encounters'):
            g['encounters'] = g.get('encounters', []) + [[x['areas'], x['species'], x['chance'], '%s, %d %% der Begegnungen' % (x['where'], x['chance'] // 100)] for x in m['encounters']]
            g['encounterLabel'] = ' und '.join('%s (%s)' % (x['species_name'], x['where']) for x in m['encounters']) + ' als wilde Digimon (%s)' % m['name'].split(':')[0]


if __name__ == '__main__':
    a = sys.argv[1:]
    pdir = a[a.index('--patches') + 1]; single = a[a.index('--single') + 1] if '--single' in a else None
    roms = [x for i, x in enumerate(a) if x not in ('--patches', '--single') and (i == 0 or a[i - 1] not in ('--patches', '--single'))]
    meta = {'roms': {}, 'games': {}}; patches = {}
    for rom in roms:
        nds = NDS(rom); game, title = TITLES[nds.title]
        name = '%s (Deutsch).bps' % title; patch = open(os.path.join(pdir, name), 'rb').read()
        src = open(rom, 'rb').read(); de = bps.apply(src, patch); patches[name] = patch
        meta['games'][game] = dict(meta_ds(nds) if game == 'ds' else meta_pak(nds), title=title)
        for lang, data in (('en', src), ('de', de)):
            meta['roms']['%08X' % zlib.crc32(data)] = {'game': game, 'lang': lang, 'crc': '%08X' % zlib.crc32(data), 'patch': name}
    add_mods(meta)
    web = os.path.join(ROOT, 'web')
    if single:
        rd = lambda f: open(os.path.join(web, f), encoding='utf-8').read()
        html = rd('index.html')
        html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + rd('style.css') + '</style>')
        pre = 'var DW_META = %s;\nvar DW_I\nINE = %s;\n' % (json.dumps(meta, separators=(',', ':'), ensure_ascii=False),
                                                       json.dumps({n: base64.b64encode(p).decode() for n, p in patches.items()}))
        html = html.replace('<script src="core.js"></script>', '<script>\n' + pre + '</script>\n<script id="core">\n' + rd('core.js') + '</script>')
        html = html.replace('<script src="app.js"></script>', '<script>\n' + rd('app.js') + '</script>')
        open(single, 'w', encoding='utf-8').write(html); print('%s: %d bytes' % (single, len(html)))
    else:
        os.makedirs(os.path.join(web, 'data'), exist_ok=True); os.makedirs(os.path.join(web, 'patches'), exist_ok=True)
        json.dump(meta, open(os.path.join(web, 'data', 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        for n, p in patches.items(): open(os.path.join(web, 'patches', n), 'wb').write(p)
        print('web/data/meta.json + %d patches, games %s' % (len(patches), ', '.join(meta['games'])))

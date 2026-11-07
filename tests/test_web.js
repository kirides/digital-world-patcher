// Run the web patcher's core under node and compare its output with the Python builds.
//   node tests/test_web.js <rom dir> <release dir> <mod dir>
// rom dir: the original USA ROMs; release dir: de/*.nds (dgmtool release --keep-roms) and de_offline/ (with --mod mods/ds-offline)
// mod dir: '<Game>_off.nds' and '<Game>_de_off.nds' from tools/mod.py mods/dawn-dusk-offline (EN and German ROM)
// Runs web/core.js with web/data/meta.json and web/patches/*.bps, i.e. exactly what GitHub Pages serves.
const fs = require('fs'), path = require('path');
const [romDir, rel, scratch] = process.argv.slice(2);
const WEB = path.join(__dirname, '..', 'web'), core = fs.readFileSync(path.join(WEB, 'core.js'), 'utf8');
global.DW_META = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'meta.json'), 'utf8'));
const atob = s => Buffer.from(s, 'base64').toString('binary');
const api = new Function('atob', 'fetch', core + '; return { loadModel, ndsFiles, records, icon, encounterTable, exportJSON, importEncounters, sectorThumb, patchRom, presetState, reachable, exportJSON, importJSON, META, INLINE, b64 };')(atob, null);
const rd = p => new Uint8Array(fs.readFileSync(p));
global.localStorage = { getItem: () => null, setItem() {} }; global.document = { addEventListener() {} };
const SDAT = new Function(fs.readFileSync(path.join(WEB, 'sound.js'), 'utf8') + '; return SDAT;')();
const eq = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
let ok = true;
const check = (label, fn, want) => {
  let r; try { r = fn(); } catch (e) { r = e; }
  const pass = want instanceof RegExp ? r instanceof Error && want.test(r.message) : typeof want === 'function' ? !(r instanceof Error) && want(r) : !(r instanceof Error) && eq(r, rd(want));
  console.log((pass ? 'ok   ' : 'FAIL ') + label + (r instanceof Error ? ' (' + r.message + ')' : '')); ok = ok && pass;
};
const bpsOf = m => new Uint8Array(fs.readFileSync(path.join(WEB, 'patches', m.info.patch)));
const games = [
  ['ds', 'Digimon World DS.nds', 'Digimon World DS (Deutsch)'],
  ['dawn', 'Digimon World - Dawn.nds', 'Digimon World Dawn (Deutsch)'],
  ['dusk', 'Digimon World - Dusk.nds', 'Digimon World Dusk (Deutsch)']];
for (const [game, enFile, deName] of games) {
  const E = rd(path.join(romDir, enFile)), deFile = path.join(rel, 'de', deName + '.nds'), D = rd(deFile);
  const mE = api.loadModel(E), mD = api.loadModel(D), orig = api.presetState(mE, 'orig');
  console.log(`== ${game}: ${mE.names.length} records, ${mE.dex.length} Digimon, e.g. ${mE.dex.slice(0, 4).map(i => mE.names[i]).join(', ')}`);
  check(game + ': EN and DE ROM read the same routes', () => JSON.stringify(mE.evo) === JSON.stringify(mD.evo) && JSON.stringify(mE.dex) === JSON.stringify(mD.dex), r => r === true);
  check(game + ': EN -> Deutsch', () => api.patchRom(E, mE, { tr: 'de', enc: false, evo: null }, bpsOf(mE)), deFile);
  check(game + ': Original preset changes nothing', () => api.patchRom(E, mE, { tr: 'de', enc: false, evo: orig }, bpsOf(mE)), deFile);
  check(game + ': Deutsch + Deutsch is refused', () => api.patchRom(D, mD, { tr: 'de' }, null), /err.already/);
  // edit round trip: change the first route of the first Digimon that has one, patch, read back
  const st = api.presetState(mE, 'orig'), i = mE.dex.find(x => st[x].s[0]), s0 = st[i].s[0];
  st[i].s[0] = [s0[0], 42, ...s0.slice(2)]; st[i].s[1] = st[i].s[1] || [mE.dex[5], 33, ...Array(s0.length - 2).fill(0)];
  const out = api.patchRom(E, mE, { tr: null, enc: false, evo: st }, null);
  const rec = out.slice(...(() => { const fl = mE.files[mE.sk[i].path]; return [fl[0] + mE.sk[i].off, fl[0] + mE.sk[i].off + mE.sk[i].rec.length]; })());
  const u = new Uint32Array(rec.slice().buffer), slot0 = game === 'ds' ? [u[0], u[4]] : [u[1], u[11]];
  check(game + ': edited record encodes target + level', () => slot0, r => r[0] === s0[0] && r[1] === 42);
  check(game + ': JSON round trip', () => api.patchRom(E, mE, { tr: null, enc: false, evo: api.importJSON(mE, api.exportJSON(mE, st)) }, null), r => eq(r, out));
  { const f = mE.files[Object.keys(mE.files).find(p => p.toLowerCase().endsWith('.sdat'))], S = SDAT.open(E.subarray(f[0], f[1])), g = api.META.games[game];
    const m = SDAT.render(S, { seq: g.defaultTheme }, { maxSec: 240 }), j = SDAT.render(S, g.digivolveSound, { maxSec: 20, loop: false });
    check(game + `: music renders (${m.seconds.toFixed(0)} s, loop ${m.loopStart !== undefined ? m.loopStart.toFixed(1) + '-' + m.loopEnd.toFixed(1) : 'none'}), digivolve jingle ${j.seconds.toFixed(1)} s`, () => m.peak > 0.05 && j.peak > 0.05 && m.loopEnd > 0, r => r === true); }
  let icons = 0, t0 = Date.now(); for (const x of mE.dex) if (api.icon(E, mE, x)) icons++;
  console.log(`     icons ${icons}/${mE.dex.length} in ${Date.now() - t0} ms`);
  { // encounter lookup: the preview with the mod equals the encounters of the patched ROM; every sector has a thumbnail
    const pre = game === 'ds' ? 'ds-offline' : 'dawn-dusk-offline', P = api.patchRom(E, mE, { tr: null, enc: true, evo: api.presetState(mE, pre) }, null);
    const strip = T => JSON.stringify(T.map(S => S.variants.map(v => v.forms.map(f => [f.mons, f.p.toFixed(4), f.lv]))));
    const T = api.encounterTable(mE, E, true), fP = api.ndsFiles(P), TP = api.encounterTable({ ...mE, files: fP, ec: game === 'ds' ? api.records(P, fP, 'ec', 102) : [] }, P, false);
    check(game + `: encounter lookup, ${T.length} sectors, mod preview = patched ROM`, () => strip(T) === strip(TP) && T.some(S => S.variants.some(v => v.forms.some(f => f.added))), r => r === true);
    { // encounter editor: change a table (DS: 2 formations, Dawn/Dusk: one more entry), patch, read it back
      const T0 = T[0].variants[0], ed = {};
      ed[T0.key] = game === 'ds' ? [{ p: 0.6, pos: [0xFFFF, 0xFFFF, mE.dex[3], 0xFFFF, 0xFFFF] }, { p: 0.4, pos: [0xFFFF, mE.dex[4], 0xFFFF, mE.dex[5], 0xFFFF] }]
        : [...T0.forms.map(f => ({ mons: f.mons, mid: f.mid, w: f.w, lv: f.lv, item: f.item })), { mons: [mE.dex[7]], mid: T0.forms[0].mid, w: 50, lv: 9, item: 0xFFFF }];
      const Q = api.patchRom(E, mE, { tr: null, enc: true, evo: null, encEdits: ed }, null), fQ = api.ndsFiles(Q);
      const TQ = api.encounterTable({ ...mE, files: fQ, ec: game === 'ds' ? api.records(Q, fQ, 'ec', 102) : [] }, Q, false);
      const got = TQ.flatMap(S => S.variants).find(v => v.key === T0.key).forms.map(f => [f.mons, f.p.toFixed(3), f.lv || 0]);
      const want = api.encounterTable(mE, E, true, ed).flatMap(S => S.variants).find(v => v.key === T0.key).forms.map(f => [f.mons, f.p.toFixed(3), f.lv || 0]);
      check(game + ': edited encounter table is patched', () => JSON.stringify(got) === JSON.stringify(want) && JSON.stringify(api.importEncounters(mE, api.exportJSON(mE, orig, ed))) === JSON.stringify(ed), r => r === true);
      if (game === 'ds') check('ds: encounter table must add up to 100 %', () => api.patchRom(E, mE, { tr: null, enc: false, evo: null, encEdits: { [T0.key]: [{ p: 0.5, pos: [0xFFFF, 0xFFFF, mE.dex[3], 0xFFFF, 0xFFFF] }] } }, null), /enc.errSum/); }
    check(game + ': every sector has a thumbnail', () => T.filter(S => !api.sectorThumb(E, mE, S.thumb)).map(S => S.id), r => r.length === 0); }
  if (game !== 'ds') {
    const G = game[0].toUpperCase() + game.slice(1), off = api.presetState(mE, 'dawn-dusk-offline'), offD = api.presetState(mD, 'dawn-dusk-offline');
    check(game + ': EN -> Offline (= tools/mod.py)', () => api.patchRom(E, mE, { tr: null, enc: true, evo: off }, null), path.join(scratch, G + '_off.nds'));
    check(game + ': EN -> Deutsch + Offline', () => api.patchRom(E, mE, { tr: 'de', enc: true, evo: off }, bpsOf(mE)), path.join(scratch, G + '_de_off.nds'));
    check(game + ': Deutsch -> Offline', () => api.patchRom(D, mD, { tr: null, enc: true, evo: offD }, null), path.join(scratch, G + '_de_off.nds'));
    for (const [label, s, enc] of [['Original', orig, false], ['Offline', off, true]]) {
      const h = api.reachable(mE, s, enc), miss = mE.dex.filter(x => !h.has(x));
      console.log(`     ${label}: ${mE.dex.length - miss.length}/${mE.dex.length} without trading; missing: ${miss.map(x => mE.names[x]).join(', ')}`);
    }
  }
  if (game === 'ds') {
    const off = api.presetState(mE, 'ds-offline');
    check('ds: EN -> Offline', () => api.patchRom(E, mE, { tr: null, enc: true, evo: off }, null), path.join(rel, 'offline', 'Digimon World DS (Offline).nds'));
    check('ds: EN -> Deutsch + Offline', () => api.patchRom(E, mE, { tr: 'de', enc: true, evo: off }, bpsOf(mE)), path.join(rel, 'de_offline', 'Digimon World DS (Deutsch + Offline).nds'));
    check('ds: Deutsch -> Offline', () => api.patchRom(D, mD, { tr: null, enc: true, evo: api.presetState(mD, 'ds-offline') }, null), path.join(rel, 'de_offline', 'Digimon World DS (Deutsch + Offline).nds'));
    const dex = mE.dex.filter(x => !api.META.games.ds.npc.includes(x));
    for (const [label, s, enc] of [['Original', orig, false], ['Offline', off, true]]) {
      const h = api.reachable(mE, s, enc); console.log(`     ${label}: ${dex.filter(x => h.has(x)).length}/${dex.length} without matching`);
    }
  }
}
check('wrong ROM is refused', () => api.loadModel(rd(path.join(romDir, 'Digimon World DS.nds')).slice(0, 1 << 20)), /err.unknown/);
process.exit(ok ? 0 : 1);

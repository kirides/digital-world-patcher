// Run the web patcher's core under node and compare its output with the Python builds.
//   node tests/test_web.js <rom dir> <release dir>
// rom dir: the original USA ROMs; release dir: de/*.nds (dgmtool release --keep-roms) and de_offline/ (with --mod mods/ds-offline)
// Runs web/core.js with web/data/meta.json and web/patches/*.bps, i.e. exactly what GitHub Pages serves.
const fs = require('fs'), path = require('path');
const [romDir, rel, scratch] = process.argv.slice(2);
const WEB = path.join(__dirname, '..', 'web'), core = fs.readFileSync(path.join(WEB, 'core.js'), 'utf8');
global.DW_META = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'meta.json'), 'utf8'));
const atob = s => Buffer.from(s, 'base64').toString('binary');
const api = new Function('atob', 'fetch', core + '; return { loadModel, icon, patchRom, presetState, reachable, exportJSON, importJSON, META, INLINE, b64 };')(atob, null);
const rd = p => new Uint8Array(fs.readFileSync(p));
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
  check(game + ': EN -> Deutsch', () => api.patchRom(E, mE, { de: true, enc: false, evo: null }, bpsOf(mE)), deFile);
  check(game + ': Original preset changes nothing', () => api.patchRom(E, mE, { de: true, enc: false, evo: orig }, bpsOf(mE)), deFile);
  check(game + ': Deutsch + Deutsch is refused', () => api.patchRom(D, mD, { de: true }, null), /schon/);
  // edit round trip: change the first route of the first Digimon that has one, patch, read back
  const st = api.presetState(mE, 'orig'), i = mE.dex.find(x => st[x].s[0]), s0 = st[i].s[0];
  st[i].s[0] = [s0[0], 42, ...s0.slice(2)]; st[i].s[1] = st[i].s[1] || [mE.dex[5], 33, ...Array(s0.length - 2).fill(0)];
  const out = api.patchRom(E, mE, { de: false, enc: false, evo: st }, null);
  const rec = out.slice(...(() => { const fl = mE.files[mE.sk[i].path]; return [fl[0] + mE.sk[i].off, fl[0] + mE.sk[i].off + mE.sk[i].rec.length]; })());
  const u = new Uint32Array(rec.slice().buffer), slot0 = game === 'ds' ? [u[0], u[4]] : [u[1], u[11]];
  check(game + ': edited record encodes target + level', () => slot0, r => r[0] === s0[0] && r[1] === 42);
  check(game + ': JSON round trip', () => api.patchRom(E, mE, { de: false, enc: false, evo: api.importJSON(mE, api.exportJSON(mE, st)) }, null), r => eq(r, out));
  let icons = 0, t0 = Date.now(); for (const x of mE.dex) if (api.icon(E, mE, x)) icons++;
  console.log(`     icons ${icons}/${mE.dex.length} in ${Date.now() - t0} ms`);
  if (game === 'ds') {
    const off = api.presetState(mE, 'ds-offline');
    check('ds: EN -> Offline', () => api.patchRom(E, mE, { de: false, enc: true, evo: off }, null), path.join(rel, 'offline', 'Digimon World DS (Offline).nds'));
    check('ds: EN -> Deutsch + Offline', () => api.patchRom(E, mE, { de: true, enc: true, evo: off }, bpsOf(mE)), path.join(rel, 'de_offline', 'Digimon World DS (Deutsch + Offline).nds'));
    check('ds: Deutsch -> Offline', () => api.patchRom(D, mD, { de: false, enc: true, evo: api.presetState(mD, 'ds-offline') }, null), path.join(rel, 'de_offline', 'Digimon World DS (Deutsch + Offline).nds'));
    const dex = mE.dex.filter(x => !api.META.games.ds.npc.includes(x));
    for (const [label, s, enc] of [['Original', orig, false], ['Offline', off, true]]) {
      const h = api.reachable(mE, s, enc); console.log(`     ${label}: ${dex.filter(x => h.has(x)).length}/${dex.length} without matching`);
    }
  }
}
check('wrong ROM is refused', () => api.loadModel(rd(path.join(romDir, 'Digimon World DS.nds')).slice(0, 1 << 20)), /Unbekannte/);
process.exit(ok ? 0 : 1);

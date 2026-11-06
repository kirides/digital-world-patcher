// Core: ROM reading, Nitro graphics, digivolution tables, patching. No DOM access (tests run it under node).
// META (data/meta.json) and INLINE (patches as base64) are only predefined in the single-file build.
var META = typeof DW_META !== 'undefined' ? DW_META : null;
var INLINE = typeof DW_INLINE !== 'undefined' ? DW_INLINE : {};
const FF = 0xFFFFFFFF;
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function b64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
const hex8 = n => n.toString(16).toUpperCase().padStart(8, '0');
const dvOf = u8 => new DataView(u8.buffer, u8.byteOffset, u8.length);
function applyBPS(src, p) {
  if (String.fromCharCode(p[0], p[1], p[2], p[3]) !== 'BPS1') throw new Error('kein BPS-Patch');
  let pos = 4;
  const num = () => { let d = 0, s = 1; for (;;) { const x = p[pos++]; d += (x & 0x7f) * s; if (x & 0x80) return d; s *= 128; d += s; } };
  const ss = num(), ts = num(), ms = num(); pos += ms;
  const dv = dvOf(p), end = p.length - 12;
  if (src.length !== ss || crc32(src) !== dv.getUint32(end, true)) throw new Error('falsche Quell-ROM');
  const out = new Uint8Array(ts); let o = 0, sr = 0, tr = 0;
  while (pos < end) {
    const d = num(), act = d % 4, len = Math.floor(d / 4) + 1;
    if (act === 0) { out.set(src.subarray(o, o + len), o); o += len; }
    else if (act === 1) { out.set(p.subarray(pos, pos + len), o); pos += len; o += len; }
    else { const v = num(), off = (v & 1 ? -1 : 1) * Math.floor(v / 2);
      if (act === 2) { sr += off; out.set(src.subarray(sr, sr + len), o); sr += len; o += len; }
      else { tr += off; for (let i = 0; i < len; i++) out[o++] = out[tr++]; } }
  }
  if (crc32(out) !== dv.getUint32(end + 4, true)) throw new Error('Ergebnis-Prüfsumme falsch');
  return out;
}
function ndsFiles(d) {
  const dv = dvOf(d), fnt = dv.getUint32(0x40, true), fat = dv.getUint32(0x48, true), files = {};
  (function walk(id, pre) {
    let p = fnt + dv.getUint32(fnt + (id & 0xfff) * 8, true), fid = dv.getUint16(fnt + (id & 0xfff) * 8 + 4, true);
    for (;;) { const n = d[p++]; if (!n) break; const l = n & 0x7f; let name = ''; for (let i = 0; i < l; i++) name += String.fromCharCode(d[p + i]); p += l;
      if (n & 0x80) { const sub = dv.getUint16(p, true); p += 2; walk(sub, pre + name + '/'); }
      else { files[pre + name] = [dv.getUint32(fat + fid * 8, true), dv.getUint32(fat + fid * 8 + 4, true)]; fid++; } }
  })(0xF000, '');
  return files;
}
function records(d, files, dir, size) {   // dat/<dir>/<n>: u32 offset header, fixed-size records
  const out = [];
  for (let n = 0; files['dat/' + dir + '/' + n]; n++) {
    const path = 'dat/' + dir + '/' + n, [s] = files[path], dv = dvOf(d), cnt = dv.getUint32(s, true) / 4;
    for (let k = 0; k < cnt; k++) { const off = dv.getUint32(s + 4 * k, true); out.push({ path, off, rec: d.slice(s + off, s + off + size) }); }
  }
  return out;
}
// ---- Nitro graphics: RLE (0x30) / LZ77 (0x10), NCGR tiles, NCLR palette, NCER cells
function decomp(b) {
  const t = b[0], n = b[1] | b[2] << 8 | b[3] << 16; if (t !== 0x10 && t !== 0x30) return b;
  const out = new Uint8Array(n); let p = 4, o = 0;
  if (t === 0x30) while (o < n) { const f = b[p++]; if (f & 0x80) { const v = b[p++]; for (let k = (f & 0x7f) + 3; k-- && o < n;) out[o++] = v; } else for (let k = (f & 0x7f) + 1; k-- && o < n;) out[o++] = b[p++]; }
  else while (o < n) { const fl = b[p++]; for (let k = 0; k < 8 && o < n; k++) {
    if (fl & (0x80 >> k)) { const x = b[p] << 8 | b[p + 1]; p += 2; const d = (x & 0xfff) + 1; for (let L = (x >> 12) + 3; L-- && o < n;) { out[o] = out[o - d]; o++; } }
    else out[o++] = b[p++]; } }
  return out;
}
function sections(d) {
  const dv = dvOf(d), hs = dv.getUint16(12, true), nb = dv.getUint16(14, true), out = {}; let p = hs;
  for (let i = 0; i < nb; i++) { const m = String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]), s = dv.getUint32(p + 4, true); out[m] = d.subarray(p + 8, p + s); p += s; }
  return out;
}
const SHAPES = { '0,0': [8, 8], '0,1': [16, 16], '0,2': [32, 32], '0,3': [64, 64], '1,0': [16, 8], '1,1': [32, 8], '1,2': [32, 16], '1,3': [64, 32], '2,0': [8, 16], '2,1': [8, 32], '2,2': [16, 32], '2,3': [32, 64] };
function spriteImage(cg, pl, ce) {     // first cell of a sprite -> {w, h, rgba}, transparent border trimmed
  const r = sections(cg).RAHC, rv = dvOf(r), bpp = rv.getUint32(4, true) === 3 ? 4 : 8, size = rv.getUint32(16, true), toff = rv.getUint32(20, true);
  const D = r.subarray(toff, toff + size);
  const t = sections(pl).TTLP, tv = dvOf(t), poff = tv.getUint32(12, true), pal = [];
  for (let i = poff; i + 1 < t.length; i += 2) { const c = tv.getUint16(i, true); pal.push([(c & 31) * 255 / 31 | 0, (c >> 5 & 31) * 255 / 31 | 0, (c >> 10 & 31) * 255 / 31 | 0]); }
  const k = sections(ce).KBEC, kv = dvOf(k), n = kv.getUint16(0, true), ext = kv.getUint16(2, true), coff = kv.getUint32(4, true), mapping = kv.getUint32(8, true);
  if (!n) return null;
  const esz = ext & 1 ? 16 : 8, base = coff + n * esz, no = kv.getUint16(coff, true), oo = kv.getUint32(coff + 4, true), oams = [];
  for (let j = 0; j < no; j++) {
    const a0 = kv.getUint16(base + oo + j * 6, true), a1 = kv.getUint16(base + oo + j * 6 + 2, true), a2 = kv.getUint16(base + oo + j * 6 + 4, true);
    let y = a0 & 0xff; if (y >= 128) y -= 256; let x = a1 & 0x1ff; if (x >= 256) x -= 512;
    const [w, h] = SHAPES[(a0 >> 14) + ',' + (a1 >> 14)] || [8, 8];
    oams.push({ x, y, w, h, tile: a2 & 0x3ff, pal: a2 >> 12, hf: !!(a1 & 0x1000), vf: !!(a1 & 0x2000) });
  }
  if (!oams.length) return null;
  const x0 = Math.min(...oams.map(o => o.x)), y0 = Math.min(...oams.map(o => o.y));
  const W = Math.max(...oams.map(o => o.x + o.w)) - x0, H = Math.max(...oams.map(o => o.y + o.h)) - y0;
  const px = new Uint8ClampedArray(W * H * 4), unit = mapping < 0x10 ? 32 << (mapping & 3) : 32, tb = bpp === 4 ? 32 : 64;
  for (const o of [...oams].reverse()) {
    const start = o.tile * unit, tw = o.w / 8;
    for (let ty = 0; ty < o.h / 8; ty++) for (let tx = 0; tx < tw; tx++) { const tt = start + (ty * tw + tx) * tb;
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) {
        let v, ci;
        if (bpp === 4) { const q = tt + yy * 4 + (xx >> 1); if (q >= D.length) continue; v = xx & 1 ? D[q] >> 4 : D[q] & 15; ci = o.pal * 16 + v; }
        else { const q = tt + yy * 8 + xx; if (q >= D.length) continue; v = D[q]; ci = v; }
        if (!v || ci >= pal.length) continue;
        let X = tx * 8 + xx, Y = ty * 8 + yy; if (o.hf) X = o.w - 1 - X; if (o.vf) Y = o.h - 1 - Y;
        const i = ((o.y - y0 + Y) * W + (o.x - x0 + X)) * 4; px[i] = pal[ci][0]; px[i + 1] = pal[ci][1]; px[i + 2] = pal[ci][2]; px[i + 3] = 255;
      } }
  }
  let a = W, b = H, c = -1, e = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3]) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); e = Math.max(e, y); }
  if (c < 0) return null;
  const w2 = c - a + 1, h2 = e - b + 1, out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) out.set(px.subarray(((y + b) * W + a) * 4, ((y + b) * W + a + w2) * 4), y * w2 * 4);
  return { w: w2, h: h2, rgba: out };
}
// ---- read everything from the user's ROM. Two layouts: 'ds' (Digimon World DS) and 'pak' (Dawn/Dusk)
function identify(rom) {
  const crc = crc32(rom), info = META.roms[hex8(crc)];
  if (!info) throw new Error('Unbekannte ROM (CRC32 ' + hex8(crc) + '). Unterstützt: ' + Object.values(META.roms).filter(r => r.lang === 'en').map(r => META.games[r.game].title + ' (USA, CRC32 ' + r.crc + ')').join(', ') + ', und deren deutsche Fassungen aus diesem Patcher.');
  return info;
}
function loadModel(rom) {
  const info = identify(rom), G = META.games[info.game], dv = dvOf(rom), files = ndsFiles(rom);
  const a9o = dv.getUint32(0x20, true), a9ram = dv.getUint32(0x28, true), cs = G.charset;
  const str = q => { let s = ''; for (let u; (u = dv.getUint16(q, true)) !== 0xFFFF; q += 2) s += cs[u] ?? ''; return [s, q + 2]; };
  const sk = records(rom, files, 'sk', G.skSize), n = sk.length, names = [], evo = [];
  let dex = [], sprite = {};
  if (G.layout === 'ds') {
    const nt = G.nameTable - a9ram + a9o;
    for (let i = 0; i < n; i++) names.push(str(nt + dv.getUint32(nt + 4 * i, true))[0]);
    const [zs, ze] = files['dat/msg/DigZknHelp.sdb'];
    for (let i = 0, cnt = dv.getUint32(zs, true) / 4; i < cnt && i < n; i++) {
      const a = zs + dv.getUint32(zs + 4 * i, true), b = i + 1 < cnt ? zs + dv.getUint32(zs + 4 * i + 4, true) : ze;
      for (let q = a; q < b; q += 2) { const u = dv.getUint16(q, true); if (u < 0xFFE0 && u !== 0) { dex.push(i); break; } }
    }
    for (const { rec } of sk) { const u = dvOf(rec), f = k => u.getUint32(4 * k, true);
      evo.push({ s: [0, 1, 2].map(k => f(k) === FF ? null : [f(k), f(4 + 6 * k), f(5 + 6 * k), f(6 + 6 * k)]), p: f(21) === FF ? null : f(21) }); }
    const st = G.spriteTable - a9ram + a9o;
    for (let i = 0; i < n; i++) sprite[i] = dv.getUint16(st + 16 * i, true);
  } else {
    for (let i = 0; i < G.idBase; i++) names.push('');
    let q = G.nameStart;                       // FFFF-separated names, padding counts as empty entries
    while (names.length < n) { let [s, nq] = str(q); q = nq; names.push(s.replace(/^ +/, '').trim()); }
    for (const { rec } of sk) { const u = dvOf(rec), f = k => u.getUint32(4 * k, true);
      const B = k => [f(4 + 6 * k), f(5 + 6 * k), f(6 + 6 * k), f(7 + 6 * k), f(8 + 6 * k), f(9 + 6 * k)];
      evo.push({ s: [1, 2, 3].map(k => f(k) === FF ? null : [f(k), ...B(k).slice(1)]), p: f(0) === FF ? null : f(0), pb: B(0) }); }
    const used = new Set();
    evo.forEach((e, i) => { if (e.p !== null || e.s.some(Boolean)) used.add(i); if (e.p !== null) used.add(e.p); e.s.forEach(s => s && used.add(s[0])); });
    dex = [...used].filter(i => i < n && names[i]).sort((a, b) => a - b);
    const [cs0] = files['dat/btchr/chrsize.bin'], cnt = (files['dat/btchr/chrsize.bin'][1] - cs0) / 4;
    for (let k = 0; k < cnt; k++) { const id = dv.getUint16(cs0 + 4 * k, true); if (!(id in sprite)) sprite[id] = k; }
  }
  const ec = G.layout === 'ds' ? records(rom, files, 'ec', 102) : [];
  return { game: info.game, lang: info.lang, info, files, names, dex, evo, sk, sprite, ec };
}
function icon(rom, model, i) {
  const f = model.files, k = model.sprite[i]; if (k === undefined) return null;
  try {
    if (model.game === 'ds') {
      const p = 'dat/BTCHR/' + k + '.', get = x => { const [s, e] = f[p + x]; return decomp(rom.subarray(s, e)); };
      if (!f[p + 'c'] || !f[p + 'p'] || !f[p + 'l']) return null;
      return spriteImage(get('c'), get('p'), get('l'));
    }
    const [ps] = f['dat/BTCHR.PAK'], dv = dvOf(rom), ent = j => { const o = dv.getUint32(ps + 4 + 8 * j, true), s = dv.getUint32(ps + 8 + 8 * j, true) & 0x7fffffff; return decomp(rom.subarray(ps + o, ps + o + s)); };
    return spriteImage(ent(5 * k + 1), ent(5 * k + 2), ent(5 * k + 3));
  } catch (e) { return null; }
}
// ---- digivolution state: per species {s:[slot|null x3], p:prev|null[, pb]}; slot = [target, level, c1, v1(, c2, v2)]
const clone = o => JSON.parse(JSON.stringify(o));
const G_ = model => META.games[model.game];
function presetState(model, name) {
  const st = clone(model.evo), pre = (G_(model).presets || {})[name];
  if (pre) for (const [id, ch] of Object.entries(pre)) {
    for (const k of [0, 1, 2]) if (('s' + k) in ch) st[id].s[k] = ch['s' + k].slice();
    if ('p' in ch) st[id].p = ch.p;
  }
  return st;
}
const changed = (model, st, i) => JSON.stringify(st[i]) !== JSON.stringify(model.evo[i]);
function encodeRecord(model, st, i) {
  const orig = model.sk[i].rec, e = st[i], u = new Uint32Array(orig.slice().buffer);
  if (model.game === 'ds') {
    for (let k = 0; k < 3; k++) { const s = e.s[k];
      if (s) { u[k] = s[0]; u.set([1, s[1], s[2], s[3]], 3 + 6 * k); } else { u[k] = FF; u.set([0, 0, 0, 0, 0, 0], 3 + 6 * k); } }
    u[21] = e.p === null ? FF : e.p;
  } else {
    for (let k = 0; k < 3; k++) { const s = e.s[k];
      if (s) { u[k + 1] = s[0]; u.set([1, s[1], s[2], s[3], s[4] || 0, s[5] || 0], 4 + 6 * (k + 1)); } else { u[k + 1] = FF; u.set([0, 0, 0, 0, 0, 0], 4 + 6 * (k + 1)); } }
    u[0] = e.p === null ? FF : e.p;
    if (e.p !== model.evo[i].p) {             // block 0 holds the requirement of the "degenerates to" Digimon
      let blk = [0, 0, 0, 0, 0, 0];
      if (e.p !== null && st[e.p] && st[e.p].p !== null) { const s = st[st[e.p].p].s.find(x => x && x[0] === e.p); if (s) blk = [1, s[1], s[2], s[3], s[4] || 0, s[5] || 0]; }
      u.set(blk, 4);
    }
  }
  return new Uint8Array(u.buffer);
}
function validate(model, st) {
  const errs = [], N = model.names;
  st.forEach((e, i) => e.s.forEach(s => { if (!s) return;
    if (!(s[0] >= 0 && s[0] < N.length)) errs.push(N[i] + ': Ziel fehlt');
    if (!(s[1] >= 1 && s[1] <= 99)) errs.push(N[i] + ': Level 1-99');
    if (s.slice(2).some(v => !(v >= 0 && v <= 0xFFFFFFFF))) errs.push(N[i] + ': Wert ungültig'); }));
  return errs;
}
function reachable(model, st, withEnc) {   // only for games with known offline sources
  const G = G_(model); if (!G.sources) return null;
  const have = new Set(G.sources), gate = G.befriended;
  if (withEnc) (G.encounters || []).forEach(e => have.add(e[1]));
  for (let ch = true; ch;) { ch = false;
    for (const i of [...have]) { const e = st[i]; if (!e) continue;
      for (const s of e.s) { if (!s || have.has(s[0])) continue;
        let ok = true; for (let c = 2; c + 1 < s.length; c += 2) if (s[c] === gate && !have.has(s[c + 1])) ok = false;
        if (ok) { have.add(s[0]); ch = true; } }
      if (e.p !== null && !have.has(e.p)) { have.add(e.p); ch = true; } } }
  return have;
}
function encounterEdits(model) {     // DS only, same rule as offline.py
  const out = [], G = G_(model);
  for (const { path, off, rec } of model.ec) {
    const u = new Uint16Array(rec.slice().buffer), before = u.join();
    for (const [areas, sp, chance] of G.encounters || []) {
      if (!areas.includes(u[0]) || u[2] !== 400) continue;
      const used = []; for (let s = 0; s < 8; s++) if (u[3 + 6 * s] !== 0 && u[3 + 6 * s] !== 0xFFFF) used.push(s);
      if (used.length < 2 || used.length === 8) continue;
      let big = used[0]; for (const s of used) if (u[3 + 6 * s] > u[3 + 6 * big]) big = s;
      if (u[3 + 6 * big] <= chance) continue;
      u[3 + 6 * big] -= chance; const nw = used.length;
      if (used.includes(nw)) throw new Error('unerwartetes Begegnungs-Layout in ' + path);
      u.set([chance, 0xFFFF, 0xFFFF, sp, 0xFFFF, 0xFFFF], 3 + 6 * nw);
    }
    if (u.join() !== before) out.push([path, off, new Uint8Array(u.buffer)]);
  }
  return out;
}
function patchRom(rom, model, opt, bps) {  // opt: {de, enc, evo: state|null}; bps: German patch bytes when opt.de
  if (model.lang === 'de' && opt.de) throw new Error('Diese ROM ist schon übersetzt: Häkchen bei „Deutsch“ entfernen.');
  const out = opt.de ? applyBPS(rom, bps) : rom.slice();
  const f = ndsFiles(out), put = (path, off, bytes) => { const [s, e] = f[path]; if (s + off + bytes.length > e) throw new Error('unerwartete Datei ' + path); out.set(bytes, s + off); };
  if (opt.enc) for (const [p, o, b] of encounterEdits(model)) put(p, o, b);
  if (opt.evo) { const errs = validate(model, opt.evo); if (errs.length) throw new Error(errs.slice(0, 5).join('\n'));
    opt.evo.forEach((e, i) => { if (changed(model, opt.evo, i)) put(model.sk[i].path, model.sk[i].off, encodeRecord(model, opt.evo, i)); }); }
  return out;
}
async function germanPatch(model) {
  const name = model.info.patch;
  if (INLINE[name]) return b64(INLINE[name]);
  const r = await fetch('patches/' + encodeURIComponent(name)); if (!r.ok) throw new Error('Patch nicht gefunden: ' + name);
  return new Uint8Array(await r.arrayBuffer());
}
function exportJSON(model, st) {
  const routes = {};
  st.forEach((e, i) => { if (changed(model, st, i)) routes[i] = { name: model.names[i], s: e.s, p: e.p }; });
  return JSON.stringify({ format: 'dw-digivolution', version: 1, game: model.game, routes }, null, 1);
}
function importJSON(model, text) {   // applied on top of the ROM's own table
  const j = JSON.parse(text);
  if (j.format !== 'dw-digivolution' && j.format !== 'dwds-digivolution') throw new Error('keine Digitations-Datei');
  const game = j.game || 'ds'; if (game !== model.game) throw new Error('Datei ist für ' + META.games[game].title + ', geladen ist ' + G_(model).title);
  const st = clone(model.evo);
  for (const [id, r] of Object.entries(j.routes)) { if (!st[id]) throw new Error('unbekannte Nummer ' + id);
    if (!Array.isArray(r.s) || r.s.length !== 3) throw new Error('Format bei ' + id); st[id].s = r.s; st[id].p = r.p ?? null; }
  return st;
}

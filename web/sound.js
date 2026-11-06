// Sound from the user's ROM: a small Nitro sound (SDAT) player. Sequences (SSEQ, and effects inside SSAR archives)
// are rendered in software with their instrument banks (SBNK) and samples (SWAR/SWAV: PCM8, PCM16, IMA-ADPCM; PSG
// square and noise) into a stereo buffer that Web Audio plays; music loops at the sequence's own loop point.
// Nothing is stored or uploaded. The SDAT part has no DOM access, so node can render it in tests.
var SDAT = (() => {
  const RATE = 32768;                                      // output rate (the DS mixer runs at ~32.7 kHz)
  const TICK = 64 * 2728 / 33513982;                       // sequencer update interval in seconds
  const dvo = u8 => new DataView(u8.buffer, u8.byteOffset, u8.length);
  const ADPCM_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const ADPCM_IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

  function open(sdat) {                                    // sdat: Uint8Array of the .sdat file
    const v = dvo(sdat), info = v.getUint32(0x18, true), fat = v.getUint32(0x20, true);
    const rec = k => { const o = info + v.getUint32(info + 8 + 4 * k, true), n = v.getUint32(o, true), out = [];
      for (let i = 0; i < n; i++) { const e = v.getUint32(o + 4 + 4 * i, true); out.push(e ? info + e : 0); } return out; };
    const file = id => { const o = v.getUint32(fat + 12 + 16 * id, true), s = v.getUint32(fat + 16 + 16 * id, true); return sdat.subarray(o, o + s); };
    const S = { file, cache: {},
      seqs: rec(0).map(o => o && { file: v.getUint16(o, true), bank: v.getUint16(o + 4, true), vol: sdat[o + 6] }),
      banks: rec(2).map(o => o && { file: v.getUint16(o, true), wa: [0, 1, 2, 3].map(k => v.getUint16(o + 4 + 2 * k, true)) }),
      waves: rec(3).map(o => o && { file: v.getUint16(o, true) }), arcSeqs: [] };
    for (const o of rec(1)) { if (!o) continue;              // sound effects live in sequence archives (SSAR)
      const f = file(v.getUint16(o, true)), fv = dvo(f), n = fv.getUint32(0x1C, true);
      for (let i = 0; i < n; i++) { const e = 0x20 + 12 * i, off = fv.getUint32(e, true);
        S.arcSeqs.push(off === 0xFFFFFFFF ? null : { data: f, off, bank: fv.getUint16(e + 4, true), vol: f[e + 6] }); } }
    return S;
  }
  function wave(S, wa, idx) {                              // -> {pcm: Float32Array, rate, loop, loopStart}
    const key = wa + ':' + idx; if (key in S.cache) return S.cache[key];
    const w = S.waves[wa]; if (!w) return S.cache[key] = null;
    const f = S.file(w.file), v = dvo(f), n = v.getUint32(0x38, true); if (idx >= n) return S.cache[key] = null;
    const o = v.getUint32(0x3C + 4 * idx, true), type = f[o], loop = f[o + 1], rate = v.getUint16(o + 2, true);
    const loopOff = v.getUint16(o + 6, true) * 4, len = v.getUint32(o + 8, true) * 4, d = o + 12, total = loopOff + len;
    let pcm, ls;
    if (type === 0) { pcm = new Float32Array(total); for (let i = 0; i < total; i++) pcm[i] = ((f[d + i] << 24) >> 24) / 128; ls = loopOff; }
    else if (type === 1) { pcm = new Float32Array(total >> 1); for (let i = 0; i < pcm.length; i++) pcm[i] = v.getInt16(d + 2 * i, true) / 32768; ls = loopOff >> 1; }
    else { let s = v.getInt16(d, true), ix = Math.min(88, f[d + 2]); const nb = Math.max(0, total - 4); pcm = new Float32Array(nb * 2); let p = 0;
      for (let i = 0; i < nb; i++) { const b = f[d + 4 + i];
        for (const nib of [b & 15, b >> 4]) { const st = ADPCM_STEP[ix]; let diff = st >> 3;
          if (nib & 1) diff += st >> 2; if (nib & 2) diff += st >> 1; if (nib & 4) diff += st;
          s = nib & 8 ? Math.max(-32768, s - diff) : Math.min(32767, s + diff);
          ix = Math.min(88, Math.max(0, ix + ADPCM_IDX[nib & 7])); pcm[p++] = s / 32768; } }
      ls = Math.max(0, (loopOff - 4) * 2); }
    return S.cache[key] = { pcm, rate, loop: !!loop, loopStart: ls };
  }
  function instrument(S, bankId, prg, note) {              // -> {kind, wave|duty, base, a, d, s, r, pan} or null
    const b = S.banks[bankId]; if (!b) return null;
    const f = S.file(b.file), v = dvo(f), n = v.getUint32(0x38, true); if (prg >= n) return null;
    const type = f[0x3C + 4 * prg], off = v.getUint16(0x3D + 4 * prg, true);
    const region = (t, o) => { const swav = v.getUint16(o, true), swar = v.getUint16(o + 2, true);
      const r = { base: f[o + 4], a: f[o + 5], d: f[o + 6], s: f[o + 7], r: f[o + 8], pan: f[o + 9] };
      if (t === 1) { r.kind = 'pcm'; r.wave = wave(S, b.wa[swar], swav); if (!r.wave) return null; }
      else if (t === 2) { r.kind = 'square'; r.duty = (swav + 1) / 8; } else if (t === 3) r.kind = 'noise'; else return null;
      return r; };
    if (type >= 1 && type <= 3) return region(type, off);
    if (type === 16) { const lo = f[off], hi = f[off + 1]; if (note < lo || note > hi) return null; const o = off + 2 + 12 * (note - lo); return region(f[o], o + 2); }
    if (type === 17) { let k = 0; while (k < 8 && f[off + k] && note > f[off + k]) k++; if (k >= 8 || !f[off + k]) return null; const o = off + 8 + 12 * k; return region(f[o], o + 2); }
    return null;
  }
  // envelope per sequencer update (an approximation of the DS curves), levels 0..1
  const atk = a => a >= 127 ? 1 : 1 / (1 + Math.pow((127 - a) / 127, 2) * 400);
  const fall = x => x >= 127 ? 1 : 1 / (1 + Math.pow((127 - x) / 127, 2.2) * 1800);
  const amp = x => (x / 127) * (x / 127);

  function render(S, which, opt = {}) {                    // which {seq: n} | {se: n} -> {left, right, rate, seconds, loopStart?, loopEnd?}
    let data, pc0, bankId, vol;
    if (which.seq !== undefined) { const s = S.seqs[which.seq]; if (!s) return null; data = S.file(s.file); bankId = s.bank; vol = s.vol; pc0 = dvo(data).getUint32(0x18, true); }
    else { const s = S.arcSeqs[which.se]; if (!s) return null; data = s.data; bankId = s.bank; vol = s.vol; pc0 = dvo(data).getUint32(0x18, true) + s.off; }
    const base = dvo(data).getUint32(0x18, true), dv = dvo(data), wantLoop = opt.loop !== false;
    const maxSec = opt.maxSec || 240, len = Math.ceil(maxSec * RATE), L = new Float32Array(len), R = new Float32Array(len);
    const tracks = [], voices = [], vars = new Int16Array(64);
    let tempo = 120, acc = 0, tick = 0, master = 127, loop = null, secs = 0;
    const tickTime = [];                                   // seconds at the start of each tick (tempo may change)
    const newTrack = pc => ({ pc, wait: 0, prg: 0, vol: 127, expr: 127, pan: 64, trans: 0, bend: 0, range: 2, noteWait: true,
      a: 255, d: 255, s: 255, r: 255, stack: [], loops: [], done: false, cond: true, seen: {} });
    tracks[0] = newTrack(pc0);
    const vl = t => { let x = 0, b; do { b = data[t.pc++]; x = (x << 7) | (b & 127); } while (b & 128); return x; };
    const u24 = t => { const o = data[t.pc] | data[t.pc + 1] << 8 | data[t.pc + 2] << 16; t.pc += 3; return base + o; };
    function noteOn(t, note, vel, dur) {
      const n = Math.max(0, Math.min(127, note + t.trans)), ins = instrument(S, bankId, t.prg, n); if (!ins) return;
      const pick = (tv, iv) => tv !== 255 ? tv : iv;
      voices.push({ t, ins, note: n, vel, left: dur, pos: 0, env: 0, phase: 'a', a: atk(pick(t.a, ins.a)), d: fall(pick(t.d, ins.d)),
        sus: amp(pick(t.s, ins.s)), r: fall(pick(t.r, ins.r)), lfsr: 0x7FFF });
    }
    function finishLoop(to) { if (!wantLoop || loop) return; loop = { from: tickTime[tracks[0].seen[to]] ?? 0, to: secs }; }
    function step(t) {                                     // run one track until it waits
      for (let guard = 0; guard < 4096 && !t.done && t.wait === 0; guard++) {
        const p = t.pc; if (!(p in t.seen)) t.seen[p] = tick;
        let c = data[t.pc++], cond = true, mode = 0;
        if (c === 0xA2) { cond = t.cond; c = data[t.pc++]; }
        if (c === 0xA0) { mode = 1; c = data[t.pc++]; } else if (c === 0xA1) { mode = 2; c = data[t.pc++]; }
        const arg = def => { if (mode === 1) { const lo = dv.getInt16(t.pc, true), hi = dv.getInt16(t.pc + 2, true); t.pc += 4; return lo + Math.floor(Math.random() * (hi - lo + 1)); }
          if (mode === 2) return vars[data[t.pc++] & 63]; return def(); };
        if (c < 0x80) { const vel = data[t.pc++], dur = arg(() => vl(t)); if (cond) { noteOn(t, c, vel, dur); if (t.noteWait) t.wait = dur; } continue; }
        switch (c) {
          case 0x80: { const x = arg(() => vl(t)); if (cond) t.wait = x; break; }
          case 0x81: { const x = arg(() => vl(t)); if (cond) t.prg = x; break; }
          case 0x93: { const id = data[t.pc++], to = u24(t); if (cond && !tracks[id]) tracks[id] = newTrack(to); break; }
          case 0x94: { const to = u24(t); if (!cond) break;
            if (t === tracks[0] && to <= p && wantLoop) { finishLoop(to); t.done = true; break; } t.pc = to; break; }
          case 0x95: { const to = u24(t); if (cond) { t.stack.push(t.pc); t.pc = to; } break; }
          case 0xFD: if (cond && t.stack.length) t.pc = t.stack.pop(); break;
          case 0xD4: { const n = data[t.pc++]; if (cond) t.loops.push({ pc: t.pc, n }); break; }
          case 0xFC: if (cond && t.loops.length) { const l = t.loops[t.loops.length - 1];
            if (l.n === 0) { if (t === tracks[0] && wantLoop) { finishLoop(l.pc); t.done = true; } else t.pc = l.pc; }
            else if (--l.n > 0) t.pc = l.pc; else t.loops.pop(); } break;
          case 0xFE: t.pc += 2; break;
          case 0xFF: if (cond) t.done = true; break;
          case 0xC0: { const x = data[t.pc++]; if (cond) t.pan = x; break; }
          case 0xC1: { const x = data[t.pc++]; if (cond) t.vol = x; break; }
          case 0xC2: { const x = data[t.pc++]; if (cond) master = x; break; }
          case 0xC3: { const x = (data[t.pc++] << 24) >> 24; if (cond) t.trans = x; break; }
          case 0xC4: { const x = (data[t.pc++] << 24) >> 24; if (cond) t.bend = x; break; }
          case 0xC5: { const x = data[t.pc++]; if (cond) t.range = x; break; }
          case 0xC7: { const x = data[t.pc++]; if (cond) t.noteWait = x === 1; break; }
          case 0xD0: { const x = data[t.pc++]; if (cond) t.a = x; break; }
          case 0xD1: { const x = data[t.pc++]; if (cond) t.d = x; break; }
          case 0xD2: { const x = data[t.pc++]; if (cond) t.s = x; break; }
          case 0xD3: { const x = data[t.pc++]; if (cond) t.r = x; break; }
          case 0xD5: { const x = data[t.pc++]; if (cond) t.expr = x; break; }
          case 0xE1: { const x = dv.getUint16(t.pc, true); t.pc += 2; if (cond) tempo = x || 1; break; }
          case 0xE0: case 0xE3: t.pc += 2; break;
          default:
            if (c >= 0xB0 && c <= 0xBD) { const vi = data[t.pc++] & 63, x = dv.getInt16(t.pc, true); t.pc += 2; if (!cond) break;
              switch (c) { case 0xB0: vars[vi] = x; break; case 0xB1: vars[vi] += x; break; case 0xB2: vars[vi] -= x; break; case 0xB3: vars[vi] *= x; break;
                case 0xB4: if (x) vars[vi] = Math.trunc(vars[vi] / x); break; case 0xB5: vars[vi] = x < 0 ? vars[vi] >> -x : vars[vi] << x; break;
                case 0xB6: vars[vi] = Math.floor(Math.random() * (x + 1)); break;
                case 0xB8: t.cond = vars[vi] === x; break; case 0xB9: t.cond = vars[vi] >= x; break; case 0xBA: t.cond = vars[vi] > x; break;
                case 0xBB: t.cond = vars[vi] <= x; break; case 0xBC: t.cond = vars[vi] < x; break; case 0xBD: t.cond = vars[vi] !== x; break; } }
            else if (c >= 0xC0 && c <= 0xDF) t.pc += 1;      // other one-byte parameters (priority, modulation, portamento ...)
            else t.done = true;                               // unknown command: stop this track
        }
      }
    }
    const spu = TICK * RATE; let out = 0, frac = 0;
    while (out < len) {
      acc += tempo;
      while (acc >= 240) { acc -= 240; tickTime[tick] = secs;
        for (const t of tracks) if (t && !t.done) { if (t.wait > 0) t.wait--; if (t.wait === 0) step(t); }
        for (const vo of voices) if (vo.phase !== 'r' && --vo.left <= 0) vo.phase = 'r';
        tick++; }
      if (loop) break;                                     // music: stop at the loop point, Web Audio loops the buffer
      for (const vo of voices) {
        if (vo.phase === 'a') { vo.env += vo.a * (1.01 - vo.env); if (vo.env >= 0.999) { vo.env = 1; vo.phase = 'd'; } }
        else if (vo.phase === 'd') { vo.env -= vo.d * (vo.env - vo.sus) + 1e-5; if (vo.env <= vo.sus) { vo.env = vo.sus; vo.phase = 's'; } }
        else if (vo.phase === 'r') vo.env = vo.env * (1 - vo.r) - 1e-4;
      }
      for (let i = voices.length - 1; i >= 0; i--) if (voices[i].env <= 0 || voices[i].dead) voices.splice(i, 1);
      if (tracks.every(t => !t || t.done) && !voices.length) break;
      frac += spu; const n = Math.min(Math.floor(frac), len - out); frac -= Math.floor(frac);
      for (const vo of voices) {
        const t = vo.t, ins = vo.ins, g = amp(vo.vel) * amp(t.vol) * amp(t.expr) * amp(master) * amp(vol) * 0.6 * vo.env;
        const pan = Math.max(0, Math.min(127, t.pan + ins.pan - 64)) / 127, gl = g * Math.cos(pan * Math.PI / 2), gr = g * Math.sin(pan * Math.PI / 2);
        if (ins.kind === 'pcm') { const w = ins.wave, pcm = w.pcm, ln = pcm.length, inc = w.rate * Math.pow(2, (vo.note - ins.base + t.bend * t.range / 128) / 12) / RATE;
          for (let k = 0; k < n; k++) { let p = vo.pos;
            if (p >= ln - 1) { if (w.loop && ln - 1 > w.loopStart) p = w.loopStart + (p - (ln - 1)) % (ln - 1 - w.loopStart); else { vo.dead = true; break; } }
            const i0 = p | 0, s = pcm[i0] + (pcm[i0 + 1] - pcm[i0]) * (p - i0);
            L[out + k] += s * gl; R[out + k] += s * gr; vo.pos = p + inc; } }
        else { const hz = 440 * Math.pow(2, (vo.note - 69 + t.bend * t.range / 128) / 12), inc = hz / RATE;
          for (let k = 0; k < n; k++) { let s;
            if (ins.kind === 'square') s = (vo.pos % 1) < ins.duty ? 0.5 : -0.5;
            else { const before = Math.floor(vo.pos * 8); if (Math.floor((vo.pos + inc) * 8) !== before) { const bit = (vo.lfsr ^ (vo.lfsr >> 1)) & 1; vo.lfsr = (vo.lfsr >> 1) | (bit << 14); } s = vo.lfsr & 1 ? 0.4 : -0.4; }
            L[out + k] += s * gl; R[out + k] += s * gr; vo.pos += inc; } }
      }
      out += n; secs = out / RATE;
    }
    let peak = 0; for (let i = 0; i < out; i += 5) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    if (peak > 0.95) { const k = 0.95 / peak; for (let i = 0; i < out; i++) { L[i] *= k; R[i] *= k; } }
    const res = { left: L.subarray(0, out), right: R.subarray(0, out), rate: RATE, seconds: out / RATE, peak };
    if (loop && loop.to > loop.from + 0.5) { res.loopStart = loop.from; res.loopEnd = loop.to; }
    return res;
  }
  return { open, render, RATE };
})();

// UI glue: theme music and effects. Only the settings (mute, theme number) are remembered, never ROM data.
var DWSound = (() => {
  let ctx = null, S = null, cur = null, src = null, gain = null, muted = localStorage.getItem('dw-mute') === '1', token = 0, volume = +(localStorage.getItem('dw-music-volume') ?? 0.10), fxGain = null;
  const FX_VOLUME = 0.5;                                   // digivolve sound and other effects
  const cache = {};
  function ensure() { if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); gain = ctx.createGain(); gain.gain.value = volume; gain.connect(ctx.destination); fxGain = ctx.createGain(); fxGain.gain.value = FX_VOLUME; fxGain.connect(ctx.destination); } if (ctx.state === 'suspended') ctx.resume(); }
  function stop() { if (src) { try { src.stop(); } catch (e) {} src = null; } }
  async function play(which, loop) {
    if (muted || !S) return null; ensure();
    const key = JSON.stringify(which);
    if (!(key in cache)) { await new Promise(r => setTimeout(r, 0)); cache[key] = SDAT.render(S, which, { maxSec: loop ? 240 : 20, loop }); }
    const r = cache[key]; if (!r || !r.left.length) return null;
    const b = ctx.createBuffer(2, r.left.length, r.rate); b.copyToChannel(r.left, 0); b.copyToChannel(r.right, 1);
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(loop ? gain : fxGain);
    if (loop) { s.loop = true; if (r.loopEnd) { s.loopStart = r.loopStart; s.loopEnd = r.loopEnd; } }
    s.start(); return s;
  }
  document.addEventListener('pointerdown', () => { if (ctx && ctx.state === 'suspended' && !document.hidden) ctx.resume(); }, true);
  // background tab: pause all sound, resume when the tab is shown again
  document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else if (!muted) ctx.resume(); });
  return {
    load(rom, files) { stop(); cur = null; S = null; for (const k in cache) delete cache[k];
      const k = Object.keys(files).find(p => p.toLowerCase().endsWith('.sdat')); if (k) { const [s, e] = files[k]; S = SDAT.open(rom.subarray(s, e)); } return !!S; },
    tracks() { return S ? S.seqs.map((s, i) => s ? i : -1).filter(i => i >= 0) : []; },
    effects() { return S ? S.arcSeqs.map((s, i) => s ? i : -1).filter(i => i >= 0) : []; },
    async theme(n) { cur = n; const my = ++token; stop(); if (n === null || n < 0) return; const s = await play({ seq: n }, true); if (my === token && s) src = s; else if (s) s.stop(); },
    async effect(n) { if (n !== null && n >= 0) await play({ se: n }, false); },
    async play1(which) { await play(which, false); },
    get muted() { return muted; },
    get volume() { return volume; },
    setVolume(v) { volume = v; localStorage.setItem('dw-music-volume', v); if (gain) gain.gain.value = v; },
    setMuted(m) { muted = m; localStorage.setItem('dw-mute', m ? '1' : '0'); if (m) stop(); else if (cur !== null) this.theme(cur); },
  };
})();

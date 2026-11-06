// Page logic. Texts: web/i18n/<lang>.json (t('key', {vars})); data from the loaded ROM via core.js.
const $ = id => document.getElementById(id);
let rom = null, model = null, G = null, st = null, cur = 0, DEX = [], COUNTED = [], ICON = {}, dupe = {};
let LANG = 'en', TXT = {}, TXT_EN = {};
const t = (k, v) => tr(k, v);
var DW_T = k => (k in TXT ? TXT[k] : TXT_EN[k]);
const L = o => (o && typeof o === 'object') ? (o[LANG] ?? o.en ?? Object.values(o)[0]) : o;   // {de, en} -> text
const N = i => (model.names[i] || '#' + i) + (dupe[i] ? ' #' + i : '');
const img = (i, cls = 'ico') => ICON[i] ? `<img class="${cls}" src="${ICON[i]}" alt="">` : `<span class="${cls}"></span>`;
const condOf = c => G.conds.find(x => x[0] === c) || [c, null, 1];
const condName = c => { const d = condOf(c); return d[1] ? t(d[1]) : t('ed.type', { n: c }); };
const opts = (list, sel) => list.map(([v, x]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${x}</option>`).join('');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- language
function pickLang() {
  const have = Object.keys(META.languages), saved = localStorage.getItem('dw-lang');
  if (saved && have.includes(saved)) return saved;
  for (const l of navigator.languages || [navigator.language || 'en']) { const c = l.toLowerCase().split('-')[0]; if (have.includes(c)) return c; }
  return have.includes('en') ? 'en' : have[0];
}
async function loadLang(code) {
  const get = async c => (typeof DW_I18N !== 'undefined' && DW_I18N[c]) || (await (await fetch('i18n/' + c + '.json')).json());
  TXT_EN = await get('en'); TXT = code === 'en' ? TXT_EN : await get(code); LANG = code;
  document.documentElement.lang = code;
  document.querySelectorAll('[data-i18n]').forEach(el => el.innerHTML = t(el.dataset.i18n));
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => el.placeholder = t(el.dataset.i18nPh));
  document.title = t('meta.title');
  $('lang').innerHTML = opts(Object.entries(META.languages).map(([c, n]) => [c, '🌐 ' + n]), code);
  setMuted(DWSound.muted);
  if (model) { fillGameUI(false); refresh(); soundLists(); }
}
$('lang').onchange = () => { localStorage.setItem('dw-lang', $('lang').value); loadLang($('lang').value); };

// ---- species picker
function pickBtn(sel, attrs) { return `<button type="button" class="pick" ${attrs}>${sel === null || sel === '' || sel === undefined ? `<span class="ico"></span><span class="mut">${t('ed.none')}</span>` : img(sel) + '<span>' + N(sel) + '</span>'}</button>`; }
let popCb = null;
function openPick(el, allowNone, cb) {
  popCb = cb; const r = el.getBoundingClientRect(), p = $('pop');
  p.style.left = (r.left + scrollX) + 'px'; p.style.top = (r.bottom + scrollY + 4) + 'px'; p.classList.remove('hide');
  $('popq').value = ''; fillPick(allowNone); $('popq').oninput = () => fillPick(allowNone); $('popq').focus();
}
function fillPick(allowNone) {
  const q = $('popq').value.toLowerCase();
  $('popl').innerHTML = (allowNone ? `<div class="row" data-v=""><span class="ico"></span><i>${t('ed.none')}</i></div>` : '') +
    DEX.filter(i => N(i).toLowerCase().includes(q)).map(i => `<div class="row" data-v="${i}">${img(i)}<span>${N(i)}</span></div>`).join('');
  $('popl').querySelectorAll('.row').forEach(el => el.onclick = () => { $('pop').classList.add('hide'); popCb(el.dataset.v === '' ? null : +el.dataset.v); });
}
document.addEventListener('mousedown', e => { if (!$('pop').contains(e.target) && !e.target.closest('.pick')) $('pop').classList.add('hide'); });

// ---- editor
function valueField(k, c, s) {          // condition c = index into slot (2, 4)
  const ty = s[c], v = s[c + 1], cd = condOf(ty), a = `data-k="${k}" data-c="${c}"`;
  if (ty === 0) return '';
  if (cd[2] === 'item') return `<select ${a} data-f="v">${opts(Object.entries(G.items || {}).map(([x, n]) => [+x, n]), v)}</select>`;
  if (cd[2] === 'species') return pickBtn(v, `${a} data-f="vs"`);
  return `<input type="number" min="0" ${a} data-f="v" value="${v * cd[2]}">`;
}
function renderDetail() {
  const e = st[cur], from = [], nc = G.nconds;
  st.forEach((x, i) => x.s.forEach(s => { if (s && s[0] === cur) from.push(i); }));
  const go = i => `<button class="go" data-go="${i}" title="${esc(t('ed.goto', { name: N(i) }))}">➜</button>`;
  const wild = [...(G.encounters || []).filter(x => x[1] === cur).map(x => t('ed.wildEnc', { where: x[3], pct: x[2] / 100 })),
    ...(G.wildCopy || []).filter(w => w[2] === cur).map(w => t('ed.wildIn', { file: w[0].replace('dat/ec/', '') }))];
  let h = `<div class="mon"><div class="portrait">${ICON[cur] ? `<img src="${ICON[cur]}" alt="">` : ''}</div><div>
    <h3>${N(cur)}${changed(model, st, cur) ? `<span class="tag">${t('ed.changed')}</span>` : ''}</h3>
    <p class="chips"><span class="mut" style="cursor:default">${t('ed.from')}</span> ${from.map(i => `<span data-go="${i}">${img(i)}${N(i)}</span>`).join('') || `<i class="mut">${t('ed.fromNone')}</i>`}</p>
    ${wild.length ? `<p class="wild">${t('ed.wild')} ${wild.join(' · ')} ${$('enc').checked ? '' : `<span class="err">${t('ed.wildOff')}</span>`}</p>` : ''}
  </div></div><div class="routes">`;
  const condOpts = G.conds.map(x => [x[0], t(x[1])]);
  e.s.forEach((s, k) => {
    h += `<div class="route${s ? '' : ' empty'}"><div class="head">${pickBtn(s ? s[0] : null, `data-k="${k}" data-f="t"`)}${s ? go(s[0]) : ''}</div>`;
    if (s) {
      h += `<div class="kv"><span class="lbl">${t('ed.level')}</span><input type="number" min="1" max="99" data-k="${k}" data-f="l" value="${s[1]}"></div>`;
      for (let c = 2; c < 2 + 2 * nc; c += 2) {
        const list = condOf(s[c])[1] ? condOpts : [...condOpts, [s[c], condName(s[c])]];
        h += `<div class="cond"><select data-k="${k}" data-c="${c}" data-f="c">${opts(list, s[c])}</select>${valueField(k, c, s)}</div>`; }
    } else h += `<span class="mut">${t('ed.free')}</span>`;
    h += '</div>';
  });
  h += `</div><div class="degen"><span class="mut">${t('ed.degen')}</span> ${pickBtn(e.p, 'id="prev"')}${e.p !== null ? go(e.p) : ''}
    <span class="grow"></span><button id="rst" class="ghost">${t('ed.reset', { name: N(cur) })}</button></div>`;
  $('detail').innerHTML = h;
  { const rs = $('detail').querySelector('.routes'), last = rs && rs.lastElementChild;   // tree trunk ends at the last branch
    if (last) rs.style.setProperty('--trunk-end', (last.offsetHeight - parseFloat(getComputedStyle(last).fontSize) * 1.55 - 2) + 'px'); }
  const S = () => st[cur].s;
  $('detail').querySelectorAll('[data-k]').forEach(el => {
    const k = +el.dataset.k, f = el.dataset.f, c = +el.dataset.c;
    if (f === 't') el.onclick = () => openPick(el, true, v => { const s = S(); s[k] = v === null ? null : (s[k] ? [v, ...s[k].slice(1)] : [v, 20, ...Array(2 * nc).fill(0)]); refresh(); });
    else if (f === 'vs') el.onclick = () => openPick(el, false, v => { S()[k][c + 1] = v; refresh(); });
    else el.onchange = () => { const s = S();
      if (f === 'l') s[k][1] = Math.max(1, Math.min(99, +el.value || 1));
      else if (f === 'c') { s[k][c] = +el.value; const cd = condOf(+el.value); s[k][c + 1] = cd[2] === 'species' ? cur : cd[2] === 'item' ? +Object.keys(G.items)[0] : 0; }
      else { const cd = condOf(s[k][c]); s[k][c + 1] = cd[2] === 'item' ? +el.value : Math.round((+el.value || 0) / cd[2]); }
      refresh(); };
  });
  $('prev').onclick = () => openPick($('prev'), true, v => { st[cur].p = v; refresh(); });
  $('rst').onclick = () => { st[cur] = clone(model.evo[cur]); refresh(); };
  $('detail').querySelectorAll('[data-go]').forEach(el => el.onclick = () => { cur = +el.dataset.go; refresh(); });
}
function refresh() {
  const have = reachable(model, st, $('enc').checked), miss = have ? COUNTED.filter(i => !have.has(i)) : [];
  $('reach').innerHTML = !have ? `<span class="mut">${t('reach.none')}</span>` :
    t('reach.count', { have: COUNTED.length - miss.length, total: COUNTED.length }) +
    (miss.length ? t('reach.missing') : ' <span class="ok">✓</span>') + (G.npc && G.npc.length ? ` <span class="mut">${t('reach.npc', { list: G.npc.map(N).join(', ') })}</span>` : '') +
    (G.reachNote ? ` <span class="mut">${t(G.reachNote)}</span>` : '');
  $('missing').innerHTML = miss.map(i => `<span data-go="${i}">${img(i)}${N(i)}</span>`).join('');
  $('missing').querySelectorAll('[data-go]').forEach(el => el.onclick = () => { cur = +el.dataset.go; refresh(); });
  const q = $('q').value.toLowerCase(), only = $('onlychg').checked;
  $('list').innerHTML = DEX.filter(i => N(i).toLowerCase().includes(q) && (!only || changed(model, st, i)))
    .map(i => `<div data-i="${i}" class="row ${i === cur ? 'sel ' : ''}${changed(model, st, i) ? 'chg ' : ''}${!have || have.has(i) || (G.npc || []).includes(i) ? '' : 'miss'}">${img(i)}<span class="nm">${N(i)}</span></div>`).join('');
  $('list').querySelectorAll('.row').forEach(el => el.onclick = () => { cur = +el.dataset.i; refresh(); });
  renderDetail();
}
function toDataURL(im) {
  const c = document.createElement('canvas'); c.width = im.w; c.height = im.h;
  c.getContext('2d').putImageData(new ImageData(im.rgba, im.w, im.h), 0, 0); return c.toDataURL();
}
// presets, translation choice, extra encounters: depend on game and page language
function fillGameUI(first) {
  const sel = first ? null : $('preset').value;
  const presets = [...Object.entries(G.presetNames || {}).map(([k, v]) => [k, L(v)]).reverse(), ['orig', t('s2.orig')]];
  $('preset').innerHTML = opts(presets, sel ?? presets[0][0]);
  const trs = G.translations || {}, curTr = first ? (trs[LANG] ? LANG : null) : (document.querySelector('input[name=tr]:checked') || {}).value || null;
  if (model.lang !== 'en') $('trbox').innerHTML = `<span class="mut">${t('s3.trDone', { lang: (trs[model.lang] || {}).name || model.lang })}</span>`;
  else $('trbox').innerHTML = [['', t('s3.trNone')], ...Object.entries(trs).map(([c, x]) => [c, t('s3.tr', { lang: x.name })])]
    .map(([c, label]) => `<label class="opt"><input type="radio" name="tr" value="${c}"${(curTr || '') === c ? ' checked' : ''}><span>${label}</span></label>`).join('');
  $('enclab').classList.toggle('hide', !(G.encounters || G.wildCopy)); $('enctext').textContent = L(G.encounterLabel) || '';
}
var loadFile = async function (file) {
  $('msg1').className = ''; $('msg1').textContent = t('s1.reading', { file: file.name });
  try { rom = new Uint8Array(await file.arrayBuffer()); model = loadModel(rom); G = G_(model); }
  catch (err) { $('msg1').textContent = err.message; $('msg1').className = 'err'; return; }
  DEX = model.dex; COUNTED = DEX.filter(i => !(G.npc || []).includes(i)); dupe = {}; ICON = {};
  const seen = {}; DEX.forEach(i => { if (model.names[i] in seen) dupe[i] = 1; else seen[model.names[i]] = 1; });
  for (let j = 0; j < DEX.length; j++) {
    const im = icon(rom, model, DEX[j]); if (im) ICON[DEX[j]] = toDataURL(im);
    if (j % 20 === 0) { $('msg1').textContent = t('s1.icons', { n: j, total: DEX.length }); await new Promise(r => setTimeout(r)); }
  }
  const version = model.lang === 'en' ? t('ver.en') : t('ver.tr', { lang: ((G.translations || {})[model.lang] || {}).name || model.lang });
  $('msg1').innerHTML = `<span class="ok">${esc(t('s1.loaded', { file: file.name, game: G.title, version, count: DEX.length }))}</span>`;
  fillGameUI(true); $('enc').checked = !!(G.encounters || G.wildCopy);
  st = presetState(model, $('preset').value); cur = DEX[0]; $('main').classList.remove('hide'); $('step1').classList.add('loaded'); refresh(); soundSetup();
};
$('rom').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
const drop = $('drop');
const ready = (async () => { if (!META) META = await (await fetch('data/meta.json')).json(); await loadLang(pickLang()); })();
const loadFile0 = loadFile; loadFile = async f => { await ready; return loadFile0(f); };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]); };
$('q').oninput = refresh; $('onlychg').onchange = refresh; $('enc').onchange = refresh;
$('apply').onclick = () => { st = presetState(model, $('preset').value); if (G.encounters || G.wildCopy) $('enc').checked = $('preset').value !== 'orig'; refresh(); };
$('exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([exportJSON(model, st)], { type: 'application/json' })); a.download = 'digivolutions-' + model.game + '.json'; a.click(); };
$('impb').onclick = () => $('imp').click();
$('imp').onchange = async e => { try { st = importJSON(model, await e.target.files[0].text()); refresh(); } catch (err) { alert(err.message); } e.target.value = ''; };
$('go').onclick = async () => {
  const trc = model.lang === 'en' ? ((document.querySelector('input[name=tr]:checked') || {}).value || null) : null;
  const enc = $('enc').checked && !!(G.encounters || G.wildCopy), evo = $('evo').checked && st.some((x, i) => changed(model, st, i)) ? st : null;
  try {
    $('msg').textContent = t('s3.working'); $('msg').className = ''; digivolveFx();
    const out = patchRom(rom, model, { tr: trc, enc, evo }, trc ? await translationPatch(model, trc) : null);
    const trName = trc ? G.translations[trc].name : model.lang !== 'en' ? ((G.translations || {})[model.lang] || {}).name : null;
    const tags = [trName, (enc || evo) && 'Mod'].filter(Boolean);
    const name = G.title + (tags.length ? ' (' + tags.join(' + ') + ')' : '') + '.nds';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out])); a.download = name; a.click();
    $('msg').textContent = t('s3.done', { file: name }); $('msg').className = 'ok';
  } catch (err) { $('msg').textContent = err.message; $('msg').className = 'err'; }
};

// ---- sound: theme music, digivolve sound, sound test (settings in localStorage, ROM data never stored)
const SND = { key: k => 'dw-' + k + '-' + (model ? model.game : ''), jingles: [] };
const trackName = n => L((G.music || {})[n]) || t('st.track', { n: String(n).padStart(2, '0') });
function soundSetup() {
  if (!DWSound.load(rom, model.files)) { $('theme').disabled = true; return; }
  SND.jingles = (G.jingles || []);
  const saved = localStorage.getItem(SND.key('theme'));
  soundLists(saved !== null ? saved : (G.defaultTheme ?? -1));
  themeChanged();
}
function soundLists(themeValue) {
  if (!DWSound.tracks().length) return;
  const tracks = DWSound.tracks(), val = themeValue ?? $('theme').value;
  $('theme').innerHTML = `<option value="-1">${t('head.musicOff')}</option>` + tracks.filter(n => !SND.jingles.includes(n)).map(n => `<option value="${n}">♪ ${trackName(n)}</option>`).join('');
  $('theme').disabled = false; $('theme').value = val;
  const evo = JSON.parse(localStorage.getItem(SND.key('evo')) || 'null') || G.digivolveSound || null;
  const item = (label, which) => `<div class="st-item${JSON.stringify(which) === JSON.stringify(evo) ? ' on' : ''}" data-w='${JSON.stringify(which)}'><span class="nm">${label}</span><button class="ghost" data-a="play">▶</button><button class="ghost" data-a="evo" title="${esc(t('st.star'))}">★</button></div>`;
  $('st-music').innerHTML = tracks.map(n => item(trackName(n) + (SND.jingles.includes(n) ? ' ' + t('st.jingle') : ''), { seq: n })).join('');
  $('st-se').innerHTML = DWSound.effects().map(n => item(t('st.effect', { n: String(n).padStart(3, '0') }), { se: n })).join('');
  document.querySelectorAll('.st-item').forEach(el => {
    const w = JSON.parse(el.dataset.w);
    el.querySelector('[data-a=play]').onclick = () => { if (DWSound.muted) setMuted(false); w.seq !== undefined && !SND.jingles.includes(w.seq) ? ($('theme').value = w.seq, themeChanged()) : DWSound.play1(w); };
    el.querySelector('[data-a=evo]').onclick = () => { localStorage.setItem(SND.key('evo'), JSON.stringify(w)); document.querySelectorAll('.st-item.on').forEach(x => x.classList.remove('on')); el.classList.add('on'); };
  });
}
function themeChanged() { const n = +$('theme').value; localStorage.setItem(SND.key('theme'), n); DWSound.theme(n); }
function setMuted(m) { DWSound.setMuted(m); $('mute').textContent = m ? '🔇' : '🔊'; $('mute').title = m ? t('head.muteOn') : t('head.muteOff'); }
$('theme').onchange = themeChanged;
$('mute').onclick = () => setMuted(!DWSound.muted);
$('vol').value = DWSound.volume; $('vol').oninput = () => DWSound.setVolume(+$('vol').value);
function digivolveFx() {
  const f = $('flash'); f.classList.remove('hide'); f.style.animation = 'none'; void f.offsetWidth; f.style.animation = ''; setTimeout(() => f.classList.add('hide'), 1300);
  const w = JSON.parse(localStorage.getItem(SND.key('evo')) || 'null') || G.digivolveSound;
  if (w) DWSound.play1(w);
}

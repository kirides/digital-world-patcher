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
  $('lang').innerHTML = opts(Object.entries(META.languages).map(([c, n]) => [c, n]), code);
  setMuted(DWSound.muted);
  if (model) { fillGameUI(false); refresh(); soundLists(); encRender(); }
}
$('lang').onchange = () => { localStorage.setItem('dw-lang', $('lang').value); loadLang($('lang').value); };

// ---- species picker
function pickBtn(sel, attrs) { return `<button type="button" class="pick" ${attrs}>${sel === null || sel === '' || sel === undefined ? `<span class="ico"></span><span class="mut">${t('ed.none')}</span>` : img(sel) + '<span>' + N(sel) + '</span>'}</button>`; }
let popCb = null;
function openPick(el, allowNone, cb) {
  popCb = cb; const r = el.getBoundingClientRect(), p = $('pop');
  p.classList.remove('hide'); const w = p.offsetWidth;          // keep the picker on screen (phones)
  p.style.left = (Math.max(8, Math.min(r.left, document.documentElement.clientWidth - w - 8)) + scrollX) + 'px'; p.style.top = (r.bottom + scrollY + 4) + 'px';
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
    <p class="chips"><span data-where="${cur}">⌕ ${t('enc.where')}</span></p>
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
  $('detail').querySelectorAll('[data-where]').forEach(el => el.onclick = () => { encShow(+el.dataset.where); $('encs').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
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
  st = presetState(model, $('preset').value); cur = DEX[0]; $('main').classList.remove('hide'); $('step1').classList.add('loaded'); refresh(); soundSetup(); encSetup();
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
$('exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([exportJSON(model, st, ENC.ed)], { type: 'application/json' })); a.download = 'digivolutions-' + model.game + '.json'; a.click(); };
$('impb').onclick = () => $('imp').click();
$('imp').onchange = async e => { try { const txt = await e.target.files[0].text(); st = importJSON(model, txt); const ee = importEncounters(model, txt); if (ee) { ENC.ed = ee; encBuild(); } refresh(); } catch (err) { alert(err.message); } e.target.value = ''; };
$('go').onclick = async () => {
  const trc = model.lang === 'en' ? ((document.querySelector('input[name=tr]:checked') || {}).value || null) : null;
  const enc = $('enc').checked && !!(G.encounters || G.wildCopy), evo = $('evo').checked && st.some((x, i) => changed(model, st, i)) ? st : null;
  try {
    $('msg').textContent = t('s3.working'); $('msg').className = ''; digivolveFx();
    const encEdits = $('enced').checked ? ENC.ed : null;
    const out = patchRom(rom, model, { tr: trc, enc, evo, encEdits }, trc ? await translationPatch(model, trc) : null);
    const trName = trc ? G.translations[trc].name : model.lang !== 'en' ? ((G.translations || {})[model.lang] || {}).name : null;
    const tags = [trName, (enc || evo || (encEdits && Object.keys(encEdits).length)) && 'Mod'].filter(Boolean);
    const name = G.title + (tags.length ? ' (' + tags.join(' + ') + ')' : '') + '.nds';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out])); a.download = name; a.click();
    $('msg').textContent = t('s3.done', { file: name }); $('msg').className = 'ok';
  } catch (err) { $('msg').textContent = err.message; $('msg').className = 'err'; }
};

// ---- encounter lookup: sectors of the loaded ROM with thumbnails, the searched Digimon's rate, every encounter
const ENC = { mon: null, table: null, thumbs: {}, obs: null, vars: {}, ed: {}, editing: null, open: new Set() };
const pct = p => (p * 100).toFixed(p * 100 < 10 && p * 100 % 1 ? 1 : 0).replace('.', LANG === 'de' ? ',' : '.') + ' %';
const DS = () => model.game === 'ds';
function encSetup() {
  const has = !!(G.encounters || G.wildCopy), mod = Object.values(G.presetNames || {})[0];
  $('encmodlab').classList.toggle('hide', !has); $('encmod').checked = has && $('enc').checked;
  $('encmodtext').textContent = mod ? t('enc.mod', { mod: L(mod) }) : '';
  ENC.thumbs = {}; ENC.vars = {}; ENC.ed = {}; ENC.editing = null; ENC.open = new Set(); ENC.mon = null; encBuild();
}
function encBuild() { ENC.table = encounterTable(model, rom, $('encmod').checked, ENC.ed); encRender(); encEditsUI(); }
function secName(S) {
  if (S.cyber) return [t('enc.cyber'), t('enc.cyberSub')];
  if (S.area < 0) return [t('enc.area', { n: S.part }), ''];
  if (S.map !== undefined) return [L(G.encAreas[S.area].name), S.part === 0 ? t('enc.tele') : S.part === null ? t('enc.mapOther') : t('enc.mapN', { n: S.part })];
  return [L(G.encAreas[S.area].name), t('enc.part', { n: S.part })];
}
const shown = T => T.forms.filter(f => !f.hide);
function monRate(S, i) {   // share of battles with this Digimon, per variant
  return S.variants.map(v => shown(v).reduce((x, f) => x + (f.mons.includes(i) ? f.p : 0), 0));
}
// ---- encounter editor: edits are whole tables (ENC.ed[key]), patched in step 3, shareable in the JSON export
const plain = forms => forms.map(f => DS() ? { p: f.p, pos: f.pos.slice() } : { mons: [f.mons[0]], mid: f.mid.slice(), w: f.w, lv: f.lv, item: f.item });
function encChange(T, fn) { const forms = plain(T.forms); fn(forms); ENC.ed[T.key] = forms; encBuild(); }
function setMons(f, mons) {         // DS: keep the old positions when the count stays, else the game's usual layout
  const old = (f.pos || []).map((x, k) => x !== 0xFFFF ? k : -1).filter(k => k >= 0), at = old.length === mons.length ? old : DS_LAYOUT[mons.length];
  f.pos = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]; mons.forEach((m, k) => f.pos[at[k]] = m);
}
const monsOf = f => f.pos.filter(x => x !== 0xFFFF);
function editRows(S, T) {
  const ds = DS(), rows = T.forms.map((f, k) => f.hide ? '' : `<div class="form edit" data-k="${k}"><div class="mons">${f.mons.map((m, j) =>
      `<span class="em">${pickBtn(m, `data-a="mon" data-j="${j}"`)}${ds && f.mons.length > 1 ? `<button type="button" class="ghost x" data-a="delmon" data-j="${j}" title="${esc(t('enc.delMon'))}">×</button>` : ''}</span>`).join('')}
      ${ds && f.mons.length < 5 ? `<button type="button" class="ghost" data-a="addmon" title="${esc(t('enc.addMon'))}">+</button>` : ''}</div>
      ${ds ? '' : `<label class="num">${t('enc.lvShort')}<input type="number" min="1" max="99" data-a="lv" value="${f.lv}"></label>`}
      <label class="num">${ds ? '%' : t('enc.weight')}<input type="number" min="0" ${ds ? 'step="0.01" max="100"' : 'max="65535"'} data-a="p" value="${ds ? +(f.p * 100).toFixed(2) : f.w}"></label>
      ${ds ? '' : `<span class="pct">${pct(f.p)}</span>`}
      <button type="button" class="ghost x" data-a="del" title="${esc(t('enc.del'))}">🗑</button></div>`).join('');
  const sum = T.forms.reduce((x, f) => x + (f.hide ? 0 : f.p), 0), bad = ds && Math.round(sum * 10000) !== 10000;
  const full = ds && T.forms.length >= 8, shared = ds ? ENC.table.filter(X => X.variants.some(v => v.key === T.key)).length : 1;
  return rows + `<div class="edfoot"><button type="button" class="ghost" data-a="add"${full ? ' disabled' : ''}>＋ ${t('enc.add')}</button>
    ${ds ? `<span class="${bad ? 'err' : 'ok'}">${t('enc.sum', { sum: pct(sum) })}</span>` : `<span class="mut">${t('enc.weightHint')}</span>`}
    <span class="grow"></span>${T.edited ? `<button type="button" class="ghost" data-a="reset">${t('enc.reset')}</button>` : ''}
    <button type="button" data-a="done">${t('enc.done')}</button></div>${shared > 1 ? `<p class="mut">${t('enc.shared', { n: shared })}</p>` : ''}`;
}
function encRender() {
  const i = ENC.mon;
  $('encpick').innerHTML = i === null ? `<span class="ico"></span><span class="mut">${t('enc.pick')}</span>` : img(i) + '<span>' + N(i) + '</span>';
  $('encall').classList.toggle('hide', i === null);
  let list = ENC.table.map(S => ({ S, r: i === null ? null : monRate(S, i) }));
  if (i !== null) list = list.filter(x => Math.max(...x.r) > 0 || x.S.id === ENC.editing).sort((a, b) => (a.S.locked - b.S.locked) || Math.max(...b.r) - Math.max(...a.r));   // other version's dungeons last
  $('encsum').innerHTML = i === null ? t('enc.allCount', { n: list.length })
    : list.length ? t('enc.count', { name: esc(N(i)), n: list.length }) : t('enc.countNone', { name: esc(N(i)), mod: $('encmod').checked ? '' : t('enc.modOff') });
  $('enclist').innerHTML = '<div class="secs">' + list.map(({ S, r }) => {
    const [name, sub] = secName(S), key = S.id, v = Math.min(ENC.vars[key] || 0, S.variants.length - 1), T = S.variants[v], forms = shown(T);
    const lo = r && Math.min(...r), hi = r && Math.max(...r), editing = ENC.editing === key;
    const uniq = [...new Set(S.variants.flatMap(v => shown(v).flatMap(f => f.mons)))];
    const rate = r ? `<div class="rate">${lo === hi ? pct(hi) : pct(lo) + '–' + pct(hi)}</div>`
      : `<div class="peek">${uniq.slice(0, 12).map(m => img(m)).join('')}${uniq.length > 12 ? `<span class="mut">+${uniq.length - 12}</span>` : ''}</div>`;
    const lock = S.locked ? `<span class="tag lock">${t('enc.locked', { game: G.otherVersion })}</span>` : '';
    const chg = S.variants.some(x => x.edited) ? `<span class="tag">${t('ed.changed')}</span>` : '';
    const vars = S.variants.length > 1 ? `<p class="mut">${t('enc.variants', { n: S.variants.length })}</p><div class="vars">${S.variants.map((_, k) =>
      `<button type="button" class="ghost${k === v ? ' on' : ''}" data-var="${k}">${t('enc.variant', { n: k + 1 })}${r ? ' · ' + pct(r[k]) : ''}</button>`).join('')}</div>` : '';
    const rows = editing ? editRows(S, T) : forms.slice().sort((a, b) => b.p - a.p).map(f => `<div class="form${i !== null && f.mons.includes(i) ? ' me' : ''}"><div class="mons">${f.mons.map(m =>
      `<span data-mon="${m}" title="${esc(t('enc.show', { name: N(m) }))}">${img(m)}${esc(N(m))}</span>`).join('')}${f.added ? `<span class="tag">${t('enc.added')}</span>` : ''}</div>` +
      (f.lv ? `<span class="lv">${t('enc.lv', { n: f.lv })}</span>` : '') + `<span class="pct">${pct(f.p)}</span></div>`).join('') +
      `<div class="edfoot"><span class="grow"></span><button type="button" class="ghost" data-a="edit">✎ ${t('enc.edit')}</button></div>`;
    return `<div class="sec${r ? ' hit' : ''}${editing ? ' editing' : ''}" data-sec="${key}"><div class="sec-top"><img class="thumb" alt="" data-thumb='${JSON.stringify(S.thumb)}'>
      <div class="sec-h"><b>${esc(name)}</b><span class="mut">${esc(sub)}</span> ${lock}${chg}${rate}</div></div>
      <details${i !== null || editing || ENC.open.has(String(key)) ? ' open' : ''}><summary>${t('enc.list', { n: forms.length })}</summary>${vars}<div class="forms">${rows}</div></details></div>`;
  }).join('') + '</div>';
  const box = $('enclist'), secOf = el => { const id = el.closest('.sec').dataset.sec, S = ENC.table.find(X => String(X.id) === id); return [S, S.variants[Math.min(ENC.vars[S.id] || 0, S.variants.length - 1)]]; };
  box.querySelectorAll('details').forEach(d => d.ontoggle = () => { const id = d.closest('.sec').dataset.sec; d.open ? ENC.open.add(id) : ENC.open.delete(id); });
  box.querySelectorAll('[data-var]').forEach(b => b.onclick = () => { const [S] = secOf(b); ENC.vars[S.id] = +b.dataset.var; encRender(); });
  box.querySelectorAll('[data-mon]').forEach(el => el.onclick = () => { cur = +el.dataset.mon; refresh(); $('ed').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  box.querySelectorAll('[data-a]').forEach(el => {
    const a = el.dataset.a, row = el.closest('[data-k]'), k = row ? +row.dataset.k : -1, j = +el.dataset.j;
    const [S, T] = secOf(el), ev = a === 'p' || a === 'lv' ? 'onchange' : 'onclick';
    el[ev] = () => {
      if (a === 'edit') { ENC.editing = S.id; return encRender(); }
      if (a === 'done') { ENC.editing = null; return encRender(); }
      if (a === 'reset') { delete ENC.ed[T.key]; return encBuild(); }
      if (a === 'mon') return openPick(el, false, m => encChange(T, F => { if (DS()) { const ms = monsOf(F[k]); ms[j] = m; setMons(F[k], ms); } else F[k].mons = [m]; }));
      if (a === 'addmon') return openPick(el, false, m => encChange(T, F => setMons(F[k], [...monsOf(F[k]), m])));
      encChange(T, F => {
        if (a === 'delmon') { const ms = monsOf(F[k]); ms.splice(j, 1); setMons(F[k], ms); }
        else if (a === 'del') F.splice(k, 1);
        else if (a === 'p') { if (DS()) F[k].p = Math.max(0, Math.min(100, +el.value || 0)) / 100; else F[k].w = Math.max(0, Math.min(65535, Math.round(+el.value || 0))); }
        else if (a === 'lv') F[k].lv = Math.max(1, Math.min(99, Math.round(+el.value || 1)));
        else if (a === 'add') { const m = ENC.mon ?? DEX[0];
          if (DS()) { const f = { p: 0 }; setMons(f, [m]); F.push(f); }
          else { const b = F.find(x => model.names[x.mons[0]]) || F[0]; F.push({ mons: [m], mid: b ? b.mid.slice() : Array(8).fill(3200), w: 10, lv: b ? b.lv : 1, item: 0xFFFF }); } }
      });
    };
  });
  if (ENC.obs) ENC.obs.disconnect();      // thumbnails are drawn when they scroll into view
  ENC.obs = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { ENC.obs.unobserve(e.target); drawThumb(e.target); } }), { rootMargin: '200px' });
  box.querySelectorAll('img[data-thumb]').forEach(el => ENC.obs.observe(el));
}
function encEditsUI() {   // step 3: apply the edited tables
  const n = Object.keys(ENC.ed).length;
  $('encedlab').classList.toggle('hide', !n); $('encedtext').textContent = t('s3.encEd', { n });
  if (n && !ENC.wasEdited) $('enced').checked = true; ENC.wasEdited = !!n;
}
function drawThumb(el) {
  const k = el.dataset.thumb;
  if (!(k in ENC.thumbs)) { const im = sectorThumb(rom, model, JSON.parse(k)); ENC.thumbs[k] = im ? toDataURL(im) : ''; }
  if (ENC.thumbs[k]) el.src = ENC.thumbs[k];
}
function encShow(i) { ENC.mon = i; encRender(); }
$('encpick').onclick = () => openPick($('encpick'), true, v => encShow(v));
$('encall').onclick = () => encShow(null);
$('encmod').onchange = encBuild;

// ---- sound: theme music, digivolve sound, sound test (settings in localStorage, ROM data never stored)
const SND = { key: k => 'dw-' + (k === 'evo' ? 'evo2' : k) + '-' + (model ? model.game : ''), jingles: [] };   // evo2: old choices used the wrong default
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
  const same = (x, y) => !!x && !!y && x.seq === y.seq && x.se === y.se;
  const item = (label, which) => `<div class="st-item${same(which, evo) ? ' on' : ''}" data-w='${JSON.stringify(which)}'><span class="nm">${label}</span><button class="ghost" data-a="play">▶</button><button class="ghost" data-a="evo" title="${esc(t('st.star'))}">★</button></div>`;
  $('st-music').innerHTML = tracks.map(n => item(trackName(n) + (SND.jingles.includes(n) ? ' ' + t('st.jingle') : ''), { seq: n })).join('');
  $('st-se').innerHTML = DWSound.effects().map(n => item(t('st.effect', { n: String(n).padStart(3, '0') }), { se: n })).join('');
  document.querySelectorAll('.st-item').forEach(el => {
    const w = JSON.parse(el.dataset.w);
    el.querySelector('[data-a=play]').onclick = () => { if (DWSound.muted) setMuted(false); w.seq !== undefined && !SND.jingles.includes(w.seq) ? ($('theme').value = w.seq, themeChanged()) : DWSound.play1({ seconds: 10, ...w }); };
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
  if (w) DWSound.play1({ seconds: 7, ...w });
}

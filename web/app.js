const $ = id => document.getElementById(id);
let rom = null, model = null, G = null, st = null, cur = 0, DEX = [], COUNTED = [], ICON = {}, dupe = {};
const N = i => (model.names[i] || '#' + i) + (dupe[i] ? ' #' + i : '');
const img = (i, cls = 'ico') => ICON[i] ? `<img class="${cls}" src="${ICON[i]}" alt="">` : `<span class="${cls}"></span>`;
const condOf = t => G.conds.find(c => c[0] === t) || [t, 'Typ ' + t, 1];
const opts = (list, sel) => list.map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('');
function pickBtn(sel, attrs) { return `<button type="button" class="pick" ${attrs}>${sel === null || sel === '' || sel === undefined ? '<span class="ico"></span><span class="mut">— keine —</span>' : img(sel) + '<span>' + N(sel) + '</span>'}</button>`; }
let popCb = null;
function openPick(el, allowNone, cb) {
  popCb = cb; const r = el.getBoundingClientRect(), p = $('pop');
  p.style.left = (r.left + scrollX) + 'px'; p.style.top = (r.bottom + scrollY + 4) + 'px'; p.classList.remove('hide');
  $('popq').value = ''; fillPick(allowNone); $('popq').oninput = () => fillPick(allowNone); $('popq').focus();
}
function fillPick(allowNone) {
  const q = $('popq').value.toLowerCase();
  $('popl').innerHTML = (allowNone ? '<div class="row" data-v=""><span class="ico"></span><i>— keine —</i></div>' : '') +
    DEX.filter(i => N(i).toLowerCase().includes(q)).map(i => `<div class="row" data-v="${i}">${img(i)}<span>${N(i)}</span></div>`).join('');
  $('popl').querySelectorAll('.row').forEach(el => el.onclick = () => { $('pop').classList.add('hide'); popCb(el.dataset.v === '' ? null : +el.dataset.v); });
}
document.addEventListener('mousedown', e => { if (!$('pop').contains(e.target) && !e.target.closest('.pick')) $('pop').classList.add('hide'); });
function valueField(k, c, s) {          // condition c = index into slot (2, 4)
  const t = s[c], v = s[c + 1], cd = condOf(t), a = `data-k="${k}" data-c="${c}"`;
  if (t === 0) return '';
  if (cd[2] === 'item') return `<select ${a} data-f="v">${opts(Object.entries(G.items || {}).map(([x, n]) => [+x, n]), v)}</select>`;
  if (cd[2] === 'species') return pickBtn(v, `${a} data-f="vs"`);
  return `<input type="number" min="0" ${a} data-f="v" value="${v * cd[2]}">`;
}
function renderDetail() {
  const e = st[cur], from = [], nc = G.nconds;
  st.forEach((x, i) => x.s.forEach(s => { if (s && s[0] === cur) from.push(i); }));
  let h = `<h2>${img(cur, 'big')} ${N(cur)} ${changed(model, st, cur) ? '<small>(geändert)</small>' : ''}</h2>
  <p class="chips"><b>Entsteht aus:</b> ${from.map(i => `<span data-go="${i}">${img(i)}${N(i)}</span>`).join('') || '<i class="mut">keiner Digitation</i>'}</p>
  ${(G.encounters || []).filter(x => x[1] === cur).map(x => `<p>🌿 <b>Wild (Mod):</b> ${x[3]} ${$('enc').checked ? '' : '<small class="err">(Häkchen bei den wilden Digimon unter „Patchen“ ist aus)</small>'}</p>`).join('')}
  <table><tr><th>Digitation zu</th><th>Level</th>${'<th>Bedingung</th><th>Wert</th>'.repeat(nc)}</tr>`;
  e.s.forEach((s, k) => {
    h += `<tr class="slot"><td>${pickBtn(s ? s[0] : null, `data-k="${k}" data-f="t"`)}${s ? `<button class="go" data-go="${s[0]}" title="Zu ${N(s[0])} wechseln">➜</button>` : ''}</td>`;
    if (s) { h += `<td><input type="number" min="1" max="99" data-k="${k}" data-f="l" value="${s[1]}"></td>`;
      for (let c = 2; c < 2 + 2 * nc; c += 2) h += `<td><select data-k="${k}" data-c="${c}" data-f="c">${opts(G.conds.map(x => [x[0], x[1]]), s[c])}</select></td><td>${valueField(k, c, s)}</td>`; }
    else h += `<td colspan="${1 + 2 * nc}"></td>`;
    h += '</tr>';
  });
  h += `</table><p class="nw">Degeneriert zu (Return Chip): ${pickBtn(e.p, 'id="prev"')}${e.p !== null ? `<button class="go" data-go="${e.p}" title="Zu ${N(e.p)} wechseln">➜</button>` : ''} <button id="rst">Original für ${N(cur)}</button></p>`;
  $('detail').innerHTML = h;
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
  $('reach').innerHTML = !have ? '<small>Die Prüfung „ohne Tausch erhältlich“ gibt es für dieses Spiel noch nicht.</small>' :
    `<b>${COUNTED.length - miss.length} von ${COUNTED.length}</b> Digimon ohne Matching/Tausch erhältlich` +
    (miss.length ? ' – fehlen:' : ' <span class="ok">✓</span>') + (G.npc && G.npc.length ? ` <small>(nicht gezählt: ${G.npc.map(N).join(', ')}, im Original gar nicht erhältlich)</small>` : '') +
    (G.reachNote ? ` <small>(${G.reachNote})</small>` : '');
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
var loadFile = async function (file) {
  $('msg1').className = ''; $('msg1').textContent = 'Lese ' + file.name + ' …';
  try { rom = new Uint8Array(await file.arrayBuffer()); model = loadModel(rom); G = G_(model); }
  catch (err) { $('msg1').textContent = err.message; $('msg1').className = 'err'; return; }
  DEX = model.dex; COUNTED = DEX.filter(i => !(G.npc || []).includes(i)); dupe = {}; ICON = {};
  const seen = {}; DEX.forEach(i => { if (model.names[i] in seen) dupe[i] = 1; else seen[model.names[i]] = 1; });
  for (let j = 0; j < DEX.length; j++) {
    const im = icon(rom, model, DEX[j]); if (im) ICON[DEX[j]] = toDataURL(im);
    if (j % 20 === 0) { $('msg1').textContent = 'Lade Bilder … ' + j + '/' + DEX.length; await new Promise(r => setTimeout(r)); }
  }
  $('msg1').innerHTML = `<span class="ok">${file.name}: ${G.title} (${model.lang === 'en' ? 'USA' : 'deutsche Fassung'}), ${DEX.length} Digimon gelesen.</span>`;
  $('de').checked = model.lang === 'en'; $('delab').classList.toggle('hide', model.lang !== 'en');
  $('enclab').classList.toggle('hide', !(G.encounters || G.wildCopy)); $('enc').checked = !!(G.encounters || G.wildCopy); $('enctext').textContent = G.encounterLabel || '';
  const presets = [['orig', 'Original-Routen der ROM'], ...Object.entries(G.presetNames || {})];
  $('preset').innerHTML = opts(presets.reverse(), presets[0][0]);
  st = presetState(model, $('preset').value); cur = DEX[0]; $('main').classList.remove('hide'); refresh();
};
$('rom').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
const drop = $('drop');
const ready = (async () => { if (!META) META = await (await fetch('data/meta.json')).json(); })();
const loadFile0 = loadFile; loadFile = async f => { await ready; return loadFile0(f); };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]); };
$('q').oninput = refresh; $('onlychg').onchange = refresh; $('enc').onchange = refresh;
$('apply').onclick = () => { st = presetState(model, $('preset').value); if (G.encounters || G.wildCopy) $('enc').checked = $('preset').value !== 'orig'; refresh(); };
$('exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([exportJSON(model, st)], { type: 'application/json' })); a.download = 'digitationen-' + model.game + '.json'; a.click(); };
$('impb').onclick = () => $('imp').click();
$('imp').onchange = async e => { try { st = importJSON(model, await e.target.files[0].text()); refresh(); } catch (err) { alert(err.message); } e.target.value = ''; };
$('go').onclick = async () => {
  const de = $('de').checked && model.lang === 'en', enc = $('enc').checked && !!(G.encounters || G.wildCopy), evo = $('evo').checked && st.some((x, i) => changed(model, st, i)) ? st : null;
  try {
    $('msg').textContent = 'Patche …'; $('msg').className = '';
    const out = patchRom(rom, model, { de, enc, evo }, de ? await germanPatch(model) : null);
    const tags = [(de || model.lang === 'de') && 'Deutsch', (enc || evo) && 'Mod'].filter(Boolean);
    const name = G.title + (tags.length ? ' (' + tags.join(' + ') + ')' : '') + '.nds';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out])); a.download = name; a.click();
    $('msg').textContent = 'Fertig: ' + name; $('msg').className = 'ok';
  } catch (err) { $('msg').textContent = err.message; $('msg').className = 'err'; }
};

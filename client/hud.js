// DOM HUD: resources & alerts, seismograph, selection & city management (incl. governors),
// build bar, road planner, and the drawer (tech graph, realm, empire overview, armies,
// diplomacy, chronicle + command history). The HUD only ever sends intents to the server.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (n) => (Math.abs(n) >= 10000 ? (n / 1000).toFixed(0) + 'k' : Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.floor(n).toString());
const cssColor = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
const CAT_ORDER = ['civic', 'residential', 'agri', 'industry', 'power', 'commerce', 'science', 'logistics', 'military'];
const CAT_NAME = { civic: 'Civic', residential: 'Housing', agri: 'Food', industry: 'Industry', power: 'Power', commerce: 'Commerce', science: 'Science', logistics: 'Logistics', military: 'Military' };

export class Hud {
  constructor(S, actions) {
    this.S = S; this.A = actions; this.tab = 'research'; this.cityTab = 'overview'; this.empireSort = ['pop', -1]; this.empireFilter = 'all';
    this.seis = new Float32Array(240); this.amp = 0; this.alertT = 0; this.shockT = 0; this.alerts = []; this.unseen = { critical: 0, major: 0 };
    this.sctx = $('seismo').getContext('2d');
    this.mctx = $('minimap').getContext('2d');
    const drawerEl = $('drawer');
    if (window.innerWidth < 1200) drawerEl.classList.add('collapsed');
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      if (this.tab === b.dataset.tab && !drawerEl.classList.contains('collapsed')) { drawerEl.classList.add('collapsed'); b.setAttribute('aria-selected', 'false'); return; }
      drawerEl.classList.remove('collapsed');
      this.tab = b.dataset.tab; document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b)); this.drawer(true);
    }));
    if (drawerEl.classList.contains('collapsed')) document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', 'false'));
    $('drawerBody').addEventListener('click', (e) => this.onDrawerClick(e));
    $('drawerBody').addEventListener('change', (e) => this.onDrawerChange(e));
    $('selection').addEventListener('click', (e) => this.onSelClick(e));
    $('selection').addEventListener('dblclick', (e) => { const c = e.target.closest('[data-card]'); if (c) this.A.selectType(c.dataset.card, !(e.ctrlKey || e.metaKey)); });
    $('selection').addEventListener('change', (e) => this.onSelChange(e));
    $('buildbar').addEventListener('click', (e) => { const b = e.target.closest('[data-build],[data-tool]'); if (b) this.A.buildMode(b.dataset.build || null, b.dataset.tool || null); });
    $('roadPanel').addEventListener('click', (e) => this.onRoadClick(e));
    $('roadPanel').addEventListener('change', (e) => { if (e.target.id === 'roadType') this.A.roadType(+e.target.value); if (e.target.id === 'roadAuto') this.A.roadAuto(e.target.checked); });
    $('alertsBtn').addEventListener('click', () => { const a = $('alerts'); a.hidden = !a.hidden; this.unseen = { critical: 0, major: 0 }; this.alertBadges(); this.renderAlerts(); });
    $('alertsClear').addEventListener('click', () => { this.alerts = []; this.renderAlerts(); });
    $('alertList').addEventListener('click', (e) => { const li = e.target.closest('[data-jump]'); if (li) this.A.jump(+li.dataset.jump); });
    this.drawerKey = '';
  }

  // ------------------------------------------------------------ top bar
  topbar() {
    const S = this.S, e = S.econ; if (!e) return;
    const me = S.civInfo[S.civId], D = S.defs;
    $('civName').textContent = me ? me.name : '';
    $('civName').style.color = cssColor(S.civColor(S.civId));
    $('ageName').textContent = D.AGES[e.age].name + (e.advancing ? ` → advancing (${e.advancing}s)` : '');
    const items = D.GOODS.filter((k) => k === 'food' || k === 'materials' || k === 'credits' || (e.res[k] || 0) > 0 || (e.rates[k] || 0) !== 0).map((k) => {
      const r = e.rates[k] || 0;
      return `<li title="${esc(D.GOOD_NAMES[k])}${k !== 'credits' ? ` (national stockpile, cap ${e.storage})` : ''}"><span class="k">${esc(D.GOOD_NAMES[k])}</span><b>${fmt(e.res[k] || 0)}</b><small class="${r < 0 ? 'neg' : ''}">${r >= 0 ? '+' : ''}${r.toFixed(1)}/s</small></li>`;
    });
    if (e.power && (e.power.gen || e.power.use)) items.push(`<li title="Power grid: generation / demand"><span class="k">Power</span><b>${e.power.gen}/${e.power.use}</b><small class="${e.power.gen < e.power.use ? 'neg' : ''}">${e.power.gen < e.power.use ? 'brownout' : 'stable'}</small></li>`);
    items.push(`<li title="Research per second"><span class="k">Research</span><b>${e.researchRate.toFixed(1)}</b><small>${e.research ? esc(D.TECHS[e.research].name) : 'idle'}</small></li>`);
    items.push(`<li title="Soldiers represented by your units"><span class="k">Forces</span><b>${fmt(e.men || 0)}</b><small>men</small></li>`);
    $('resources').innerHTML = items.join('');
  }
  clock(time, rtt) { const t = Math.floor(time); $('clock').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; $('net').textContent = rtt ? `${rtt} ms` : ''; }

  // ------------------------------------------------------------ seismograph
  quake(kind) {
    const k = { quake: 16, eruption: 12, rumor: 6, rift: 5, uplift: 3, river: 3, drought: 2, warning: 0 }[kind] ?? 0;
    if (kind === 'warning') { this.alertT = 25; return; }
    this.amp = Math.max(this.amp, k); if (k >= 6) this.shockT = 6;
  }
  seismo(dt) {
    const a = this.seis; a.copyWithin(0, 2); this.amp = Math.max(0, this.amp - dt * 3.2);
    const base = 0.8 + (this.alertT > 0 ? 2.5 : 0);
    for (let k = a.length - 2; k < a.length; k++) a[k] = (Math.random() - 0.5) * 2 * (base + this.amp * (0.6 + Math.random() * 0.6));
    this.alertT = Math.max(0, this.alertT - dt); this.shockT = Math.max(0, this.shockT - dt);
    const c = this.sctx, w = 240, h = 34; c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(231,226,212,0.08)'; c.lineWidth = 1; for (let x = 0; x < w; x += 20) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); c.stroke(); }
    c.strokeStyle = this.shockT > 0 ? '#ff7a5c' : this.alertT > 0 ? '#f0b54a' : '#8fd19e'; c.lineWidth = 1.2; c.beginPath();
    for (let x = 0; x < w; x++) { const y = h / 2 + Math.max(-16, Math.min(16, a[x])); x ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
    const lbl = $('seismoLabel');
    const txt = this.shockT > 0 ? 'Shock' : this.alertT > 0 ? 'Precursors' : 'Quiet';
    if (lbl.textContent !== txt) { lbl.textContent = txt; lbl.className = this.shockT > 0 ? 'shock' : this.alertT > 0 ? 'alert' : ''; }
  }

  // ------------------------------------------------------------ toasts & alert tray
  toast(m) {
    const el = document.createElement('div');
    el.className = 'toast ' + (m.kind || '') + ' lv-' + (m.level || 'minor');
    el.textContent = m.text;
    if (m.tile >= 0) el.addEventListener('click', () => this.A.jump(m.tile));
    if (m.kind === 'proposal') el.addEventListener('click', () => { this.tab = ''; document.querySelector('[data-tab=diplomacy]').click(); });
    const box = $('toasts'); box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => el.remove(), m.level === 'critical' ? 15000 : m.kind === 'warning' || m.kind === 'proposal' ? 12000 : 6500);
  }
  alert(m) {
    if (m.level === 'info' || m.quiet) return;
    this.alerts.unshift(m); if (this.alerts.length > 80) this.alerts.length = 80;
    if (m.level === 'critical' || m.level === 'major') this.unseen[m.level]++;
    this.alertBadges(); if (!$('alerts').hidden) this.renderAlerts();
  }
  alertBadges() { for (const [id, k] of [['alC', 'critical'], ['alM', 'major']]) { const el = $(id); el.textContent = this.unseen[k]; el.classList.toggle('on', this.unseen[k] > 0); } }
  renderAlerts() { $('alertList').innerHTML = this.alerts.map((m) => `<li class="lv-${m.level}" ${m.tile >= 0 ? `data-jump="${m.tile}"` : ''}><time>${Math.floor(m.time / 60)}:${String(m.time % 60).padStart(2, '0')}</time>${esc(m.text)}</li>`).join('') || '<li class="lv-info">No alerts.</li>'; }

  // ------------------------------------------------------------ minimap
  minimap(view) {
    const S = this.S, c = this.mctx, W = S.W, H = S.H;
    const MW = 192, MH = 168, sx = MW / (W + 0.5), sy = MH / H;
    const img = c.createImageData(MW, MH); const d = img.data;
    for (let y = 0; y < MH; y++) {
      const r = Math.min(H - 1, Math.floor(y / sy));
      for (let x = 0; x < MW; x++) {
        const q = Math.floor(x / sx - 0.5 * (r & 1)); const o = (y * MW + x) * 4;
        if (q < 0 || q >= W) { d[o + 3] = 255; d[o] = 16; d[o + 1] = 24; d[o + 2] = 27; continue; }
        const i = r * W + q;
        let col = S.terr[i] === 255 ? 0x10181b : S.color[i];
        if (S.owner[i] >= 0 && S.terr[i] !== 255 && S.lens !== 'terrain') col = mix(col, S.civColor(S.owner[i]), 0.45);
        const fog = S.vis[i] ? 1 : 0.6;
        d[o] = ((col >> 16) & 255) * fog; d[o + 1] = ((col >> 8) & 255) * fog; d[o + 2] = (col & 255) * fog; d[o + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    for (const u of S.units.values()) { c.fillStyle = cssColor(S.civColor(u.owner)); const q = u.tile % W, r = (u.tile / W) | 0; c.fillRect((q + 0.5 * (r & 1)) * sx - 1, r * sy - 1, 2.5, 2.5); }
    for (const city of S.cities.values()) { c.fillStyle = cssColor(S.civColor(city.o)); c.strokeStyle = '#f3eedf'; const q = city.t % W, r = (city.t / W) | 0; c.fillRect((q + 0.5 * (r & 1)) * sx - 3, r * sy - 3, 6, 6); c.strokeRect((q + 0.5 * (r & 1)) * sx - 3, r * sy - 3, 6, 6); }
    const v = view; const [x0, y0] = v.screenToWorld(0, 0); const [x1, y1] = v.screenToWorld(v.app.screen.width, v.app.screen.height);
    const kx = MW / v.pw, ky = MH / v.ph;
    c.strokeStyle = '#f1c75b'; c.lineWidth = 1; c.strokeRect(x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky);
  }

  // ------------------------------------------------------------ build bar
  buildbar() {
    const S = this.S, e = S.econ; if (!e) return;
    const D = S.defs, techs = new Set(e.techs);
    const items = Object.entries(D.BUILDINGS).filter(([k, d]) => k !== 'town' && !d.rebelOnly && d.age <= e.age && (!d.tech || techs.has(d.tech)))
      .sort((a, b) => CAT_ORDER.indexOf(a[1].cat) - CAT_ORDER.indexOf(b[1].cat));
    const afford = (c) => Object.entries(c).every(([k, v]) => (e.res[k] || 0) >= v);
    const cost = (c) => Object.entries(c).map(([k, v]) => `${v} ${D.GOOD_NAMES[k].toLowerCase()}`).join(', ') || 'free';
    let html = items.map(([k, d]) => `<button class="buildbtn${S.mode?.type === k ? ' active' : ''}${afford(d.cost) ? '' : ' poor'}" data-build="${k}" title="${esc(d.name)} (${CAT_NAME[d.cat] || ''}): ${esc(cost(d.cost))}${afford(d.cost) ? '' : '. Not enough now: placing it plans it, and building starts when funded.'}"><span class="g">${d.glyph}</span><span class="n">${esc(d.name)}</span><small>${esc(cost(d.cost))}</small></button>`).join('');
    html += `<button class="buildbtn tool${S.mode?.kind === 'road' ? ' active' : ''}" data-tool="road" title="Road planner: drag or click waypoints, preview cost, then commission (R)"><span class="g">\u{1F6E4}</span><span class="n">Plan road</span><small>dirt / paved / highway / rail</small></button>`;
    if (techs.has('civil_engineering')) html += `<button class="buildbtn tool${S.mode?.kind === 'clearPass' ? ' active' : ''}" data-tool="clearPass" title="Blast a passage through impassable peaks"><span class="g">\u{1F9E8}</span><span class="n">Clear peak</span><small>120 materials, 40 munitions</small></button>`;
    const key = html.length + '|' + JSON.stringify(Object.values(e.res).map((v) => Math.floor(v / 10))) + S.mode?.kind + S.mode?.type;
    if (key !== this.bbKey) { this.bbKey = key; $('buildbar').innerHTML = html; }
  }

  // ------------------------------------------------------------ road planner
  roadPanel() {
    const S = this.S, m = S.mode, el = $('roadPanel');
    if (!m || m.kind !== 'road') { el.hidden = true; return; }
    el.hidden = false;
    const D = S.defs, techs = new Set(S.econ?.techs || []);
    const p = m.preview;
    const opts = D.ROAD_TYPES.filter(Boolean).filter((r) => !r.tech || techs.has(r.tech)).map((r) => `<option value="${r.id}" ${m.type === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    let h = `<h3>Road planner</h3><p class="muted">Drag across the map to sketch a route, or click waypoints. ${m.auto ? 'Auto-route finds the best path between the first and last point.' : 'The road follows your line exactly.'}</p>`;
    h += `<div class="actions"><select id="roadType">${opts}</select><label class="perm"><input type="checkbox" id="roadAuto" ${m.auto ? 'checked' : ''}> Auto-route</label></div>`;
    if (p) {
      const reasons = {}; for (const s of p.segments) if (s.reason && !s.skip) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
      h += `<dl class="kv"><dt>Length</dt><dd>${p.length} hexes${p.bridges ? `, ${p.bridges} bridge${p.bridges > 1 ? 's' : ''}` : ''}</dd><dt>New segments</dt><dd>${p.buildable}${p.segments.some((s) => s.skip) ? ` (+${p.segments.filter((s) => s.skip).length} existing)` : ''}</dd><dt>Cost</dt><dd>${Object.entries(p.cost).map(([k, v]) => `${v} ${D.GOOD_NAMES[k].toLowerCase()}`).join(', ') || '—'}</dd><dt>Build time</dt><dd>~${p.time}s</dd></dl>`;
      if (p.blocked) h += `<div class="bad">${p.blocked} segment${p.blocked > 1 ? 's' : ''} cannot be built: ${esc(Object.entries(reasons).map(([r, n]) => `${r} (${n})`).join('; '))}</div>`;
    } else h += `<p class="muted">${m.points.length ? 'Add another point to see the route.' : 'Pick a starting point.'}</p>`;
    h += `<div class="actions"><button class="btn primary" data-road="commit" ${p && p.buildable ? '' : 'disabled'}>Commission road</button><button class="btn small" data-road="undo" ${m.points.length ? '' : 'disabled'}>Undo point</button><button class="btn small ghost" data-road="clear">Clear</button><button class="btn small ghost" data-road="close">Close</button></div>`;
    const projects = S.econ?.roads || [];
    if (projects.length) h += `<h4 style="margin:8px 0 2px">Projects</h4><ul class="log">${projects.map((r) => `<li><span class="tag ${r.status === 'blocked' || r.status === 'paused' ? 'warn' : r.status === 'complete' ? 'good' : ''}">${esc(r.status)}</span> ${esc(D.ROAD_TYPES[r.type].name)} ${r.done}/${r.total}${r.by && r.by !== 'player' ? ` <span class="muted">(${esc(r.by.replace('governor:', 'governor '))})</span>` : ''} ${r.status !== 'complete' ? `<button class="btn small ghost" data-road="cancel" data-id="${r.id}">Cancel</button>` : ''}</li>`).join('')}</ul>`;
    if (h !== this.roadHtml) { this.roadHtml = h; el.innerHTML = h; }
  }
  onRoadClick(e) { const b = e.target.closest('[data-road]'); if (!b) return; this.A.road(b.dataset.road, +b.dataset.id); }

  // ------------------------------------------------------------ selection & city management
  selection() {
    const S = this.S, el = $('selection'), D = S.defs;
    let html = '';
    const units = [...S.selUnits].map((id) => S.units.get(id)).filter(Boolean);
    if (units.length) {
      const own = units[0].owner === S.civId;
      const types = new Map(); for (const u of units) types.set(u.type, (types.get(u.type) || 0) + 1);
      const avg = (f) => Math.round(units.reduce((s, u) => s + u[f], 0) / units.length);
      const first = D.UNITS[units[0].type];
      const men = units.reduce((s, u) => s + (D.UNITS[u.type].men || 0), 0);
      html += `<h3>${units.length > 1 ? `${units.length} units selected` : esc(first.name)}</h3>`;
      html += `<div class="sub">${own ? `${men} soldiers represented` : esc(S.civInfo[units[0].owner]?.name || '')}</div>`;
      if (own) html += `<div class="cards">${[...types].map(([t, n]) => `<span class="ucard" data-card="${t}" title="Click: keep only these. Double-click: every ${esc(D.UNITS[t].name)} on screen (Ctrl/Cmd: whole map)"><b>${n}×</b>${esc(D.UNITS[t].name)}</span>`).join('')}</div>`;
      html += `<div>Strength ${avg('hp')}%</div><div class="bar hp"><i style="width:${avg('hp')}%"></i></div>`;
      if (own) {
        const outs = units.filter((u) => u.flags & 4).length, waiting = units.filter((u) => u.flags & 8).length, blocked = units.filter((u) => u.flags & 16).length;
        html += `<div>Supply ${avg('sup')}%</div><div class="bar sup"><i style="width:${avg('sup')}%"></i></div>`;
        if (outs) html += `<div class="bad">${outs} out of supply: weakening. Bring them within range of a city, depot, port, fortress or supply truck${units.some((u) => D.UNITS[u.type].air) ? ' (aircraft need an airfield)' : ''}.</div>`;
        if (waiting) html += `<div class="warn">${waiting} waiting for a congested road or bridge.</div>`;
        if (blocked) html += `<div class="bad">${blocked} cannot reach their destination: the route is blocked.</div>`;
        if (units.length === 1) html += `<dl class="kv"><dt>Attack / Defense</dt><dd>${first.atk} / ${first.def}</dd><dt>Range / Speed</dt><dd>${first.range} / ${first.speed}</dd><dt>Movement</dt><dd>${esc(first.move)}${first.aa ? `, anti-air ×${first.aa}` : ''}</dd></dl>`;
        const stance = units.find((u) => u.stance)?.stance || 'defensive';
        html += `<div class="actions"><select data-sel="stance" title="Stance">${Object.entries(D.STANCES).map(([k, n]) => `<option value="${k}" ${k === stance ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><select data-sel="formation" title="Formation for the next order">${Object.entries(D.FORMATIONS).map(([k, n]) => `<option value="${k}" ${k === S.formation ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`;
        html += `<div class="actions"><button class="btn small" data-act="stop">Stop (S)</button><button class="btn small" data-act="amove">Attack-move (A)</button><button class="btn small" data-act="army">Form army (G)</button>`;
        if (units.some((u) => u.type === 'colonist')) html += `<button class="btn small primary" data-act="found">Found city (F)</button><button class="btn small" data-act="autoSettle">Auto-settle</button>`;
        html += `</div>`;
        if (units.some((u) => D.UNITS[u.type].engineer)) html += `<p class="muted">Idle engineers repair roads and buildings, fight fires and clear rubble next to them, and speed up nearby construction.</p>`;
      }
    } else if (S.selBuilding != null && S.buildings.has(S.selBuilding)) {
      const b = S.buildings.get(S.selBuilding), d = D.BUILDINGS[b.ty];
      const own = b.o === S.civId;
      const city = b.ty === 'town' ? S.cityAt.get(b.t) : null;
      html += `<h3>${esc(city ? city.n : d.name)}</h3><div class="sub">${esc(city ? d.name + (city.cap ? ' (capital)' : '') : '')}${own ? '' : esc(S.civInfo[b.o]?.name || '')}</div>`;
      if (city && own) {
        html += `<div class="subtabs">${['overview', 'governor', 'storage'].map((t) => `<button class="${this.cityTab === t ? 'on' : ''}" data-ctab="${t}">${t === 'overview' ? 'Overview' : t === 'governor' ? 'Governor' : 'Stockpile'}</button>`).join('')}</div>`;
        if (this.cityTab === 'governor') html += this.governorPanel(city);
        else if (this.cityTab === 'storage') html += this.storagePanel(city);
        else html += this.cityOverview(city, b, d);
      } else {
        html += this.buildingPanel(b, d, own, city);
      }
    } else {
      const e = S.econ;
      const mine = [...S.cities.values()].filter((c) => c.o === S.civId);
      html += `<h3>Your realm</h3><div class="sub">${mine.length} ${mine.length === 1 ? 'city' : 'cities'}, ${Math.round(mine.reduce((s, c) => s + c.pop, 0))} people, ${e ? fmt(e.men || 0) : 0} soldiers</div>`;
      html += `<ul class="log">${mine.map((c) => `<li data-jump="${c.t}"><b>${esc(c.n)}</b> pop ${Math.floor(c.pop)}/${c.h}, stability <span class="${c.st < 25 ? 'bad' : c.st < 45 ? 'warn' : ''}">${c.st}</span>${c.fs ? ' <span class="tag bad">famine</span>' : ''}${c.iso ? ' <span class="tag warn">cut off</span>' : ''}${c.gov?.enabled ? ' <span class="tag">governed</span>' : ''}</li>`).join('')}</ul>`;
      html += `<p class="muted">Select units with a click or drag; double-click selects a type. Right-click to move or attack. Pick a building below to place it.</p>`;
    }
    if (html !== this.selHtml) { this.selHtml = html; el.innerHTML = html; }
  }

  buildingPanel(b, d, own, city) {
    const S = this.S, D = S.defs;
    let html = `<div>Condition ${b.hp}% <span class="tag ${b.st === 'damaged' ? 'bad' : b.st === 'operational' ? 'good' : 'warn'}">${esc(b.st)}</span>${b.f ? ' <span class="tag bad">on fire</span>' : ''}</div><div class="bar hp"><i style="width:${b.hp}%"></i></div>`;
    if (b.st === 'planned') html += `<div class="warn">Planned: construction starts once the resources are available.</div>`;
    else if (!b.d) html += `<div class="warn">Under construction: ${b.p}% (crew rate ×${(b.cr || 1).toFixed(1)}; engineers nearby speed this up)</div>`;
    if (b.st === 'damaged' && own) html += `<div class="bad">Damaged buildings work at half capacity and do not recover by themselves.</div>`;
    if (city) html += `<div>Population ${Math.floor(city.pop)}</div>`;
    if (own && d.jobs && b.d) html += `<div class="muted">${b.s} / ${d.jobs[1]} ${d.jobs[0]}s employed${b.a ? '' : ' (idle)'}</div>`;
    if (own && b.gov) html += `<div class="muted">Built by the city governor.</div>`;
    html += this.trainPanel(b, d, own);
    if (own) html += `<div class="actions">${b.hp < 100 && b.d ? '<button class="btn small" data-act="repair">Repair</button>' : ''}${b.ty !== 'town' ? '<button class="btn small ghost" data-act="demolish">Demolish</button>' : ''}</div>`;
    void D;
    return html;
  }

  trainPanel(b, d, own) {
    const S = this.S, D = S.defs, e = S.econ;
    if (!own || !d.trains || !b.d) return '';
    const cost = (c) => Object.entries(c).map(([k, v]) => `${v} ${D.GOOD_NAMES[k].toLowerCase()}`).join(', ');
    let html = `<div class="actions">` + d.trains.filter((u) => D.UNITS[u].age <= e.age).map((u) => {
      const ud = D.UNITS[u]; const locked = ud.tech && !e.techs.includes(ud.tech);
      return `<button class="btn trainbtn" data-train="${u}" ${locked ? 'disabled' : ''} title="${esc(ud.name)}: ${esc(cost(ud.cost))}${ud.pop ? `, ${ud.pop} pop` : ''}${ud.men ? `, ${ud.men} soldiers` : ''}"><span>${esc(ud.name)}</span><small>${locked ? 'needs ' + esc(D.TECHS[ud.tech].name) : esc(cost(ud.cost))}</small></button>`;
    }).join('') + `</div>`;
    if (b.q?.length) html += `<div class="queue">${b.q.map(([u, t]) => `<span>${esc(D.UNITS[u].name)} ${t}s</span>`).join('')}</div>`;
    const armies = e.armies || [];
    html += `<div class="muted">Right-click the map to set a rally point${armies.length ? `; new units join <select data-sel="rallyArmy"><option value="0">no army</option>${armies.map((a) => `<option value="${a.id}" ${b.rallyArmy === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}.</div>`;
    return html;
  }

  cityOverview(city, b, d) {
    let html = `<dl class="kv"><dt>Population</dt><dd>${city.pop.toFixed(1)} / ${city.h} housing</dd><dt>Workers</dt><dd>${city.jobs?.worker || 0}</dd><dt>Merchants</dt><dd>${city.jobs?.merchant || 0}</dd><dt>Specialists</dt><dd>${city.jobs?.specialist || 0}</dd><dt>Unemployed</dt><dd>${city.un}</dd>
      <dt>Network</dt><dd>${city.cap ? 'Capital' : city.iso ? '<span class="bad">Cut off: living on local reserves</span>' : `<span class="good">Connected</span> (${city.fr} goods/s freight)`}</dd></dl>`;
    html += `<div>Stability ${city.st}</div><div class="bar stab"><i style="width:${city.st}%"></i></div>`;
    if (city.unrest) html += `<div class="bad">Unrest! Output halved. Below 8 the city may rebel and defect.</div>`;
    if (city.fs) html += `<div class="bad">Famine: the people are starving.</div>`;
    if (city.dis > 2) html += `<div class="warn">Recovering from disaster (−${city.dis} stability)</div>`;
    if (city.occ > 2) html += `<div class="warn">Recently occupied (−${Math.round(city.occ / 2)} stability)</div>`;
    if (city.dmg > 0) html += `<div class="warn">${city.dmg}% of the district is damaged or in ruins.</div>`;
    html += this.trainPanel(b, d, true);
    return html;
  }

  storagePanel(city) {
    const D = this.S.defs, st = city.stock || {};
    const rows = D.GOODS.filter((k) => k !== 'credits').map((k) => `<span>${esc(D.GOOD_NAMES[k])}</span><b>${fmt(st[k] || 0)}</b>`).join('');
    return `<p class="muted">${city.cap ? 'The capital draws directly on the national stockpile.' : city.iso ? 'This city is cut off: it produces and consumes from these local reserves until a road, railway or sea lane reconnects it.' : `Goods move to the national stockpile at up to ${city.fr}/s over the weakest link of its route; surplus waits here. Shipping ${city.ship}/s now.`}</p><div class="stock">${rows}</div>`;
  }

  governorPanel(city) {
    const S = this.S, D = S.defs, gv = city.gov || { enabled: false, spec: 'balanced', reserve: 0.25, perms: {}, log: [], queue: [] };
    const perm = (k, label) => `<label class="perm"><input type="checkbox" data-gperm="${k}" ${gv.perms[k] ? 'checked' : ''}> ${label}</label>`;
    let html = `<label class="perm"><input type="checkbox" data-gov="enabled" ${gv.enabled ? 'checked' : ''}> <b>Autonomous governor</b></label>`;
    html += `<label class="field inline"><span>Specialization</span><select data-gov="spec">${Object.entries(D.GOVERNOR_SPECS).map(([k, s]) => `<option value="${k}" ${gv.spec === k ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`;
    html += `<p class="muted">${esc(D.GOVERNOR_SPECS[gv.spec]?.desc || '')}</p>`;
    html += `<label class="field inline"><span>Reserve ${Math.round(gv.reserve * 100)}%</span><input type="range" min="0" max="90" step="5" value="${Math.round(gv.reserve * 100)}" data-gov="reserve"></label>`;
    html += `<p class="muted">The governor never spends the reserved share of any stockpile.</p>`;
    html += perm('build', 'Construct buildings') + perm('roads', 'Build and repair roads') + perm('repair', 'Repair damage and clear ruins') + perm('recruit', 'Recruit a defensive garrison') + perm('settle', 'Found new settlements');
    const queued = (gv.queue || []).map((id) => S.buildings.get(id)).filter(Boolean);
    if (queued.length) html += `<h4 style="margin:6px 0 2px">Projects</h4><ul class="log">${queued.map((b) => `<li>${esc(D.BUILDINGS[b.ty].name)} ${b.st === 'planned' ? '(waiting for funds)' : `${b.p}%`} <button class="btn small ghost" data-gcancel="${b.id}" title="Cancel and never build on that hex again">Cancel &amp; lock</button></li>`).join('')}</ul>`;
    html += `<h4 style="margin:6px 0 2px">Decisions</h4><ul class="log govlog">${(gv.log || []).map((l) => `<li><time>${Math.floor(l.t / 60)}:${String(l.t % 60).padStart(2, '0')}</time>${esc(l.text)}</li>`).join('') || '<li class="muted">No decisions yet.</li>'}</ul>`;
    return html;
  }

  onSelClick(e) {
    const t = e.target.closest('[data-act],[data-train],[data-jump],[data-ctab],[data-gcancel],[data-card]'); if (!t) return;
    if (t.dataset.train) return this.A.train(t.dataset.train);
    if (t.dataset.jump) return this.A.jump(+t.dataset.jump);
    if (t.dataset.ctab) { this.cityTab = t.dataset.ctab; this.selHtml = ''; return this.selection(); }
    if (t.dataset.gcancel) return this.A.governor({ cancel: +t.dataset.gcancel });
    if (t.dataset.card && e.detail === 1) return this.A.narrowTo(t.dataset.card);
    if (t.dataset.act) this.A.act(t.dataset.act);
  }
  onSelChange(e) {
    const t = e.target;
    if (t.dataset.sel === 'stance') this.A.stance(t.value);
    else if (t.dataset.sel === 'formation') { this.S.formation = t.value; }
    else if (t.dataset.sel === 'rallyArmy') this.A.rallyArmy(+t.value);
    else if (t.dataset.gov === 'enabled') this.A.governor({ enabled: t.checked });
    else if (t.dataset.gov === 'spec') this.A.governor({ spec: t.value });
    else if (t.dataset.gov === 'reserve') this.A.governor({ reserve: +t.value / 100 });
    else if (t.dataset.gperm) this.A.governor({ perms: { [t.dataset.gperm]: t.checked } });
  }

  // ------------------------------------------------------------ drawer
  drawer(force) {
    const S = this.S, e = S.econ; if (!e) return;
    if ($('drawer').classList.contains('collapsed') && !force) return;
    const key = this.tab + JSON.stringify([e.research, Math.floor(e.progress / 10), e.queue, e.techs.length, e.age, e.advancing > 0, e.gov, e.govCooldown > 0, e.policies, e.tax, e.focus, e.proposals,
      S.civInfo.map((c) => [c.rel, c.alive, c.age, c.known]), this.tab === 'chronicle' ? [S.log.length, e.cmdlog?.length, e.cmdlog?.[0]?.t, this.chronTab] : 0,
      this.tab === 'empire' ? [[...S.cities.values()].filter((c) => c.o === S.civId).map((c) => [Math.round(c.pop / 4), Math.round(c.st / 5), c.fs, c.iso, c.unrest, c.gov?.enabled, c.gov?.spec]), this.empireSort, this.empireFilter] : 0,
      this.tab === 'armies' ? (e.armies || []).map((a) => [a.id, a.name, a.units.length, a.status, a.formation, a.stance, a.note, Math.round((a.hp || 0) / 5), Math.round((a.supply || 0) / 5)]) : 0]);
    if (!force && key === this.drawerKey) return;
    this.drawerKey = key;
    const body = $('drawerBody'); const scroll = body.scrollTop;
    body.innerHTML = this['tab_' + this.tab]?.() || '';
    if (this.tab === 'research') this.drawTechLinks();
    body.scrollTop = scroll;
  }

  tab_research() {
    const S = this.S, e = S.econ, D = S.defs;
    let h = '';
    const next = D.AGES[e.age + 1];
    if (next) {
      const have = e.techs.filter((t) => D.TECHS[t].age === e.age).length;
      const pct = Math.min(100, (100 * have) / next.techsNeeded);
      h += `<div class="era-hd"><h4>Next era: ${esc(next.name)}</h4><span class="muted">${have}/${next.techsNeeded}</span></div><div class="era-bar"><i style="width:${pct}%"></i></div>`;
      h += `<p class="muted">Needs ${next.techsNeeded} ${esc(D.AGES[e.age].name)} technologies and ${Object.entries(next.cost).map(([k, v]) => `${v} ${D.GOOD_NAMES[k].toLowerCase()}`).join(', ')}.</p>`;
      h += e.advancing ? `<p class="warn">Advancing… ${e.advancing}s</p>` : `<button class="btn primary" data-advance="1" ${have < next.techsNeeded ? 'disabled' : ''}>Advance to ${esc(next.name)}</button>`;
    }
    if (e.queue.length) h += `<p class="muted">Queue: ${e.queue.map((k) => esc(D.TECHS[k].name)).join(' → ')}</p>`;
    h += `<p class="muted">Click an available technology to research it now; click a locked one to queue it with all its prerequisites.</p><div class="techgraph" id="techgraph"><svg id="techlinks"></svg>`;
    for (let age = 0; age < D.AGES.length; age++) {
      h += `<div class="era"><h4>${esc(D.AGES[age].name)}</h4>`;
      for (const [k, t] of Object.entries(D.TECHS)) {
        if (t.age !== age) continue;
        const done = e.techs.includes(k), cur = e.research === k, avail = t.age <= e.age && t.req.every((r) => e.techs.includes(r));
        const qi = e.queue.indexOf(k);
        const cls = done ? 'done' : cur ? 'current' : qi >= 0 ? 'queued' : avail ? '' : 'locked';
        h += `<button class="tech ${cls}" data-tech="${k}" id="tech-${k}" ${done ? 'disabled' : ''}>${qi >= 0 ? `<span class="qn">${qi + 1}</span>` : ''}<b>${esc(t.name)}</b> <span class="muted">${done ? 'known' : t.cost + ' research'}</span><small>${esc(t.desc)}${t.req.length ? ` · needs ${t.req.map((r) => esc(D.TECHS[r].name)).join(', ')}` : ''}</small>${cur ? `<div class="prog"><i style="width:${Math.min(100, (100 * e.progress) / t.cost)}%"></i></div>` : ''}</button>`;
      }
      h += `</div>`;
    }
    return h + '</div>';
  }
  drawTechLinks() {
    const svg = $('techlinks'), host = $('techgraph'); if (!svg || !host) return;
    const D = this.S.defs, hb = host.getBoundingClientRect(); let p = '';
    for (const [k, t] of Object.entries(D.TECHS)) for (const r of t.req) {
      const a = document.getElementById('tech-' + r), b = document.getElementById('tech-' + k); if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.left - hb.left + 6, y1 = ra.top - hb.top + ra.height / 2, x2 = rb.left - hb.left + 6, y2 = rb.top - hb.top + rb.height / 2;
      p += `<path d="M${x1} ${y1} C ${x1 - 14} ${y1}, ${x2 - 14} ${y2}, ${x2} ${y2}" stroke="rgba(201,154,46,0.35)" fill="none" stroke-width="1.2"/>`;
    }
    svg.setAttribute('width', hb.width); svg.setAttribute('height', host.scrollHeight); svg.innerHTML = p;
  }

  tab_realm() {
    const S = this.S, e = S.econ, D = S.defs;
    const slots = D.GOVS[e.gov].slots;
    let h = `<h4>Government</h4>${e.govCooldown > 0 ? `<p class="muted">Reform possible in ${e.govCooldown}s.</p>` : ''}`;
    for (const [k, g] of Object.entries(D.GOVS)) { const ok = !g.tech || e.techs.includes(g.tech); h += `<button class="gov${e.gov === k ? ' on' : ''}" data-gov="${k}" ${!ok || e.gov === k ? 'disabled' : ''}><b>${esc(g.name)}</b> <span class="muted">${g.slots} policy slots${ok ? '' : ', needs ' + esc(D.TECHS[g.tech].name)}</span><small>${esc(g.desc)}</small></button>`; }
    h += `<h4>Policies (${e.policies.length}/${slots})</h4>`;
    for (const [k, p] of Object.entries(D.POLICIES)) { const ok = !p.tech || e.techs.includes(p.tech), on = e.policies.includes(k); h += `<button class="policy${on ? ' on' : ''}" data-policy="${k}" ${!ok ? 'disabled' : ''}><b>${esc(p.name)}</b> <span class="muted">${on ? 'active' : ok ? '' : 'needs ' + esc(D.TECHS[p.tech].name)}</span><small>${esc(p.desc)}</small></button>`; }
    h += `<h4>Taxation</h4><div class="seg">${D.TAX.map((t, i) => `<button class="${e.tax === i ? 'on' : ''}" data-tax="${i}" title="${t.stab >= 0 ? '+' : ''}${t.stab} stability">${esc(t.name)}</button>`).join('')}</div>`;
    h += `<h4>Labour focus</h4><div class="seg">${Object.entries(D.FOCI).map(([k, n]) => `<button class="${e.focus === k ? 'on' : ''}" data-focus="${k}">${esc(n)}</button>`).join('')}</div>`;
    h += `<p class="muted">War weariness ${e.weariness}. Power ${e.power?.gen || 0}/${e.power?.use || 0}. National storage cap ${e.storage}.${e.wonder != null ? ` Arcology victory in ${e.wonder}s.` : ''}</p>`;
    return h;
  }

  tab_empire() {
    const S = this.S, D = S.defs;
    const mine = [...S.cities.values()].filter((c) => c.o === S.civId);
    const defenses = (c) => [...S.buildings.values()].filter((b) => b.o === S.civId && ['bunker', 'fort'].includes(b.ty) && hexDist(S, b.t, c.t) <= (c.r || 3)).length;
    const garrison = (c) => [...S.units.values()].filter((u) => u.owner === S.civId && !D.UNITS[u.type].civilian && hexDist(S, u.tile, c.t) <= 3).length;
    const shortages = (c) => [c.fs && 'famine', c.iso && 'cut off', c.unrest && 'unrest', c.un > 3 && 'jobless'].filter(Boolean);
    const rows = mine.map((c) => ({ c, name: c.n, pop: c.pop, st: c.st, prod: (c.jobs?.worker || 0) + (c.jobs?.merchant || 0) + (c.jobs?.specialist || 0), def: defenses(c) * 10 + garrison(c), short: shortages(c), auto: c.gov?.enabled ? 1 : 0 }));
    const filt = { all: () => true, shortages: (r) => r.short.length, isolated: (r) => r.c.iso, automated: (r) => r.auto, manual: (r) => !r.auto, unrest: (r) => r.c.unrest || r.st < 35 }[this.empireFilter] || (() => true);
    const [sk, sd] = this.empireSort;
    const list = rows.filter(filt).sort((a, b) => ((a[sk] ?? 0) > (b[sk] ?? 0) ? 1 : -1) * sd);
    let h = `<div class="chips">${['all', 'shortages', 'isolated', 'unrest', 'automated', 'manual'].map((f) => `<span class="chip ${this.empireFilter === f ? 'on' : ''}" data-efilter="${f}">${f[0].toUpperCase() + f.slice(1)}</span>`).join('')}</div>`;
    const th = (k, n) => `<th data-esort="${k}">${n}${sk === k ? (sd > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    h += `<table class="grid"><thead><tr>${th('name', 'City')}${th('pop', 'Pop')}${th('prod', 'Staffed')}${th('st', 'Stab.')}${th('def', 'Defense')}<th>Status</th></tr></thead><tbody>`;
    for (const r of list) {
      const c = r.c;
      h += `<tr data-jump="${c.t}" data-city="${c.id}"><td><b>${esc(c.n)}</b>${c.cap ? ' ★' : ''}</td><td>${Math.floor(c.pop)}/${c.h}</td><td>${r.prod}</td><td class="${c.st < 25 ? 'bad' : c.st < 45 ? 'warn' : ''}">${c.st}</td><td>${defenses(c)}▣ ${garrison(c)}⚑</td><td>${r.short.map((s) => `<span class="tag ${s === 'famine' || s === 'unrest' ? 'bad' : 'warn'}">${s}</span>`).join('')}${c.gov?.enabled ? `<span class="tag good">${esc(D.GOVERNOR_SPECS[c.gov.spec]?.name || 'governor')}</span>` : '<span class="tag">manual</span>'}</td></tr>`;
    }
    h += `</tbody></table>`;
    if (!list.length) h += `<p class="muted">No cities match this filter.</p>`;
    h += `<p class="muted">Click a row to jump to the city. Select its hub to change its governor.</p>`;
    return h;
  }

  tab_armies() {
    const S = this.S, e = S.econ, D = S.defs;
    const armies = e.armies || [];
    let h = `<p class="muted">Select units and press G (or "Form army") to group them. Armies take one order and manage formation, stance and spacing themselves.</p>`;
    if (!armies.length) h += `<p class="muted">No armies yet.</p>`;
    for (const a of armies) {
      const o = a.order || {};
      h += `<div class="army"><div class="hd"><b>${esc(a.name)}</b><span class="tag ${a.status === 'blocked' || a.status === 'withdrawing' ? 'bad' : a.status === 'attacking' || a.status === 'engaging' ? 'warn' : 'good'}">${esc(a.status)}</span></div>
        <div class="meta">${a.units.length} units · ${a.men} soldiers · strength ${a.hp ?? '–'}% · supply ${a.supply ?? '–'}%${o.kind && o.kind !== 'idle' ? ` · order: ${esc(o.kind)}${o.phase ? ` (${esc(o.phase)})` : ''}` : ''}</div>
        ${a.note ? `<div class="meta">${esc(a.note)}</div>` : ''}
        <div class="actions"><button class="btn small" data-army="select" data-id="${a.id}">Select</button><button class="btn small" data-army="center" data-id="${a.id}" data-tile="${a.center}">Find</button>
          <select data-army-formation="${a.id}">${Object.entries(D.FORMATIONS).map(([k, n]) => `<option value="${k}" ${a.formation === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <select data-army-stance="${a.id}">${Object.entries(D.STANCES).map(([k, n]) => `<option value="${k}" ${a.stance === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div class="actions"><button class="btn small" data-army="move" data-id="${a.id}">March</button><button class="btn small" data-army="attackMove" data-id="${a.id}">Advance</button><button class="btn small" data-army="hold" data-id="${a.id}">Hold</button><button class="btn small" data-army="defend" data-id="${a.id}">Defend zone</button><button class="btn small primary" data-army="offensive" data-id="${a.id}">Prepare offensive</button><button class="btn small ghost" data-army="disband" data-id="${a.id}">Disband</button></div></div>`;
    }
    h += `<h4>Rally network</h4><p class="muted">Send every production building's new units to one place.</p><div class="actions"><button class="btn small" data-army="rallyAll">Set rally point for all</button></div>`;
    return h;
  }

  tab_diplomacy() {
    const S = this.S, e = S.econ, D = S.defs;
    let h = '';
    if (e.proposals.length) h += `<h4>Proposals</h4>` + e.proposals.map((p) => `<div class="civrow"><b>${esc(p.fromName)}</b>: ${esc(p.label)}<div class="actions"><button class="btn small primary" data-respond="${p.id}" data-accept="1">Accept</button><button class="btn small ghost" data-respond="${p.id}" data-accept="0">Decline</button></div></div>`).join('');
    h += `<h4>Empires & factions</h4>`;
    for (const c of S.civInfo) {
      if (c.id === S.civId) continue;
      const r = c.rel || { state: 'unmet' };
      h += `<div class="civrow"><div class="hd"><span class="swatch" style="background:${cssColor(c.color)}"></span><b>${esc(c.name)}</b>${c.rebel ? ' <span class="tag">rebels</span>' : ''}<span class="state ${r.state}">${c.alive ? r.state : 'fallen'}</span></div>`;
      if (r.state !== 'unmet' && c.alive) {
        h += `<div class="muted">${c.age != null ? esc(D.AGES[c.age]?.name || '') + ', ' : ''}${c.known?.cities ?? 0} cities seen${r.trade ? ', trade agreement' : ''}${r.borders ? ', open borders' : ''}${r.until > 0 ? `, truce ${r.until}s` : ''}</div><div class="actions">`;
        const btn = (a, label, cls = '') => `<button class="btn small ${cls}" data-diplo="${a}" data-to="${c.id}">${label}</button>`;
        if (c.rebel) h += btn('tribute', 'Pay off (truce)', 'ghost');
        else if (r.state === 'war') h += btn('peace', 'Propose peace', 'primary');
        else {
          if (!r.trade) h += btn('trade', 'Trade agreement'); else h += btn('cancel_trade', 'Cancel trade', 'ghost');
          if (!r.borders) h += btn('borders', 'Open borders');
          if (r.state === 'peace') h += btn('alliance', 'Alliance');
          h += btn('war', 'Declare war', 'danger');
        }
        if (!c.rebel) h += btn('tribute', 'Gift 100 credits', 'ghost') + btn('demand', 'Demand tribute', 'ghost');
        h += `</div>`;
      } else if (c.alive) h += `<div class="muted">Not yet contacted. Explore to find them.</div>`;
      h += `</div>`;
    }
    return h;
  }

  tab_chronicle() {
    const S = this.S, e = S.econ;
    this.chronTab = this.chronTab || 'events';
    let h = `<div class="subtabs"><button class="${this.chronTab === 'events' ? 'on' : ''}" data-chron="events">Events</button><button class="${this.chronTab === 'commands' ? 'on' : ''}" data-chron="commands">Command history</button></div>`;
    if (this.chronTab === 'events') h += `<ul class="log">${S.log.slice().reverse().map((m) => `<li class="lv-${m.level || 'minor'}" ${m.tile >= 0 ? `data-jump="${m.tile}"` : ''}><time>${Math.floor(m.time / 60)}:${String(m.time % 60).padStart(2, '0')}</time>${esc(m.text)}</li>`).join('')}</ul>`;
    else h += `<p class="muted">Every order, who gave it — you, a city governor, or an army controller — and why.</p><ul class="log">${(e.cmdlog || []).map((c) => `<li><time>${Math.floor(c.t / 60)}:${String(c.t % 60).padStart(2, '0')}</time><span class="by">${esc(c.by.replace('governor:', 'Governor of ').replace('army:', ''))}</span>${esc(c.text)}</li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>`;
    return h;
  }

  onDrawerClick(ev) {
    const t = ev.target.closest('button,[data-jump],[data-efilter],[data-esort],[data-chron]'); if (!t) return;
    const d = t.dataset;
    if (d.tech) this.A.cmd({ c: 'research', tech: d.tech, queue: t.classList.contains('locked') || t.classList.contains('queued') ? true : undefined });
    else if (d.advance) this.A.cmd({ c: 'advance' });
    else if (d.gov) this.A.cmd({ c: 'gov', id: d.gov });
    else if (d.policy) this.A.cmd({ c: 'policy', id: d.policy, on: !this.S.econ.policies.includes(d.policy) });
    else if (d.tax) this.A.cmd({ c: 'tax', level: +d.tax });
    else if (d.focus) this.A.cmd({ c: 'focus', id: d.focus });
    else if (d.diplo) this.A.cmd({ c: 'diplo', to: +d.to, action: d.diplo });
    else if (d.respond) this.A.cmd({ c: 'respond', id: +d.respond, accept: d.accept === '1' });
    else if (d.army) this.A.army(d.army, +d.id, d.tile != null ? +d.tile : undefined);
    else if (d.efilter) { this.empireFilter = d.efilter; }
    else if (d.esort) { this.empireSort = [d.esort === 'name' ? 'name' : d.esort, this.empireSort[0] === d.esort ? -this.empireSort[1] : -1]; }
    else if (d.chron) { this.chronTab = d.chron; }
    else if (d.jump) { if (d.city) this.A.selectCity(+d.city); this.A.jump(+d.jump); }
    this.drawer(true);
    setTimeout(() => this.A.refresh(), 200);
  }
  onDrawerChange(ev) {
    const t = ev.target;
    if (t.dataset.armyFormation) this.A.cmd({ c: 'army', op: 'formation', id: +t.dataset.armyFormation, formation: t.value });
    if (t.dataset.armyStance) this.A.cmd({ c: 'army', op: 'stance', id: +t.dataset.armyStance, stance: t.value });
  }

  tooltip(tile, x, y) {
    const tip = $('tooltip'), S = this.S;
    if (tile < 0 || S.terr[tile] === 255) { tip.hidden = true; return; }
    const D = S.defs, t = D.TERRAIN[S.terr[tile]];
    const parts = [`<b>${esc(t.name)}</b>`];
    if (S.flags[tile] & 1) parts.push('River' + (S.flags[tile] & 16 ? ' (low: drought)' : '') + ' — fording is slow; heavy vehicles need paved bridges');
    if (S.flags[tile] & 4) parts.push('Volcanic soil: very fertile');
    if (S.flags[tile] & 32) parts.push('Ashfall: harvests ruined for now');
    if (S.res[tile]) parts.push('Resource: ' + esc(D.RESOURCE[S.res[tile]].name));
    const r = S.ruins.get(tile); if (r) parts.push(`Ruins of ${esc(D.BUILDINGS[r.type]?.name || 'a building')}${r.flags & 4 ? ' (overgrown)' : ''}${r.flags & 2 ? ' — still smouldering' : ''}. Clear them (engineers or governor) or rebuild the same building at half cost.`);
    if (Number.isFinite(t.move)) parts.push(`Infantry move cost ${t.move}${t.def ? `, defense ${t.def > 0 ? '+' : ''}${Math.round(t.def * 100)}%` : ''}`);
    else if (!t.water) parts.push('Impassable');
    if (S.road[tile]) { const best = Math.max(...[0, 1, 2, 3, 4, 5].map((d) => (S.road[tile] >> (d * 4)) & 7)); const ruined = [0, 1, 2, 3, 4, 5].some((d) => (S.road[tile] >> (d * 4)) & 8); parts.push(esc(D.ROAD_TYPES[best]?.name || 'Road') + (ruined ? ' — some segments wrecked' : '')); }
    const tr = S.trafficTile.get(tile); if (tr) parts.push(`Traffic: ${tr > 6 ? 'heavy' : tr > 2 ? 'moderate' : 'light'}`);
    if (S.stab[tile] >= 0) parts.push(`Structural stability ${S.stab[tile]}%`);
    if (S.owner[tile] >= 0) parts.push('Territory of ' + esc(S.civInfo[S.owner[tile]]?.name || ''));
    if (S.owner[tile] === S.civId || S.supply[tile]) parts.push(S.supply[tile] ? '<span class="good">In your supply network</span>' : '<span class="bad">Outside supply</span>');
    if (!S.vis[tile]) parts.push('<span class="muted">Last seen; may have changed</span>');
    tip.innerHTML = parts.join('<br>');
    tip.hidden = false; tip.style.left = Math.min(window.innerWidth - 270, x + 16) + 'px'; tip.style.top = y + 16 + 'px';
  }
}
function hexDist(S, a, b) {
  const cube = (i) => { const q = i % S.W, r = (i / S.W) | 0; const x = q - ((r - (r & 1)) >> 1); return [x, r, -x - r]; };
  const [ax, ay, az] = cube(a), [bx, by, bz] = cube(b);
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}
function mix(a, b, t) { const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255, br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255; return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t); }

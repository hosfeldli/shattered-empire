// DOM HUD: resources, seismograph, selection, build bar, research/realm/diplomacy drawer.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RES_LABEL = { food: 'Food', wood: 'Wood', stone: 'Stone', iron: 'Iron', coal: 'Coal', gold: 'Gold', equip: 'Equipment' };
export const fmt = (n) => (Math.abs(n) >= 10000 ? (n / 1000).toFixed(0) + 'k' : Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.floor(n).toString());
export const costStr = (c) => Object.entries(c || {}).map(([k, v]) => `${v} ${RES_LABEL[k]?.toLowerCase() || k}`).join(', ') || 'free';
const cssColor = (c) => '#' + c.toString(16).padStart(6, '0');

export class Hud {
  constructor(S, actions) {
    this.S = S; this.A = actions; this.tab = 'research'; this.seis = new Float32Array(240); this.amp = 0; this.alertT = 0; this.shockT = 0;
    this.sctx = $('seismo').getContext('2d');
    this.mctx = $('minimap').getContext('2d');
    const drawerEl = $('drawer');
    if (window.innerWidth < 1200) drawerEl.classList.add('collapsed');
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      // clicking the open tab folds the drawer away so the map is unobstructed
      if (this.tab === b.dataset.tab && !drawerEl.classList.contains('collapsed')) { drawerEl.classList.add('collapsed'); b.setAttribute('aria-selected', 'false'); return; }
      drawerEl.classList.remove('collapsed');
      this.tab = b.dataset.tab; document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b)); this.drawer(true);
    }));
    if (drawerEl.classList.contains('collapsed')) document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', 'false'));
    $('drawerBody').addEventListener('click', (e) => this.onDrawerClick(e));
    $('selection').addEventListener('click', (e) => this.onSelClick(e));
    $('buildbar').addEventListener('click', (e) => { const b = e.target.closest('[data-build],[data-tool]'); if (b) this.A.buildMode(b.dataset.build || null, b.dataset.tool || null); });
    this.drawerKey = '';
  }

  // ------------------------------------------------------------ top bar
  topbar() {
    const S = this.S, e = S.econ; if (!e) return;
    const me = S.civInfo[S.civId];
    $('civName').textContent = me ? me.name : '';
    $('civName').style.color = cssColor(S.civColor(S.civId));
    $('ageName').textContent = S.defs.AGES[e.age].name + (e.advancing ? ` → advancing (${e.advancing}s)` : '');
    $('resources').innerHTML = S.defs.GOODS.map((k) => {
      const r = e.rates[k] || 0;
      return `<li title="${RES_LABEL[k]}"><span class="k">${RES_LABEL[k]}</span><b>${fmt(e.res[k] || 0)}</b><small class="${r < 0 ? 'neg' : ''}">${r >= 0 ? '+' : ''}${r.toFixed(1)}/s</small></li>`;
    }).join('') + `<li title="Research per second"><span class="k">Research</span><b>${e.researchRate.toFixed(1)}</b><small>${e.research ? esc(S.defs.TECHS[e.research].name) : 'idle'}</small></li>`;
  }

  clock(time, rtt) { const t = Math.floor(time); $('clock').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; $('net').textContent = rtt ? `${rtt} ms` : ''; }

  // ------------------------------------------------------------ seismograph (the land's heartbeat)
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

  // ------------------------------------------------------------ toasts
  toast(m) {
    const el = document.createElement('div');
    el.className = 'toast ' + (m.kind || '');
    el.textContent = m.text;
    if (m.tile >= 0) el.addEventListener('click', () => this.A.jump(m.tile));
    if (m.kind === 'proposal') el.addEventListener('click', () => { this.tab = ''; document.querySelector('[data-tab=diplomacy]').click(); });
    const box = $('toasts'); box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => el.remove(), m.kind === 'warning' || m.kind === 'proposal' ? 12000 : 6500);
  }

  // ------------------------------------------------------------ minimap
  minimap(view) {
    const S = this.S, c = this.mctx, W = S.W, H = S.H;
    const sx = 192 / (W + 0.5), sy = 168 / H;
    const img = c.createImageData(192, 168);
    const d = img.data;
    for (let y = 0; y < 168; y++) {
      const r = Math.min(H - 1, Math.floor(y / sy));
      for (let x = 0; x < 192; x++) {
        const q = Math.floor(x / sx - 0.5 * (r & 1)); const o = (y * 192 + x) * 4;
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
    // camera rect
    const v = view; const [x0, y0] = v.screenToWorld(0, 0); const [x1, y1] = v.screenToWorld(v.app.screen.width, v.app.screen.height);
    const kx = 192 / v.pw, ky = 168 / v.ph;
    c.strokeStyle = '#f1c75b'; c.lineWidth = 1; c.strokeRect(x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky);
  }

  // ------------------------------------------------------------ build bar
  buildbar() {
    const S = this.S, e = S.econ; if (!e) return;
    const techs = new Set(e.techs);
    const items = Object.entries(S.defs.BUILDINGS).filter(([k, d]) => k !== 'town' && d.age <= e.age && (!d.tech || techs.has(d.tech)));
    const afford = (c) => Object.entries(c).every(([k, v]) => (e.res[k] || 0) >= v);
    let html = items.map(([k, d]) => `<button class="buildbtn${S.mode?.type === k ? ' active' : ''}${afford(d.cost) ? '' : ' poor'}" data-build="${k}" title="${esc(d.name)}: ${esc(costStr(d.cost))}"><span class="g">${d.glyph}</span><span class="n">${esc(d.name)}</span><small>${esc(costStr(d.cost))}</small></button>`).join('');
    html += `<button class="buildbtn tool${S.mode?.kind === 'road' && !S.mode.rail ? ' active' : ''}" data-tool="road" title="Build a road between two tiles (R)"><span class="g">\u{1F6E4}</span><span class="n">Road</span><small>2 wood, 1 stone per hex</small></button>`;
    if (techs.has('railroads')) html += `<button class="buildbtn tool${S.mode?.rail ? ' active' : ''}" data-tool="rail" title="Upgrade a route to railway"><span class="g">\u{1F682}</span><span class="n">Railway</span><small>2 iron, 1 coal per hex</small></button>`;
    if (techs.has('engineering')) html += `<button class="buildbtn tool${S.mode?.kind === 'clearPass' ? ' active' : ''}" data-tool="clearPass" title="Blast a passage through impassable peaks"><span class="g">\u{1F9E8}</span><span class="n">Clear peak</span><small>${techs.has('explosives') ? '30 stone, 40 gold' : '120 stone, 120 gold, 20 equip'}</small></button>`;
    const key = html.length + '|' + JSON.stringify(e.res && Object.values(e.res).map((v) => Math.floor(v / 10)));
    if (key !== this.bbKey) { this.bbKey = key; $('buildbar').innerHTML = html; }
  }

  // ------------------------------------------------------------ selection
  selection() {
    const S = this.S, el = $('selection');
    const D = S.defs;
    let html = '';
    const units = [...S.selUnits].map((id) => S.units.get(id)).filter(Boolean);
    if (units.length) {
      const own = units[0].owner === S.civId;
      const types = new Map(); for (const u of units) types.set(u.type, (types.get(u.type) || 0) + 1);
      const avg = (f) => Math.round(units.reduce((s, u) => s + u[f], 0) / units.length);
      const first = D.UNITS[units[0].type];
      html += `<h3>${units.length > 1 ? `${units.length} units` : esc(first.name)}</h3>`;
      html += own ? `<div class="chips">${[...types].map(([t, n]) => `<button class="chip" data-narrow="${t}" title="Select only these">${n}× ${esc(D.UNITS[t].name)}</button>`).join('')}</div>` : `<div class="sub">${esc(S.civInfo[units[0].owner]?.name || '')}</div>`;
      html += `<div>Strength</div><div class="bar hp"><i style="width:${avg('hp')}%"></i></div>`;
      if (own) {
        const outs = units.filter((u) => u.flags & 4).length;
        html += `<div>Supply ${avg('sup')}%</div><div class="bar sup"><i style="width:${avg('sup')}%"></i></div>`;
        html += outs ? `<div class="bad">${outs} out of supply: weakening and losing strength. Bring them within range of a city, depot, port, fort or supply wagon.</div>` : `<div class="muted">In supply: fed, reinforced and at full fighting strength.</div>`;
        if (units.length === 1) html += `<dl class="kv"><dt>Attack</dt><dd>${first.atk}</dd><dt>Defense</dt><dd>${first.def}</dd><dt>Range</dt><dd>${first.range}</dd><dt>Speed</dt><dd>${first.speed}</dd></dl>`;
        html += `<div class="actions"><button class="btn small" data-act="stop">Stop (S)</button><button class="btn small" data-act="amove">Attack-move (A)</button>`;
        if (units.some((u) => u.type === 'settler')) html += `<button class="btn small primary" data-act="found">Found city (F)</button>`;
        html += `</div><p class="muted">Double-click a unit for all of its type on screen; Ctrl/⌘ + double-click for all on the map. Ctrl+1–9 saves a group.</p>`;
      }
    } else if (S.selBuilding != null && S.buildings.has(S.selBuilding)) {
      const b = S.buildings.get(S.selBuilding), d = D.BUILDINGS[b.ty];
      const own = b.o === S.civId;
      const city = b.ty === 'town' ? [...S.cities.values()].find((c) => c.t === b.t) : null;
      html += `<h3>${esc(city ? city.n : d.name)}</h3><div class="sub">${esc(city ? d.name + (city.cap ? ' (capital)' : '') : '')}${own ? '' : esc(S.civInfo[b.o]?.name || '')}</div>`;
      html += `<div>Condition</div><div class="bar hp"><i style="width:${b.hp}%"></i></div>`;
      if (!b.d) html += `<div class="warn">Under construction: ${b.p}%</div>`;
      if (city && own) {
        html += `<dl class="kv"><dt>Population</dt><dd>${city.pop.toFixed(1)} / ${city.h} housing</dd><dt>Workers</dt><dd>${city.jobs?.worker || 0}</dd><dt>Merchants</dt><dd>${city.jobs?.merchant || 0}</dd><dt>Specialists</dt><dd>${city.jobs?.specialist || 0}</dd><dt>Unemployed</dt><dd>${city.un}</dd><dt>Trade route</dt><dd>${city.cap ? 'Capital' : city.trade ? '<span class="good">Connected</span>' : '<span class="muted">No road to capital</span>'}</dd></dl>`;
        html += `<div>Stability ${city.st}</div><div class="bar stab"><i style="width:${city.st}%"></i></div>`;
        if (city.unrest) html += `<div class="bad">Unrest! Output halved. Below 8 the city may rebel and defect.</div>`;
        if (city.fs) html += `<div class="bad">Famine: the people are starving.</div>`;
        if (city.dis > 2) html += `<div class="warn">Recovering from disaster (−${city.dis} stability)</div>`;
        if (city.occ > 2) html += `<div class="warn">Recently occupied (−${Math.round(city.occ / 2)} stability)</div>`;
      } else if (city) html += `<div>Population ${Math.floor(city.pop)}</div>`;
      if (own && d.jobs && b.d) html += `<div class="muted">${b.s} / ${d.jobs[1]} ${d.jobs[0]}s employed</div>`;
      if (own && d.trains && b.d) {
        const e = S.econ;
        html += `<div class="actions">` + d.trains.filter((u) => D.UNITS[u].age <= e.age).map((u) => {
          const ud = D.UNITS[u]; const locked = ud.tech && !e.techs.includes(ud.tech);
          return `<button class="btn trainbtn" data-train="${u}" ${locked ? 'disabled' : ''} title="${esc(ud.name)}: ${esc(costStr(ud.cost))}, ${ud.pop} pop"><span>${esc(ud.name)}</span><small>${locked ? 'needs ' + esc(D.TECHS[ud.tech].name) : esc(costStr(ud.cost))}</small></button>`;
        }).join('') + `</div>`;
        if (b.q?.length) html += `<div class="queue">${b.q.map(([u, t]) => `<span>${esc(D.UNITS[u].name)} ${t}s</span>`).join('')}</div>`;
        html += `<div class="muted">Right-click the map to set a rally point.</div>`;
      }
      if (own && b.ty !== 'town') html += `<div class="actions"><button class="btn small ghost" data-act="demolish">Demolish</button></div>`;
    } else {
      const e = S.econ;
      const mine = [...S.cities.values()].filter((c) => c.o === S.civId);
      html += `<h3>Your realm</h3><div class="sub">${mine.length} ${mine.length === 1 ? 'city' : 'cities'}, ${Math.round(mine.reduce((s, c) => s + c.pop, 0))} people, ${e ? e.soldiers : 0} under arms</div>`;
      html += `<ul class="log">${mine.map((c) => `<li data-jump="${c.t}"><b>${esc(c.n)}</b> pop ${Math.floor(c.pop)}/${c.h}, stability <span class="${c.st < 25 ? 'bad' : c.st < 45 ? 'warn' : ''}">${c.st}</span>${c.fs ? ' <span class="bad">famine</span>' : ''}</li>`).join('')}</ul>`;
      html += `<p class="muted">Select units with a click or drag. Right-click to move or attack. Pick a building below to place it.</p>`;
    }
    if (html !== this.selHtml) { this.selHtml = html; el.innerHTML = html; }
  }

  onSelClick(e) {
    const t = e.target.closest('[data-act],[data-train],[data-jump],[data-narrow]'); if (!t) return;
    if (t.dataset.narrow) return this.A.narrow(t.dataset.narrow);
    if (t.dataset.train) return this.A.train(t.dataset.train);
    if (t.dataset.jump) return this.A.jump(+t.dataset.jump);
    this.A.act(t.dataset.act);
  }

  // ------------------------------------------------------------ drawer
  drawer(force) {
    const S = this.S, e = S.econ; if (!e) return;
    const D = S.defs;
    const key = this.tab + JSON.stringify([e.research, Math.floor(e.progress / 5), e.techs.length, e.age, e.advancing > 0, e.gov, e.govCooldown > 0, e.policies, e.tax, e.focus, e.proposals, S.civInfo.map((c) => [c.rel, c.alive, c.known?.cities, c.age]), this.tab === 'chronicle' ? S.log.length : 0]);
    if (!force && key === this.drawerKey) return;
    this.drawerKey = key;
    const body = $('drawerBody'); const scroll = body.scrollTop;
    let h = '';
    if (this.tab === 'research') {
      const next = D.AGES[e.age + 1];
      if (next) {
        const have = e.techs.filter((t) => D.TECHS[t].age === e.age).length;
        h += `<h4>${esc(next.name)}</h4><p class="muted">Requires ${next.techsNeeded} ${esc(D.AGES[e.age].name)} technologies (${have} known) and ${esc(costStr(next.cost))}.</p>`;
        h += e.advancing ? `<p class="warn">Advancing… ${e.advancing}s</p>` : `<button class="btn primary" data-advance="1" ${have < next.techsNeeded ? 'disabled' : ''}>Advance to the ${esc(next.name)}</button>`;
      }
      for (const age of [0, 1, 2]) {
        h += `<h4>${esc(D.AGES[age].name)}</h4>`;
        for (const [k, t] of Object.entries(D.TECHS)) {
          if (t.age !== age) continue;
          const done = e.techs.includes(k), cur = e.research === k, locked = t.age > e.age;
          h += `<button class="tech${done ? ' done' : ''}${cur ? ' current' : ''}${locked ? ' locked' : ''}" data-tech="${k}" ${done || locked ? 'disabled' : ''}><b>${esc(t.name)}</b> <span class="muted">${done ? 'known' : t.cost + ' research'}</span><small>${esc(t.desc)}</small>${cur ? `<div class="prog"><i style="width:${Math.min(100, (100 * e.progress) / t.cost)}%"></i></div>` : ''}</button>`;
        }
      }
    } else if (this.tab === 'realm') {
      const slots = D.GOVS[e.gov].slots;
      h += `<h4>Government</h4>${e.govCooldown > 0 ? `<p class="muted">Reform possible in ${e.govCooldown}s.</p>` : ''}`;
      for (const [k, g] of Object.entries(D.GOVS)) {
        const ok = !g.tech || e.techs.includes(g.tech);
        h += `<button class="gov${e.gov === k ? ' on' : ''}" data-gov="${k}" ${!ok || e.gov === k ? 'disabled' : ''}><b>${esc(g.name)}</b> <span class="muted">${g.slots} policy slots${ok ? '' : ', needs ' + esc(D.TECHS[g.tech].name)}</span><small>${esc(g.desc)}</small></button>`;
      }
      h += `<h4>Policies (${e.policies.length}/${slots})</h4>`;
      for (const [k, p] of Object.entries(D.POLICIES)) {
        const ok = !p.tech || e.techs.includes(p.tech), on = e.policies.includes(k);
        h += `<button class="policy${on ? ' on' : ''}" data-policy="${k}" ${!ok ? 'disabled' : ''}><b>${esc(p.name)}</b> <span class="muted">${on ? 'active' : ok ? '' : 'needs ' + esc(D.TECHS[p.tech].name)}</span><small>${esc(p.desc)}</small></button>`;
      }
      h += `<h4>Taxation</h4><div class="seg">${D.TAX.map((t, i) => `<button class="${e.tax === i ? 'on' : ''}" data-tax="${i}" title="${t.stab >= 0 ? '+' : ''}${t.stab} stability">${esc(t.name)}</button>`).join('')}</div>`;
      h += `<h4>Labour focus</h4><div class="seg">${Object.entries(D.FOCI).map(([k, n]) => `<button class="${e.focus === k ? 'on' : ''}" data-focus="${k}">${esc(n)}</button>`).join('')}</div>`;
      h += `<p class="muted">War weariness ${e.weariness}. Soldiers ${e.soldiers}.${e.wonder != null ? ` Grand Exposition victory in ${e.wonder}s.` : ''}</p>`;
    } else if (this.tab === 'diplomacy') {
      if (e.proposals.length) {
        h += `<h4>Proposals</h4>` + e.proposals.map((p) => `<div class="civrow"><b>${esc(p.fromName)}</b>: ${esc(p.label)}<div class="actions"><button class="btn small primary" data-respond="${p.id}" data-accept="1">Accept</button><button class="btn small ghost" data-respond="${p.id}" data-accept="0">Decline</button></div></div>`).join('');
      }
      h += `<h4>Empires</h4>`;
      for (const c of S.civInfo) {
        if (c.id === S.civId) continue;
        const r = c.rel || { state: 'unmet' };
        const known = c.known || {};
        h += `<div class="civrow"><div class="hd"><span class="swatch" style="background:${cssColor(c.color)}"></span><b>${esc(c.name)}</b><span class="state ${r.state}">${c.alive ? r.state : 'fallen'}</span></div>`;
        if (r.state !== 'unmet' && c.alive) {
          h += `<div class="muted">${esc(D.AGES[c.age].name)}, ${known.cities} cities seen${r.trade ? ', trade agreement' : ''}${r.borders ? ', open borders' : ''}</div><div class="actions">`;
          const btn = (a, label, cls = '') => `<button class="btn small ${cls}" data-diplo="${a}" data-to="${c.id}">${label}</button>`;
          if (r.state === 'war') h += btn('peace', 'Propose peace', 'primary');
          else {
            if (!r.trade) h += btn('trade', 'Trade agreement'); else h += btn('cancel_trade', 'Cancel trade', 'ghost');
            if (!r.borders) h += btn('borders', 'Open borders');
            if (r.state === 'peace') h += btn('alliance', 'Alliance');
            h += btn('war', 'Declare war', 'danger');
          }
          h += btn('tribute', 'Gift 100 gold', 'ghost') + btn('demand', 'Demand tribute', 'ghost') + `</div>`;
        } else if (c.alive) h += `<div class="muted">Not yet contacted. Explore to find them.</div>`;
        h += `</div>`;
      }
    } else {
      h += `<ul class="log">${S.log.slice().reverse().map((m) => `<li ${m.tile >= 0 ? `data-jump="${m.tile}"` : ''}><time>${Math.floor(m.time / 60)}:${String(m.time % 60).padStart(2, '0')}</time>${esc(m.text)}</li>`).join('')}</ul>`;
    }
    body.innerHTML = h; body.scrollTop = scroll;
  }

  onDrawerClick(ev) {
    const t = ev.target.closest('button,[data-jump]'); if (!t) return;
    const d = t.dataset;
    if (d.tech) this.A.cmd({ c: 'research', tech: d.tech });
    else if (d.advance) this.A.cmd({ c: 'advance' });
    else if (d.gov) this.A.cmd({ c: 'gov', id: d.gov });
    else if (d.policy) this.A.cmd({ c: 'policy', id: d.policy, on: !this.S.econ.policies.includes(d.policy) });
    else if (d.tax) this.A.cmd({ c: 'tax', level: +d.tax });
    else if (d.focus) this.A.cmd({ c: 'focus', id: d.focus });
    else if (d.diplo) this.A.cmd({ c: 'diplo', to: +d.to, action: d.diplo });
    else if (d.respond) this.A.cmd({ c: 'respond', id: +d.respond, accept: d.accept === '1' });
    else if (d.jump) this.A.jump(+d.jump);
    setTimeout(() => this.A.refresh(), 150);
  }

  tooltip(tile, x, y) {
    const tip = $('tooltip'), S = this.S;
    if (tile < 0 || S.terr[tile] === 255) { tip.hidden = true; return; }
    const D = S.defs, t = D.TERRAIN[S.terr[tile]];
    const parts = [`<b>${esc(t.name)}</b>`];
    if (S.flags[tile] & 1) parts.push('River (fording is slow; bridges need Engineering)');
    if (S.flags[tile] & 4) parts.push('Volcanic soil: very fertile');
    if (S.res[tile]) parts.push('Resource: ' + esc(D.RESOURCE[S.res[tile]].name));
    if (Number.isFinite(t.move)) parts.push(`Move cost ${t.move}${t.def ? `, defense ${t.def > 0 ? '+' : ''}${Math.round(t.def * 100)}%` : ''}`);
    else if (!t.water) parts.push('Impassable');
    if (S.road[tile]) parts.push(S.road[tile] === 2 ? 'Railway' : 'Road');
    if (S.stab[tile] >= 0) parts.push(`Structural stability ${S.stab[tile]}%`);
    if (S.owner[tile] >= 0) parts.push('Territory of ' + esc(S.civInfo[S.owner[tile]]?.name || ''));
    if (S.owner[tile] === S.civId || S.supply[tile]) parts.push(S.supply[tile] ? '<span class="good">In your supply network</span>' : '<span class="bad">Outside supply</span>');
    if (!S.vis[tile]) parts.push('<span class="muted">Last seen; may have changed</span>');
    tip.innerHTML = parts.join('<br>');
    tip.hidden = false; tip.style.left = x + 16 + 'px'; tip.style.top = y + 16 + 'px';
  }
}
function mix(a, b, t) { const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255, br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255; return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t); }

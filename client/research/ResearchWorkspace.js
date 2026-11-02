// Full-screen research workspace: an interactive technology graph (eras left to right, research
// categories in lanes), a node inspector, a queue tray, search and filters. Selecting a node only
// inspects it; research and queue changes are explicit buttons validated by the server.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);

// presentation metadata only: no effect on prerequisites
export const CATEGORIES = [
  ['civ', 'Civilization & agriculture', '❀'],
  ['industry', 'Industry & energy', '⚙'],
  ['infra', 'Infrastructure & transport', '⛕'],
  ['military', 'Military equipment', '⚔'],
  ['logistics', 'Logistics & communications', '⇄'],
  ['society', 'Government & society', '⚖'],
  ['advanced', 'Advanced systems', '✦'],
];
const CAT_OF = {
  agronomy: 'civ', schooling: 'civ', higher_education: 'civ', mechanized_agriculture: 'civ', climate_engineering: 'civ',
  salvage_engineering: 'industry', metallurgy: 'industry', electrification: 'industry', petroleum: 'industry', munitions_industry: 'industry', computing: 'industry', materials_recycling: 'industry', fusion_power: 'industry',
  surveying: 'infra', seafaring: 'infra', civil_engineering: 'infra', highways: 'infra', railways: 'infra',
  small_arms: 'military', fortification: 'military', field_artillery: 'military', mechanization: 'military', aviation: 'military', self_propelled_guns: 'military', air_defense: 'military', special_operations: 'military', precision_missiles: 'military',
  motorization: 'logistics', logistics: 'logistics', networked_command: 'logistics', drones: 'logistics',
  trade_networks: 'society', corporate_charter: 'society', federal_union: 'society',
  robotics: 'advanced', energy_shields: 'advanced', strike_swarms: 'advanced', exo_armor: 'advanced', continental_arcology: 'advanced',
};
export const techCategory = (k) => CAT_OF[k] || 'advanced';

const NODE_W = 168, NODE_H = 58, COL_W = 210, LANE_GAP = 18;

// Deterministic DAG layout: x by era then by depth inside the era; y by category lane, ordered
// by the mean position of prerequisites to keep links short.
export function layoutTechs(TECHS, AGES) {
  const keys = Object.keys(TECHS);
  const depth = {};
  const d = (k) => { if (depth[k] != null) return depth[k]; const t = TECHS[k]; let m = 0; for (const r of t.req) if (TECHS[r].age === t.age) m = Math.max(m, d(r) + 1); return (depth[k] = m); };
  keys.forEach(d);
  const colsPerAge = AGES.map((_, a) => 1 + Math.max(0, ...keys.filter((k) => TECHS[k].age === a).map((k) => depth[k])));
  const ageX = []; let x = 40; for (let a = 0; a < AGES.length; a++) { ageX.push(x); x += colsPerAge[a] * COL_W + 30; }
  const pos = {};
  for (const k of keys) pos[k] = { x: ageX[TECHS[k].age] + depth[k] * COL_W, y: 0 };
  // lanes
  let y = 70; const lanes = [];
  for (const [cat, name] of CATEGORIES) {
    const members = keys.filter((k) => techCategory(k) === cat);
    if (!members.length) continue;
    // per column, stack nodes; order by prerequisite barycentre (stable by key)
    const cols = new Map();
    for (const k of members) { const c = pos[k].x; if (!cols.has(c)) cols.set(c, []); cols.get(c).push(k); }
    const rows = Math.max(...[...cols.values()].map((a) => a.length));
    for (const [, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
      list.forEach((k, i) => { pos[k].y = y + i * (NODE_H + 10); });
    }
    lanes.push({ cat, name, y: y - 30, h: rows * (NODE_H + 10) + 30 });
    y += rows * (NODE_H + 10) + 30 + LANE_GAP;
    function bary(k) { const r = TECHS[k].req.filter((q) => pos[q] && pos[q].y); return r.length ? r.reduce((s, q) => s + pos[q].y, 0) / r.length : 0; }
  }
  return { pos, lanes, width: x + 40, height: y + 20, ageX, colsPerAge };
}

export class ResearchWorkspace {
  constructor(S, actions) {
    this.S = S; this.A = actions;
    this.sel = null; this.view = null; this.search = ''; this.filter = { cat: '', era: '', avail: '' };
    this.layout = null; this.dragging = null;
  }

  // what a technology unlocks, from the definitions
  unlocks(k) {
    const D = this.S.defs, out = [];
    for (const [id, b] of Object.entries(D.BUILDINGS)) if (b.tech === k) out.push(['building', b.name, id]);
    for (const [id, u] of Object.entries(D.UNITS)) if (u.tech === k) out.push(['unit', u.name, id]);
    for (const [id, p] of Object.entries(D.POLICIES)) if (p.tech === k) out.push(['policy', p.name, id]);
    for (const [id, g] of Object.entries(D.GOVS)) if (g.tech === k) out.push(['government', g.name, id]);
    for (const [id, r] of Object.entries(D.ROAD_TYPES || {})) if (r && r.tech === k) out.push(['road', r.name, id]);
    return out;
  }
  missing(k) {
    const D = this.S.defs, e = this.S.econ, out = [];
    const walk = (x) => { for (const r of D.TECHS[x].req) if (!e.techs.includes(r) && !out.includes(r)) { walk(r); out.push(r); } };
    walk(k); return out;
  }
  state(k) {
    const e = this.S.econ, t = this.S.defs.TECHS[k];
    if (e.techs.includes(k)) return 'done';
    if (e.research === k) return 'current';
    if (e.queue.includes(k)) return 'queued';
    if (t.age > e.age) return 'era';
    if (t.req.every((r) => e.techs.includes(r))) return 'available';
    return 'locked';
  }
  eta(k) {
    const e = this.S.econ, t = this.S.defs.TECHS[k];
    const left = t.cost - (e.techProgress?.[k] || (e.research === k ? e.progress : 0) || 0);
    return e.researchRate > 0 ? Math.ceil(left / e.researchRate) : null;
  }

  render(body) {
    const S = this.S, D = S.defs, e = S.econ;
    if (!this.layout) this.layout = layoutTechs(D.TECHS, D.AGES);
    if (!body.querySelector('.rw')) {
      body.innerHTML = `<div class="rw">
        <header class="rw-hd" id="rwHead"></header>
        <div class="rw-main">
          <div class="rw-graph" id="rwGraph" tabindex="0" aria-label="Technology graph: drag or scroll to move, Ctrl+wheel to zoom">
            <svg id="rwSvg" xmlns="http://www.w3.org/2000/svg"><g id="rwG"></g></svg>
            <div class="rw-tools"><button class="btn small" data-rw="fit" title="Fit the whole tree">Fit</button><button class="btn small" data-rw="center" title="Centre on current research">Current</button><button class="btn small" data-rw="zin" aria-label="Zoom in">+</button><button class="btn small" data-rw="zout" aria-label="Zoom out">−</button></div>
          </div>
          <aside class="rw-insp" id="rwInsp"></aside>
        </div>
        <footer class="rw-queue" id="rwQueue"></footer>
      </div>`;
      this.bind(body);
      this.drawStatic();
      requestAnimationFrame(() => { if (!this.view) this.home(); else this.applyView(); });
    }
    this.refresh();
  }

  // the graph structure (edges, lanes) is drawn once; node states are refreshed in place
  drawStatic() {
    const D = this.S.defs, L = this.layout, g = $('rwG');
    let h = '';
    for (const l of L.lanes) h += `<rect class="lane" x="0" y="${l.y}" width="${L.width}" height="${l.h}"/><text class="lane-t" x="12" y="${l.y + 18}">${esc(CATEGORIES.find((c) => c[0] === l.cat)[2] + ' ' + l.name)}</text>`;
    D.AGES.forEach((a, i) => { h += `<text class="era-t" x="${L.ageX[i]}" y="34">${esc(a.name)}</text><line class="era-l" x1="${L.ageX[i] - 16}" y1="44" x2="${L.ageX[i] - 16}" y2="${L.height}"/>`; });
    for (const [k, t] of Object.entries(D.TECHS)) for (const r of t.req) {
      const a = L.pos[r], b = L.pos[k];
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
      h += `<path class="edge" data-from="${r}" data-to="${k}" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
    }
    for (const [k, t] of Object.entries(D.TECHS)) {
      const p = L.pos[k];
      h += `<g class="node" data-tech="${k}" transform="translate(${p.x} ${p.y})" tabindex="0" role="button" aria-label="${esc(t.name)}">
        <rect class="nb" width="${NODE_W}" height="${NODE_H}" rx="4"/><rect class="nbar" width="4" height="${NODE_H}" rx="2"/>
        <text class="ic" x="12" y="22">${CATEGORIES.find((c) => c[0] === techCategory(k))[2]}</text>
        <text class="nm" x="30" y="22">${esc(t.name.length > 20 ? t.name.slice(0, 19) + '…' : t.name)}</text>
        <text class="st" x="30" y="42"></text><text class="qn" x="${NODE_W - 10}" y="22" text-anchor="end"></text>
        <rect class="pg-bg" x="30" y="48" width="${NODE_W - 42}" height="3"/><rect class="pg" x="30" y="48" width="0" height="3"/></g>`;
    }
    g.innerHTML = h;
    const svg = $('rwSvg'); svg.setAttribute('width', L.width); svg.setAttribute('height', L.height);
  }

  refresh() {
    const S = this.S, D = S.defs, e = S.econ; if (!e || !$('rwG')) return;
    const q = this.search.trim().toLowerCase();
    const hiPre = new Set(), hiPost = new Set();
    if (this.sel) {
      const up = (k) => { for (const r of D.TECHS[k].req) if (!hiPre.has(r)) { hiPre.add(r); up(r); } }; up(this.sel);
      const down = (k) => { for (const [x, t] of Object.entries(D.TECHS)) if (t.req.includes(k) && !hiPost.has(x)) { hiPost.add(x); down(x); } }; down(this.sel);
    }
    for (const n of document.querySelectorAll('#rwG .node')) {
      const k = n.dataset.tech, t = D.TECHS[k], st = this.state(k);
      n.setAttribute('class', `node ${st}${this.sel === k ? ' sel' : ''}${hiPre.has(k) ? ' pre' : ''}${hiPost.has(k) ? ' post' : ''}`);
      const match = (!q || t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q) || this.unlocks(k).some((u) => u[1].toLowerCase().includes(q)))
        && (!this.filter.cat || techCategory(k) === this.filter.cat) && (this.filter.era === '' || t.age === +this.filter.era)
        && (!this.filter.avail || (this.filter.avail === 'available' ? st === 'available' || st === 'current' : this.filter.avail === 'todo' ? st !== 'done' : st === this.filter.avail));
      n.classList.toggle('dim', !match);
      const prog = e.techProgress?.[k] || (e.research === k ? e.progress : 0) || 0;
      n.querySelector('.st').textContent = st === 'done' ? 'Researched' : st === 'era' ? `${D.AGES[t.age].name} era` : st === 'locked' ? `Needs ${t.req.filter((r) => !e.techs.includes(r)).map((r) => D.TECHS[r].name).join(', ')}`.slice(0, 26) : `${t.cost} research${prog ? ` · ${Math.floor((100 * prog) / t.cost)}%` : ''}`;
      const qi = e.queue.indexOf(k); n.querySelector('.qn').textContent = qi >= 0 ? `#${qi + 1}` : e.researchGoal === k ? '◎' : '';
      n.querySelector('.pg').setAttribute('width', String(Math.max(0, Math.min(1, prog / t.cost)) * (NODE_W - 42)));
    }
    for (const p of document.querySelectorAll('#rwG .edge')) p.setAttribute('class', `edge${this.sel && (hiPre.has(p.dataset.from) && (hiPre.has(p.dataset.to) || p.dataset.to === this.sel)) ? ' pre' : ''}${this.sel && (p.dataset.from === this.sel || hiPost.has(p.dataset.from)) && hiPost.has(p.dataset.to) ? ' post' : ''}${e.techs.includes(p.dataset.from) ? ' known' : ''}`);
    this.header(); this.inspector(); this.queue();
  }

  header() {
    const S = this.S, D = S.defs, e = S.econ;
    const cur = e.research ? D.TECHS[e.research] : null;
    const next = D.AGES[e.age + 1];
    const have = e.techs.filter((t) => D.TECHS[t].age === e.age).length;
    const eta = e.research ? this.eta(e.research) : null;
    const key = JSON.stringify([e.research, Math.floor(e.progress / 5), e.researchRate, e.age, have, e.advancing, this.search, this.filter]);
    if (key === this.hdKey) return; this.hdKey = key;
    $('rwHead').innerHTML = `<div class="rw-now"><h2>Research</h2><button class="btn small ${e.autoTech ? 'primary' : 'ghost'}" data-rw="auto" title="${e.autoTech ? 'Automatic: the next useful technology is picked whenever nothing is under research, and the next era is entered as soon as it qualifies. Your own picks always come first.' : 'Manual: you pick research and advance eras yourself'}">${e.autoTech ? 'Automatic research: on' : 'Automatic research: off'}</button><div><b>${cur ? esc(cur.name) : 'Nothing under research'}</b> <span class="muted">${e.researchRate.toFixed(1)}/s${eta != null ? ` · ${fmtT(eta)} left` : ''}</span></div>${cur ? `<div class="era-bar"><i style="width:${Math.min(100, (100 * e.progress) / cur.cost)}%"></i></div>` : ''}</div>
      <div class="rw-era">${next ? `<b>${esc(next.name)}</b> <span class="muted">${have}/${next.techsNeeded} ${esc(D.AGES[e.age].name)} technologies · ${Object.entries(next.cost).map(([k, v]) => `<span class="${(e.res[k] || 0) < v ? 'bad' : ''}">${v} <button type="button" class="rlink" data-res="${k}">${esc(D.GOOD_NAMES[k].toLowerCase())}</button></span>`).join(', ')}</span> ${e.advancing ? `<span class="warn">advancing ${e.advancing}s</span>` : `<button class="btn small primary" data-rw="advance" ${have < next.techsNeeded ? 'disabled' : ''}>Advance</button>`}` : '<b>Final era reached</b>'}</div>
      <div class="rw-filters"><input id="rwSearch" type="search" placeholder="Search technologies or unlocks…" value="${esc(this.search)}" aria-label="Search technologies">
        <select id="rwCat" aria-label="Category"><option value="">All categories</option>${CATEGORIES.map(([k, n]) => `<option value="${k}" ${this.filter.cat === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <select id="rwEra" aria-label="Era"><option value="">All eras</option>${D.AGES.map((a, i) => `<option value="${i}" ${this.filter.era === String(i) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        <select id="rwAvail" aria-label="Status"><option value="">Any status</option><option value="available" ${this.filter.avail === 'available' ? 'selected' : ''}>Available now</option><option value="todo" ${this.filter.avail === 'todo' ? 'selected' : ''}>Not researched</option><option value="done" ${this.filter.avail === 'done' ? 'selected' : ''}>Researched</option></select>
        <button class="btn small ghost" data-ws-close="1" aria-label="Close research">Close ✕</button></div>`;
    const s = $('rwSearch'); if (this.searchFocus) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }

  inspector() {
    const S = this.S, D = S.defs, e = S.econ, k = this.sel, el = $('rwInsp');
    if (!k) { const key = 'none'; if (this.inKey === key) return; this.inKey = key; el.innerHTML = '<p class="muted">Select a technology to see what it needs and what it unlocks. Selecting never starts research: use the buttons here.</p><p class="muted small">Drag or scroll to move around, Ctrl/Cmd+scroll or pinch to zoom, double-click a node to centre it.</p>'; return; }
    const t = D.TECHS[k], st = this.state(k), eta = this.eta(k), miss = this.missing(k), unl = this.unlocks(k);
    const prog = e.techProgress?.[k] || (e.research === k ? e.progress : 0) || 0;
    const key = JSON.stringify([k, st, Math.floor(prog / 5), e.queue, e.researchGoal, e.researchRate.toFixed(1), e.age]);
    if (this.inKey === key) return; this.inKey = key;
    const cum = (() => { let pts = 0; for (const x of [...miss, k]) pts += D.TECHS[x].cost - (e.techProgress?.[x] || 0); return e.researchRate > 0 ? Math.ceil(pts / e.researchRate) : null; })();
    el.innerHTML = `<h3>${esc(t.name)}</h3><div class="sub">${esc(D.AGES[t.age].name)} · ${esc(CATEGORIES.find((c) => c[0] === techCategory(k))[1])}</div>
      <p>${esc(t.desc)}</p>
      <dl class="kv"><dt>Cost</dt><dd>${t.cost} research${prog ? ` (${Math.floor(prog)} earned, kept if you switch)` : ''}</dd><dt>Time</dt><dd>${st === 'done' ? 'researched' : eta != null ? fmtT(eta) + ' at the current rate' : 'no research output'}</dd>
      ${miss.length ? `<dt>With prerequisites</dt><dd>${cum != null ? fmtT(cum) : '—'}</dd>` : ''}</dl>
      <h4>Prerequisites</h4>${t.req.length ? `<ul class="log">${t.req.map((r) => `<li class="${e.techs.includes(r) ? 'good' : 'warn'}" data-rwsel="${r}">${e.techs.includes(r) ? '✓' : '○'} ${esc(D.TECHS[r].name)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
      ${t.age > e.age ? `<p class="warn">Requires the ${esc(D.AGES[t.age].name)} era. Queue it as a goal: its prerequisites are researched now and it starts once the era is reached.</p>` : ''}
      <h4>Unlocks</h4>${unl.length ? `<ul class="log">${unl.map(([kind, name]) => `<li><span class="muted">${kind}</span> ${esc(name)}</li>`).join('')}</ul>` : '<p class="muted">Effects described above.</p>'}
      <div class="actions">${st === 'available' ? `<button class="btn primary" data-rw="now" data-k="${k}">Research now</button>` : ''}
        ${st !== 'done' && st !== 'current' && !e.queue.includes(k) ? `<button class="btn" data-rw="queue" data-k="${k}">${miss.length ? `Queue with ${miss.length} prerequisite${miss.length > 1 ? 's' : ''}` : 'Add to queue'}</button>` : ''}
        ${e.queue.includes(k) ? `<button class="btn" data-rw="front" data-k="${k}">Move to front</button><button class="btn ghost" data-rw="remove" data-k="${k}">Remove from queue</button>` : ''}
        ${st !== 'done' && e.researchGoal !== k ? `<button class="btn ghost" data-rw="goal" data-k="${k}" title="A long-term target: everything it needs is queued in order">Set as goal</button>` : ''}
        ${miss.length ? `<button class="btn ghost" data-rw="showpre" data-k="${k}">Show prerequisites</button>` : ''}</div>`;
  }

  queue() {
    const S = this.S, D = S.defs, e = S.econ;
    const key = JSON.stringify([e.queue, e.research, e.researchGoal, Math.floor(e.progress / 10), e.researchRate.toFixed(1), e.age, e.techs.length]);
    if (this.qKey === key) return; this.qKey = key;
    let tsum = e.research ? this.eta(e.research) || 0 : 0;
    const items = e.queue.map((k, i) => {
      const t = D.TECHS[k];
      const blocked = t.age > e.age ? `needs ${D.AGES[t.age].name} era` : t.req.filter((r) => !e.techs.includes(r) && r !== e.research && e.queue.indexOf(r) > i).length ? 'prerequisite later in queue' : '';
      const left = t.cost - (e.techProgress?.[k] || 0); tsum += e.researchRate > 0 ? left / e.researchRate : 0;
      return `<li class="${blocked ? 'blocked' : ''}" data-rwsel="${k}"><span class="n">${i + 1}</span><b>${esc(t.name)}</b><small>${blocked ? esc(blocked) : e.researchRate > 0 ? 'done in ' + fmtT(tsum) : ''}</small>
        <span class="qa"><button class="btn tiny ghost" data-rw="up" data-k="${k}" ${i ? '' : 'disabled'} aria-label="Earlier">↑</button><button class="btn tiny ghost" data-rw="down" data-k="${k}" ${i < e.queue.length - 1 ? '' : 'disabled'} aria-label="Later">↓</button><button class="btn tiny ghost" data-rw="remove" data-k="${k}" aria-label="Remove">✕</button></span></li>`;
    }).join('');
    $('rwQueue').innerHTML = `<div class="qh"><b>Queue</b>${e.research ? ` <span class="muted">now: ${esc(D.TECHS[e.research].name)}</span>` : ''}${e.researchGoal ? ` <span class="goal">goal: ${esc(D.TECHS[e.researchGoal].name)}</span>` : ''}${e.queue.length ? ` <button class="btn tiny ghost" data-rw="clear">Clear</button>` : ''}</div><ol class="ql">${items || '<li class="empty muted">Empty. Queue technologies from the inspector; research continues down the queue automatically.</li>'}</ol>`;
  }

  // ------------------------------------------------------------------ pan & zoom
  // the tree never drifts away: zoom stops where the whole height fits (or a legible minimum), and
  // panning keeps the tree on screen
  minZ() { const host = $('rwGraph'), L = this.layout; if (!host || !L) return 0.45; const r = host.getBoundingClientRect(); return Math.max(0.45, Math.min(1, r.height / L.height)); }
  clampView() {
    const v = this.view, host = $('rwGraph'), L = this.layout; if (!v || !host || !L) return;
    const r = host.getBoundingClientRect(), w = L.width * v.z, h = L.height * v.z, m = 40;
    v.x = w + 2 * m <= r.width ? (r.width - w) / 2 : Math.min(m, Math.max(r.width - w - m, v.x));
    v.y = h + 2 * m <= r.height ? Math.min(Math.max(4, v.y), r.height - h) : Math.min(m, Math.max(r.height - h - m, v.y));
  }
  applyView() { const v = this.view; if (!v) return; this.clampView(); $('rwG').setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.z})`); }
  fit() {
    const host = $('rwGraph'); if (!host) return; const L = this.layout;
    const r = host.getBoundingClientRect(); const z = Math.max(this.minZ(), Math.min(1, Math.min(r.width / L.width, r.height / L.height)));
    this.view = { x: (r.width - L.width * z) / 2, y: 4, z }; this.applyView();
  }
  // a readable starting view: the current era at the left edge, nodes at a legible size
  home() {
    const host = $('rwGraph'); if (!host) return; const L = this.layout, e = this.S.econ;
    const r = host.getBoundingClientRect();
    const z = Math.max(0.62, Math.min(1, r.height / L.height));
    const x0 = L.ageX[Math.max(0, (e?.age || 0))] - 40;
    this.view = { x: -x0 * z + 10, y: 4, z }; this.applyView();
  }
  focus(k) {
    const host = $('rwGraph'); if (!host || !k) return; const p = this.layout.pos[k]; const r = host.getBoundingClientRect();
    const z = Math.max(this.view?.z || 0.8, 0.8);
    this.view = { x: r.width / 2 - (p.x + NODE_W / 2) * z, y: r.height / 2 - (p.y + NODE_H / 2) * z, z }; this.applyView();
  }
  zoomAt(f, cx, cy) {
    const v = this.view; if (!v) return; const z = Math.max(this.minZ(), Math.min(2.2, v.z * f));
    v.x = cx - (cx - v.x) * (z / v.z); v.y = cy - (cy - v.y) * (z / v.z); v.z = z; this.applyView();
  }

  bind(body) {
    const graph = body.querySelector('#rwGraph');
    // the wheel scrolls the tree like a page (Shift: sideways); Ctrl/Cmd+wheel or a pinch zooms
    graph.addEventListener('wheel', (e) => {
      e.preventDefault(); const r = graph.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) { this.zoomAt(Math.exp(-e.deltaY * 0.004), e.clientX - r.left, e.clientY - r.top); return; }
      const v = this.view; if (!v) return;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      // a mostly vertical wheel over a wide, short tree pans sideways: there is little to scroll vertically
      const L = this.layout, tall = L.height * v.z > r.height;
      v.x -= tall ? dx : dx + dy; v.y -= tall ? dy : 0; this.applyView();
    }, { passive: false });
    // Panning: one pointer owns the gesture; text is never selected; a drag never selects a node.
    const end = (e, commit) => {
      const d = this.dragging; if (!d || (e && e.pointerId !== d.id)) return;
      this.dragging = null; graph.classList.remove('is-dragging');
      try { graph.releasePointerCapture(d.id); } catch { /* already released */ }
      if (commit && !d.moved) { const n = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node'); this.sel = n ? n.dataset.tech : null; this.refresh(); }
    };
    graph.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.rw-tools') || e.button > 0 || this.dragging) return;
      e.preventDefault();   // no native text selection or image drag
      window.getSelection?.()?.removeAllRanges();
      this.dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: this.view?.x || 0, vy: this.view?.y || 0, moved: false };
      graph.classList.add('is-dragging');
      try { graph.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
      graph.focus({ preventScroll: true });
    });
    graph.addEventListener('pointermove', (e) => {
      const d = this.dragging; if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y; if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved && this.view) { this.view.x = d.vx + dx; this.view.y = d.vy + dy; this.applyView(); }
    });
    graph.addEventListener('pointerup', (e) => end(e, true));
    graph.addEventListener('pointercancel', (e) => end(e, false));
    graph.addEventListener('lostpointercapture', (e) => { if (this.dragging && e.pointerId === this.dragging.id) end(e, false); });
    graph.addEventListener('selectstart', (e) => e.preventDefault());
    graph.addEventListener('dragstart', (e) => e.preventDefault());
    graph.addEventListener('dblclick', (e) => { const n = e.target.closest('.node'); if (n) this.focus(n.dataset.tech); });
    graph.addEventListener('keydown', (e) => { const n = e.target.closest?.('.node'); if (n && (e.key === 'Enter' || e.key === ' ')) { this.sel = n.dataset.tech; this.refresh(); e.preventDefault(); } });
    body.addEventListener('click', (e) => {
      const rl = e.target.closest('[data-res]'); if (rl) { this.A.openResource?.(rl.dataset.res); return; }
      const s = e.target.closest('[data-rwsel]'); if (s && !e.target.closest('[data-rw]')) { this.sel = s.dataset.rwsel; this.refresh(); this.focus(this.sel); return; }
      const b = e.target.closest('[data-rw]'); if (!b) return;
      const k = b.dataset.k, op = b.dataset.rw, e2 = this.S.econ;
      if (op === 'fit') this.fit();
      else if (op === 'center') this.focus(e2.research || e2.queue[0] || this.sel);
      else if (op === 'zin' || op === 'zout') { const r = $('rwGraph').getBoundingClientRect(); this.zoomAt(op === 'zin' ? 1.2 : 1 / 1.2, r.width / 2, r.height / 2); }
      else if (op === 'advance') this.A.cmd({ c: 'advance' });
      else if (op === 'auto') this.A.cmd({ c: 'autoTech', on: !e2.autoTech });
      else if (op === 'now') this.A.cmd({ c: 'research', tech: k });
      else if (op === 'queue') this.A.cmd({ c: 'researchQueue', op: 'add', tech: k });
      else if (op === 'goal') this.A.cmd({ c: 'researchQueue', op: 'goal', tech: k });
      else if (op === 'remove') this.A.cmd({ c: 'researchQueue', op: 'remove', tech: k });
      else if (op === 'front') this.A.cmd({ c: 'researchQueue', op: 'front', tech: k });
      else if (op === 'up' || op === 'down') { const i = e2.queue.indexOf(k); this.A.cmd({ c: 'researchQueue', op: 'move', tech: k, index: op === 'up' ? i - 1 : i + 1 }); }
      else if (op === 'clear') this.A.cmd({ c: 'researchQueue', op: 'clear' });
      else if (op === 'showpre') { this.filter = { cat: '', era: '', avail: '' }; this.search = ''; this.refresh(); this.fit(); }
    });
    body.addEventListener('input', (e) => { if (e.target.id === 'rwSearch') { this.search = e.target.value; this.searchFocus = true; this.hdKey = ''; this.refresh(); } });
    body.addEventListener('change', (e) => {
      if (e.target.id === 'rwCat') this.filter.cat = e.target.value; else if (e.target.id === 'rwEra') this.filter.era = e.target.value; else if (e.target.id === 'rwAvail') this.filter.avail = e.target.value; else return;
      this.hdKey = ''; this.refresh();
    });
    body.addEventListener('focusout', (e) => { if (e.target.id === 'rwSearch') this.searchFocus = false; });
  }
}
const fmtT = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);

// DOM HUD: resources & alerts, seismograph, selection & city management (incl. governors),
// build bar, road planner, and the drawer (tech graph, realm, empire overview, armies,
// diplomacy, chronicle + command history). The HUD only ever sends intents to the server.
import { findMatch } from './view.js';
import { ResearchWorkspace } from './research/ResearchWorkspace.js';
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
    // management workspaces open from the command rail; the map stays the primary surface
    this.ws = null; this.research = new ResearchWorkspace(S, actions); this.alertFilter = 'all'; this.toastGroups = new Map();
    $('rail').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ws],[data-rail]'); if (!b) return;
      if (b.dataset.rail) { this.A.pref('rail', document.body.classList.contains('rail-expanded') ? 'compact' : 'expanded'); return; }
      const w = b.dataset.ws;
      if (w === 'world') this.closeWorkspace();
      else if (w === 'build') this.toggleBuild();
      else if (this.ws === w) this.closeWorkspace(); else this.openWorkspace(w);
    });
    $('drawer').addEventListener('click', (e) => { if (e.target.closest('[data-ws-close]')) this.closeWorkspace(); });
    $('researchChip').addEventListener('click', () => (this.ws === 'research' ? this.closeWorkspace() : this.openWorkspace('research')));
    $('alertFilter').addEventListener('click', (e) => { const b = e.target.closest('[data-af]'); if (!b) return; this.alertFilter = b.dataset.af; for (const x of $('alertFilter').children) x.classList.toggle('on', x === b); this.renderAlerts(); });
    $('drawerBody').addEventListener('click', (e) => this.onDrawerClick(e));
    $('drawerBody').addEventListener('change', (e) => this.onDrawerChange(e));
    $('selection').addEventListener('click', (e) => this.onSelClick(e));
    $('selection').addEventListener('dblclick', (e) => { const c = e.target.closest('[data-card]'); if (c) this.A.selectType(c.dataset.card, !(e.ctrlKey || e.metaKey)); });
    $('selection').addEventListener('change', (e) => this.onSelChange(e));
    $('buildbar').addEventListener('click', (e) => { const b = e.target.closest('[data-build],[data-tool]'); if (b) this.A.buildMode(b.dataset.build || null, b.dataset.tool || null); });
    $('roadPanel').addEventListener('click', (e) => this.onRoadClick(e));
    $('specbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-follow],[data-speed],[data-fog]'); if (!b) return;
      if (b.dataset.follow) this.A.follow(+b.dataset.follow);
      else if (b.dataset.speed) this.A.speed(+b.dataset.speed);
      else if (b.dataset.fog) this.A.fog(b.dataset.fog === '1');
    });
    $('roadPanel').addEventListener('change', (e) => { if (e.target.id === 'roadType') this.A.roadType(+e.target.value); if (e.target.id === 'roadAuto') this.A.roadAuto(e.target.checked); });
    $('alertsBtn').addEventListener('click', () => { const a = $('alerts'); a.hidden = !a.hidden; this.unseen = { critical: 0, major: 0 }; this.alertBadges(); this.renderAlerts(); });
    $('alertsClear').addEventListener('click', () => { this.alerts = []; this.renderAlerts(); });
    $('alertList').addEventListener('click', (e) => { const li = e.target.closest('[data-jump]'); if (li) this.A.jump(+li.dataset.jump); });
    this.drawerKey = '';
    $('btnKey').addEventListener('click', () => this.toggleKey());
    $('battle').addEventListener('click', (e) => { const b = e.target.closest('[data-battle]'); if (b) this.A.battle(b.dataset.battle, this.battleId); });
  }

  // ------------------------------------------------------------ combat sandbox
  sandboxPanel() {
    const S = this.S, D = S.defs, el = $('sandbox');
    if (!S.sandbox) { el.hidden = true; return; }
    el.hidden = false;
    if (el.innerHTML) return;
    const sc = [['rifles', '10 v 10 rifle squads'], ['mixed', '20 mixed vs 12 defenders'], ['armor', 'Tanks vs fortified position'], ['artillery', 'Artillery bombardment'], ['large', '30 v 30 combined arms']];
    const types = Object.entries(D.UNITS).filter(([, u]) => !u.civilian || u.supplyRadius).map(([k, u]) => `<option value="${k}">${esc(u.name)}</option>`).join('');
    el.innerHTML = `<div class="hd"><b>Combat sandbox</b><button class="btn small ghost" data-sb="toggle" title="Show or hide the sandbox tools">▾</button></div><p class="muted">Stage a battle, then command your side. The enemy fights back but does not plan.</p>
      <div class="sbsc">${sc.map(([k, n]) => `<button class="btn small" data-sb="scenario" data-key="${k}">${esc(n)}</button>`).join('')}</div>
      <h4>Spawn</h4><div class="actions"><select id="sbCiv"><option value="0">Your side</option><option value="1">Enemy</option></select><select id="sbType">${types}</select><input id="sbN" type="number" min="1" max="30" value="5" style="width:52px"></div>
      <div class="actions"><button class="btn small primary" data-sb="spawn">Place (click map)</button><button class="btn small" data-sb="advance">Enemy attacks…</button><button class="btn small ghost" data-sb="clear">Clear forces</button></div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sb]'); if (!b) return;
      if (b.dataset.sb === 'toggle') { el.classList.toggle('min'); b.textContent = el.classList.contains('min') ? '▸' : '▾'; return; }
      if (b.dataset.sb === 'scenario') { this.A.sandbox('scenario', b.dataset.key); el.classList.add('min'); el.querySelector('[data-sb=toggle]').textContent = '▸'; }
      else if (b.dataset.sb === 'spawn') this.A.sandbox('spawn', { civ: +$('sbCiv').value, type: $('sbType').value, n: +$('sbN').value || 1 });
      else this.A.sandbox(b.dataset.sb);
    });
  }

  // ------------------------------------------------------------ battle summary
  battlePanel() {
    const S = this.S, D = S.defs, el = $('battle');
    const b = (S.battles || []).find((x) => x.id === this.battleId);
    if (!b) { el.hidden = true; if (this.battleId != null && !(S.battles || []).length) this.battleId = null; return; }
    el.hidden = false;
    const foeStr = b.foes.reduce((s2, f) => s2 + f.str, 0), total = Math.max(1, foeStr + b.myStr), mine = b.mine;
    const m = Math.floor(b.age / 60), sec = b.age % 60;
    let h = `<div class="hd"><b>${esc(b.name)}</b><button class="btn small ghost" data-battle="close">Close</button></div>`;
    h += `<div class="muted">Fighting for ${m}:${String(sec).padStart(2, '0')} · intensity ${b.heat > 30 ? 'heavy' : b.heat > 10 ? 'sustained' : 'light'}</div>`;
    h += `<div class="balance" title="Estimated strength in the area (enemy only as far as you can see)"><i style="width:${Math.round((100 * b.myStr) / total)}%; background:${cssColor(S.civColor(S.civId))}"></i></div>`;
    if (mine.n) h += `<dl class="kv"><dt>Your units</dt><dd>${mine.n} (${mine.engaged} engaging${mine.suppressed ? `, ${mine.suppressed} suppressed` : ''}${mine.retreating ? `, ${mine.retreating} falling back` : ''})</dd><dt>Your losses</dt><dd>${mine.lost}</dd><dt>Supply</dt><dd class="${mine.sup < 40 ? 'bad' : mine.sup < 65 ? 'warn' : ''}">${mine.sup ?? '–'}%${mine.lowSup ? ` · ${mine.lowSup} running low` : ''}</dd><dt>Reinforcements</dt><dd>${mine.inbound ? `${mine.inbound} on the way` : 'none moving here'}</dd></dl>`;
    if (mine.n) { const r = foeStr ? b.myStr / foeStr : null; h += `<p class="${r == null ? 'muted' : r > 1.5 ? 'good' : r < 0.7 ? 'bad' : 'warn'}">${r == null ? 'No enemy in sight.' : r > 1.5 ? 'Favourable' : r < 0.7 ? 'Unfavourable' : 'Contested'}${r != null ? ` — about ${r.toFixed(1)}:1 against what you can see. Enemy forces beyond your sight are unknown.` : ''}</p>`; }
    for (const f of b.foes) h += `<div class="civrow"><span class="swatch" style="background:${cssColor(S.civColor(f.civ))}"></span><b>${esc(S.civInfo[f.civ]?.name || 'Unknown')}</b> <span class="muted">${f.n} seen${f.lost != null ? ` · ${f.lost} lost` : ''}</span></div>`;
    if (!b.foes.length) h += `<p class="muted">No enemy forces in sight.</p>`;
    h += `<div class="actions"><button class="btn small" data-battle="jump">Go to</button>${mine.n ? '<button class="btn small" data-battle="select">Select my units here</button>' : ''}<button class="btn small primary" data-battle="reinforce" title="Send the current selection to this battle">Reinforce</button>${mine.n ? '<button class="btn small" data-battle="hold">Hold</button><button class="btn small ghost" data-battle="withdraw">Withdraw</button>' : ''}<button class="btn small ghost" data-battle="command">Military command</button></div>`;
    void D;
    if (h !== this.battleHtml) { this.battleHtml = h; el.innerHTML = h; }
  }

  // ------------------------------------------------------------ map key
  toggleKey(force) {
    const el = $('mapkey'); el.hidden = force != null ? !force : !el.hidden;
    if (el.hidden || el.innerHTML) return;
    const ic = (bg, path, fg = '#1b1405') => `<svg viewBox="-5 -5 10 10" width="20" height="20" aria-hidden="true"><circle r="4.6" fill="${bg}" stroke="#0b1518" stroke-width="0.8"/><g fill="${fg}" stroke="${fg}">${path}</g></svg>`;
    const rows = [
      [ic('#b5432f', '<path d="M0 -3.2 L2.2 0 L1.4 2.6 L-1.4 2.6 L-2.2 0 L-0.6 -1 Z" stroke="none"/>', '#fff'), 'On fire', 'Engineers nearby fight fires; it spreads damage until out.'],
      [ic('#6a2a1e', '<path d="M-2.6 -2.6 L-0.4 -0.4 L-1.4 0.8 L2.6 2.8" fill="none" stroke-width="1.1"/>', '#ffd9cf'), 'Damaged', 'Half output until repaired (Repair, engineers or a governor).'],
      [ic('#f1c75b', '<path d="M-2.2 -2.8 L2.2 -2.8 L0 0 Z M-2.2 2.8 L2.2 2.8 L0 0 Z" stroke="none"/>'), 'Awaiting funds', 'Planned: shown as a gold outline; construction starts when affordable.'],
      [ic('#f0b54a', '<circle cy="-1.6" r="1.1" stroke="none"/><rect x="-1.7" y="-0.2" width="3.4" height="2.8" rx="1" stroke="none"/><path d="M-2.8 2.8 L2.8 -2.8" stroke="#b5432f" stroke-width="0.9"/>'), 'No workers', 'The city has no one to staff it: grow population or build fewer job sites.'],
      [ic('#f0b54a', '<rect x="-2.4" y="-2.4" width="4.8" height="4.8" fill="none" stroke-width="0.9"/><path d="M-2.4 -2.4 L2.4 2.4 M2.4 -2.4 L-2.4 2.4" stroke-width="0.7"/>'), 'Missing input', 'Short of ore, steel or another input; close up it names the good.'],
      [ic('#f0d84a', '<path d="M0.8 -3.2 L-2 0.4 L-0.2 0.4 L-0.8 3.2 L2 -0.6 L0.2 -0.6 Z" stroke="none"/>'), 'No power', 'Brownout: generation is below demand.'],
      [ic('#24533c', '<path d="M-2.6 -0.6 L0 -2.8 L2.6 -0.6 M-2.6 2.2 L0 0 L2.6 2.2" fill="none" stroke-width="1"/>', '#e9fbef'), 'Training', 'The green ring around the building fills as the unit nears completion.'],
    ];
    let h = `<div class="hd"><b>Map key</b><button class="btn small ghost" data-close="1" aria-label="Close">Close</button></div>`;
    h += `<ul class="key">${rows.map(([i, n, d]) => `<li>${i}<span><b>${n}</b><small>${d}</small></span></li>`).join('')}</ul>`;
    h += `<ul class="key text">
      <li><span class="sw banner">★ City 12</span><span><small>City banner: ★ capital, population. A red strip underneath lists famine, cut off, unrest or heavy damage; green shows its governor's plan.</small></span></li>
      <li><span class="sw flag">⚑ 1st Army · 6 · STAGING</span><span><small>Army standard over each army: name, units, what it is doing.</small></span></li>
      <li><span class="sw bar"></span><span><small>Gold bar under a site: construction progress (scaffolding and crews show the work).</small></span></li>
      <li><span class="sw battle">✕ Battle</span><span><small>Battle marker (zoomed out): click for forces, losses and relative strength; reinforce, hold or withdraw from there.</small></span></li>
      <li><span class="sw fire">- - ▸ ◯</span><span><small>Selected units' fire: one dashed arrow per target, thicker with more shooters. A ring is a spread attack; red brackets are focus fire. Red chevrons on a unit show incoming fire and where it comes from.</small></span></li>
      <li><span class="sw supp">▬▬▬</span><span><small>Amber bars under a unit: suppression. Three bars: pinned down, crawling for cover.</small></span></li>
      <li><span class="sw crater"></span><span><small>Craters slow vehicles and give infantry cover; wrecks narrow the way until engineers clear them; dense smoke hides what is inside it.</small></span></li>
      <li><span class="sw outline"></span><span><small>Each building's base is edged in its owner's colour. Buildings change material with the era: timber, brick, concrete, glass, composites.</small></span></li>
    </ul>`;
    el.innerHTML = h;
    el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) this.toggleKey(false); });
  }

  // ------------------------------------------------------------ top bar
  topbar() {
    const S = this.S, e = S.econ; if (!e) return;
    const me = S.civInfo[S.civId], D = S.defs;
    $('civName').textContent = me ? me.name : '';
    $('civName').style.color = cssColor(S.civColor(S.civId));
    $('ageName').textContent = D.AGES[e.age].name + (e.advancing ? ` → advancing (${e.advancing}s)` : '');
    // condensed: amount and trend; the detail lives in the tooltip and the Economy workspace
    const items = D.GOODS.filter((k) => k === 'food' || k === 'materials' || k === 'credits' || (e.res[k] || 0) > 0 || (e.rates[k] || 0) !== 0).map((k) => {
      const r = e.rates[k] || 0, v = e.res[k] || 0;
      const tr = Math.abs(r) < 0.05 ? ['flat', '▸'] : r > 0 ? ['up', '▲'] : ['down', '▼'];
      const endure = r < -0.05 ? ` — runs out in ${Math.round(v / -r / 60)} min` : '';
      return `<li class="${r < -0.05 && v / -r < 180 ? 'short' : ''}" title="${esc(D.GOOD_NAMES[k])}: ${fmt(v)}${k !== 'credits' ? ` of ${e.storage}` : ''}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}/s${endure}. Details: Economy."><span class="k">${esc(D.GOOD_NAMES[k])}</span><b>${fmt(v)}</b><span class="tr ${tr[0]}">${tr[1]}</span></li>`;
    });
    if (e.power && (e.power.gen || e.power.use)) items.push(`<li title="Power grid: generation / demand" class="${e.power.gen < e.power.use ? 'short' : ''}"><span class="k">Power</span><b>${e.power.gen}/${e.power.use}</b></li>`);
    items.push(`<li title="Soldiers represented by your units${e.command ? `; command: ${e.command.organised} organised, ${e.command.loose} loose of ${e.command.cap} capacity` : ''}"><span class="k">Forces</span><b>${fmt(e.men || 0)}</b></li>`);
    const html = items.join(''); if (html !== this.resHtml) { this.resHtml = html; $('resources').innerHTML = html; }
    // research chip
    const cur = e.research ? D.TECHS[e.research] : null;
    $('rcName').textContent = cur ? cur.name : 'No research — choose one';
    $('rcBar').style.width = cur ? `${Math.min(100, (100 * e.progress) / cur.cost)}%` : '0';
    $('rcEta').textContent = cur && e.researchRate > 0 ? `${Math.ceil((cur.cost - e.progress) / e.researchRate)}s · ${e.queue.length} queued` : e.queue.length ? `${e.queue.length} queued` : '';
    $('researchChip').classList.toggle('idle', !cur);
    if (this.ws === 'research') this.research.refresh();
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
  // Toasts: repeated messages group into one with a count; during battles minor news is held back;
  // the notification preference filters what interrupts at all.
  toast(m) {
    const pref = this.A.prefs?.().notify || 'normal';
    const lvl = m.level || 'minor';
    if (pref === 'quiet' && lvl !== 'critical' && m.kind !== 'error') return;
    if (pref === 'normal' && lvl === 'info' && m.kind !== 'error' && m.kind !== 'build') return;
    if (lvl === 'minor' && m.kind !== 'error' && this.A.inBattle?.() && pref !== 'verbose') return;
    const key = (m.kind || '') + '|' + String(m.text).replace(/\d+/g, '#');
    const g = this.toastGroups.get(key);
    if (g && g.el.isConnected) {
      g.n++; g.el.querySelector('.count').textContent = `×${g.n}`; g.el.querySelector('.tt').textContent = m.text;
      clearTimeout(g.timer); g.timer = setTimeout(() => g.el.remove(), 6500); return;
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (m.kind || '') + ' lv-' + lvl;
    el.innerHTML = `<span class="tt"></span><span class="count"></span>`; el.querySelector('.tt').textContent = m.text;
    el.addEventListener('click', () => this.openAlertTarget(m));
    const box = $('toasts'); box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    const timer = setTimeout(() => el.remove(), lvl === 'critical' ? 15000 : m.kind === 'warning' || m.kind === 'proposal' ? 12000 : 6500);
    this.toastGroups.set(key, { el, n: 1, timer });
  }
  // clicking an alert opens what it is about
  openAlertTarget(m) {
    if (m.kind === 'proposal' || m.kind === 'diplo') return this.openWorkspace('diplomacy');
    if (m.kind === 'tech' || m.kind === 'age') return this.openWorkspace('research');
    if (m.kind === 'famine' || m.kind === 'shortage') { if (m.tile >= 0) this.A.jump(m.tile); return this.openWorkspace('economy'); }
    if (m.tile >= 0) this.A.jump(m.tile);
  }
  // critical: survival / essential activity; actionable: something the player can fix; info: news
  alertCategory(m) {
    if (m.level === 'critical' || ['fall', 'famine', 'war'].includes(m.kind)) return 'critical';
    if (['warning', 'blocked', 'shortage', 'error', 'proposal', 'loss', 'unrest'].includes(m.kind) || m.level === 'major') return 'actionable';
    return 'info';
  }
  alert(m) {
    if (m.level === 'info' || m.quiet) return;
    // the same alert again within a short time updates the existing entry instead of stacking
    const prev = this.alerts[0];
    if (prev && prev.kind === m.kind && String(prev.text).replace(/\d+/g, '#') === String(m.text).replace(/\d+/g, '#') && m.time - prev.time < 30) { prev.n = (prev.n || 1) + 1; prev.text = m.text; prev.time = m.time; if (!$('alerts').hidden) this.renderAlerts(); return; }
    this.alerts.unshift(m); if (this.alerts.length > 80) this.alerts.length = 80;
    if (m.level === 'critical' || m.level === 'major') this.unseen[m.level]++;
    this.alertBadges(); if (!$('alerts').hidden) this.renderAlerts();
  }
  alertBadges() { for (const [id, k] of [['alC', 'critical'], ['alM', 'major']]) { const el = $(id); el.textContent = this.unseen[k]; el.classList.toggle('on', this.unseen[k] > 0); } }
  renderAlerts() { const list = this.alerts.filter((m) => this.alertFilter === 'all' || this.alertCategory(m) === this.alertFilter); $('alertList').innerHTML = list.map((m) => `<li class="lv-${m.level} cat-${this.alertCategory(m)}" ${m.tile >= 0 ? `data-jump="${m.tile}"` : ''}><time>${Math.floor(m.time / 60)}:${String(m.time % 60).padStart(2, '0')}</time>${esc(m.text)}${m.n > 1 ? ` <span class="muted">×${m.n}</span>` : ''}</li>`).join('') || '<li class="lv-info">No alerts.</li>'; }

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
    if (S.find) for (const b of S.buildings.values()) if (b.o === S.civId && findMatch(S, b.ty, S.find)) { const q = b.t % W, r = (b.t / W) | 0; c.fillStyle = '#f1c75b'; c.strokeStyle = '#0b1518'; c.beginPath(); c.arc((q + 0.5 * (r & 1)) * sx, r * sy, 3.2, 0, 7); c.fill(); c.stroke(); }
    for (const city of S.cities.values()) { c.fillStyle = cssColor(S.civColor(city.o)); c.strokeStyle = '#f3eedf'; const q = city.t % W, r = (city.t / W) | 0; c.fillRect((q + 0.5 * (r & 1)) * sx - 3, r * sy - 3, 6, 6); c.strokeRect((q + 0.5 * (r & 1)) * sx - 3, r * sy - 3, 6, 6); }
    const v = view; const [x0, y0] = v.screenToWorld(0, 0); const [x1, y1] = v.screenToWorld(v.app.screen.width, v.app.screen.height);
    const kx = MW / v.pw, ky = MH / v.ph;
    c.strokeStyle = '#f1c75b'; c.lineWidth = 1;
    if (v.wrap) {
      // the viewport wraps around the cylinder: draw it on both sides of the seam
      const P = v.P * kx, ax = (((x0 * kx) % P) + P) % P, w2 = (x1 - x0) * kx;
      c.strokeRect(ax, y0 * ky, w2, (y1 - y0) * ky); if (ax + w2 > MW) c.strokeRect(ax - P, y0 * ky, w2, (y1 - y0) * ky);
    } else c.strokeRect(x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky);
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

  // ------------------------------------------------------------ spectator bar
  specbar() {
    const S = this.S, el = $('specbar');
    if (!S.spectator) { el.hidden = true; return; }
    el.hidden = false;
    const D = S.defs, o = S.obs || { speed: 1, fog: false };
    const civs = S.civInfo.filter((c) => !c.rebel);
    let h = `<div class="spec-label"><span class="live-dot ${o.speed ? '' : 'paused'}"></span><b>Spectating</b><small>${o.fog ? 'fog: as ' + esc(S.civInfo[S.civId]?.name || '') : 'no fog of war'}</small></div>`;
    h += `<div class="spec-civs" role="group" aria-label="Follow an empire">${civs.map((c) => {
      const sm = c.summary || {};
      const dead = c.alive === false;
      return `<button class="civchip${c.id === S.civId ? ' on' : ''}${dead ? ' dead' : ''}" data-follow="${c.id}" title="Follow ${esc(c.name)}: see its economy, research and cities in the panels">`
        + `<span class="swatch" style="background:${cssColor(c.color)}"></span><span class="nm">${esc(c.name)}</span>`
        + `<small>${dead ? 'fallen' : `${sm.cities ?? '?'} ${sm.cities === 1 ? 'city' : 'cities'} · ${sm.pop ?? '?'} pop · era ${(c.age ?? 0) + 1}`}</small></button>`;
    }).join('')}</div>`;
    h += `<div class="seg spec-speed" role="group" aria-label="Match speed">${[[0, 'Pause'], [1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']].map(([v, n]) => `<button class="${o.speed === v ? 'on' : ''}" data-speed="${v}" title="${v ? `Run at ${v}× speed` : 'Pause the match'} (P pause, , and . step)">${n}</button>`).join('')}</div>`;
    h += `<div class="seg spec-fog" role="group" aria-label="Fog of war"><button class="${o.fog ? '' : 'on'}" data-fog="0" title="Reveal the whole continent (V toggles)">No fog</button><button class="${o.fog ? 'on' : ''}" data-fog="1" title="See only what the followed empire sees (V toggles)">Their fog</button></div>`;
    if (h !== this.specHtml) { this.specHtml = h; el.innerHTML = h; }
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
    // keep the multi-selection consistent with code that sets a single building
    if (S.selBuildings) { if (S.selBuilding == null || !S.buildings.has(S.selBuilding)) S.selBuildings.clear(); else if (!S.selBuildings.has(S.selBuilding)) { S.selBuildings.clear(); S.selBuildings.add(S.selBuilding); } for (const id of [...S.selBuildings]) if (!S.buildings.has(id)) S.selBuildings.delete(id); }
    const units = [...S.selUnits].map((id) => S.units.get(id)).filter(Boolean);
    if (units.length) {
      const own = units[0].owner === S.civId || S.spectator;   // spectators inspect everything
      const types = new Map(); for (const u of units) types.set(u.type, (types.get(u.type) || 0) + 1);
      const avg = (f) => Math.round(units.reduce((s, u) => s + u[f], 0) / units.length);
      const first = D.UNITS[units[0].type];
      const men = units.reduce((s, u) => s + (D.UNITS[u.type].men || 0), 0);
      const big = own && units.length >= 10;
      html += `<h3>${big ? 'Task force' : units.length > 1 ? `${units.length} units selected` : esc(first.name)}</h3>`;
      html += `<div class="sub">${own ? `${units.length} unit${units.length > 1 ? 's' : ''} · ${men} soldiers represented` : esc(S.civInfo[units[0].owner]?.name || '')}</div>`;
      if (big) {
        // composition at a glance instead of a long list of cards
        const comp = { Infantry: 0, Armour: 0, Artillery: 0, Air: 0, Support: 0 };
        for (const u of units) { const d = D.UNITS[u.type]; comp[d.air ? 'Air' : d.cat === 'artillery' ? 'Artillery' : d.civilian || d.cat === 'support' ? 'Support' : d.move === 'infantry' ? 'Infantry' : 'Armour']++; }
        html += `<div class="comp">${Object.entries(comp).filter(([, n]) => n).map(([k, n]) => `<div><b>${n}</b><span>${k}</span></div>`).join('')}</div>`;
      } else if (own) html += `<div class="cards">${[...types].map(([t, n]) => `<span class="ucard" data-card="${t}" title="Click: keep only these. Double-click: every ${esc(D.UNITS[t].name)} on screen (Ctrl/Cmd: whole map)"><b>${n}×</b>${esc(D.UNITS[t].name)}</span>`).join('')}</div>`;
      if (own && D.COMBAT_STATUS) {
        // what the group is doing, from the server's combat state
        const st = {}; for (const u of units) if (!D.UNITS[u.type].civilian) { const k = u.cstat || 0; st[k] = (st[k] || 0) + 1; }
        const tone = { 2: 'good', 4: 'bad', 10: 'bad', 9: 'warn', 5: 'warn', 6: 'warn', 8: 'warn' };
        const chips = Object.entries(st).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="tag ${tone[k] || ''}" title="${esc(D.COMBAT_STATUS[k])}">${esc(D.COMBAT_STATUS[k])} ${n}</span>`).join('');
        if (chips) html += `<div class="cstat">${chips}</div>`;
        const mor = Math.round(units.reduce((s2, u) => s2 + (u.morale ?? 100), 0) / units.length), sup = Math.round(units.reduce((s2, u) => s2 + (u.supp || 0), 0) / units.length);
        if (mor < 70 || sup > 15) html += `<div class="${mor < 35 ? 'bad' : 'warn'}">Morale ${mor}%${sup > 15 ? ` · suppression ${sup}%` : ''}${mor < 35 ? ' — units not under your direct orders may fall back' : ''}</div>`;
      }
      html += `<div>Strength ${avg('hp')}%</div><div class="bar hp"><i style="width:${avg('hp')}%"></i></div>`;
      if (own) {
        const outs = units.filter((u) => u.flags & 4).length, waiting = units.filter((u) => u.flags & 8).length, blocked = units.filter((u) => u.flags & 16).length;
        html += `<div>Supply ${avg('sup')}%</div><div class="bar sup"><i style="width:${avg('sup')}%"></i></div>`;
        if (outs) html += `<div class="bad">${outs} out of supply: weakening. Bring them within range of a city, depot, port, fortress or supply truck${units.some((u) => D.UNITS[u.type].air) ? ' (aircraft need an airfield)' : ''}.</div>`;
        if (waiting) html += `<div class="warn">${waiting} waiting for a congested road or bridge.</div>`;
        if (blocked) html += `<div class="bad">${blocked} cannot reach their destination: the route is blocked.</div>`;
        // veterancy: experienced units are worth keeping (and refitting rather than replacing)
        const vets = units.filter((u) => u.vet > 0);
        if (vets.length) html += `<div class="muted">${D.VET_NAMES.slice(1).map((n, i) => [n, vets.filter((u) => u.vet === i + 1).length]).filter(([, k]) => k).map(([n, k]) => `${k} ${n.toLowerCase()}`).join(', ')} — +${10 * Math.max(...vets.map((u) => u.vet))}% attack</div>`;
        const inRefit = units.filter((u) => u.refit > 0).length;
        if (inRefit) html += `<div class="warn">${inRefit} in the workshop being refitted.</div>`;
        if (!S.spectator) html += this.refitPanel(units);
        if (units.length === 1) html += `<dl class="kv"><dt>Attack / Defense</dt><dd>${first.atk} / ${first.def}</dd><dt>Range / Speed</dt><dd>${first.range} / ${first.speed}</dd><dt>Movement</dt><dd>${esc(first.move)}${first.aa ? `, anti-air ×${first.aa}` : ''}</dd></dl>`;
        const stance = units.find((u) => u.stance)?.stance || 'defensive';
        html += `<div class="actions"><select data-sel="stance" title="Stance">${Object.entries(D.STANCES).map(([k, n]) => `<option value="${k}" ${k === stance ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><select data-sel="formation" title="Formation for the next order">${Object.entries(D.FORMATIONS).map(([k, n]) => `<option value="${k}" ${k === S.formation ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`;
        if (units.length >= 3) {
          html += `<div class="gcmds">${[['amove', 'Advance', 'Attack-move: advance and engage on the way (A)'], ['engageMode', 'Engage', 'Click an enemy: fire is spread over nearby threats (right-click)'], ['focusMode', 'Focus fire', 'Click an enemy: every weapon on one target (Ctrl+right-click)'], ['defendMode', 'Defend', 'Hold a zone as an army'], ['withdraw', 'Withdraw', 'Fall back to the nearest friendly city, firing only in passing (X)'], ['moveMode', 'Reposition', 'Move without engaging (right-drag for a battle line)'], ['hold', 'Hold', 'Stop and hold this ground (H)']].map(([a, n, t]) => `<button class="btn small${a === 'withdraw' ? ' ghost' : ''}" data-act="${a}" title="${t}">${n}</button>`).join('')}</div>`;
          html += `<div class="actions"><label class="field inline"><span>Engagement</span><select data-sel="policy">${Object.entries(D.ENGAGE_POLICIES).map(([k, n]) => `<option value="${k}" ${S.policy === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>`;
        }
        html += `<div class="actions"><button class="btn small" data-act="stop">Stop (S)</button>${units.length < 3 ? '<button class="btn small" data-act="amove">Attack-move (A)</button><button class="btn small" data-act="hold">Hold (H)</button><button class="btn small ghost" data-act="withdraw">Withdraw (X)</button>' : ''}<button class="btn small" data-act="army">Form army (G)</button>`;
        if (units.some((u) => u.type === 'colonist')) html += `<button class="btn small primary" data-act="found">Found city (F)</button><button class="btn small" data-act="autoSettle">Auto-settle</button>`;
        html += `</div>`;
        if (units.some((u) => D.UNITS[u.type].engineer)) html += `<p class="muted">Idle engineers repair roads and buildings, fight fires and clear rubble next to them, and speed up nearby construction.</p>`;
        html += this.formationHtml(units);
      }
    } else if (S.selBuildings && S.selBuildings.size > 1) {
      html += this.multiBuildingPanel([...S.selBuildings].map((id) => S.buildings.get(id)).filter(Boolean));
    } else if (S.selBuilding != null && S.buildings.has(S.selBuilding)) {
      const b = S.buildings.get(S.selBuilding), d = D.BUILDINGS[b.ty];
      const own = b.o === S.civId || S.spectator;
      const city = b.ty === 'town' ? S.cityAt.get(b.t) : null;
      html += `<h3>${esc(city ? city.n : d.name)}</h3><div class="sub">${esc(city ? d.name + (city.cap ? ' (capital)' : '') : '')}${b.o === S.civId && !S.spectator ? '' : (city ? ' · ' : '') + esc(S.civInfo[b.o]?.name || '')}</div>`;
      if (S.spectator && b.o !== S.civId && S.civInfo[b.o] && !S.civInfo[b.o].rebel) html += `<div class="actions spec-ok"><button class="btn small" data-follow-civ="${b.o}">Follow ${esc(S.civInfo[b.o].name)}</button></div>`;
      if (city && own) {
        const props = city.gov?.proposals?.length || 0;
        html += `<div class="subtabs">${['overview', 'workforce', 'governor', 'storage'].map((t) => `<button class="${this.cityTab === t ? 'on' : ''}" data-ctab="${t}">${{ overview: 'Overview', workforce: 'Workforce', governor: 'Governor' + (props ? ` (${props})` : ''), storage: 'Stockpile' }[t]}</button>`).join('')}</div>`;
        if (this.cityTab === 'governor') html += this.governorPanel(city);
        else if (this.cityTab === 'workforce') html += this.workforcePanel(city);
        else if (this.cityTab === 'storage') html += this.storagePanel(city);
        else html += this.cityOverview(city, b, d);
      } else {
        html += this.buildingPanel(b, d, own, city);
      }
    }
    // nothing selected: the inspector gets out of the way of the map
    el.classList.toggle('empty', !html);
    if (html !== this.selHtml) { this.selHtml = html; patchHtml(el, html); }
  }

  // formation membership, deployment, fortification and stacks for the selected units
  formationHtml(units) {
    const S = this.S, D = S.defs, e = S.econ; let h = '';
    const fids = new Set(units.map((u) => u.form).filter(Boolean));
    const fs = (e?.formations || []).filter((f) => fids.has(f.id));
    if (fs.length === 1) {
      const f = fs[0], det = units.filter((u) => u.det).length;
      h += `<div class="formation"><b>${esc({ line: 'Line', compact: 'Compact line', depth: 'Defense in depth', preserve: 'Formation' }[f.mode] || 'Formation')}</b> <span class="muted">${f.units.length} units · ${esc(f.status)}${f.fortify ? ' · dug in' : ''}</span>
        <div class="seg">${[['hold', 'Hold line', 'Stay in place and fire at what is in range'], ['defend', 'Defend line', 'Engage nearby threats, then return'], ['attackMove', 'Advance', 'Advance the line and engage']].map(([k, n, t]) => `<button class="${f.behavior === k ? 'on' : ''}" data-fbeh="${k}" data-fid="${f.id}" title="${t}">${n}</button>`).join('')}</div>
        <div class="actions">${det ? `<button class="btn small" data-fop="rejoin" data-fid="${f.id}">Return to formation (${det})</button>` : ''}<button class="btn small ghost" data-fop="dissolve" data-fid="${f.id}">Release formation</button></div></div>`;
    }
    // reinforce: some selected units are in a formation, others are not
    const outside = units.filter((u) => !u.form);
    if (fs.length === 1 && outside.length && outside.length < units.length) h += `<div class="actions"><button class="btn small primary" data-fop="reinforce" data-fid="${fs[0].id}">Reinforce formation with ${outside.length}</button></div>`;
    // logistics: one-click supply runs and an optional standing resupply policy
    const combat = units.filter((u) => !D.UNITS[u.type].civilian);
    const trucks = units.filter((u) => u.type === 'supply_truck');
    if (combat.length && !S.spectator) {
      const avg = Math.round(combat.reduce((s2, u) => s2 + u.sup, 0) / combat.length);
      const pol = fs.length === 1 ? (e.logPolicies || []).find((p) => p.key === 'f:' + fs[0].id) : null;
      const inbound = (e.convoys || []).filter((c) => c.state !== 'available' && (fs.length === 1 ? c.target === 'formation:' + fs[0].id : c.target.startsWith('units')));
      h += `<div class="logi"><div class="actions"><select data-sel="preset" title="Supply package">${[['auto', 'Automatic'], ['infantry', 'Infantry'], ['armored', 'Armored'], ['fortification', 'Fortification'], ['emergency', 'Emergency']].map(([k, n]) => `<option value="${k}" ${this.preset === k ? 'selected' : ''}>${n}</option>`).join('')}</select><button class="btn small ${avg < 50 ? 'primary' : ''}" data-act="supply" title="A truck loads real goods at a city or depot, drives to a safe point behind these units and unloads">Send supplies</button></div>`;
      if (fs.length === 1) h += `<label class="field inline check"><input type="checkbox" data-logauto="${fs[0].id}" ${pol?.auto ? 'checked' : ''}><span>Automatically resupply this line below 40%</span></label>${pol?.note ? `<div class="muted small">${esc(pol.note)}</div>` : ''}`;
      if (inbound.length) h += `<div class="muted small">${inbound.map((c) => `Convoy ${esc(c.state)}${c.eta ? `, about ${c.eta}s out` : ''} (${c.cargo} cargo)`).join(' · ')}</div>`;
      h += '</div>';
    }
    if (trucks.length && !S.spectator) {
      const cv = (e.convoys || []).filter((c) => trucks.some((t) => t.id === c.truck));
      h += `<div class="logi"><b>Supply trucks</b><ul class="log">${cv.map((c) => `<li>${esc({ available: 'Available', toSource: 'Going to load', loading: 'Loading', outbound: 'Delivering', unloading: 'Unloading', returning: 'Returning', blocked: 'Route blocked' }[c.state] || c.state)} · ${c.cargo} cargo${c.eta ? ` · ${c.eta}s` : ''}${c.note ? ` <span class="muted">— ${esc(c.note)}</span>` : ''}${c.state !== 'available' && c.state !== 'returning' ? ` <button class="btn tiny ghost" data-truckback="${c.truck}">Return</button>` : ''}</li>`).join('')}</ul><p class="muted small">Trucks no longer supply by being nearby: select troops and press Send supplies.</p></div>`;
    }
    const diggers = units.filter((u) => { const d = D.UNITS[u.type]; return d.engineer || (d.move === 'infantry' && !d.civilian && d.cat !== 'artillery' && d.atk > 0); });
    if (diggers.length && !S.spectator) h += `<div class="actions"><button class="btn small" data-act="fortify" title="Dig trenches where these troops stand (Shift+F)">Fortify position (Shift+F)</button></div>`;
    // a stack: several units on one hex
    const tiles = new Set(units.map((u) => u.tile));
    if (tiles.size === 1 && units.length > 1) {
      h += `<div class="stack"><b>Stack of ${units.length} on one hex</b> <span class="muted">— one shell hits them all</span><ul class="log">${units.slice(0, 10).map((u) => `<li data-pick="${u.id}">${esc(D.UNITS[u.type].name)} <span class="muted">${u.hp}%${u.supp > 20 ? ` · suppressed ${u.supp}%` : ''}${u.sup < 50 ? ` · supply ${u.sup}%` : ''}</span></li>`).join('')}</ul><div class="actions"><button class="btn small" data-act="spread" title="Spread out over neighbouring hexes">Spread out</button></div></div>`;
    } else if (units.length > 1 && units.length <= 40 && !S.spectator) h += `<p class="muted small">Right-drag to draw a deployment line: longer spreads them out, shorter concentrates them.</p>`;
    return h;
  }

  // Deployment toolbar: visible while drawing a line and whenever several own combat units are
  // selected (so density, depth and behaviour can be chosen before the drag).
  deployBar(force) {
    const S = this.S, D = S.defs, el = $('deployBar'); if (!D) return;
    const units = [...S.selUnits].map((id) => S.units.get(id)).filter((u) => u && u.owner === S.civId && !D.UNITS[u.type].civilian);
    const show = !S.spectator && (S.deploy || units.length >= 2);
    if (!show) { if (!el.hidden) el.hidden = true; return; }
    const o = S.deployOpts, p = S.deploy?.plan;
    const seg = (k, opts) => `<div class="seg">${opts.map(([v, n, t]) => `<button class="${String(o[k]) === String(v) ? 'on' : ''}" data-dopt="${k}" data-v="${v}" title="${t}">${n}</button>`).join('')}</div>`;
    let h = `<span class="lbl">Deploy</span>${seg('mode', [['line', 'Line', 'A broad front, shallow ranks'], ['compact', 'Compact', 'A deliberately dense front (up to legal capacity)'], ['depth', 'In depth', 'Front line with support and artillery behind'], ['preserve', 'Keep shape', 'Move the formation as it stands']])}`;
    h += `${seg('density', [['auto', 'Auto', 'Line length decides: shorter concentrates'], ['spread', 'Spread', 'At most one unit per hex'], ['balanced', 'Balanced', 'Up to three per hex'], ['tight', 'Tight', 'Up to hex capacity']])}`;
    h += `${seg('depth', [['auto', 'Ranks: auto', 'Ranks as needed'], ['1', '1', 'One rank'], ['2', '2', 'Two ranks'], ['3', '3', 'Three ranks']])}`;
    h += `${seg('behavior', [['hold', 'Hold', 'Stay on the line, fire at what is in range'], ['defend', 'Defend', 'Engage nearby threats, then return'], ['attackMove', 'Advance', 'Advance and engage (or Alt+right-drag)']])}`;
    h += `<button class="btn tiny ${o.reverse ? 'primary' : 'ghost'}" data-dopt="reverse" title="Reverse the facing (Tab while dragging)">⇅ Facing</button><button class="btn tiny ${o.fortify ? 'primary' : 'ghost'}" data-dopt="fortify" title="Deploy & Fortify: infantry dig trenches once in position">⛏ Fortify</button>`;
    if (p) {
      const over = p.overflow.length, inv = p.invalid.length;
      h += `<span class="exposure ${p.label}" title="${p.label === 'dense' ? 'Several units share the same few hexes: one shell can hit them all' : p.label === 'concentrated' ? 'Some hexes hold several units' : 'Most units stand on their own hex'}">${{ dispersed: 'Dispersed', concentrated: 'Concentrated', dense: 'Dense — artillery risk', none: '—' }[p.label]}</span>`;
      h += `<span class="lbl">${S.deploy.n - over} placed${p.ranks > 1 ? ` · ${p.ranks} ranks` : ''}${over ? ` · <b class="bad">${over} do not fit</b>` : ''}${inv ? ` · ${inv} hexes impassable` : ''}</span>`;
    } else h += `<span class="lbl">Right-drag on the map to draw the line</span>`;
    if (h !== this.dbHtml || force) { this.dbHtml = h; el.innerHTML = h; }
    el.hidden = false;
  }
  // Fortify preview: what will be dug, what it costs and how long it takes, before committing.
  fortifyPanel(f, confirm) {
    const S = this.S, D = S.defs, el = $('fortifyPanel');
    const reasons = {}; for (const [, r] of f.skipped) reasons[r] = (reasons[r] || 0) + 1;
    el.innerHTML = `<h3>Fortify position</h3><div class="sub">${f.diggers} unit${f.diggers === 1 ? '' : 's'} can dig · ${esc(f.type)}</div>
      <dl class="kv"><dt>Valid segments</dt><dd>${f.valid} of ${f.total}</dd><dt>Materials</dt><dd>${Object.entries(f.cost).map(([k, v]) => `${v} ${esc(D.GOOD_NAMES[k].toLowerCase())}`).join(', ') || '—'}</dd><dt>Estimated time</dt><dd>${f.seconds}s</dd></dl>
      ${Object.keys(reasons).length ? `<p class="warn">${Object.entries(reasons).map(([r, n]) => `${n} skipped: ${esc(r)}`).join('; ')}.</p>` : ''}
      <p class="muted small">Trenches give infantry directional cover (strongest to the front), little to vehicles, and do not stop artillery hitting everyone on a stacked hex. Moving or pinned diggers pause the work.</p>
      <div class="actions"><button class="btn primary" data-fz="go" ${f.valid ? '' : 'disabled'}>Dig in</button><button class="btn ghost" data-fz="no">Cancel</button></div>`;
    el.hidden = false;
    el.onclick = (e) => { const b = e.target.closest('[data-fz]'); if (!b) return; el.hidden = true; if (b.dataset.fz === 'go') confirm(); };
  }

  // Several buildings selected: one production interface for all of them.
  multiBuildingPanel(blds) {
    const S = this.S, D = S.defs, e = S.econ;
    const byType = {}; for (const b of blds) byType[b.ty] = (byType[b.ty] || 0) + 1;
    let html = `<h3>${blds.length} buildings selected</h3><div class="sub">${Object.entries(byType).map(([t, n]) => `${n} ${esc(D.BUILDINGS[t].name)}`).join(', ')}</div>`;
    const queued = blds.reduce((s2, b) => s2 + (b.q?.length || 0), 0), longest = Math.max(0, ...blds.map((b) => (b.q || []).reduce((s2, q) => s2 + q[1], 0)));
    html += `<div class="muted">${queued} in training${queued ? ` · last finishes in about ${longest}s` : ''}. Right-click the map to set one rally point for all of them.</div>`;
    const units = new Map();
    for (const b of blds) if (b.d && b.o === S.civId) for (const u of D.BUILDINGS[b.ty].trains || []) if (D.UNITS[u].age <= (e?.age || 0)) units.set(u, (units.get(u) || 0) + 1);
    if (!units.size || S.spectator) return html;
    const per = S.batchMode === 'per', n = S.batchCount;
    html += `<div class="actions batchctl"><span>Train</span><input type="number" min="1" max="60" value="${n}" data-batch="count" aria-label="How many">
      <div class="seg"><button class="${per ? '' : 'on'}" data-batchmode="total" title="${n} units in total, spread over the buildings">in total</button><button class="${per ? 'on' : ''}" data-batchmode="per" title="${n} units from each building">per building</button></div></div>`;
    const cost = (c, k) => Object.entries(c).map(([g, v]) => `${v * k} ${(D.GOOD_NAMES[g] || g).toLowerCase()}`).join(', ');
    html += `<div class="actions">` + [...units].map(([u, nb]) => {
      const ud = D.UNITS[u]; const locked = ud.tech && !e.techs.includes(ud.tech);
      const total = per ? n * nb : n;
      return `<button class="btn trainbtn" data-batchtrain="${u}" ${locked ? 'disabled' : ''} title="${esc(ud.name)} ×${total}: ${esc(cost(ud.cost, total))}${ud.pop ? `, ${ud.pop * total} manpower` : ''}; spread over ${nb} building${nb > 1 ? 's' : ''} to finish soonest"><span>${esc(ud.name)} ×${total}</span><small>${locked ? 'needs ' + esc(D.TECHS[ud.tech].name) : `${nb} building${nb > 1 ? 's' : ''}`}</small></button>`;
    }).join('') + `</div>`;
    const rep = blds.find((b) => b.rp)?.rp;
    html += `<div class="actions"><label class="field inline"><span>Repeat production</span><select data-batch="repeat"><option value="">Off</option>${[...units.keys()].map((u) => `<option value="${u}" ${rep === u ? 'selected' : ''}>${esc(D.UNITS[u].name)}</option>`).join('')}</select></label></div>`;
    return html;
  }

  // Refit options for the selected units: one button per available upgrade path.
  refitPanel(units) {
    const S = this.S, D = S.defs, e = S.econ; if (!e) return '';
    const byType = new Map(); for (const u of units) if (!u.refit) byType.set(u.type, (byType.get(u.type) || 0) + 1);
    const btns = [];
    for (const [t, n] of byType) for (const r of D.REFIT[t] || []) {
      const ud = D.UNITS[r.to]; const ok = ud.age <= e.age && (!ud.tech || e.techs.includes(ud.tech));
      const fac = Object.values(D.BUILDINGS).find((b) => (b.trains || []).includes(r.to));
      btns.push(`<button class="btn small" data-refit="${t}" data-to="${r.to}" ${ok ? '' : 'disabled'} title="${ok ? `Re-equip within 3 hexes of a ${esc(fac?.name || 'facility')}. Veterancy is kept${r.conv ? '; a conversion costs most of a new unit' : ''}.` : `Needs ${esc(ud.tech ? D.TECHS[ud.tech].name : D.AGES[ud.age].name)}`}">Refit ${n} ${esc(D.UNITS[t].name)} → ${esc(ud.name)}</button>`);
    }
    btns.push(`<button class="btn small ghost" data-act="disband" title="Demobilise: about 80% of the soldiers return home as civilians">Disband</button>`);
    return `<div class="actions refits">${btns.join('')}</div>`;
  }

  buildingPanel(b, d, own, city) {
    const S = this.S, D = S.defs;
    let html = `<div>Condition ${b.hp}% <span class="tag ${b.st === 'damaged' ? 'bad' : b.st === 'operational' ? 'good' : 'warn'}">${esc(b.st)}</span>${b.f ? ' <span class="tag bad">on fire</span>' : ''}</div><div class="bar hp"><i style="width:${b.hp}%"></i></div>`;
    if (b.st === 'planned') html += `<div class="warn">Planned: construction starts once the resources are available.</div>`;
    else if (!b.d) html += `<div class="warn">Under construction: ${b.p}% (crew rate ×${(b.cr || 1).toFixed(1)}; engineers nearby speed this up)</div>`;
    if (b.st === 'damaged' && own) html += `<div class="bad">Damaged buildings work at half capacity and do not recover by themselves.</div>`;
    if (city) html += `<div>Population ${Math.floor(city.pop)}</div>`;
    if (own && d.jobs && b.d) html += `<div class="${b.w && !['under', 'surplus', 'locked'].includes(b.w) ? 'warn' : 'muted'}">${esc(staffText(b, D))}</div>`;
    if (own && b.ty === 'house' && b.d && !S.spectator) html += `<div class="muted">Density level ${b.lv || 1} of 3.</div>${(b.lv || 1) < 3 ? `<div class="actions"><button class="btn small" data-upgrade="${b.id}" title="Add storeys: more homes on the same hex">Upgrade housing (${(S.econ?.age || 0) >= 1 ? `${40 * (b.lv || 1)} materials, ${10 * (b.lv || 1)} steel` : `${45 * (b.lv || 1)} materials`})</button></div>` : ''}`;
    if (own && b.w) {
      const g = b.w.startsWith('input:') ? b.w.slice(6) : null;
      const msg = g ? `Short of ${esc((D.GOOD_NAMES[g] || g).toLowerCase())}: output is limited until supply improves.` : { staff: 'No workers: the city needs more people (housing and food) or fewer job buildings.', power: 'Brownout: power demand exceeds generation. Build or staff a power plant.', rare: 'Needs a rare-earth deposit inside your territory.' }[b.w];
      if (msg) html += `<div class="warn">${msg}</div>`;
    }
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
    if (b.q?.length) html += `<div class="queue">${b.q.map(([u, t], i) => `<span>${esc(D.UNITS[u].name)} ${t}s <button class="x" data-qcancel="${i}" title="Cancel: ${i === 0 ? 'half the cost back once training has started' : 'full refund'}; the reserved manpower returns to work">×</button></span>`).join('')}</div>`;
    const armies = e.armies || [];
    html += `<div class="muted">Right-click the map to set a rally point${armies.length ? `; new units join <select data-sel="rallyArmy"><option value="0">no army</option>${armies.map((a) => `<option value="${a.id}" ${b.rallyArmy === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}.</div>`;
    return html;
  }

  cityOverview(city, b, d) {
    const gr = city.gr || 0;
    let html = `<div class="ledger">
      <div><b>${Math.floor(city.pop)}</b><span>civilians</span></div><div><b>${city.lab ?? '–'}</b><span>labor</span></div>
      <div><b>${city.rsv || 0}</b><span>in training</span></div><div><b>${city.mil || 0}</b><span>serving</span></div><div><b>${city.rec ?? 0}</b><span>recruitable</span></div></div>
      <div class="muted">Growth ${gr >= 0 ? '+' : ''}${gr.toFixed(1)}/min · housing ${city.h}${city.pop > city.h ? ' <span class="warn">(overcrowded)</span>' : ''}${city.recov ? ' · <span class="good">post-war recovery</span>' : ''}${city.mig > 0.05 ? ` · migrants +${city.mig}` : ''}${city.back ? ' · demobilised soldiers returning' : ''}</div>
      <dl class="kv"><dt>Population</dt><dd>${city.pop.toFixed(1)} / ${city.h} housing</dd><dt>Workers</dt><dd>${city.jobs?.worker || 0}</dd><dt>Merchants</dt><dd>${city.jobs?.merchant || 0}</dd><dt>Specialists</dt><dd>${city.jobs?.specialist || 0}</dd><dt>Unemployed</dt><dd>${city.un}</dd>
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

  // Workforce: category priorities, per-building staffing in words, locks, and an auto-balance preview.
  workforcePanel(city) {
    const S = this.S, D = S.defs;
    const wf = city.wf || { mode: 'balanced', prio: { food: 'critical', industry: 'normal', research: 'normal', commerce: 'normal' } };
    const CAT = { agri: 'food', industry: 'industry', power: 'industry', science: 'research', commerce: 'commerce' };
    const catOf = (t) => (t === 'port' ? 'food' : CAT[D.BUILDINGS[t].cat] || 'industry');
    const blds = [...S.buildings.values()].filter((b) => b.c === city.id && b.d && D.BUILDINGS[b.ty].jobs);
    const sum = {}; for (const k of ['food', 'industry', 'research', 'commerce']) sum[k] = { s: 0, n: 0, list: [] };
    for (const b of blds) { const k = catOf(b.ty); sum[k].s += b.s || 0; sum[k].n += D.BUILDINGS[b.ty].jobs[1]; sum[k].list.push(b); }
    const assigned = blds.reduce((s2, b) => s2 + (b.s || 0), 0);
    let h = `<div class="ledger"><div><b>${Math.floor(city.pop)}</b><span>population</span></div><div><b>${city.lab ?? 0}</b><span>available</span></div><div><b>${assigned}</b><span>assigned</span></div><div><b>${city.ua ?? 0}</b><span>unassigned</span></div></div>`;
    const levels = ['critical', 'high', 'normal', 'low', 'off'];
    const names = { food: 'Food', industry: 'Industry', research: 'Research', commerce: 'Commerce' };
    for (const [k, v] of Object.entries(sum)) {
      const open = this.wfOpen === k;
      h += `<div class="wfcat"><button class="wfhd" data-wf="toggle" data-cat="${k}"><b>${names[k]}</b><span>${v.s} / ${v.n} positions staffed</span></button>
        <select data-wfprio="${k}" title="Priority for ${names[k].toLowerCase()} jobs">${levels.map((l) => `<option value="${l}" ${wf.prio?.[k] === l ? 'selected' : ''}>${l[0].toUpperCase() + l.slice(1)}</option>`).join('')}</select></div>`;
      if (open) h += `<ul class="log wfb">${v.list.map((b) => {
        const n = D.BUILDINGS[b.ty].jobs[1];
        return `<li><span>${esc(D.BUILDINGS[b.ty].name)}</span> <span class="muted">${esc(staffText(b, D))}</span>
          <span class="wfctl"><button class="btn small ghost" data-wf="lock" data-id="${b.id}" data-n="${Math.max(0, (b.lk ?? b.s ?? 0) - 1)}" title="Lock one fewer worker">−</button><button class="btn small ghost" data-wf="lock" data-id="${b.id}" data-n="${Math.min(n, (b.lk ?? b.s ?? 0) + 1)}" title="Lock one more worker">+</button>${b.lk != null ? `<button class="btn small ghost" data-wf="lock" data-id="${b.id}" data-n="null" title="Let the allocator decide again">unlock</button>` : ''}<button class="btn small ghost" data-wf="off" data-id="${b.id}" data-on="${b.off ? '0' : '1'}">${b.off ? 'enable' : 'disable'}</button></span></li>`;
      }).join('') || '<li class="muted">No workplaces.</li>'}</ul>`;
    }
    const p = this.wfPreview;
    h += `<div class="actions"><select id="wfMode">${['balanced', 'growth', 'industry', 'research', 'commerce'].map((m) => `<option value="${m}" ${(p?.mode || wf.mode) === m ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select><button class="btn small" data-wf="preview" data-mode="${p?.mode || (wf.mode === 'custom' ? 'balanced' : wf.mode)}">Preview auto-balance</button></div>`;
    if (p) {
      h += `<div class="preview"><b>Auto-balance (${esc(p.mode)})</b>${p.changes.length ? `<ul class="log">${p.changes.map((c) => `<li>${esc(D.BUILDINGS[c.type].name)}: ${c.from} → <b>${c.to}</b></li>`).join('')}</ul>` : '<p class="muted">No assignments would change.</p>'}`;
      const eff = Object.entries(p.effect || {}).filter(([, v]) => Math.abs(v) >= 0.05);
      if (eff.length) h += `<p class="muted">Estimated effect: ${eff.map(([k, v]) => `<span class="${v < 0 ? 'bad' : 'good'}">${v > 0 ? '+' : ''}${v.toFixed(1)} ${esc((D.GOOD_NAMES[k] || k).toLowerCase())}/s</span>`).join(', ')}</p>`;
      h += `<div class="actions"><button class="btn small primary" data-wf="apply" data-mode="${esc(p.mode)}">Apply (clears locks)</button><button class="btn small ghost" data-wf="cancelPreview">Cancel</button></div></div>`;
    }
    h += `<p class="muted">Food is always staffed first up to what the city eats. Locked buildings keep exactly their workers; governors never change locks. Buildings that cannot run (no inputs, power or storage) leave their workers free.</p>`;
    return h;
  }

  governorPanel(city) {
    const S = this.S, D = S.defs, gv = city.gov || { enabled: false, level: 'off', goal: 'none', budget: 0.15, emergency: true, spec: 'balanced', reserve: 0.25, perms: {}, log: [], queue: [], proposals: [], deferred: [] };
    const perm = (k, label) => `<label class="perm"><input type="checkbox" data-gperm="${k}" ${gv.perms[k] ? 'checked' : ''}> ${label}</label>`;
    const LV = { off: ['Off', 'No delegated actions.'], advisor: ['Advisor', 'Analyses the city and proposes projects for your approval. Only permitted emergency repairs run on their own.'], managed: ['Managed', 'Handles labor priorities, repairs, rubble, farms and housing within its budget; asks before anything else.'], autonomous: ['Autonomous', 'Develops the city within its budget, goal and permissions. Founding cities still needs your approval.'] };
    let html = `<div class="seg govlv">${Object.entries(LV).map(([k, [n]]) => `<button class="${(gv.level || 'off') === k ? 'on' : ''}" data-govlevel="${k}">${n}</button>`).join('')}</div><p class="muted">${esc(LV[gv.level || 'off'][1])}</p>`;
    if ((gv.proposals || []).length) {
      html += `<h4 style="margin:6px 0 2px">Proposals</h4>` + gv.proposals.map((p) => `<div class="proposal"><b>${p.action === 'build' ? 'Construct ' + esc(D.BUILDINGS[p.type]?.name) : p.action === 'upgrade' ? 'Upgrade a housing block' : p.action === 'road' ? 'Build a road' : p.action === 'settle' ? 'Train a colonist convoy' : esc(p.action)}</b><small>${esc(p.reason || '')}</small><small class="muted">${Object.entries(p.cost || {}).map(([k, v]) => `${v} ${esc((D.GOOD_NAMES[k] || k).toLowerCase())}`).join(', ')}${p.confidence ? ` · confidence ${Math.round(p.confidence * 100)}%` : ''}</small>
        <div class="actions"><button class="btn small primary" data-prop="${p.id}" data-answer="approve">Approve</button><button class="btn small" data-prop="${p.id}" data-answer="defer">Later</button><button class="btn small ghost" data-prop="${p.id}" data-answer="reject">Reject</button>${p.tile >= 0 ? `<button class="btn small ghost" data-jump="${p.tile}">Show site</button>` : ''}</div></div>`).join('');
    }
    if ((gv.deferred || []).length) html += `<h4 style="margin:6px 0 2px">Deliberately not building</h4><ul class="log">${gv.deferred.map((d2) => `<li class="muted">${esc(d2)}</li>`).join('')}</ul>`;
    html += `<label class="field inline"><span>City goal</span><select data-gov="goal">${Object.entries(D.GOVERNOR_GOALS || {}).map(([k, g]) => `<option value="${k}" ${gv.goal === k ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>`;
    html += `<label class="field inline"><span>Specialization</span><select data-gov="spec">${Object.entries(D.GOVERNOR_SPECS).map(([k, sp]) => `<option value="${k}" ${gv.spec === k ? 'selected' : ''}>${esc(sp.name)}</option>`).join('')}</select></label>`;
    html += `<label class="field inline"><span>Budget ${Math.round((gv.budget ?? 0.15) * 100)}% of a stockpile per project</span><input type="range" min="5" max="60" step="5" value="${Math.round((gv.budget ?? 0.15) * 100)}" data-gov="budget"></label>`;
    html += `<label class="field inline"><span>Reserve ${Math.round(gv.reserve * 100)}%</span><input type="range" min="0" max="90" step="5" value="${Math.round(gv.reserve * 100)}" data-gov="reserve"></label>`;
    html += `<label class="perm"><input type="checkbox" data-gov="emergency" ${gv.emergency !== false ? 'checked' : ''}> Allow emergency repairs in Advisor mode</label>`;
    html += perm('build', 'Construct buildings') + perm('roads', 'Build and repair roads') + perm('repair', 'Repair damage and clear ruins') + perm('recruit', 'Recruit a defensive garrison (Autonomous)') + perm('settle', 'Propose new settlements');
    const queued = (gv.queue || []).map((id) => S.buildings.get(id)).filter(Boolean);
    if (queued.length) html += `<h4 style="margin:6px 0 2px">Projects</h4><ul class="log">${queued.map((b) => `<li>${esc(D.BUILDINGS[b.ty].name)} ${b.st === 'planned' ? '(waiting for funds)' : `${b.p}%`} <button class="btn small ghost" data-gcancel="${b.id}" title="Cancel and never build on that hex again">Cancel &amp; lock</button></li>`).join('')}</ul>`;
    html += `<h4 style="margin:6px 0 2px">Decisions</h4><ul class="log govlog">${(gv.log || []).map((l) => `<li><time>${Math.floor(l.t / 60)}:${String(l.t % 60).padStart(2, '0')}</time>${esc(l.text)}</li>`).join('') || '<li class="muted">No decisions yet.</li>'}</ul>`;
    return html;
  }

  onSelClick(e) {
    const t = e.target.closest('[data-act],[data-train],[data-jump],[data-ctab],[data-gcancel],[data-card],[data-follow-civ],[data-refit],[data-wf],[data-prop],[data-qcancel],[data-upgrade],[data-import],[data-govlevel],[data-batchtrain],[data-batchmode],[data-fbeh],[data-fop],[data-pick],[data-truckback]'); if (!t) return;
    if (t.dataset.truckback) return this.A.cmd({ c: 'returnSupplyTruck', truck: +t.dataset.truckback });
    if (t.dataset.fbeh) return this.A.cmd({ c: 'formation', id: +t.dataset.fid, op: 'behavior', behavior: t.dataset.fbeh });
    if (t.dataset.fop) return this.A.formationOp(t.dataset.fop, +t.dataset.fid);
    if (t.dataset.pick) return this.A.pickUnit(+t.dataset.pick);
    if (t.dataset.batchtrain) return this.A.batchTrain(t.dataset.batchtrain);
    if (t.dataset.batchmode) { this.S.batchMode = t.dataset.batchmode; this.selHtml = ''; return this.selection(); }
    if (t.dataset.refit) return this.A.refit(t.dataset.refit, t.dataset.to);
    if (t.dataset.wf === 'toggle') { this.wfOpen = this.wfOpen === t.dataset.cat ? null : t.dataset.cat; this.selHtml = ''; return this.selection(); }
    if (t.dataset.wf === 'cancelPreview') { this.wfPreview = null; this.selHtml = ''; return this.selection(); }
    if (t.dataset.wf) return this.A.workforce(t.dataset);
    if (t.dataset.govlevel) return this.A.governor({ level: t.dataset.govlevel });
    if (t.dataset.prop) return this.A.governor({ proposal: +t.dataset.prop, answer: t.dataset.answer });
    if (t.dataset.qcancel != null) return this.A.cmd({ c: 'cancelTrain', building: this.S.selBuilding, index: +t.dataset.qcancel });
    if (t.dataset.upgrade) return this.A.cmd({ c: 'upgrade', id: +t.dataset.upgrade });
    if (t.dataset.followCiv) return this.A.follow(+t.dataset.followCiv, false);
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
    if (t.dataset.sel === 'preset') { this.preset = t.value; return; }
    if (t.dataset.logauto) return this.A.cmd({ c: 'supplyPolicy', formation: +t.dataset.logauto, auto: t.checked, preset: this.preset || 'auto' });
    else if (t.dataset.sel === 'formation') { this.S.formation = t.value; }
    else if (t.dataset.sel === 'policy') this.A.policy(t.value);
    else if (t.dataset.sel === 'rallyArmy') this.A.rallyArmy(+t.value);
    else if (t.dataset.gov === 'enabled') this.A.governor({ enabled: t.checked });
    else if (t.dataset.gov === 'spec') this.A.governor({ spec: t.value });
    else if (t.dataset.gov === 'goal') this.A.governor({ goal: t.value });
    else if (t.dataset.batch === 'count') { this.S.batchCount = Math.max(1, Math.min(60, +t.value || 1)); this.selHtml = ''; this.selection(); }
    else if (t.dataset.batch === 'repeat') this.A.repeat(t.value || null);
    else if (t.dataset.gov === 'budget') this.A.governor({ budget: +t.value / 100 });
    else if (t.dataset.gov === 'emergency') this.A.governor({ emergency: t.checked });
    else if (t.dataset.wfprio) this.A.workforce({ wf: 'prio', cat: t.dataset.wfprio, level: t.value });
    else if (t.id === 'wfMode') { this.wfPreview = null; this.A.workforce({ wf: 'preview', mode: t.value }); }
    else if (t.dataset.gov === 'reserve') this.A.governor({ reserve: +t.value / 100 });
    else if (t.dataset.gperm) this.A.governor({ perms: { [t.dataset.gperm]: t.checked } });
  }

  // ------------------------------------------------------------ drawer
  // ------------------------------------------------------------ onboarding: brief, contextual, once
  tip(key, text) {
    let seen = {}; try { seen = JSON.parse(localStorage.getItem('se.tips') || '{}'); } catch { /* ignore */ }
    if (seen[key] || this.S.spectator) return;
    seen[key] = 1; try { localStorage.setItem('se.tips', JSON.stringify(seen)); } catch { /* ignore */ }
    const el = document.createElement('div'); el.className = 'toast tip lv-info';
    el.innerHTML = `<b>Tip</b> <span class="tt"></span> <button class="btn tiny ghost">Got it</button>`; el.querySelector('.tt').textContent = text;
    el.querySelector('button').onclick = () => el.remove();
    $('toasts').prepend(el); setTimeout(() => el.remove(), 20000);
  }
  checkTips() {
    const S = this.S, e = S.econ; if (!e) return;
    if (this.ws === 'research') this.tip('research', 'Selecting a technology only inspects it. Use Research now or Add to queue; queued research continues automatically and switching never loses progress.');
    const sel = [...S.selUnits].map((id) => S.units.get(id)).filter((u) => u && u.owner === S.civId);
    if (sel.length >= 3) this.tip('army', 'Right-drag to draw a deployment line: a longer line spreads troops out, a shorter one concentrates them (and makes them an artillery target). Units cut off from supply live on their reserves; dug-in infantry last longest.');
    if (Object.entries(e.rates || {}).some(([k, r]) => r < -0.05 && (e.res[k] || 0) / -r < 180)) this.tip('shortage', 'A stockpile is running down. Open Economy (rail) to see the production chain and what blocks it.');
    if ((S.battles || []).some((b) => b.mine?.n > 0)) this.tip('battle', 'A battle is under way. Click the battle marker for forces, losses and quick orders; minor notifications are held back while you fight.');
    if (this.cityTab === 'governor' && S.selBuilding != null) this.tip('governor', 'Advisor governors only suggest. Managed handles routine upkeep; Autonomous may build within the budget you set. Locks and manual choices are always respected.');
  }

  // ------------------------------------------------------------ workspaces
  openWorkspace(w) {
    const TAB = { research: 'research', cities: 'empire', military: 'military', economy: 'economy', government: 'realm', diplomacy: 'diplomacy', chronicle: 'chronicle' };
    if (!TAB[w]) return;
    this.ws = w; this.tab = TAB[w];
    const el = $('drawer'); el.hidden = false; el.classList.toggle('research', w === 'research');
    $('wsTitle').textContent = { cities: 'Cities', military: 'Military command', economy: 'Economy & logistics', government: 'Government', diplomacy: 'Diplomacy', chronicle: 'Chronicle' }[w] || '';
    for (const b of $('rail').querySelectorAll('[data-ws]')) b.classList.toggle('on', b.dataset.ws === w);
    if (w !== 'research') $('drawerBody').innerHTML = '';
    this.drawerKey = ''; this.drawer(true);
  }
  closeWorkspace() {
    if (!this.ws) return false;
    this.ws = null; $('drawer').hidden = true; $('drawer').classList.remove('research');
    for (const b of $('rail').querySelectorAll('[data-ws]')) b.classList.toggle('on', b.dataset.ws === 'world' || (b.dataset.ws === 'build' && !$('buildbar').hidden));
    return true;
  }
  toggleBuild(force) {
    const bb = $('buildbar'); bb.hidden = force != null ? !force : !bb.hidden;
    $('rail').querySelector('[data-ws=build]').classList.toggle('on', !bb.hidden);
    if (!bb.hidden) this.buildbar();
  }
  // Escape closes the innermost layer: popover, then inspector selection, then workspace
  escape() {
    if (!$('lensPop').hidden) { $('lensPop').hidden = true; return true; }
    if (!$('search').hidden) { $('search').hidden = true; return true; }
    if (!$('fortifyPanel').hidden) { $('fortifyPanel').hidden = true; return true; }
    if (!$('alerts').hidden) { $('alerts').hidden = true; return true; }
    if (!$('mapkey').hidden) { this.toggleKey(false); return true; }
    if (this.ws) return this.closeWorkspace();
    if (!$('buildbar').hidden && !this.S.mode) { this.toggleBuild(false); return true; }
    return false;
  }

  drawer(force) {
    const S = this.S, e = S.econ; if (!e) return;
    if (!this.ws && !force) return;
    if (!this.ws) return;
    if (this.ws === 'research') { this.research.render($('drawerBody')); return; }
    const key = this.tab + (this.tab === 'research' ? JSON.stringify(e.readiness) : this.tab === 'realm' ? JSON.stringify([e.market, e.upkeep]) : '') + JSON.stringify([e.research, Math.floor(e.progress / 10), e.queue, e.techs.length, e.age, e.advancing > 0, e.gov, e.govCooldown > 0, e.policies, e.tax, e.focus, e.proposals,
      S.civInfo.map((c) => [c.rel, c.alive, c.age, c.known]), this.tab === 'chronicle' ? [S.log.length, e.cmdlog?.length, e.cmdlog?.[0]?.t, this.chronTab] : 0,
      this.tab === 'empire' ? [[...S.cities.values()].filter((c) => c.o === S.civId).map((c) => [Math.round(c.pop / 4), Math.round(c.st / 5), c.fs, c.iso, c.unrest, c.gov?.enabled, c.gov?.spec]), this.empireSort, this.empireFilter] : 0,
      this.tab === 'armies' ? (e.armies || []).map((a) => [a.id, a.name, a.units.length, a.status, a.formation, a.stance, a.note, Math.round((a.hp || 0) / 5), Math.round((a.supply || 0) / 5)]) : 0,
      this.tab === 'economy' || this.tab === 'military' ? [Math.floor(S.time / 2), this.chainGood, JSON.stringify(this.plans || {}).length] : 0]);
    if (!force && key === this.drawerKey) return;
    this.drawerKey = key;
    const body = $('drawerBody'); const scroll = body.scrollTop;
    patchHtml(body, this['tab_' + this.tab]?.() || '');
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
    h += this.readinessHtml();
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
  // What stands between the empire and its next era and each locked unit, in one place.
  readinessHtml() {
    const S = this.S, D = S.defs, r = S.econ?.readiness; if (!r) return '';
    let h = '<details class="ready" open><summary>Readiness</summary>';
    if (r.era) {
      h += `<div class="muted">${esc(r.era.name)}: ${r.era.techs[0]}/${r.era.techs[1]} technologies${r.era.research ? ` — ${esc(r.era.research)}` : ''}</div><ul class="log">`;
      for (const [k, c] of Object.entries(r.era.cost)) h += `<li><span class="${c.have >= c.need ? 'good' : 'warn'}">${esc(D.GOOD_NAMES[k] || k)} ${c.have}/${c.need}</span>${c.blockers.length ? ` <span class="muted">— ${esc(c.blockers.join('; '))}</span>` : ''}</li>`;
      h += '</ul>';
    }
    const units = (r.units || []).filter((u) => !D.UNITS[u.unit].civilian).slice(0, 6);
    if (units.length) h += `<div class="muted">Locked units</div><ul class="log">${units.map((u) => `<li><b>${esc(D.UNITS[u.unit].name)}</b> <span class="muted">needs ${esc(u.needs.join(', '))}</span></li>`).join('')}</ul>`;
    return h + '</details>';
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

  // ------------------------------------------------------------ economy & logistics workspace
  tab_economy() {
    const S = this.S, e = S.econ, D = S.defs;
    const mine = [...S.buildings.values()].filter((b) => b.o === S.civId);
    const work = mine.filter((b) => b.d && D.BUILDINGS[b.ty].jobs);
    const staffed = work.filter((b) => b.s > 0).length;
    const WHY = { staff: 'no workers', power: 'no power', full: 'storage full', rare: 'no rare earths', off: 'switched off', locked: 'locked by you' };
    const why = (w) => (!w ? '' : w.startsWith('input:') ? 'missing ' + w.slice(6) : w.startsWith('prio:') ? 'lower labour priority' : WHY[w] || w);
    let h = '<div class="ws-cols">';
    // national overview
    h += `<div class="ws-card"><h4>National overview</h4><table class="grid"><tr><th>Good</th><th>Stock</th><th>Made</th><th>Used</th><th>Net</th><th>Lasts</th></tr>`;
    for (const k of D.GOODS) {
      const v = e.res[k] || 0, net = e.rates[k] || 0, made = e.gross?.[k] || Math.max(0, net), used = Math.max(0, made - net);
      if (!v && !made && !net) continue;
      const lasts = net < -0.05 ? `${Math.round(v / -net / 60)} min` : '—';
      h += `<tr class="${net < -0.05 && v / -net < 300 ? 'short' : ''}"><td><a href="#" data-chain="${k}">${esc(D.GOOD_NAMES[k])}</a></td><td>${fmt(v)}</td><td>${made.toFixed(1)}</td><td>${used.toFixed(1)}</td><td class="${net < 0 ? 'neg' : 'pos'}">${net >= 0 ? '+' : ''}${net.toFixed(1)}</td><td>${lasts}</td></tr>`;
    }
    h += `</table><p class="muted small">Per second. Click a good for its production chain.</p>`;
    h += `<div><span class="ind ${staffed < work.length * 0.7 ? 'mid' : ''}"><b>${work.length ? Math.round((100 * staffed) / work.length) : 100}%</b>industry staffed</span><span class="ind"><b>${e.power ? `${e.power.gen}/${e.power.use}` : '—'}</b>power</span><span class="ind"><b>${e.upkeep ? e.upkeep.credits.toFixed(1) : 0}</b>army credits/s</span><span class="ind"><b>${e.upkeep ? e.upkeep.fuel.toFixed(2) : 0}</b>army fuel/s</span></div>`;
    if (e.saving) h += `<p class="muted">Reserved for the next era: ${Object.entries(e.saving).map(([k, v]) => `${v} ${esc(D.GOOD_NAMES[k].toLowerCase())}`).join(', ')}.</p>`;
    if (e.natReserve) h += `<p class="muted">Reserved for a national project: ${esc(D.BUILDINGS[e.natReserve]?.name || e.natReserve)}.</p>`;
    h += '</div>';
    // production chain explorer
    const good = this.chainGood || (e.saving ? Object.keys(e.saving).find((k) => (e.res[k] || 0) < e.saving[k]) : null) || 'steel';
    h += `<div class="ws-card"><h4>Production chain: <select data-chainsel="1">${D.GOODS.filter((k) => k !== 'credits').map((k) => `<option value="${k}" ${k === good ? 'selected' : ''}>${esc(D.GOOD_NAMES[k])}</option>`).join('')}</select></h4>`;
    const makers = Object.entries(D.BUILDINGS).filter(([, d]) => d.produce && d.produce[good]);
    const users = Object.entries(D.BUILDINGS).filter(([, d]) => d.consume && d.consume[good]);
    const stage = (type) => {
      const list = mine.filter((b) => b.ty === type && b.d); const run = list.filter((b) => b.s > 0).length;
      const reasons = {}; for (const b of list) if (b.w && b.w !== 'surplus' && b.w !== 'under') reasons[why(b.w)] = (reasons[why(b.w)] || 0) + 1;
      const d = D.BUILDINGS[type]; const locked = d.tech && !e.techs.includes(d.tech);
      return `<div class="stage ${!list.length ? '' : run < list.length ? 'bad' : 'ok'}"><b>${esc(d.name)}</b><br><small>${locked ? `needs ${esc(D.TECHS[d.tech].name)}` : list.length ? `${run}/${list.length} working${Object.keys(reasons).length ? ' — ' + Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(', ') : ''}` : 'none built'}</small>${d.consume ? `<br><small class="muted">uses ${Object.keys(d.consume).map((k) => esc(D.GOOD_NAMES[k].toLowerCase())).join(', ')}${d.power < 0 ? ', power' : ''}</small>` : d.power < 0 ? '<br><small class="muted">uses power</small>' : ''}</div>`;
    };
    const inputs = [...new Set(makers.flatMap(([, d]) => Object.keys(d.consume || {})))];
    h += `<div class="chain">${inputs.length ? `${inputs.map((k) => `<div class="stage"><b>${esc(D.GOOD_NAMES[k])}</b><br><small>${fmt(e.res[k] || 0)} in stock, ${(e.rates[k] || 0).toFixed(1)}/s</small></div>`).join('')}<span class="arrow">→</span>` : ''}${makers.map(([t]) => stage(t)).join('') || '<div class="stage">No producer</div>'}<span class="arrow">→</span><div class="stage ${(e.rates[good] || 0) < 0 ? 'bad' : 'ok'}"><b>${esc(D.GOOD_NAMES[good])}</b><br><small>${fmt(e.res[good] || 0)} · ${(e.rates[good] || 0) >= 0 ? '+' : ''}${(e.rates[good] || 0).toFixed(1)}/s</small></div>${users.length ? `<span class="arrow">→</span>${users.map(([t]) => stage(t)).join('')}` : ''}</div>`;
    const imp = e.market && D.IMPORT_PRICE[good] ? `<p class="muted">Can be imported: ${D.IMPORT_PRICE[good]} credits each at the world market (Government).</p>` : '';
    h += imp + '</div>';
    // facilities that are not running, and disconnected cities
    const idle = work.filter((b) => !b.s && b.w && b.w !== 'surplus');
    h += `<div class="ws-card"><h4>Not running (${idle.length})</h4>${idle.length ? `<ul class="log">${idle.slice(0, 14).map((b) => `<li data-jump="${b.t}"><b>${esc(D.BUILDINGS[b.ty].name)}</b> <span class="warn">${esc(why(b.w))}</span></li>`).join('')}</ul>` : '<p class="muted">Every workplace is running.</p>'}`;
    const cut = [...S.cities.values()].filter((c) => c.o === S.civId && (c.iso || (c.fr >= 0 && c.ship >= c.fr * 0.95)));
    h += `<h4>Logistics</h4>${cut.length ? `<ul class="log">${cut.map((c) => `<li data-jump="${c.t}"><b>${esc(c.n)}</b> ${c.iso ? '<span class="bad">cut off: living on local stock</span>' : `<span class="warn">freight full (${c.fr}/s)</span>`}</li>`).join('')}</ul>` : '<p class="muted">Every city is connected with spare freight capacity.</p>'}</div>`;
    // city development planner
    const cities = [...S.cities.values()].filter((c) => c.o === S.civId);
    this.plans = this.plans || {};
    if (!this.planAt || S.time - this.planAt > 8) { this.planAt = S.time; for (const c of cities.slice(0, 8)) this.A.cmd({ c: 'cityPlan', city: c.id }).then((r) => { if (r.plan) { this.plans[c.id] = r.plan; } }); }
    h += `<div class="ws-card"><h4>City development planner</h4><p class="muted small">From the same rules the simulation and governors use.</p>`;
    for (const c of cities.slice(0, 8)) {
      const p = this.plans[c.id];
      h += `<h5 data-jump="${c.t}">${esc(c.n)} <small class="muted">pop ${Math.floor(c.pop)}/${c.h}</small></h5>`;
      if (!p) { h += '<p class="muted">…</p>'; continue; }
      for (const i of p.issues) h += `<div class="rec alt">${esc(i)}</div>`;
      p.recs.forEach((r, i) => { h += `<div class="rec ${i ? 'alt' : ''}"><b>${i ? 'Alternative' : 'Recommended'}:</b> ${r.kind === 'upgrade' ? 'raise a housing block' : esc(D.BUILDINGS[r.type]?.name || r.type)} <span class="muted">— ${esc(r.reason)}</span></div>`; });
      for (const a of p.avoid.slice(0, 2)) h += `<div class="rec no"><b>Not recommended:</b> <span class="muted">${esc(a)}</span></div>`;
      if (!p.recs.length && !p.issues.length) h += '<p class="muted">Nothing would clearly improve it right now.</p>';
    }
    return h + '</div></div>';
  }

  // ------------------------------------------------------------ military workspace
  tab_military() {
    const S = this.S, e = S.econ, D = S.defs;
    let h = '<div class="ws-cols">';
    const cmd = e.command;
    h += `<div class="ws-card"><h4>Command</h4>${cmd ? `<div><span class="ind ${cmd.over > 0 ? 'bad' : ''}"><b>${cmd.organised}</b>organised</span><span class="ind ${cmd.loose > cmd.cap ? 'bad' : ''}"><b>${cmd.loose}/${cmd.cap}</b>loose / capacity</span></div><p class="muted small">Armies, deployed formations and missions are easy to command. Loose units beyond your command capacity recover morale and suppression more slowly${cmd.over > 0 ? ' — <b>you are over capacity: form armies or deploy formations</b>' : ''}. Capacity grows with cities, armies, Logistics and Networked Command.</p>` : ''}`;
    h += `<p class="muted small">Upkeep: ${e.upkeep ? `${e.upkeep.credits.toFixed(1)} credits/s, ${e.upkeep.fuel.toFixed(2)} fuel/s` : '—'}. Advanced units cost more to run.</p></div>`;
    // formations
    const fs = e.formations || [];
    h += `<div class="ws-card"><h4>Formations (${fs.length})</h4>${fs.length ? `<ul class="log">${fs.map((f) => `<li><b>${esc({ line: 'Line', compact: 'Compact line', depth: 'Defense in depth', preserve: 'Formation' }[f.mode] || f.mode)}</b> · ${f.units.length} units · ${esc({ hold: 'hold line', defend: 'defend line', attackMove: 'advance' }[f.behavior] || f.behavior)} · <span class="${f.status === 'deployed' ? 'good' : 'muted'}">${f.status}</span>${f.detached.length ? ` · ${f.detached.length} detached` : ''} <button class="btn tiny" data-fsel="${f.id}">Select</button></li>`).join('')}</ul>` : '<p class="muted">Right-drag with units selected to draw a deployment line.</p>'}</div>`;
    const cv = e.convoys || [];
    h += `<div class="ws-card"><h4>Logistics (${cv.length} truck${cv.length === 1 ? '' : 's'})</h4>${cv.length ? `<table class="grid"><tr><th>Truck</th><th>Status</th><th>Cargo</th><th>ETA</th></tr>${cv.map((c) => `<tr><td>#${c.truck}</td><td>${esc(c.state)}${c.note ? ` <small class="muted">${esc(c.note)}</small>` : ''}</td><td>${c.cargo}</td><td>${c.eta != null ? c.eta + 's' : '—'}</td></tr>`).join('')}</table>` : '<p class="muted">No supply trucks. Train them at a settlement hub or motor works (needs Motorization).</p>'}
      ${(e.caches || []).length ? `<p class="muted">${e.caches.length} field cache${e.caches.length > 1 ? 's' : ''}: ${e.caches.map((c) => `<a href="#" data-jump="${c.t}">${c.cargo} cargo</a>`).join(', ')}</p>` : ''}
      <p class="muted small">Units cut off from the network live on their own reserves: entrenched infantry last longest, marching troops the shortest. Trucks carry finite cargo from a city or depot.</p></div>`;
    h += `<div class="ws-card"><h4>Armies</h4>${this.tab_armies()}</div>`;
    return h + '</div>';
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
    if (e.market && !S.spectator) {
      h += `<h4>World market</h4><p class="muted">Buy what your land cannot provide. Each market brings in ${D.IMPORT_PER_MARKET} units a minute; trade agreements lower prices.</p><div class="market">`;
      for (const [k, q] of Object.entries(e.market)) h += `<div><span>${esc(D.GOOD_NAMES[k] || k)}</span>${q.error ? `<small class="muted">${esc(q.error)}</small>` : `<small>${q.unit} cr · ${q.room} available</small><button class="btn small" data-import="${k}" data-amount="${Math.min(50, q.room)}">Buy ${Math.min(50, q.room)}</button>`}</div>`;
      h += '</div>';
    }
    if (e.upkeep) h += `<p class="muted">Army upkeep ${e.upkeep.credits} credits/s${e.upkeep.fuel ? `, ${e.upkeep.fuel} fuel/s` : ''} — grows faster than the army itself.</p>`;
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
        <div class="meta">${a.units.length} units · ${a.men} soldiers${o.kind && o.kind !== 'idle' ? ` · order: ${esc(o.kind)}${o.phase ? ` (${esc(o.phase)})` : ''}` : ''}</div>
        <div class="opind">${[['Supply', a.supply], ['Readiness', a.readiness], ['Sustainability', a.sustain], ['Cohesion', a.cohesion]].map(([n, v]) => `<span class="ind ${v < 35 ? 'bad' : v < 65 ? 'mid' : ''}" title="${esc(n)}"><b>${v ?? '–'}%</b>${n}</span>`).join('')}</div>
        ${a.issues?.length ? `<div class="meta warn">${esc(a.issues.join(' · '))}</div>` : ''}
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
      h += `<div class="civrow"><div class="hd"><span class="swatch" style="background:${cssColor(c.color)}"></span><b>${esc(c.name)}</b>${c.rebel ? ' <span class="tag">rebels</span>' : ''}${c.ai ? ` <span class="tag" title="AI rules: ${c.ai.advantages && c.ai.advantages.econ !== 1 ? `economy ×${c.ai.advantages.econ}, research ×${c.ai.advantages.research}, army ×${c.ai.advantages.army}` : 'no numerical advantages (fair play)'}${c.ai.profile === 'legacy' ? ' — legacy settings from an older save' : ''}">AI ${esc(({ easy: 'Relaxed', normal: 'Standard', hard: 'Hard', expert: 'Expert', brutal: 'Brutal' })[c.ai.difficulty] || '')}${c.ai.advantages && c.ai.advantages.econ !== 1 ? ' +bonus' : ''}${c.ai.profile === 'legacy' ? ' (legacy)' : ''}</span>` : ''}<span class="state ${r.state}">${c.alive ? r.state : 'fallen'}</span></div>`;
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
    if (this.ws === 'research') return;              // the research workspace handles its own clicks
    const t = ev.target.closest('button,[data-jump],[data-efilter],[data-esort],[data-chron],[data-chain],[data-fsel]'); if (!t) return;
    const d = t.dataset;
    if (d.chain) { ev.preventDefault(); this.chainGood = d.chain; this.drawerKey = ''; this.drawer(true); return; }
    if (d.fsel) { this.A.selectFormation(+d.fsel); return; }
    if (d.import) { this.A.cmd({ c: 'import', good: d.import, amount: +d.amount }).then((r) => { if (r.bought) this.toast({ text: `Imported ${r.bought.amount} ${D_name(this.S, r.bought.good)} for ${r.bought.credits} credits.`, kind: 'build', level: 'minor' }); }); return; }
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
    if (t.dataset.chainsel) { this.chainGood = t.value; this.drawerKey = ''; this.drawer(true); return; }
    if (t.dataset.armyFormation) this.A.cmd({ c: 'army', op: 'formation', id: +t.dataset.armyFormation, formation: t.value });
    if (t.dataset.armyStance) this.A.cmd({ c: 'army', op: 'stance', id: +t.dataset.armyStance, stance: t.value });
  }

  tooltip(tile, x, y) {
    const tip = $('tooltip'), S = this.S;
    if (tile < 0 || S.terr[tile] === 255) { tip.hidden = true; return; }
    const D = S.defs, t = D.TERRAIN[S.terr[tile]];
    const parts = [];
    const b = S.buildingAtTile.get(tile);
    if (b) {
      const d = D.BUILDINGS[b.ty], city = b.ty === 'town' ? S.cityAt.get(tile) : null;
      parts.push(`<b class="tt-b">${esc(city ? city.n : d.name)}</b> <span class="muted">${esc(city ? d.name : '')} · ${esc(S.civInfo[b.o]?.name || '')}</span>`);
      const why = { staff: 'Idle: no workers. The city needs more people (housing, food) or fewer job buildings.', power: 'Brownout: not enough power. Build or staff a power plant.', rare: 'Needs a rare-earth deposit in your territory.' };
      const state = b.f ? '<span class="bad">On fire</span> — engineers nearby put it out' : b.st === 'damaged' ? '<span class="bad">Damaged</span> — half output until repaired' : b.st === 'planned' ? '<span class="warn">Planned</span> — starts when the resources are available' : !b.d ? `<span class="warn">Under construction ${b.p}%</span>` : b.a ? '<span class="good">Working</span>' : 'Idle';
      parts.push(state + (b.hp < 100 && b.d ? ` · condition ${b.hp}%` : ''));
      if (b.w && why[b.w]) parts.push(`<span class="warn">${why[b.w]}</span>`);
      else if (b.w && b.w.startsWith('input:')) parts.push(`<span class="warn">Short of ${esc((D.GOOD_NAMES[b.w.slice(6)] || b.w.slice(6)).toLowerCase())}: output limited.</span>`);
      if (b.q?.length) parts.push(`Training ${b.q.map(([u, s2]) => `${esc(D.UNITS[u].name)} (${s2}s)`).join(', ')}`);
      parts.push('<hr>');
    }
    parts.push(`<b>${esc(t.name)}</b>`);
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
  const d0 = Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
  if (!S.wrap) return d0;
  return Math.min(d0, Math.max(Math.abs(ax - bx - S.W), Math.abs(ay - by), Math.abs(az - bz + S.W)), Math.max(Math.abs(ax - bx + S.W), Math.abs(ay - by), Math.abs(az - bz - S.W)));
}
function mix(a, b, t) { const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255, br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255; return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t); }

// One building's staffing in plain words (mirrors server/sim/workforce.js staffingText).
function staffText(b, D) {
  const d = D.BUILDINGS[b.ty]; if (!d.jobs) return '';
  const head = `${b.s || 0}/${d.jobs[1]} ${d.jobs[0]}s`, w = b.w || '';
  const cat = { food: 'agriculture', industry: 'industry', research: 'research', commerce: 'commerce' };
  if (b.off || w === 'off') return `${head} — disabled by player`;
  if (w === 'locked') return `${head} — locked by player`;
  if (w === 'rare') return `${head} — needs rare earths`;
  if (w === 'power') return `${head} — not enough power`;
  if (w === 'full') return `${head} — storage for its output is full`;
  if (w.startsWith('input:')) return `${head} — no incoming ${(D.GOOD_NAMES[w.slice(6)] || w.slice(6)).toLowerCase()}`;
  if (w === 'prio:off') return `${head} — its category is switched off`;
  if (w.startsWith('prio:')) return `${head} — ${cat[w.slice(5)] || w.slice(5)} has higher priority`;
  if (w === 'surplus') return `${head} — not needed: food target met`;
  if (w === 'staff') return `${head} — no workers available`;
  if (w === 'under') return `${head} — understaffed`;
  return `${head} — operating`;
}
const D_name = (S, k) => (S.defs.GOOD_NAMES[k] || k).toLowerCase();

// Replace only the top-level children that changed, so buttons the player is about to click
// are not swapped out underneath the pointer every time a number updates.
function patchHtml(el, html) {
  const t = document.createElement('template'); t.innerHTML = html;
  const next = [...t.content.childNodes], cur = [...el.childNodes];
  if (cur.length !== next.length || document.activeElement && el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') {
    if (cur.length === next.length) { next.forEach((n, i) => { if (!cur[i].isEqualNode(n) && !cur[i].contains(document.activeElement)) el.replaceChild(n, cur[i]); }); return; }
    el.replaceChildren(...next); return;
  }
  next.forEach((n, i) => { if (!cur[i].isEqualNode(n)) el.replaceChild(n, cur[i]); });
}

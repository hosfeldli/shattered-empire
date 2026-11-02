// DOM HUD: resources & alerts, selection & city management (incl. governors),
// build bar, road planner, and the drawer (tech graph, realm, empire overview, armies,
// diplomacy, chronicle + command history). The HUD only ever sends intents to the server.
import { wrappedIntervals } from './visual/WorldWrapGeometry.js';
import { unitIconURL } from './visual/UnitIcons.js';
import { findMatch } from './view.js';
import { ResearchWorkspace } from './research/ResearchWorkspace.js';
import { EconomyWorkspace } from './economy/EconomyWorkspace.js';
import { Finder } from './finder.js';
import { CommandBar } from './commandBar.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (n) => (Math.abs(n) >= 10000 ? (n / 1000).toFixed(0) + 'k' : Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.floor(n).toString());
const cssColor = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
const CAT_ORDER = ['civic', 'residential', 'agri', 'industry', 'power', 'commerce', 'science', 'logistics', 'military'];
const CAT_NAME = { civic: 'Civic', residential: 'Housing', agri: 'Food', industry: 'Industry', power: 'Power', commerce: 'Commerce', science: 'Science', logistics: 'Logistics', military: 'Military' };

export class Hud {
  constructor(S, actions) {
    this.S = S; this.A = actions; this.tab = 'research'; this.cityTab = 'overview'; this.empireSort = ['pop', -1]; this.empireFilter = 'all';
    this.alerts = []; this.unseen = { critical: 0, major: 0 };
    this.mctx = $('minimap').getContext('2d');
    // management workspaces open from the command rail; the map stays the primary surface
    this.cmdbar = new CommandBar(S, $('cmdbar'), (c, kind) => actions.act(c, kind));
    this.ws = null; this.research = new ResearchWorkspace(S, actions); this.alertFilter = 'all'; this.toastGroups = new Map();
    this.econ = new EconomyWorkspace(S, actions); this.finder = new Finder(S, actions);
    // a resource name anywhere (top bar, costs, alerts) opens its explanation
    $('resources').addEventListener('click', (e) => { const li = e.target.closest('[data-res]'); if (li) this.openResource(li.dataset.res); });
    $('resources').addEventListener('keydown', (e) => { const li = e.target.closest('[data-res]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.openResource(li.dataset.res); } });
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
    // remember whether the optional orders are unfolded across panel refreshes
    $('selection').addEventListener('toggle', (e) => { if (e.target.classList?.contains('more-orders')) this.moreOpen = e.target.open; }, true);
    $('selection').addEventListener('dblclick', (e) => { const c = e.target.closest('[data-card]'); if (c) this.A.selectType(c.dataset.card, !(e.ctrlKey || e.metaKey)); });
    $('selection').addEventListener('change', (e) => this.onSelChange(e));
    $('buildbar').addEventListener('click', (e) => {
      if (e.target.closest('[data-showlocked]')) { this.showLocked = !this.showLocked; this.bbKey = ''; this.buildbar(); return; }
      const b = e.target.closest('[data-build],[data-tool]'); if (b && !b.disabled) this.A.buildMode(b.dataset.build || null, b.dataset.tool || null);
    });
    $('roadPanel').addEventListener('click', (e) => this.onRoadClick(e));
    $('placePanel').addEventListener('click', (e) => { const r = e.target.closest('[data-res]'); if (r) this.openResource(r.dataset.res); });
    $('specbar').addEventListener('click', (e) => {
      if (e.target.closest('[data-aidiag]')) return this.aiDiag();
      const b = e.target.closest('[data-follow],[data-speed],[data-fog]'); if (!b) return;
      if (b.dataset.follow) this.A.follow(+b.dataset.follow);
      else if (b.dataset.speed) this.A.speed(+b.dataset.speed);
      else if (b.dataset.fog) this.A.fog(b.dataset.fog === '1');
    });
    $('roadPanel').addEventListener('change', (e) => { if (e.target.id === 'roadType') this.A.roadType(+e.target.value); if (e.target.id === 'roadAuto') this.A.roadAuto(e.target.checked); });
    $('alertsBtn').addEventListener('click', () => { const a = $('alerts'); a.hidden = !a.hidden; this.unseen = { critical: 0, major: 0 }; this.alertBadges(); this.renderAlerts(); this.layoutPanels(); });
    $('alertsClear').addEventListener('click', () => { this.alerts = []; this.renderAlerts(); });
    $('missileBanner').addEventListener('click', (e) => { const b = e.target.closest('[data-jump]'); if (b) this.A.jump(+b.dataset.jump); });
    $('alertList').addEventListener('click', (e) => {
      const a = e.target.closest('[data-ract]'); if (a) { try { this.A.resourceAction(JSON.parse(a.dataset.ract)); } catch { /* ignore */ } return; }
      const r = e.target.closest('[data-res]'); if (r) return this.openResource(r.dataset.res);
      const li = e.target.closest('[data-jump]'); if (li) this.A.jump(+li.dataset.jump);
    });
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
    const sc = [['rifles', '10 v 10 rifle squads'], ['mixed', '20 mixed vs 12 defenders'], ['armor', 'Tanks vs fortified position'], ['artillery', 'Artillery bombardment'], ['large', '30 v 30 combined arms'], ['air', 'Air operations vs troops and AA'], ['strategic', 'Strategic missile strike']];
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
    // persistent items updated in place: hovering, focus and clicks are never interrupted by a refresh
    const rows = D.GOODS.filter((k) => k === 'food' || k === 'materials' || k === 'credits' || (e.res[k] || 0) > 0 || (e.rates[k] || 0) !== 0).map((k) => {
      const r = e.rates[k] || 0, v = e.res[k] || 0, rep = e.resources?.[k];
      const net = rep ? rep.net : r;
      const tr = Math.abs(net) < 0.05 ? ['flat', '▸'] : net > 0 ? ['up', '▲'] : ['down', '▼'];
      const endure = rep && rep.lasts != null ? ` — runs out in ${rep.lasts >= 120 ? Math.round(rep.lasts / 60) + ' min' : rep.lasts + ' s'}` : '';
      const bad = rep ? rep.status === 'deficit' || rep.status === 'empty' : r < -0.05 && v / -r < 180;
      return { key: k, label: D.GOOD_NAMES[k], value: fmt(v), tr, cls: bad ? 'short' : '', res: k, title: `${D.GOOD_NAMES[k]}: ${fmt(v)}${k !== 'credits' ? ` of ${e.storage}` : ''}, ${net >= 0 ? '+' : ''}${net.toFixed(1)}/s${endure}. Click: what it is, what makes it and what to do.` };
    });
    if (e.power && (e.power.gen || e.power.use)) rows.push({ key: 'power', label: 'Power', value: `${e.power.gen}/${e.power.use}`, cls: e.power.gen < e.power.use ? 'short' : '', title: 'Power grid: generation / demand' });
    rows.push({ key: 'forces', label: 'Forces', value: fmt(e.men || 0), cls: '', title: `Soldiers represented by your units${e.command ? `; command: ${e.command.organised} organised, ${e.command.loose} loose of ${e.command.cap} capacity` : ''}` });
    const ul = $('resources'), ord = rows.map((r) => r.key).join();
    if (ord !== this.resOrder) {
      this.resOrder = ord; ul.textContent = '';
      for (const r of rows) {
        const li = document.createElement('li'); li.dataset.key = r.key;
        if (r.res) { li.dataset.res = r.res; li.tabIndex = 0; li.setAttribute('role', 'button'); }
        li.innerHTML = `<span class="k"></span><b></b>${r.tr ? '<span class="tr"></span>' : ''}`; li.querySelector('.k').textContent = r.label;
        ul.appendChild(li);
      }
    }
    for (const r of rows) {
      const li = ul.querySelector(`li[data-key="${r.key}"]`); if (!li) continue;
      const b2 = li.querySelector('b'); if (b2.textContent !== r.value) b2.textContent = r.value;
      if (li.className !== r.cls) li.className = r.cls;
      if (li.title !== r.title) li.title = r.title;
      const t = li.querySelector('.tr'); if (t && r.tr) { if (t.textContent !== r.tr[1]) t.textContent = r.tr[1]; const c = 'tr ' + r.tr[0]; if (t.className !== c) t.className = c; }
    }
    // research chip
    const cur = e.research ? D.TECHS[e.research] : null;
    $('rcName').textContent = cur ? (e.autoTech ? '⟳ ' : '') + cur.name : e.autoTech ? 'Research: automatic' : 'No research — choose one';
    $('rcBar').style.width = cur ? `${Math.min(100, (100 * e.progress) / cur.cost)}%` : '0';
    $('rcEta').textContent = cur && e.researchRate > 0 ? `${Math.ceil((cur.cost - e.progress) / e.researchRate)}s · ${e.queue.length} queued` : e.queue.length ? `${e.queue.length} queued` : '';
    $('researchChip').classList.toggle('idle', !cur);
    if (this.ws === 'research') this.research.refresh();
  }
  clock(time, rtt) { const t = Math.floor(time); $('clock').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; $('net').textContent = rtt ? `${rtt} ms` : ''; }

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
    while (box.children.length > 3) box.lastElementChild.remove();      // never a wall of messages over the map
    while (box.children.length > 4) box.lastChild.remove();
    const timer = setTimeout(() => el.remove(), lvl === 'critical' ? 10000 : m.kind === 'warning' || m.kind === 'proposal' ? 7000 : 4000);
    this.toastGroups.set(key, { el, n: 1, timer });
  }
  // clicking an alert opens what it is about
  openAlertTarget(m) {
    if (m.kind === 'proposal' || m.kind === 'diplo') return this.openWorkspace('diplomacy');
    if (m.kind === 'tech' || m.kind === 'age') return this.openWorkspace('research');
    if (m.good) return this.openResource(m.good);
    if (m.kind === 'famine' || m.kind === 'shortage') { if (m.tile >= 0) this.A.jump(m.tile); return this.openResource('food'); }
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
  // one alerts button: a bell, and a single badge (red when anything critical is unseen)
  alertBadges() {
    const c = this.unseen.critical, m = this.unseen.major, n = c + m, el = $('alN');
    el.textContent = n > 99 ? '99+' : String(n); el.hidden = !n; el.classList.toggle('critical', c > 0);
    $('alertsBtn').title = n ? `Alerts: ${c ? `${c} critical` : ''}${c && m ? ', ' : ''}${m ? `${m} important` : ''} since you last looked` : 'Alerts: nothing new';
  }
  renderAlerts() {
    const list = this.alerts.filter((m) => this.alertFilter === 'all' || this.alertCategory(m) === this.alertFilter);
    // a shortage alert carries its valid actions (from the live resource report)
    const acts = (m) => { const r = m.good && this.S.econ?.resources?.[m.good]; return r ? `<div class="actions">${[{ a: 'inspect', good: m.good, label: 'Explain' }, ...r.actions.slice(0, 3)].map((a) => `<button type="button" class="btn tiny" data-ract='${esc(JSON.stringify({ ...a, good: a.good || m.good }))}' ${a.disabled ? 'disabled' : ''} title="${esc(a.why || '')}">${esc(a.label)}</button>`).join('')}</div>` : ''; };
    $('alertList').innerHTML = list.map((m) => `<li class="lv-${m.level} cat-${this.alertCategory(m)}" ${m.tile >= 0 ? `data-jump="${m.tile}"` : ''}><time>${Math.floor(m.time / 60)}:${String(m.time % 60).padStart(2, '0')}</time>${esc(m.text)}${m.n > 1 ? ` <span class="muted">×${m.n}</span>` : ''}${acts(m)}</li>`).join('') || '<li class="lv-info">No alerts.</li>';
  }
  openResource(k) { this.openWorkspace('economy'); this.econ.tab = 'resources'; this.econ.good = k; this.drawerKey = ''; this.drawer(true); }

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
    if (S.deposits) { c.fillStyle = '#6fc3ff'; for (const t of S.deposits.tiles) { const q = t % W, r = (t / W) | 0; c.fillRect((q + 0.5 * (r & 1)) * sx - 1.5, r * sy - 1.5, 3, 3); } }
    if (S.find || S.findIds) for (const b of S.buildings.values()) if (b.o === S.civId && (S.findIds ? S.findIds.has(b.id) : findMatch(S, b.ty, S.find))) { const q = b.t % W, r = (b.t / W) | 0; c.fillStyle = '#f1c75b'; c.strokeStyle = '#0b1518'; c.beginPath(); c.arc((q + 0.5 * (r & 1)) * sx, r * sy, 3.2, 0, 7); c.fill(); c.stroke(); }
    for (const city of S.cities.values()) { c.fillStyle = cssColor(S.civColor(city.o)); c.strokeStyle = '#f3eedf'; const q = city.t % W, r = (city.t / W) | 0; c.fillRect((q + 0.5 * (r & 1)) * sx - 3, r * sy - 3, 6, 6); c.strokeRect((q + 0.5 * (r & 1)) * sx - 3, r * sy - 3, 6, 6); }
    const v = view; const [x0, y0] = v.screenToWorld(0, 0); const [x1, y1] = v.screenToWorld(v.app.screen.width, v.app.screen.height);
    const kx = MW / v.pw, ky = MH / v.ph;
    c.strokeStyle = '#f1c75b'; c.lineWidth = 1;
    if (v.wrap) {
      // one canonical world: a viewport across the seam is two pieces of one rectangle, open at the seam
      const P = v.P * kx, ya = y0 * ky, yb = y1 * ky, parts = wrappedIntervals(x0 * kx, x1 * kx, P);
      c.beginPath();
      if (parts.length === 1) c.rect(parts[0][0], ya, parts[0][1] - parts[0][0], yb - ya);
      else {
        const [[a, pe], [, b]] = parts;
        c.moveTo(pe, ya); c.lineTo(a, ya); c.lineTo(a, yb); c.lineTo(pe, yb);   // east piece, open toward the seam
        c.moveTo(0, ya); c.lineTo(b, ya); c.lineTo(b, yb); c.lineTo(0, yb);     // west piece
      }
      c.stroke();
    } else c.strokeRect(x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky);
  }

  // ------------------------------------------------------------ build bar
  // Build palette, grouped. Defenses: trench lines (drawn like roads), then the four installations,
  // each with one sentence on its role; "Show locked" reveals future defenses and what they need.
  buildbar() {
    const S = this.S, e = S.econ; if (!e) return;
    const D = S.defs, techs = new Set(e.techs);
    const unlocked = ([k, d]) => d.age <= e.age && (!d.tech || techs.has(d.tech));
    const DEF = ['guard_post', 'bunker', 'fort', 'aa_battery'];
    const items = Object.entries(D.BUILDINGS).filter(([k, d]) => k !== 'town' && !d.rebelOnly && !d.obsolete && !DEF.includes(k) && unlocked([k, d]))
      .sort((a, b) => CAT_ORDER.indexOf(a[1].cat) - CAT_ORDER.indexOf(b[1].cat));
    const afford = (c) => Object.entries(c).every(([k, v]) => (e.res[k] || 0) >= v);
    const cost = (c) => Object.entries(c).map(([k, v]) => `${v} ${D.GOOD_NAMES[k].toLowerCase()}`).join(', ') || 'free';
    const btn = ([k, d], locked) => `<button class="buildbtn${S.mode?.type === k ? ' active' : ''}${afford(d.cost) ? '' : ' poor'}${locked ? ' locked' : ''}" data-build="${k}" ${locked ? 'disabled' : ''} title="${esc(d.name)} (${CAT_NAME[d.cat] || ''}): ${esc(cost(d.cost))}${d.desc ? '. ' + esc(d.desc) : ''}${locked ? `. Needs ${esc(d.tech ? D.TECHS[d.tech].name : D.AGES[d.age].name)}.` : afford(d.cost) ? '' : '. Not enough now: placing it plans it, and building starts when funded.'}"><span class="g">${d.glyph}</span><span class="n">${esc(d.name)}</span><small>${locked ? 'needs ' + esc(d.tech ? D.TECHS[d.tech].name : D.AGES[d.age].name) : esc(cost(d.cost))}</small></button>`;
    let html = '';
    let cat = null;
    for (const it of items) { if (it[1].cat !== cat) { cat = it[1].cat; html += `<span class="bb-hd">${esc(CAT_NAME[cat] || cat)}</span>`; } html += btn(it, false); }
    html += `<span class="bb-hd">Infrastructure</span><button class="buildbtn tool${S.mode?.kind === 'road' ? ' active' : ''}" data-tool="road" title="Road planner: drag or click waypoints, preview cost, then commission (R)"><span class="g">\u{1F6E4}</span><span class="n">Plan road</span><small>dirt / paved / highway / rail</small></button><button class="buildbtn tool${S.mode?.kind === 'bridge' ? ' active' : ''}" data-tool="bridge" title="Bridge: click both banks of a river or narrow strait; timber, reinforced or rail"><span class="g">\u{1F309}</span><span class="n">Bridge</span><small>timber / reinforced / rail</small></button>`;
    if (techs.has('civil_engineering')) html += `<button class="buildbtn tool${S.mode?.kind === 'clearPass' ? ' active' : ''}" data-tool="clearPass" title="Blast a passage through impassable peaks"><span class="g">\u{1F9E8}</span><span class="n">Clear peak</span><small>120 materials, 40 munitions</small></button>`;
    // defenses
    html += `<span class="bb-hd">Defenses</span><button class="bb-toggle${this.showLocked ? ' on' : ''}" data-showlocked="1" title="Show defenses you have not unlocked yet, and what they need">${this.showLocked ? 'Hide' : 'Show'} locked</button>`;
    html += `<button class="buildbtn tool${S.mode?.kind === 'trench' ? ' active' : ''}" data-tool="trench" title="Trench Line: draw a connected defensive line across the map; crews build it without troops. Cover and low supply use for infantry holding it."><span class="g">\u{26CF}</span><span class="n">Trench Line</span><small>${techs.has('fortification') ? '6–10' : '6'} materials per hex</small></button>`;
    for (const k of DEF) { const d = D.BUILDINGS[k]; const ok = unlocked([k, d]); if (ok || this.showLocked) html += btn([k, d], !ok); }
    const key = html.length + '|' + JSON.stringify(Object.values(e.res).map((v) => Math.floor(v / 10))) + S.mode?.kind + S.mode?.type + this.showLocked;
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
        + `<small>${dead ? 'fallen' : `${sm.cities ?? '?'} ${sm.cities === 1 ? 'city' : 'cities'} · ${sm.pop ?? '?'} pop · era ${(c.age ?? 0) + 1}${sm.posture ? ' · ' + esc(sm.posture) : ''}`}</small></button>`;
    }).join('')}</div>`;
    h += `<div class="seg spec-speed" role="group" aria-label="Match speed">${[[0, 'Pause'], [1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']].map(([v, n]) => `<button class="${o.speed === v ? 'on' : ''}" data-speed="${v}" title="${v ? `Run at ${v}× speed` : 'Pause the match'} (P pause, , and . step)">${n}</button>`).join('')}</div>`;
    h += `<button class="btn small ghost" data-aidiag="1" title="The followed AI's plan, objectives, memory and decision record">AI plan</button>`;
    h += `<div class="seg spec-fog" role="group" aria-label="Fog of war"><button class="${o.fog ? '' : 'on'}" data-fog="0" title="Reveal the whole continent (V toggles)">No fog</button><button class="${o.fog ? 'on' : ''}" data-fog="1" title="See only what the followed empire sees (V toggles)">Their fog</button></div>`;
    if (h !== this.specHtml) { this.specHtml = h; el.innerHTML = h; }
  }

  // the developer inspector for spectators: the followed AI's full plan and decision record
  async aiDiag() {
    const S = this.S, r = await this.A.cmd({ c: 'aiDiag', civ: S.civId });
    const d = r?.diag; const el = $('aiDiagPanel');
    if (!d) { this.toast({ text: 'That empire is not run by the AI.', kind: 'info', level: 'minor' }); return; }
    const q = d.quality || {};
    el.hidden = false;
    el.innerHTML = `<div class="hd"><b>${esc(S.civInfo[S.civId]?.name || '')}: ${esc(d.posture || '')}</b><button class="btn small ghost" data-close-diag>Close</button></div>
      <p class="muted">Goal: <b>${esc(d.goal || '')}</b>${d.why ? ` (${esc(d.why)})` : ''}</p>
      ${(d.objectives || []).map((o) => `<div class="small">Objective: take hex ${o.target}: stage <b>${esc(o.stage || '')}</b>, ${esc(o.status)}, ${o.units} units</div>`).join('') || '<div class="small muted">No campaign under way.</div>'}
      <dl class="kv small"><dt>Orders</dt><dd>${q.orders} sent, ${q.refused} refused (${q.duplicates} duplicate, ${q.ownershipConflicts} not owner, ${q.jitter} jitter), ${q.failed} failed</dd><dt>Plans</dt><dd>${q.stalls} stalls, ${q.recovered} recovered, ${q.abandoned} abandoned, ${q.reversals} reversals, ${q.oscillations} oscillations</dd>
      <dt>Memory</dt><dd>${d.memory.sightings} sightings, ${d.memory.battles} losses, ${d.memory.raids} raided regions, ${d.memory.routes} failed routes</dd><dt>Reserved</dt><dd>${esc(Object.entries(d.reserved || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing')}</dd>
      <dt>Traits</dt><dd>${esc(Object.entries(d.traits || {}).map(([k, v]) => `${k} ${v}`).join(', '))}</dd></dl>
      <ul class="log small">${(d.log || []).slice().reverse().map((l) => `<li><span class="muted">${Math.floor(l.at / 60)}:${String(Math.floor(l.at % 60)).padStart(2, '0')}</span> <b>${esc(l.kind)}</b> ${esc(l.text)}${l.by ? ` <span class="muted">(${esc(l.by)})</span>` : ''}</li>`).join('')}</ul>`;
    el.onclick = (e) => { if (e.target.closest('[data-close-diag]')) el.hidden = true; };
  }

  // ------------------------------------------------------------ road planner
  roadPanel() {
    const S = this.S, m = S.mode, el = $('roadPanel');
    if (m && m.kind === 'trench') return this.trenchPanel();
    if (m && m.kind === 'bridge') return this.bridgePanel();
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
  bridgePanel() {
    const S = this.S, m = S.mode, el = $('roadPanel'), D = S.defs, techs = new Set(S.econ?.techs || []);
    el.hidden = false;
    const C = D.BRIDGE_CLASSES || {};
    const seg = Object.values(C).map((c) => { const ok = !c.tech || techs.has(c.tech); return `<button class="${m.cls === c.key ? 'on' : ''}" data-bridgecls="${c.key}" ${ok ? '' : 'disabled'} title="${esc(c.desc)}${ok ? '' : ' Needs ' + esc(D.TECHS[c.tech]?.name || c.tech) + '.'}">${esc(c.name.replace(' Bridge', ''))}</button>`; }).join('');
    let h = `<h3>Bridge</h3><p class="muted">Click one bank, then the other. A bridge crosses a river or up to ${C[m.cls]?.span || 2} hexes of shallow water; deep sea cannot be bridged.</p><div class="seg">${seg}</div><p class="muted small">${esc(C[m.cls]?.desc || '')}</p>`;
    const p = m.preview;
    if (p) {
      h += `<dl class="kv"><dt>Crossing</dt><dd>${p.water ? `${p.water} hex${p.water > 1 ? 'es' : ''} of water` : 'river'}${p.major ? ' (major river)' : ''}</dd><dt>Cost</dt><dd>${Object.entries(p.cost).map(([k, v]) => `${v} ${D.GOOD_NAMES[k].toLowerCase()}`).join(', ') || 'already built'}</dd><dt>Build time</dt><dd>~${p.time}s</dd><dt>Carries</dt><dd>${C[p.cls]?.heavy ? 'every unit, tanks included' : 'infantry and light vehicles'}</dd></dl>`;
      if (p.blocked) h += `<div class="bad">${esc(p.segments.find((s) => s.reason && !s.skip)?.reason || 'part of it cannot be built')}</div>`;
    } else if (m.error) h += `<div class="bad">${esc(m.error)}</div>`;
    else h += `<p class="muted">${m.from < 0 ? 'Pick the first bank.' : 'Now pick the far bank.'}</p>`;
    h += `<div class="actions"><button class="btn primary" data-bridge="commit" ${p && p.buildable ? '' : 'disabled'}>Build bridge</button><button class="btn small ghost" data-bridge="clear">Clear</button><button class="btn small ghost" data-bridge="close">Close</button></div>`;
    if (h !== this.roadHtml) { this.roadHtml = h; el.innerHTML = h; }
  }
  // Placement preview: what it costs against what you have, what it needs, where it can go, what it
  // would produce (and what would stop it), whether the hovered hex works, and the session so far.
  placePanel() {
    const S = this.S, m = S.mode, el = $('placePanel');
    if (!m || m.kind !== 'build' || !S.econ) { if (!el.hidden) el.hidden = true; return; }
    const D = S.defs, e = S.econ, d = D.BUILDINGS[m.type], t = S.hover;
    const rl = (k, n) => `<button type="button" class="rlink" data-res="${k}">${esc(n)}</button>`;
    const cost = Object.entries(d.cost).map(([k, v]) => { const have = e.res[k] || 0; return `<span class="${have < v ? 'bad' : ''}">${v} ${rl(k, D.GOOD_NAMES[k].toLowerCase())} <small class="muted">(${fmt(have)})</small></span>`; }).join(', ') || 'free';
    const short = Object.entries(d.cost).some(([k, v]) => (e.res[k] || 0) < v);
    let h = `<div class="hd"><b>${esc(d.name)}</b><span class="muted">${esc(CAT_NAME[d.cat] || '')}</span></div>`;
    h += `<div>Cost: ${cost}${short ? '<br><small class="warn">Not enough now: it will be planned and start automatically when funded.</small>' : ''}</div>`;
    h += `<div class="muted small">Built on ${esc(D.PLACE_INFO?.[d.place] || 'any suitable hex')}${d.tech ? ` · ${esc(D.TECHS[d.tech].name)}` : ''} · ${d.time}s to build</div>`;
    // output and what it depends on: never imply full output without workers, power or inputs
    if (d.produce) {
      const per = d.jobs ? d.jobs[1] : 1;
      const out = Object.entries(d.produce).filter(([k]) => k !== 'research').map(([k, v]) => `${(v * per).toFixed(2)} ${rl(k, D.GOOD_NAMES[k].toLowerCase())}/s`).join(', ');
      if (out) h += `<div class="small">Up to ${out} with ${per} ${d.jobs ? d.jobs[0] + 's' : 'staff'}${m.type === 'farm' && t >= 0 && S.terr[t] !== 255 ? ` · soil ${Math.round((D.TERRAIN[S.terr[t]].fert || 0.5) * 100)}%` : ''}.</div>`;
      if (d.produce.research) h += `<div class="small">Research +${(d.produce.research * per).toFixed(2)}/s when staffed.</div>`;
    }
    const needs = [];
    if (d.jobs) { const c = this.nearestCity(t); if (c) needs.push(`${d.jobs[1]} workers (${esc(c.n)} has ${c.lab ?? 0} free)`); }
    if (d.power < 0) needs.push(`${-d.power} power (grid ${e.power?.gen || 0}/${e.power?.use || 0})`);
    if (d.consume) needs.push(...Object.entries(d.consume).map(([k, v]) => `${(v * (d.jobs ? d.jobs[1] : 1)).toFixed(2)} ${rl(k, D.GOOD_NAMES[k].toLowerCase())}/s`));
    if (d.needs === 'rare') needs.push('access to rare earths');
    if (needs.length) h += `<div class="small">Needs ${needs.join(', ')}.</div>`;
    if (d.attack) {
      const near = [...S.buildings.values()].filter((b) => b.o === S.civId && D.BUILDINGS[b.ty].attack && (D.BUILDINGS[b.ty].defense === 'air') === (d.defense === 'air') && t >= 0 && hexDist(S, b.t, t) <= d.range).length;
      h += `<div class="small">${d.defense === 'air' ? 'Engages detected aircraft only' : 'Engages ground units only (cannot target aircraft)'} within ${d.range} hexes${d.ammo ? `; uses ${d.ammo} munitions a shot` : ''}.${near ? ` <span class="warn">Overlaps ${near} existing defense${near > 1 ? 's' : ''}: concentrated fire has diminishing returns.</span>` : ''}</div>`;
      if (d.desc) h += `<div class="muted small">${esc(d.desc)}</div>`;
    }
    // the hovered hex
    if (t >= 0) {
      const ok = m.tiles ? m.tiles.has(t) : null;
      h += ok == null ? '<div class="muted small">Checking valid sites…</div>' : ok ? '<div class="good small">✓ This hex is valid.</div>' : `<div class="bad small">✗ ${esc(this.A.placeProblem ? this.A.placeProblem(m.type, t) : 'not valid here')}</div>`;
    }
    h += `<div class="muted small">${m.tiles ? `${m.tiles.size} valid hex${m.tiles.size === 1 ? '' : 'es'} highlighted.` : ''} Click to place · drag across hexes to place several · Shift+drag to fill an area · Escape to finish.</div>`;
    const s = m.session;
    if (s && s.n) h += `<div class="small"><b>${s.n} ${esc(d.name)}${s.n > 1 ? 's' : ''} placed</b> · ${Object.entries(s.cost).map(([k, v]) => `${v} ${esc(D.GOOD_NAMES[k])}`).join(', ') || 'free'} committed${s.planned ? ` · ${s.planned} awaiting funds` : ''}</div>`;
    if (h !== this.placeHtml) { this.placeHtml = h; el.innerHTML = h; }
    el.hidden = false;
  }
  nearestCity(t) { const S = this.S; let best = null, bd = 1e9; if (!(t >= 0)) return [...S.cities.values()].find((c) => c.o === S.civId && c.cap) || null; for (const c of S.cities.values()) if (c.o === S.civId) { const d = hexDist(S, c.t, t); if (d < bd) { bd = d; best = c; } } return best; }
  onRoadClick(e) {
    const tr = e.target.closest('[data-trench]'); if (tr) return this.A.trench(tr.dataset.trench, tr.dataset.v ?? +tr.dataset.id);
    const r = e.target.closest('[data-res]'); if (r) return this.openResource(r.dataset.res);
    const bc = e.target.closest('[data-bridgecls]'); if (bc) return this.A.bridge('cls', bc.dataset.bridgecls);
    const bb = e.target.closest('[data-bridge]'); if (bb) return this.A.bridge(bb.dataset.bridge);
    const b = e.target.closest('[data-road]'); if (!b) return; this.A.road(b.dataset.road, +b.dataset.id);
  }

  // Trench Line planner: route, valid and invalid segments, facing (reversible), cost, completion.
  trenchPanel() {
    const S = this.S, m = S.mode, el = $('roadPanel'), D = S.defs, e = S.econ;
    el.hidden = false;
    const techs = new Set(e?.techs || []), p = m.preview;
    const types = [['basic', 'Earthworks', '6 materials · 10 s a hex'], ['reinforced', 'Reinforced trench', techs.has('fortification') ? '10 materials · 18 s (4 more to reinforce earthworks)' : 'needs Fortification']];
    let h = `<h3>Trench Line</h3><p class="muted">Drag across the map or click waypoints. Construction crews build it; troops do not need to stand on the line. Infantry holding it get directional cover and use little supply.</p>`;
    h += `<div class="seg">${types.map(([k, n, t]) => `<button class="${m.type === k ? 'on' : ''}" data-trench="type" data-v="${k}" ${k === 'reinforced' && !techs.has('fortification') ? 'disabled' : ''} title="${esc(t)}">${n}</button>`).join('')}</div>`;
    if (p) {
      const reasons = {}; for (const s2 of p.segments) if (!s2.ok) reasons[s2.reason] = (reasons[s2.reason] || 0) + 1;
      h += `<dl class="kv"><dt>Route</dt><dd>${p.tiles.length} hex${p.tiles.length === 1 ? '' : 'es'}</dd><dt>To build</dt><dd>${p.build}${p.segments.some((s2) => s2.upgrade) ? ` (${p.segments.filter((s2) => s2.upgrade).length} reinforced from earthworks)` : ''}${p.segments.some((s2) => s2.skip) ? `, ${p.segments.filter((s2) => s2.skip).length} already there` : ''}</dd>
        <dt>Cost</dt><dd>${Object.entries(p.cost).map(([k, v]) => `<span class="${(e.res[k] || 0) < v ? 'bad' : ''}">${v} <button type="button" class="rlink" data-res="${k}">${esc(D.GOOD_NAMES[k].toLowerCase())}</button></span>`).join(', ') || '—'}</dd>
        <dt>Completion</dt><dd>about ${p.seconds}s with ${p.crews} crews</dd><dt>Protected side</dt><dd>${['east', 'south-east', 'south-west', 'west', 'north-west', 'north-east'][p.dir] || '—'} <button class="btn tiny" data-trench="reverse" title="Protect the other side">⇅ Reverse facing</button></dd></dl>`;
      if (p.invalid) h += `<div class="bad">${p.invalid} segment${p.invalid > 1 ? 's' : ''} cannot be built: ${esc(Object.entries(reasons).map(([r, n]) => `${r} (${n})`).join('; '))}</div>`;
    } else h += `<p class="muted">${m.points.length ? 'Checking the line…' : 'Pick a starting point.'}</p>`;
    h += `<div class="actions"><button class="btn primary" data-trench="commit" ${p && p.build ? '' : 'disabled'}>Build trench line</button><button class="btn small" data-trench="undo" ${m.points.length ? '' : 'disabled'}>Undo point</button><button class="btn small ghost" data-trench="clear">Clear</button><button class="btn small ghost" data-trench="close">Close</button></div>`;
    const pr = e?.trenches?.projects || [];
    if (pr.length) h += `<h4 style="margin:8px 0 2px">Trench projects</h4><ul class="log">${pr.map((x) => `<li><span class="tag ${x.status === 'materials' ? 'warn' : x.status === 'complete' ? 'good' : ''}">${x.status === 'materials' ? 'awaiting materials' : esc(x.status)}</span> ${x.type === 'reinforced' ? 'Reinforced' : 'Earthworks'} ${x.done}/${x.total}${x.eta ? ` · ~${x.eta}s` : ''}${x.by && x.by !== 'player' ? ` <span class="muted">(${esc(x.by)})</span>` : ''} ${x.status !== 'complete' ? `<button class="btn small ghost" data-trench="cancel" data-id="${x.id}">Cancel</button>` : ''}</li>`).join('')}</ul>`;
    if (h !== this.roadHtml) { this.roadHtml = h; el.innerHTML = h; }
  }

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
      } else if (own) html += `<div class="cards">${[...types].map(([t, n]) => `<span class="ucard" data-card="${t}" title="Click: keep only these. Double-click: every ${esc(D.UNITS[t].name)} on screen (Ctrl/Cmd: whole map)"><img class="uicon" src="${unitIconURL(t, D.UNITS[t], S.civColor(S.civId))}" alt=""><b>${n}×</b>${esc(D.UNITS[t].name)}</span>`).join('')}</div>`;
      if (own && D.COMBAT_STATUS) {
        // what the group is doing, from the server's combat state
        const st = {}; for (const u of units) if (!D.UNITS[u.type].civilian && !D.UNITS[u.type].air) { const k = u.cstat || 0; st[k] = (st[k] || 0) + 1; }
        const tone = { 2: 'good', 4: 'bad', 10: 'bad', 9: 'warn', 5: 'warn', 6: 'warn', 8: 'warn' };
        const chips = Object.entries(st).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="tag ${tone[k] || ''}" title="${esc(D.COMBAT_STATUS[k])}">${esc(D.COMBAT_STATUS[k])} ${n}</span>`).join('');
        if (chips) html += `<div class="cstat">${chips}</div>`;
        const mor = Math.round(units.reduce((s2, u) => s2 + (u.morale ?? 100), 0) / units.length), sup = Math.round(units.reduce((s2, u) => s2 + (u.supp || 0), 0) / units.length);
        if (mor < 70 || sup > 15) html += `<div class="${mor < 35 ? 'bad' : 'warn'}">Morale ${mor}%${sup > 15 ? ` · suppression ${sup}%` : ''}${mor < 35 ? ' — units not under your direct orders may fall back' : ''}</div>`;
      }
      html += `<div>Strength ${avg('hp')}%</div><div class="bar hp"><i style="width:${avg('hp')}%"></i></div>`;
      const allAir = units.every((u) => D.UNITS[u.type].air);
      if (own) html += this.aircraftStatus(units);
      if (own && allAir) html += `<p class="muted">Aircraft fly missions from their airfield: Patrol, Strike or Return in the command bar, or right-click (enemy: strike · ground: patrol · own airfield: return).</p>`;
      if (own && !allAir) {
        const outs = units.filter((u) => u.flags & 4).length, waiting = units.filter((u) => u.flags & 8).length, blocked = units.filter((u) => u.flags & 16).length;
        void outs;
        if (waiting) html += `<div class="warn">${waiting} waiting for a congested road or bridge.</div>`;
        // the standardized reason, not just "blocked"
        const fails = {}; for (const u of units) if (u.pf && u.pf !== 'deadlock') fails[u.pf] = (fails[u.pf] || 0) + 1;
        const fk = Object.keys(fails).sort((a, b) => fails[b] - fails[a]);
        if (fk.length) html += `<div class="${fk[0] === 'partial' ? 'warn' : 'bad'}">${fk.map((k) => `${fails[k]} ${units.length > 1 ? 'units: ' : ''}${esc(D.PATH_FAIL[k])}`).join('<br>')}.</div>`;
        else if (blocked) html += `<div class="bad">${blocked} cannot reach their destination: the route is blocked.</div>`;
        // veterancy: experienced units are worth keeping (and refitting rather than replacing)
        const vets = units.filter((u) => u.vet > 0);
        if (vets.length) html += `<div class="muted">${D.VET_NAMES.slice(1).map((n, i) => [n, vets.filter((u) => u.vet === i + 1).length]).filter(([, k]) => k).map(([n, k]) => `${k} ${n.toLowerCase()}`).join(', ')} — +${10 * Math.max(...vets.map((u) => u.vet))}% attack</div>`;
        const inRefit = units.filter((u) => u.refit > 0).length;
        if (inRefit) html += `<div class="warn">${inRefit} in the workshop being refitted.</div>`;
        if (units.length === 1) html += `<dl class="kv"><dt>Attack / Defense</dt><dd>${first.atk} / ${first.def}</dd><dt>Range / Speed</dt><dd>${first.range} / ${first.speed}</dd><dt>Movement</dt><dd>${esc(first.move)}${first.aa ? `, anti-air ×${first.aa}` : ''}</dd></dl>`;
        // one choice: defend (hold where sent, fire at what comes) or attack (fight their way to
        // wherever they are sent); everything else is right-click and right-drag on the map
        const fighters = units.filter((u) => !D.UNITS[u.type].civilian);
        const attack = fighters.length > 0 && fighters.every((u) => u.stance === 'aggressive');
        if (fighters.length) html += `<div class="seg troopmode"><button class="${attack ? '' : 'on'}" data-act="modeDefend" title="Hold where you send them and fire at anything in range">Defend</button><button class="${attack ? 'on' : ''}" data-act="modeAttack" title="Fight their way to wherever you send them, and chase what they see">Attack</button></div>`;
        html += `<div class="howto muted small">Right-click: move · right-drag: line · right-click an enemy: attack</div>`;
        if (units.some((u) => u.type === 'colonist')) html += `<div class="actions"><button class="btn small primary" data-act="found">Found city (F)</button><button class="btn small" data-act="autoSettle">Auto-settle</button></div>`;
        if (units.some((u) => D.UNITS[u.type].engineer)) html += `<p class="muted">Idle engineers repair roads and buildings, fight fires and clear rubble next to them, and speed up nearby construction.</p>`;
        if (units.length === 1 && (S.sandbox || S.dev)) html += `<details class="diag" data-diag="${units[0].id}" ${this.diagOpen ? 'open' : ''}><summary>Diagnostics</summary><pre>${esc(this.diagText || 'loading…')}</pre></details>`;
      }
    } else if (S.selRuin && S.selBuilding == null) {
      const p = S.selRuin.preview, D2 = S.defs;
      html += `<h3>${esc(p?.name ? `Ruins of ${p.name}` : 'Town ruins')}</h3><div class="sub">A destroyed settlement</div>`;
      if (!p) html += `<p class="muted">Checking…</p>`;
      else {
        html += `<p class="muted">Resettling brings the town back with a few families; it is shielded from unrest while it recovers.</p><dl class="kv"><dt>Cost</dt><dd>${Object.entries(D2.REBUILD_COST || {}).map(([k, v]) => `${v} ${esc(D2.GOOD_NAMES[k].toLowerCase())}`).join(', ')}</dd></dl>`;
        if (!p.ok) html += `<div class="warn">${esc(p.why)}</div>`;
        html += `<div class="actions"><button class="btn primary small" data-act="rebuildRuin" ${p.ok ? '' : 'disabled'}>Rebuild settlement</button></div>`;
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
    this.cmdbar.render();
  }

  // formation membership, deployment, fortification and stacks for the selected units
  formationHtml(units) {
    const S = this.S, D = S.defs, e = S.econ; let h = '';
    const fids = new Set(units.map((u) => u.form).filter(Boolean));
    const fs = (e?.formations || []).filter((f) => fids.has(f.id));
    if (fs.length === 1) {
      const f = fs[0], det = units.filter((u) => u.det).length;
      h += `<div class="formation"><b>${esc({ line: 'Line', compact: 'Compact line', depth: 'Defense in depth', preserve: 'Formation' }[f.mode] || 'Formation')}</b> <span class="muted">${f.units.length} units · ${esc(f.status)}</span>
        <div class="seg">${[['hold', 'Hold line', 'Stay in place and fire at what is in range'], ['defend', 'Defend line', 'Engage nearby threats, then return'], ['attackMove', 'Advance', 'Advance the line and engage']].map(([k, n, t]) => `<button class="${f.behavior === k ? 'on' : ''}" data-fbeh="${k}" data-fid="${f.id}" title="${t}">${n}</button>`).join('')}</div>
        <div class="actions">${det ? `<button class="btn small" data-fop="rejoin" data-fid="${f.id}">Return to formation (${det})</button>` : ''}<button class="btn small ghost" data-fop="dissolve" data-fid="${f.id}">Release formation</button></div></div>`;
    }
    // reinforce: some selected units are in a formation, others are not
    const outside = units.filter((u) => !u.form);
    if (fs.length === 1 && outside.length && outside.length < units.length) h += `<div class="actions"><button class="btn small primary" data-fop="reinforce" data-fid="${fs[0].id}">Reinforce formation with ${outside.length}</button></div>`;
    const diggers = units.filter((u) => { const d = D.UNITS[u.type]; return d.engineer || (d.move === 'infantry' && !d.civilian && d.cat !== 'artillery' && d.atk > 0); });
    void diggers;
    // a stack: several units on one hex
    const tiles = new Set(units.map((u) => u.tile));
    if (tiles.size === 1 && units.length > 1) {
      h += `<div class="stack"><b>Stack of ${units.length} on one hex</b> <span class="muted">— one shell hits them all</span><ul class="log">${units.slice(0, 10).map((u) => `<li data-pick="${u.id}">${esc(D.UNITS[u.type].name)} <span class="muted">${u.hp}%${u.supp > 20 ? ` · suppressed ${u.supp}%` : ''}${u.sup < 50 ? ` · supply ${u.sup}%` : ''}</span></li>`).join('')}</ul><div class="actions"><button class="btn small" data-act="spread" title="Spread out over neighbouring hexes">Spread out</button></div></div>`;
    } else if (units.length > 1 && units.length <= 40 && !S.spectator) h += `<p class="muted small">Right-drag to draw a deployment line: longer spreads them out, shorter concentrates them.</p>`;
    return h;
  }

  // Deployment toolbar: visible while drawing a line and whenever several own combat units are
  // selected (so density, depth and behaviour can be chosen before the drag).
  // While right-dragging a battle line: live feedback only. No modes to set: the line spreads units
  // along it (a short line concentrates them), support and artillery fall in behind, and they defend
  // it. Alt+right-drag advances instead; Tab flips the facing; Shift queues.
  deployBar(force) {
    const S = this.S, D = S.defs, el = $('deployBar'); if (!D) return;
    const show = !S.spectator && S.deploy && !(S.mode && ['build', 'road', 'trench', 'missile'].includes(S.mode.kind));
    if (!show) { if (!el.hidden) el.hidden = true; return; }
    const p = S.deploy?.plan;
    let h = `<span class="lbl">Battle line</span>`;
    if (p) {
      const over = p.overflow.length, inv = p.invalid.length;
      h += `<span class="exposure ${p.label}" title="${p.label === 'dense' ? 'Several units share the same few hexes: one shell can hit them all' : p.label === 'concentrated' ? 'Some hexes hold several units' : 'Most units stand on their own hex'}">${{ dispersed: 'Spread out', concentrated: 'Concentrated', dense: 'Packed tight' }[p.label] || ''}</span>`;
      h += `<span class="lbl">${S.deploy.n - over} placed${p.ranks > 1 ? ` · ${p.ranks} ranks` : ''}${over ? ` · <b class="bad">${over} do not fit: draw a longer line</b>` : ''}${inv ? ` · ${inv} hexes impassable` : ''}</span>`;
    }
    h += `<span class="lbl muted">Release to deploy · Alt: advance · Tab: flip facing · Esc: cancel</span>`;
    if (h !== this.dbHtml || force) { this.dbHtml = h; el.innerHTML = h; }
    el.hidden = false;
  }
  // Fortify preview: what will be dug, what it costs and how long it takes, before committing.


  // Several buildings selected: one production interface for all of them.
  multiBuildingPanel(blds) {
    const S = this.S, D = S.defs, e = S.econ;
    const byType = {}; for (const b of blds) byType[b.ty] = (byType[b.ty] || 0) + 1;
    const types = Object.keys(byType), one = types.length === 1 ? D.BUILDINGS[types[0]] : null;
    let html = `<h3>${one ? `${blds.length} × ${esc(one.name)} selected` : `${blds.length} buildings selected`}</h3><div class="sub">${one ? '' : Object.entries(byType).map(([t, n]) => `${n} ${esc(D.BUILDINGS[t].name)}`).join(', ')}</div>`;
    const upg = blds.filter((b) => b.o === S.civId && this.canLevel(b) !== null);
    if (upg.length && !S.spectator) html += this.housingBatchPanel(upg);
    const fac = blds.filter((b) => b.d && b.o === S.civId && D.BUILDINGS[b.ty].trains);
    if (!fac.length) return html;
    const queued = fac.reduce((s2, b) => s2 + (b.q?.length || 0), 0), longest = Math.max(0, ...fac.map((b) => (b.q || []).reduce((s2, q) => s2 + q[1], 0)));
    html += `<div class="muted">${queued} in training${queued ? ` · last finishes in about ${longest}s` : ''}. Right-click the map to set one rally point for all of them.</div>`;
    // consolidated queue: each facility's current unit and progress
    if (queued) html += `<ul class="log cqueue">${fac.filter((b) => b.q?.length).map((b) => { const [u, left] = b.q[0], ud = D.UNITS[u]; const p = Math.max(0, Math.min(100, Math.round(100 * (1 - left / Math.max(1, ud.time))))); return `<li><button type="button" class="rlink" data-jump="${b.t}">${esc(D.BUILDINGS[b.ty].name)}</button> ${esc(ud.name)} ${left}s${b.q.length > 1 ? ` <span class="muted">+${b.q.length - 1} queued</span>` : ''}${b.rp ? ' <span class="tag good">repeat</span>' : ''}<div class="bar sup"><i style="width:${p}%"></i></div></li>`; }).join('')}</ul><div class="actions"><button class="btn small ghost" data-clearq="${fac.map((b) => b.id).join(',')}" title="Cancel everything still queued in these facilities (refunds as for single cancellations; finished units are untouched)">Clear these queues</button></div>`;
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

  // Batch housing upgrades: what is eligible, what it costs, what it adds, then one order.
  // can this building gain a level (housing: storeys)? its upgrade cost, false if not now (maxed,
  // unfinished, era too early), null if it has no levels at all
  canLevel(b) {
    const S = this.S, D = S.defs, e = S.econ || {}, lv = b.lv || 1;
    if (b.ty === 'house') return b.d && lv < 3 ? ((e.age || 0) >= 1 ? { materials: 55 * lv, steel: 12 * lv } : { materials: 60 * lv }) : false;
    const d = D.BUILDINGS[b.ty]; if (!d.jobs || !(d.produce || d.power > 0) || b.ty === 'town') return null;
    if (!b.d || lv >= (D.LEVELS?.max || 3) || (e.age || 0) < (D.LEVELS?.age?.[lv] ?? 9)) return false;
    return b.uc || false;
  }
  // batch upgrades for the selection: housing gains storeys, production buildings a level
  housingBatchPanel(houses) {
    const S = this.S, D = S.defs, e = S.econ;
    const elig = houses.filter((b) => this.canLevel(b)), maxed = houses.filter((b) => b.d && !this.canLevel(b)), unfinished = houses.filter((b) => !b.d);
    const cost = {}; for (const b of elig) for (const [k, v] of Object.entries(this.canLevel(b))) cost[k] = (cost[k] || 0) + v;
    const afford = Object.entries(cost).every(([k, v]) => (e.res[k] || 0) >= v);
    const homes = elig.filter((b) => b.ty === 'house').length * (4 + (e.age || 0));
    const later = maxed.filter((b) => (b.lv || 1) < (b.ty === 'house' ? 3 : D.LEVELS?.max || 3)).length;
    let h = `<ul class="log"><li>${elig.length} ready to upgrade</li>${maxed.length - later ? `<li class="muted">${maxed.length - later} already at the top level</li>` : ''}${later ? `<li class="muted">${later} need the next era</li>` : ''}${unfinished.length ? `<li class="muted">${unfinished.length} unfinished</li>` : ''}</ul>`;
    if (elig.length) {
      h += `<dl class="kv"><dt>Total cost</dt><dd>${Object.entries(cost).map(([k, v]) => `<span class="${(e.res[k] || 0) < v ? 'bad' : ''}">${v} <button type="button" class="rlink" data-res="${k}">${esc(D.GOOD_NAMES[k].toLowerCase())}</button></span>`).join(', ')}</dd><dt>Housing gained</dt><dd>+${homes} homes</dd></dl>`;
      h += `<div class="actions"><button class="btn small primary" data-hup="all" ${afford ? '' : 'disabled'} title="${afford ? 'Upgrade every eligible block in one order' : 'Not enough for all of them: upgrade what is affordable instead'}">Upgrade all eligible</button><button class="btn small" data-hup="affordable" title="Upgrade as many as the stockpile allows, lowest density first; the rest are reported">Upgrade what is affordable</button><button class="btn small ghost" data-hup="preview">Preview costs</button>${elig.length < houses.length ? '<button class="btn small ghost" data-hup="eligible">Select eligible only</button>' : ''}</div>`;
    } else h += '<p class="muted small">Nothing here can be upgraded.</p>';
    if (this.hupResult) h += `<div class="preview small">${esc(this.hupResult)}</div>`;
    return h;
  }

  housingAction(op) {
    const S = this.S, D = S.defs;
    const ids = [...S.selBuildings].filter((id) => { const b = S.buildings.get(id); return b && b.o === S.civId && this.canLevel(b) !== null; });
    if (op === 'eligible') { const el = ids.filter((id) => this.canLevel(S.buildings.get(id))); S.selBuildings = new Set(el); S.selBuilding = el[0] ?? null; this.selHtml = ''; this.selection(); return; }
    const preview = op === 'preview';
    const costTxt = (c) => Object.entries(c || {}).map(([k, v]) => `${v} ${(D.GOOD_NAMES[k] || k).toLowerCase()}`).join(', ') || 'nothing';
    this.A.cmd({ c: 'batchUpgrade', ids, policy: op === 'all' ? 'all' : 'affordable', preview, requestId: preview ? undefined : `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }).then((r) => {
      const u = r.upgrade; if (!u) return;
      const why = {}; for (const s2 of u.skipped || []) why[s2.reason] = (why[s2.reason] || 0) + 1;
      const skipped = Object.entries(why).map(([w, n]) => `${n} ${w}`).join(', ');
      this.hupResult = preview ? `Preview: ${u.eligible.length} eligible · ${costTxt(u.cost)} · +${u.capacity} homes${skipped ? ` · not eligible: ${skipped}` : ''}.` : `${u.upgraded.length} upgraded for ${costTxt(u.cost)} · +${u.capacity} homes${skipped ? ` · skipped: ${skipped}` : ''}.`;
      if (!preview) this.toast({ text: this.hupResult, kind: 'build', level: 'minor' });
      this.selHtml = ''; this.selection();
    });
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

  // Floating panels never cover each other: the right column (alerts, finder, side drawer, inspector)
  // and the bottom-centre stack (command/build bar, deployment bar, placement panel) are laid out in
  // order, so opening one moves the others aside instead of hiding them. Positions animate (CSS).
  layoutPanels() {
    const vis = (el) => el && !el.hidden && el.offsetParent !== null && !el.classList.contains('empty') && el.offsetHeight > 0;
    const top0 = 56, gap = 8;
    let top = top0;
    for (const id of ['alerts', 'finder', 'drawer', 'selection']) {
      const el = document.getElementById(id); if (!el) continue;
      if (id === 'drawer' && el.classList.contains('workspace')) continue;
      if (!vis(el)) continue;
      if (el.dataset.top !== String(top)) { el.style.top = top + 'px'; el.dataset.top = String(top); }
      if (id === 'selection' || id === 'drawer') el.style.maxHeight = `calc(100vh - ${top}px - 236px)`;
      top += el.offsetHeight + gap;
    }
    // top centre: urgent banners (missiles, pause) first, the toast column below them
    let tc = 52;
    for (const id of ['missileBanner', 'pausedBanner']) { const el = document.getElementById(id); if (!vis(el)) continue; el.style.top = tc + 'px'; tc += el.offsetHeight + 6; }
    const toasts = document.getElementById('toasts'); if (toasts) toasts.style.top = Math.max(56, tc) + 'px';
    let bottom = 10;
    for (const id of [['cmdbar', 'buildbar', 'specbar'], 'deployBar', 'placePanel', 'roadPanelBottom']) {
      const ids = Array.isArray(id) ? id : [id];
      const els = ids.map((x) => document.getElementById(x)).filter(vis);
      if (!els.length) continue;
      if (!Array.isArray(id)) for (const el of els) if (el.dataset.bottom !== String(bottom)) { el.style.bottom = bottom + 'px'; el.dataset.bottom = String(bottom); }
      bottom += Math.max(...els.map((e) => e.offsetHeight)) + gap;
    }
  }

  // Missile warning banner: every strategic missile in flight that this nation can see, with countdowns.
  missileBanner() {
    const S = this.S, el = document.getElementById('missileBanner'); if (!el) return;
    const list = S.ms?.m || [];
    if (!list.length) { el.hidden = true; clearInterval(this.mbT); this.mbT = 0; return; }
    const draw = () => {
      const now = S.time + (performance.now() - (S.timeAt || performance.now())) / 1000;
      el.innerHTML = (S.ms?.m || []).map(([id, , to, , arrive, owner]) => `<button type="button" class="mb ${owner === S.civId ? 'own' : 'hostile'}" data-jump="${to}">${owner === S.civId ? 'Our missile' : 'INCOMING MISSILE'} · impact in ${Math.max(0, Math.ceil(arrive - now))} s</button>`).join('');
    };
    el.hidden = false; draw();
    if (!this.mbT) this.mbT = setInterval(() => { if (!(S.ms?.m || []).length) { el.hidden = true; clearInterval(this.mbT); this.mbT = 0; return; } draw(); }, 250);
  }

  // Missile silo: inventory, the project in progress, build and launch.
  siloPanel(b) {
    const S = this.S, D = S.defs, M = D.MISSILE;
    let h = `<div class="airstats"><div><b>${b.mi || 0}</b><span>missiles</span></div><div><b>${M.store}</b><span>capacity</span></div><div><b>${b.mp != null ? b.mp + '%' : '—'}</b><span>project</span></div><div><b>${S.econ?.missiles?.ready ?? 0}</b><span>nation</span></div></div>`;
    if (b.mp != null) h += `<div class="bar"><i style="width:${b.mp}%"></i></div><div class="muted">Building a strategic missile (${Math.round(M.build * (1 - b.mp / 100))} s left).</div>`;
    const cost = Object.entries(M.cost).map(([k, v]) => `<span class="${(S.econ?.res[k] || 0) < v ? 'bad' : ''}">${v} ${esc(D.GOOD_NAMES[k].toLowerCase())}</span>`).join(', ');
    if (!S.spectator) h += `<div class="actions"><button class="btn small" data-act="missileBuild" ${b.mp != null || (b.mi || 0) >= M.store ? 'disabled' : ''} title="Paid up front: ${esc(Object.entries(M.cost).map(([k, v]) => v + ' ' + D.GOOD_NAMES[k].toLowerCase()).join(', '))}">Build missile</button><button class="btn small danger" data-act="missileMode" ${S.econ?.missiles?.ready ? '' : 'disabled'}>Launch…</button></div><div class="muted small">Cost per missile: ${cost} · ${M.build} s · range ${M.range} hexes. Every nation sees a launch coming; upgraded AA with Missile Defense can intercept it; striking anyone turns world opinion against you.</div>`;
    return h;
  }

  // Airfield inspector: what is based here and what it is doing; one-click missions with automatic aircraft choice.
  airfieldPanel(b, d) {
    const S = this.S, D = S.defs, air = S.econ?.air;
    const s = air?.bases.find((x) => x.id === b.id);
    if (!s) return '';
    const craft = (air.craft || []).filter((c) => c.home === b.id);
    let h = `<div class="airstats"><div><b>${s.ready}</b><span>ready</span></div><div><b>${s.patrol + s.mission}</b><span>aloft</span></div><div><b>${s.servicing + s.awaiting}</b><span>servicing</span></div><div><b>${s.returning + s.holding}</b><span>inbound</span></div></div>`;
    h += `<div class="muted">${s.slots} servicing slot${s.slots > 1 ? 's' : ''}${d.droneOnly ? ' · drones only' : ''}${s.holding ? ` · <span class="warn">${s.holding} holding for a slot</span>` : ''}${s.awaiting ? ` · <span class="bad">${s.awaiting} waiting for fuel or munitions</span>` : ''}</div>`;
    if (!S.spectator) {
      const has = (k) => craft.some((c) => k(D.UNITS[c.type]));
      h += `<div class="actions">${has((u) => u.role !== 'recon' && u.role !== 'oneway' && u.role !== 'bomber') ? `<button class="btn small" data-airbase="patrol" data-base="${b.id}" title="Click an area: the best ready aircraft go">Patrol</button>` : ''}${has((u) => u.role !== 'recon') ? `<button class="btn small" data-airbase="strike" data-base="${b.id}" title="Click a target: suitable aircraft are chosen for you">Strike</button>` : ''}${has((u) => u.role === 'recon') ? `<button class="btn small" data-airbase="scout" data-base="${b.id}">Scout</button>` : ''}${craft.length ? `<button class="btn small ghost" data-airbase="select" data-base="${b.id}" title="Select every aircraft based here">Select aircraft</button>` : ''}</div>`;
    }
    if (craft.length) h += `<ul class="airlist">${craft.slice(0, 16).map((c) => `<li data-pick="${c.id}" title="${esc(c.note || '')}"><span>${esc(D.UNITS[c.type].name)}</span><span class="${c.state === 'awaiting' ? 'bad' : c.state === 'holding' || c.state === 'diverting' ? 'warn' : 'muted'}">${esc(this.airStateText(c.state, c.mission?.kind))}${c.svc != null ? ` ${c.svc}%` : ''}</span><span class="mini" title="Fuel ${c.fuel}%"><i style="width:${c.fuel}%;background:${c.fuel < 30 ? '#d0533b' : '#e2b84c'}"></i></span><span class="muted">${c.ammoMax ? `${c.ammo}/${c.ammoMax}` : ''}</span></li>`).join('')}</ul>`;
    else h += `<p class="muted">No aircraft based here yet${(d.trains || []).length ? ': train them below' : ''}.</p>`;
    return h;
  }
  airStateText(st, mis) {
    return { ready: 'ready', launching: 'launching', outbound: 'outbound', mission: { patrol: 'on patrol', scout: 'scouting', strike: 'striking', support: 'supporting' }[mis] || 'on mission', returning: 'returning', landing: 'landing', holding: 'holding', servicing: 'servicing', awaiting: 'needs supplies', diverting: 'diverting' }[st] || st;
  }
  // selected aircraft: state, fuel, ammunition, servicing and why they are waiting
  aircraftStatus(units) {
    const S = this.S, D = S.defs;
    const air = units.filter((u) => u.air && u.air.st);
    if (!air.length) return '';
    const avg = (f) => Math.round(air.reduce((s2, u) => s2 + u.air[f], 0) / air.length);
    const st = {}; for (const u of air) { const k = this.airStateText(u.air.st, u.air.mis); st[k] = (st[k] || 0) + 1; }
    let h = `<div class="cstat">${Object.entries(st).map(([k, n]) => `<span class="tag">${esc(k)}${air.length > 1 ? ' ' + n : ''}</span>`).join('')}</div>`;
    h += `<div>Fuel ${avg('fuel')}%</div><div class="bar"><i style="width:${avg('fuel')}%;background:${avg('fuel') < 30 ? '#d0533b' : '#e2b84c'}"></i></div>`;
    const armed = air.filter((u) => D.UNITS[u.type].ammo);
    if (armed.length) { const a = armed.reduce((s2, u) => s2 + u.air.ammo, 0), m = armed.reduce((s2, u) => s2 + D.UNITS[u.type].ammo, 0); h += `<div>Ammunition ${a} / ${m}</div>`; }
    const svc = air.filter((u) => u.air.st === 'servicing' && u.air.svc >= 0);
    if (svc.length) h += `<div class="muted">Servicing ${Math.round(svc.reduce((s2, u) => s2 + u.air.svc, 0) / svc.length)}% — refuelling, rearming and repairing from national stock.</div>`;
    const crafts = (S.econ?.air?.craft || []).filter((c) => air.some((u) => u.id === c.id) && c.note);
    if (crafts.length) h += `<div class="bad">${esc(crafts[0].note)}</div>`;
    if (air.some((u) => u.air.st === 'diverting')) h += `<div class="warn">Diverting: the home airfield is lost or full; looking for another base.</div>`;
    return h;
  }

  // a city's construction queue in order: what is being built, what waits for a crew, what waits for funds
  constructionQueue(city) {
    const S = this.S, D = S.defs;
    const sites = [...S.buildings.values()].filter((x) => x.o === S.civId && !x.d && x.c === city.id).sort((a, b) => (a.qn ?? a.id) - (b.qn ?? b.id));
    if (!sites.length) return '';
    const state = (x) => (x.st === 'planned' ? '<span class="tag warn">awaiting funds</span>' : x.qw ? '<span class="tag">waiting for a crew</span>' : `<span class="tag good">${x.p}%</span>`);
    return `<div class="cprod"><b>Construction queue (${sites.length})</b><ul class="log">${sites.slice(0, 12).map((x, i) => `<li><button type="button" class="rlink" data-jump="${x.t}">${esc(D.BUILDINGS[x.ty].name)}</button> ${state(x)}${i ? ` <button type="button" class="rlink" data-qnext="${x.id}" title="Build this next">▲ next</button>` : ''}</li>`).join('')}</ul></div>`;
  }

  buildingPanel(b, d, own, city) {
    const S = this.S, D = S.defs;
    let html = `<div>Condition ${b.hp}% <span class="tag ${b.st === 'damaged' ? 'bad' : b.st === 'operational' ? 'good' : 'warn'}">${esc(b.st)}</span>${b.f ? ' <span class="tag bad">on fire</span>' : ''}</div><div class="bar hp"><i style="width:${b.hp}%"></i></div>`;
    if (b.st === 'planned') html += `<div class="warn">In the construction queue: it is funded as soon as the resources are there, in the order you placed things (earlier orders first).</div>`;
    else if (!b.d && b.qw) html += `<div class="warn">Funded and waiting for a crew: ${b.qw} site${b.qw > 1 ? 's' : ''} ahead of it in this city. Engineers beside it start it at once.</div>`;
    else if (!b.d) html += `<div class="warn">Under construction: ${b.p}% (crew rate ×${(b.cr || 1).toFixed(1)}; engineers nearby speed this up)</div>`;
    if (own && !b.d && !S.spectator) html += `<div class="actions"><button class="btn small primary" data-act="buildNext" title="Move this site to the front of the construction queue: funded and built before everything else">Build next</button></div>`;
    if (own && city && !S.spectator) html += this.constructionQueue(city);
    if (b.st === 'damaged' && own) html += `<div class="bad">Damaged buildings work at half capacity and do not recover by themselves.</div>`;
    if (city) html += `<div>Population ${Math.floor(city.pop)}</div>`;
    if (own && d.jobs && b.d) html += `<div class="${b.w && !['under', 'surplus', 'locked'].includes(b.w) ? 'warn' : 'muted'}">${esc(staffText(b, D))}</div>`;
    if (own && b.ty === 'house' && b.d && !S.spectator) { const lv = b.lv || 1, a = S.econ?.age || 0, cost = a >= 1 ? `${55 * lv} materials, ${12 * lv} steel` : `${60 * lv} materials`; html += `<div class="muted">Density level ${lv} of 3.</div>${lv < 3 ? `<div class="actions"><button class="btn small" data-upgrade="${b.id}" title="Add storeys: more homes on the same hex">Add storeys (${cost})</button></div>` : ''}`; }
    // production buildings grow in place: more jobs and more output per worker on the same hex
    if (own && d.jobs && b.ty !== 'town' && b.d && D.LEVELS) {
      const lv = b.lv || 1, L = D.LEVELS;
      html += `<div class="lvl"><b>Level ${lv}</b> of ${L.max} <span class="muted">· ${slotsOf(b, D)} jobs · output ×${(L.out[lv - 1] * L.jobs[lv - 1]).toFixed(1)} at full staff</span></div>`;
      if (b.uc && !S.spectator) {
        const ok = (S.econ?.age || 0) >= L.age[lv], short = Object.entries(b.uc).some(([k, v]) => (S.econ?.res[k] || 0) < v);
        html += `<div class="actions"><button class="btn small${ok && !short ? ' primary' : ''}" data-upgrade="${b.id}" ${ok ? '' : 'disabled'} title="${ok ? `Level ${lv + 1}: ${Math.round(d.jobs[1] * L.jobs[lv])} jobs, each ${Math.round((L.out[lv] / L.out[lv - 1] - 1) * 100)}% more productive` : `Needs the ${['Reclamation', 'Industrial', 'Mechanized'][L.age[lv]]} era`}">Expand to level ${lv + 1} (${Object.entries(b.uc).map(([k, v]) => `${v} ${esc(D.GOOD_NAMES[k].toLowerCase())}`).join(', ')})</button></div>`;
      }
    }
    if (own && b.w) {
      const g = b.w.startsWith('input:') ? b.w.slice(6) : null;
      const msg = g ? `Short of ${esc((D.GOOD_NAMES[g] || g).toLowerCase())}: output is limited until supply improves.` : { staff: 'No workers: the city needs more people (housing and food) or fewer job buildings.', power: 'Brownout: power demand exceeds generation. Build or staff a power plant.', rare: 'Needs a rare-earth deposit inside your territory.' }[b.w];
      if (msg) html += `<div class="warn">${msg}</div>`;
    }
    if (own && b.gov) html += `<div class="muted">Built by the city governor.</div>`;
    // defensive installations: role, reach and (AA) ammunition and upgrade
    if (d.attack && b.ty !== 'town') {
      const air = d.defense === 'air', rng = d.range + (b.ug ? 1 : 0);
      html += `<div class="defrole"><b>${air ? 'Air defense' : 'Ground defense'}</b> <span class="muted">· range ${rng} hexes · ${air ? 'targets detected aircraft only' : 'cannot target aircraft'}</span>${d.desc ? `<div class="muted small">${esc(d.desc)}</div>` : ''}</div>`;
      if (b.na) html += `<div class="bad">Needs munitions: it cannot fire until the munitions stockpile recovers. <button type="button" class="rlink" data-res="munitions">Why?</button></div>`;
      if (b.ty === 'aa_battery' && own && !S.spectator) {
        if (b.ug) html += `<div class="good small">Upgraded: better detection, +1 range, improved fire control.</div>`;
        else { const ok = S.econ?.techs.includes('air_defense'); html += `<div class="actions"><button class="btn small" data-act="upgradeDefense" ${ok ? '' : 'disabled'} title="${ok ? 'Better detection, +1 range, improved fire control' : 'Requires Air Defense'}">Upgrade (30 steel, 10 electronics)</button>${ok ? '' : ' <small class="muted">needs Air Defense</small>'}</div>`; }
      }
    }
    if (own && d.airbase && b.d) html += this.airfieldPanel(b, d);
    if (own && d.silo && b.d) html += this.siloPanel(b);
    html += this.trainPanel(b, d, own);
    if (own) html += `<div class="actions">${b.hp < 100 && b.d ? '<button class="btn small" data-act="repair">Repair</button>' : ''}${b.ty !== 'town' ? '<button class="btn small ghost" data-act="demolish">Demolish</button>' : ''}</div>`;
    void D;
    return html;
  }

  trainPanel(b, d, own) {
    const S = this.S, D = S.defs, e = S.econ;
    if (!own || !d.trains || !b.d) return '';
    // the production queue at a glance: current unit and progress, what follows, free slots, repeat, rally
    let qh = '';
    if (b.q?.length) {
      const [u0, left0] = b.q[0], ud0 = D.UNITS[u0], p0 = Math.max(0, Math.min(100, Math.round(100 * (1 - left0 / Math.max(1, ud0.time)))));
      qh += `<div class="pq"><b>Training ${esc(ud0.name)}</b> <span class="muted">${left0}s left</span><div class="bar sup"><i style="width:${p0}%"></i></div></div>`;
    } else qh += `<div class="muted small">Idle: nothing in training.</div>`;
    const slots = 8 - (b.q?.length || 0);
    const army = b.ra ? (e.armies || []).find((a) => a.id === b.ra) : null;
    qh += `<div class="muted small">${slots} of 8 queue slots free${b.rp ? ` · repeating ${esc(D.UNITS[b.rp]?.name || b.rp)}` : ''}${b.r >= 0 ? ' · rally point set' : ''}${army ? ` · joins ${esc(army.name)}` : ''}</div>`;
    const cost = (c) => Object.entries(c).map(([k, v]) => `${v} ${D.GOOD_NAMES[k].toLowerCase()}`).join(', ');
    let html = `<div class="actions">` + d.trains.filter((u) => D.UNITS[u].age <= e.age).map((u) => {
      const ud = D.UNITS[u]; const locked = ud.tech && !e.techs.includes(ud.tech);
      return `<button class="btn trainbtn" data-train="${u}" ${locked ? 'disabled' : ''} title="${esc(ud.name)}: ${esc(cost(ud.cost))}${ud.pop ? `, ${ud.pop} pop` : ''}${ud.men ? `, ${ud.men} soldiers` : ''}"><span><img class="uicon" src="${unitIconURL(u, ud, S.civColor(S.civId))}" alt="">${esc(ud.name)}</span><small>${locked ? 'needs ' + esc(D.TECHS[ud.tech].name) : esc(cost(ud.cost))}</small></button>`;
    }).join('') + `</div>`;
    // the whole queue sits right under the current item, before the train buttons, so it is never missed
    if (b.q?.length) qh += `<div class="queue">${b.q.map(([u, t], i) => `<span>${esc(D.UNITS[u].name)} ${t}s <button class="x" data-qcancel="${i}" title="Cancel: ${i === 0 ? 'half the cost back once training has started' : 'full refund'}; the reserved manpower returns to work">×</button></span>`).join('')}</div><div class="actions"><button class="btn small ghost" data-clearq="${b.id}">Clear queue</button></div>`;
    html = qh + html;
    html += `<div class="actions"><label class="field inline"><span>Repeat</span><select data-batch="repeat" data-bid="${b.id}"><option value="">Off</option>${d.trains.filter((u) => D.UNITS[u].age <= e.age && (!D.UNITS[u].tech || e.techs.includes(D.UNITS[u].tech))).map((u) => `<option value="${u}" ${b.rp === u ? 'selected' : ''}>${esc(D.UNITS[u].name)}</option>`).join('')}</select></label></div>`;
    const armies = e.armies || [];
    html += `<div class="muted">Right-click the map to set a rally point${armies.length ? `; new units join <select data-sel="rallyArmy"><option value="0">no army</option>${armies.map((a) => `<option value="${a.id}" ${b.rallyArmy === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}.</div>`;
    return html;
  }

  // Everything this city's facilities are training, in one place (town, barracks, works, airfields).
  cityProduction(city) {
    const S = this.S, D = S.defs;
    const fac = [...S.buildings.values()].filter((b) => b.o === S.civId && b.c === city.id && b.q?.length);
    if (!fac.length) return '';
    const items = fac.flatMap((b) => b.q.map(([u, left], i) => ({ b, u, left, i })));
    return `<div class="cprod"><b>In training (${items.length})</b><ul class="log">${fac.map((b) => b.q.map(([u, left], i) => { const ud = D.UNITS[u]; const p = i === 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - left / Math.max(1, ud.time))))) : 0; return `<li><button type="button" class="rlink" data-selb="${b.id}">${esc(D.BUILDINGS[b.ty].name)}</button> ${esc(ud.name)} <span class="muted">${i === 0 ? `${left}s` : `queued #${i + 1}`}</span>${i === 0 ? `<div class="bar sup"><i style="width:${p}%"></i></div>` : ''}</li>`; }).join('')).join('')}</ul></div>`;
  }
  // the city lifecycle state, as a tag with its reason
  cityStateTag(city) {
    const D = this.S.defs, st = D.CITY_STATES?.[city.cs];
    if (!st || st === 'operational') return '';
    const tone = { damaged: 'warn', besieged: 'bad', defenseless: 'bad', captured: 'warn', rebuilding: 'good' }[st] || '';
    return `<div class="cstate"><span class="tag ${tone}">${esc({ damaged: 'Damaged', besieged: 'Under siege', defenseless: 'Defenseless', captured: 'Recently captured', rebuilding: 'Resettling' }[st])}</span>${city.csw ? ` <span class="muted">${esc(city.csw)}</span>` : ''}</div>`;
  }
  cityOverview(city, b, d) {
    const gr = city.gr || 0;
    const prod = this.cityProduction(city);
    const tiers = this.S.defs.LEVELS?.tiers || ['Town', 'City', 'Metropolis', 'Megacity'], ti = city.ti || 0;
    const tierHtml = `<div class="ctier"><span class="tag ${ti >= 2 ? 'good' : ''}">${esc(tiers[ti] || 'Town')}</span> <span class="muted">${ti < 3 ? 'grows into a ' + esc((tiers[ti + 1] || '').toLowerCase()) + ' with more people and a later era: more homes, jobs and output at its centre' : 'the largest a city can grow'}</span></div>`;
    let html = tierHtml + this.cityStateTag(city) + prod + (this.S.sandbox || this.S.dev ? `<details class="diag" data-cdiag="${city.id}" ${this.diagOpen ? 'open' : ''}><summary>City diagnostics</summary><pre>${esc(this.diagText || 'loading…')}</pre></details>` : '') + `<div class="ledger">
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
    for (const b of blds) { const k = catOf(b.ty); sum[k].s += b.s || 0; sum[k].n += slotsOf(b, D); sum[k].list.push(b); }
    const assigned = blds.reduce((s2, b) => s2 + (b.s || 0), 0);
    let h = `<div class="ledger"><div><b>${Math.floor(city.pop)}</b><span>population</span></div><div><b>${city.lab ?? 0}</b><span>available</span></div><div><b>${assigned}</b><span>assigned</span></div><div><b>${city.ua ?? 0}</b><span>unassigned</span></div></div>`;
    const levels = ['critical', 'high', 'normal', 'low', 'off'];
    const names = { food: 'Food', industry: 'Industry', research: 'Research', commerce: 'Commerce' };
    for (const [k, v] of Object.entries(sum)) {
      const open = this.wfOpen === k;
      h += `<div class="wfcat"><button class="wfhd" data-wf="toggle" data-cat="${k}"><b>${names[k]}</b><span>${v.s} / ${v.n} positions staffed</span></button>
        <select data-wfprio="${k}" title="Priority for ${names[k].toLowerCase()} jobs">${levels.map((l) => `<option value="${l}" ${wf.prio?.[k] === l ? 'selected' : ''}>${l[0].toUpperCase() + l.slice(1)}</option>`).join('')}</select></div>`;
      if (open) h += `<ul class="log wfb">${v.list.map((b) => {
        const n = slotsOf(b, D);
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
    { const hu = e.target.closest('[data-hup]'); if (hu) return this.housingAction(hu.dataset.hup); }
    { const qn = e.target.closest('[data-qnext]'); if (qn) { this.A.cmd({ c: 'buildNext', id: +qn.dataset.qnext }).then(() => { this.selHtml = ''; this.selection(); }); return; } }
    { const cq = e.target.closest('[data-clearq]'); if (cq) return this.A.cmd({ c: 'clearQueue', buildings: cq.dataset.clearq.split(',').map(Number) }).then((r) => { if (r.cleared) this.toast({ text: `${r.cleared.n} queued unit${r.cleared.n === 1 ? '' : 's'} cancelled; resources refunded.`, kind: 'build', level: 'info' }); }); }
    { const rr = e.target.closest('[data-res]'); if (rr) return this.openResource(rr.dataset.res); }
    const t = e.target.closest('[data-act],[data-train],[data-jump],[data-ctab],[data-gcancel],[data-card],[data-follow-civ],[data-refit],[data-wf],[data-prop],[data-qcancel],[data-upgrade],[data-import],[data-govlevel],[data-batchtrain],[data-batchmode],[data-fbeh],[data-fop],[data-pick],[data-truckback],[data-airbase],[data-selb]'); if (!t) return;
    if (t.dataset.truckback) return this.A.cmd({ c: 'returnSupplyTruck', truck: +t.dataset.truckback });
    if (t.dataset.fbeh) return this.A.cmd({ c: 'formation', id: +t.dataset.fid, op: 'behavior', behavior: t.dataset.fbeh });
    if (t.dataset.fop) return this.A.formationOp(t.dataset.fop, +t.dataset.fid);
    if (t.dataset.pick) return this.A.pickUnit(+t.dataset.pick);
    if (t.dataset.airbase) return this.A.airbase(t.dataset.airbase, +t.dataset.base);
    if (t.dataset.selb) { const b = this.S.buildings.get(+t.dataset.selb); if (b) { this.S.selUnits.clear(); this.S.selBuildings.clear(); this.S.selBuildings.add(b.id); this.S.selBuilding = b.id; this.selHtml = ''; this.selection(); this.A.jump?.(b.t); } return; }
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
    else if (t.dataset.batch === 'repeat') this.A.repeat(t.value || null, t.dataset.bid ? [+t.dataset.bid] : null);
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
    if (Object.values(e.resources || {}).some((r) => r.status === 'deficit' || r.status === 'empty')) this.tip('shortage', 'A stockpile is running down. Click it in the top bar: the panel says what makes it, why it is short and offers the next step.');
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
    if (this.finder.isOpen) { this.finder.close(); return true; }
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
      this.tab === 'economy' ? this.econ.key() : 0,
      this.tab === 'military' ? [Math.floor(S.time / 2)] : 0]);
    if (!force && key === this.drawerKey) return;
    this.drawerKey = key;
    const body = $('drawerBody'); const scroll = body.scrollTop;
    morph(body, this['tab_' + this.tab]?.() || '');
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
  tab_economy() { return this.econ.render(); }
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
      ${(e.caches || []).length ? `<p class="muted">${e.caches.length} field cache${e.caches.length > 1 ? 's' : ''}: ${e.caches.map((c) => `<button type="button" class="rlink" data-jump="${c.t}">${c.cargo} cargo</button>`).join(', ')}</p>` : ''}
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
        h += `<div class="muted">${c.posture ? `<span class="tag" title="What this nation is visibly doing">${esc(c.posture)}</span> ` : ''}${c.age != null ? esc(D.AGES[c.age]?.name || '') + ', ' : ''}${c.known?.cities ?? 0} cities seen${r.trade ? ', trade agreement' : ''}${r.borders ? ', open borders' : ''}${r.until > 0 ? `, truce ${r.until}s` : ''}</div><div class="actions">`;
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
    if (this.tab === 'economy' && this.econ.onClick(ev)) { this.drawerKey = ''; this.drawer(true); return; }
    { const r = ev.target.closest('[data-res]'); if (r) return this.openResource(r.dataset.res); }
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
    else if (d.jump) { if (d.city) this.A.selectCity(+d.city); if (d.pulse) { this.S.pulse = { id: +d.pulse, until: this.S.time + 4 }; this.closeWorkspace(); } this.A.jump(+d.jump); }
    this.drawer(true);
    setTimeout(() => this.A.refresh(), 200);
  }
  onDrawerChange(ev) {
    const t = ev.target;
    if (this.tab === 'economy' && this.econ.onChange(ev)) { this.drawerKey = ''; this.drawer(true); return; }
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
    const ist = (S.bf?.i || []).find((x) => x[0] === tile)?.[1] || 0;
    if (ist) parts.push(`<span class="warn">${['', 'Churned ground — fighting has worn the land here', 'No man\'s land — cratered mud: vehicles bog down, infantry find shell holes', 'Devastated — wire, debris and mud: slow going for everyone'][ist]}</span>`);
    if ((S.bf?.fp || []).some((x) => x[0] === tile)) parts.push('Field positions: foxholes scraped out by infantry (light cover, collapse when abandoned)');
    if (r && r.type === 'town' && !S.buildingAtTile.get(tile)) parts.push('<span class="muted">Click to consider resettling these ruins.</span>');
    if (Number.isFinite(t.move)) parts.push(`Infantry move cost ${t.move}${t.def ? `, defense ${t.def > 0 ? '+' : ''}${Math.round(t.def * 100)}%` : ''}`);
    else if (!t.water) parts.push('Impassable');
    if (S.road[tile]) { const best = Math.max(...[0, 1, 2, 3, 4, 5].map((d) => (S.road[tile] >> (d * 4)) & 7)); const ruined = [0, 1, 2, 3, 4, 5].some((d) => (S.road[tile] >> (d * 4)) & 8); parts.push(esc(D.ROAD_TYPES[best]?.name || 'Road') + (ruined ? ' — some segments wrecked' : '')); }
    const tr = S.trafficTile.get(tile); if (tr) parts.push(`Traffic: ${tr > 6 ? 'heavy' : tr > 2 ? 'moderate' : 'light'}`);
    if (S.stab[tile] >= 0) parts.push(`Structural stability ${S.stab[tile]}%`);
    if (S.owner[tile] >= 0) parts.push('Territory of ' + esc(S.civInfo[S.owner[tile]]?.name || ''));
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
// job slots of a building, with its level (and the hub's development tier)
export function slotsOf(b, D) { const d = D.BUILDINGS[b.ty]; if (!d?.jobs) return 0; return b.ty === 'town' ? d.jobs[1] + (b.ti || 0) : Math.round(d.jobs[1] * (D.LEVELS?.jobs[(b.lv || 1) - 1] || 1)); }
function staffText(b, D) {
  const d = D.BUILDINGS[b.ty]; if (!d.jobs) return '';
  const head = `${b.s || 0}/${slotsOf(b, D)} ${d.jobs[0]}s`, w = b.w || '';
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

// Morph an element's content into new HTML, node by node: elements of the same tag are kept and
// only their attributes and text change, so the button under the pointer (or the field being typed
// in) survives a refresh. Used by the panels that update every second.
export function morph(el, html) {
  const t = document.createElement('template'); t.innerHTML = html;
  morphChildren(el, t.content);
}
function morphChildren(a, b) {
  const an = [...a.childNodes], bn = [...b.childNodes];
  for (let i = 0; i < bn.length; i++) {
    const x = an[i], y = bn[i];
    if (!x) { a.appendChild(y); continue; }
    if (x.nodeType !== y.nodeType || (x.nodeType === 1 && x.tagName !== y.tagName)) { a.replaceChild(y, x); continue; }
    if (x.nodeType === 3 || x.nodeType === 8) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    // attributes
    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    if (x.tagName === 'INPUT' && x !== document.activeElement) { if ('value' in y && x.value !== y.getAttribute('value') && y.hasAttribute('value')) x.value = y.getAttribute('value'); x.checked = y.hasAttribute('checked'); }
    if (x.tagName === 'SELECT' && x === document.activeElement) continue;      // never disturb an open dropdown
    morphChildren(x, y);
    if (x.tagName === 'SELECT') { const sel = [...y.querySelectorAll('option')].findIndex((o) => o.hasAttribute('selected')); if (sel >= 0 && x.selectedIndex !== sel) x.selectedIndex = sel; }
  }
  for (let i = an.length - 1; i >= bn.length; i--) a.removeChild(an[i]);
}

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

// Global building finder: search by name, filter by type, city and state (working, idle,
// unfinished, planned, damaged), quick commands for the common questions, and results that centre
// the map on a building and pulse its outline. Economy advice ("Inspect idle mines") reuses it.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const STATES = { all: 'Any state', working: 'Working', idle: 'Idle / inactive', unfinished: 'Unfinished', planned: 'Awaiting funds', damaged: 'Damaged' };

// pure filter, shared with tests
export function findBuildings(S, { q = '', type = '', city = '', state = 'all' } = {}) {
  const D = S.defs, ql = q.trim().toLowerCase();
  const out = [];
  for (const b of S.buildings.values()) {
    if (b.o !== S.civId) continue;
    const d = D.BUILDINGS[b.ty]; if (!d) continue;
    if (type && b.ty !== type) continue;
    if (city !== '' && city != null && b.c !== +city) continue;
    const c = S.cities.get(b.c);
    if (ql && !(d.name.toLowerCase().includes(ql) || (c && c.n.toLowerCase().includes(ql)))) continue;
    const working = b.d && (d.jobs ? b.s > 0 : true) && b.st !== 'damaged';
    const idle = b.d && d.jobs && !(b.s > 0);
    if (state === 'working' && !working) continue;
    if (state === 'idle' && !idle) continue;
    if (state === 'unfinished' && b.d) continue;
    if (state === 'planned' && b.st !== 'planned') continue;
    if (state === 'damaged' && b.st !== 'damaged' && !(b.hp < 100 && b.d)) continue;
    out.push(b);
  }
  return out;
}

export class Finder {
  constructor(S, A) {
    this.S = S; this.A = A; this.opts = { q: '', type: '', city: '', state: 'all' };
    const el = $('finder');
    el.addEventListener('input', (e) => { const k = e.target.dataset.fopt; if (k) { this.opts[k] = e.target.value; this.render(); } });
    el.addEventListener('change', (e) => { const k = e.target.dataset.fopt; if (k) { this.opts[k] = e.target.value; this.render(); } });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-fq],[data-fb],[data-fclose],[data-fall]'); if (!t) return;
      if (t.dataset.fclose) return this.close();
      if (t.dataset.fall) { this.highlight(); return; }
      if (t.dataset.fq) { Object.assign(this.opts, JSON.parse(t.dataset.fq)); this.render(); this.highlight(); return; }
      if (t.dataset.fb) this.focus(+t.dataset.fb);
    });
  }
  open(opts = {}) { Object.assign(this.opts, { q: '', type: '', city: '', state: 'all' }, opts); $('finder').hidden = false; this.render(); this.highlight(); const i = $('finder').querySelector('[data-fopt=q]'); if (i) i.focus(); }
  close() { $('finder').hidden = true; this.S.findIds = null; this.S.pulse = null; this.A.refreshMinimap?.(); }
  get isOpen() { return !$('finder').hidden; }
  // every match is highlighted on the map and minimap until cleared
  highlight() { const list = findBuildings(this.S, this.opts); this.S.findIds = new Set(list.map((b) => b.id)); this.A.refreshMinimap?.(); }
  focus(id) { const b = this.S.buildings.get(id); if (!b) return; this.A.jump(b.t); this.S.pulse = { id, until: this.S.time + 4 }; }
  render() {
    const S = this.S, D = S.defs, o = this.opts, el = $('finder');
    const types = [...new Set([...S.buildings.values()].filter((b) => b.o === S.civId).map((b) => b.ty))].sort((a, b) => D.BUILDINGS[a].name.localeCompare(D.BUILDINGS[b].name));
    const cities = [...S.cities.values()].filter((c) => c.o === S.civId);
    const list = findBuildings(S, o);
    const quick = [['All mines', { type: 'mine', state: 'all' }], ['Inactive steel mills', { type: 'steel_mill', state: 'idle' }], ['Unfinished buildings', { type: '', state: 'unfinished' }], ['Idle workplaces', { type: '', state: 'idle' }], ['Damaged', { type: '', state: 'damaged' }]];
    const head = `<div class="hd"><b>Find buildings</b><button class="btn small ghost" data-fclose="1">Close</button></div>
      <div class="finder-q"><input type="search" data-fopt="q" placeholder="Name or city…" value="${esc(o.q)}" aria-label="Search buildings">
      <select data-fopt="type" aria-label="Type"><option value="">All types</option>${types.map((t) => `<option value="${t}" ${o.type === t ? 'selected' : ''}>${esc(D.BUILDINGS[t].name)}</option>`).join('')}${o.type && !types.includes(o.type) ? `<option value="${o.type}" selected>${esc(D.BUILDINGS[o.type]?.name || o.type)}</option>` : ''}</select>
      <select data-fopt="city" aria-label="City"><option value="">All cities</option>${cities.map((c) => `<option value="${c.id}" ${String(o.city) === String(c.id) ? 'selected' : ''}>${esc(c.n)}</option>`).join('')}</select>
      <select data-fopt="state" aria-label="State">${Object.entries(STATES).map(([k, n]) => `<option value="${k}" ${o.state === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="chips">${quick.map(([n, q]) => `<button type="button" class="chip" data-fq='${esc(JSON.stringify(q))}'>${n}</button>`).join('')}</div>`;
    const body = `<p class="muted small">${list.length} found · <button type="button" class="rlink" data-fall="1">highlight all on the map</button></p><ul class="log finder-list">${list.slice(0, 60).map((b) => {
      const d = D.BUILDINGS[b.ty], c = S.cities.get(b.c);
      const st = b.st === 'planned' ? '<span class="tag warn">awaiting funds</span>' : !b.d ? `<span class="tag">${b.p}%</span>` : b.st === 'damaged' ? '<span class="tag bad">damaged</span>' : d.jobs && !(b.s > 0) ? '<span class="tag warn">idle</span>' : '<span class="tag good">working</span>';
      return `<li><button type="button" class="rlink" data-fb="${b.id}">${esc(d.name)}</button> ${st} <small class="muted">${esc(c ? c.n : '')}</small></li>`;
    }).join('') || '<li class="muted">Nothing matches.</li>'}</ul>`;
    // keep the inputs (and focus) while typing: only the list is replaced after the first render
    const key = head.replace(/data-fopt="q" placeholder="[^"]*" value="[^"]*"/, '');
    if (!el.querySelector('.finder-body') || this.headKey !== key) {
      const typing = document.activeElement?.dataset?.fopt === 'q';
      this.headKey = key; el.innerHTML = head + `<div class="finder-body">${body}</div>`;
      const i = el.querySelector('[data-fopt=q]'); if (i && typing) { i.focus(); i.setSelectionRange(o.q.length, o.q.length); }
    } else el.querySelector('.finder-body').innerHTML = body;
  }
}

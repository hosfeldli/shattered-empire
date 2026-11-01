// Economy & Logistics workspace. Problems first: an overview of the economy's health and its
// three to five most pressing issues, then one view per question — what each resource is and why it
// moves (Resources), how goods flow (Chains), where they are made (Cities), how they travel
// (Logistics), where they go (Spending) and what is being built (Construction).
// All explanations come from the server's resource report and ledger, so nothing here guesses.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (Math.abs(n) >= 10000 ? (n / 1000).toFixed(0) + 'k' : Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.floor(n).toString());
const rate = (v) => { const a = Math.abs(v); if (a < 0.005) return '0.00/s'; return `${v >= 0 ? '+' : '−'}${a < 10 ? a.toFixed(2) : a.toFixed(1)}/s`; };
const dur = (s) => (s == null ? '—' : s >= 3600 ? '> 1 h' : s >= 120 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);
export const TABS = [['overview', 'Overview'], ['resources', 'Resources'], ['chains', 'Production chains'], ['cities', 'Cities'], ['logistics', 'Logistics'], ['spending', 'Spending'], ['construction', 'Construction']];

export class EconomyWorkspace {
  constructor(S, A) { this.S = S; this.A = A; this.tab = 'overview'; this.good = 'food'; this.chainGood = null; this.cfilter = ''; this.plans = {}; }

  // a resource control: legible, keyboard accessible, never a browser link
  rlink(k, label) { const D = this.S.defs; return `<button type="button" class="rlink" data-res="${k}">${esc(label || D.GOOD_NAMES[k] || k)}</button>`; }
  costHtml(cost, have) { const D = this.S.defs; return Object.entries(cost || {}).map(([k, v]) => `<span class="${have && (have[k] || 0) < v ? 'bad' : ''}">${v} ${this.rlink(k, (D.GOOD_NAMES[k] || k).toLowerCase())}</span>`).join(', ') || 'free'; }

  key() {
    const S = this.S, e = S.econ;
    return JSON.stringify([this.tab, this.good, this.chainGood, this.cfilter, Math.floor(S.time / 2), Object.keys(this.plans).length, e?.res && Object.values(e.res).map((v) => Math.round(v / 5))]);
  }

  render() {
    const S = this.S, e = S.econ; if (!e) return '';
    let h = `<div class="subtabs ec-tabs" role="tablist">${TABS.map(([k, n]) => `<button role="tab" aria-selected="${this.tab === k}" class="${this.tab === k ? 'on' : ''}" data-ectab="${k}">${n}${k === 'overview' ? this.issueBadge() : ''}</button>`).join('')}</div>`;
    h += this['tab_' + this.tab]();
    return h;
  }
  issueBadge() { const n = this.issues().filter((i) => i.sev >= 2).length; return n ? ` <span class="tag bad">${n}</span>` : ''; }

  // ---------------------------------------------------------------- overview
  issues() {
    const S = this.S, e = S.econ, D = S.defs, out = [];
    const R = e.resources || {};
    for (const k of D.GOODS) {
      const r = R[k]; if (!r || r.status === 'ok' || r.status === 'falling' && r.lasts > 600) continue;
      out.push({ sev: r.status === 'empty' ? 3 : r.status === 'deficit' ? (k === 'food' ? 3 : 2) : 1, title: r.headline, text: r.cause || (r.lasts != null ? `Runs out in about ${dur(r.lasts)}.` : ''), good: k, actions: r.actions });
    }
    const mine = [...S.buildings.values()].filter((b) => b.o === S.civId);
    const idle = mine.filter((b) => b.d && D.BUILDINGS[b.ty].jobs && !b.s && b.w && b.w !== 'surplus' && b.w !== 'off');
    if (idle.length >= 2) out.push({ sev: 1, title: `${idle.length} workplaces are idle.`, text: summarize(idle.map((b) => whyWord(b.w, D))), actions: [{ a: 'locate', filter: 'idle', label: 'Find idle workplaces' }] });
    if (e.power && e.power.use > e.power.gen) out.push({ sev: 2, title: 'Power demand exceeds generation.', text: `${e.power.gen} generated for ${e.power.use} demanded: industry runs slower.`, actions: [{ a: 'build', type: 'power_plant', label: 'Build a Power Plant' }, { a: 'locate', type: 'power_plant', label: 'Find power plants' }] });
    const cut = [...S.cities.values()].filter((c) => c.o === S.civId && c.iso);
    if (cut.length) out.push({ sev: 2, title: `${cut.length} cit${cut.length > 1 ? 'ies are' : 'y is'} cut off from the network.`, text: `${cut.map((c) => c.n).join(', ')} live on local reserves until a road, railway or port reconnects them.`, actions: [{ a: 'road', label: 'Plan a road' }, ...cut.slice(0, 2).map((c) => ({ a: 'jump', tile: c.t, label: `Show ${c.n}` }))] });
    const full = [...S.cities.values()].filter((c) => c.o === S.civId && c.h && c.pop >= c.h * 0.97);
    if (full.length) out.push({ sev: 1, title: `Housing is full in ${full.length} cit${full.length > 1 ? 'ies' : 'y'}.`, text: 'Growth stalls without more homes: build or upgrade housing blocks.', actions: [{ a: 'housing', label: 'Build housing' }, { a: 'selectType', type: 'house', label: 'Select housing blocks' }] });
    const stalled = mine.filter((b) => b.st === 'planned');
    if (stalled.length >= 2) out.push({ sev: 1, title: `${stalled.length} construction projects are waiting for funds.`, text: 'They start automatically when the resources exist.', actions: [{ a: 'tab', tab: 'construction', label: 'Open construction' }] });
    return out.sort((a, b) => b.sev - a.sev).slice(0, 5);
  }
  tab_overview() {
    const S = this.S, e = S.econ, D = S.defs, R = e.resources || {};
    const mine = [...S.buildings.values()].filter((b) => b.o === S.civId), work = mine.filter((b) => b.d && D.BUILDINGS[b.ty].jobs), staffed = work.filter((b) => b.s > 0).length;
    const cr = R.credits;
    let h = `<div class="ws-card ec-health"><div class="opind">`;
    h += `<span class="ind ${cr && cr.net < 0 ? 'bad' : ''}"><b>${cr ? rate(cr.net) : '—'}</b>treasury</span>`;
    h += `<span class="ind ${R.food?.status !== 'ok' ? 'bad' : ''}"><b>${R.food ? rate(R.food.net) : '—'}</b>food</span>`;
    h += `<span class="ind ${staffed < work.length * 0.7 ? 'mid' : ''}"><b>${work.length ? Math.round((100 * staffed) / work.length) : 100}%</b>workplaces running</span>`;
    h += `<span class="ind ${e.power && e.power.use > e.power.gen ? 'bad' : ''}"><b>${e.power ? `${e.power.gen}/${e.power.use}` : '—'}</b>power</span>`;
    h += `<span class="ind"><b>${fmt(e.storage || 0)}</b>storage per good</span></div>`;
    h += `<p class="muted small">Rates are per second, averaged over the last ${e.ledger?.window || 20} s.</p></div>`;
    const iss = this.issues();
    h += `<div class="ws-card"><h4>What needs attention</h4>${iss.length ? iss.map((i) => `<div class="issue sev${i.sev}"><b>${esc(i.title)}</b>${i.text ? `<p>${esc(i.text)}</p>` : ''}${this.actionsHtml(i.actions, i.good)}</div>`).join('') : '<p class="muted">Nothing urgent. Every good is stable or growing.</p>'}</div>`;
    h += `<div class="ws-card"><h4>Resources at a glance</h4>${this.resourceTable()}</div>`;
    return `<div class="ws-cols">${h}</div>`;
  }
  resourceTable() {
    const S = this.S, e = S.econ, D = S.defs, R = e.resources || {};
    let h = `<table class="grid"><tr><th>Good</th><th>Stock</th><th>In</th><th>Out</th><th>Net</th><th>Lasts</th></tr>`;
    for (const k of D.GOODS) {
      const r = R[k]; const v = e.res[k] || 0; if (!r) continue;
      if (!v && !r.inflow && !r.outflow && k !== 'ore') continue;
      h += `<tr class="${r.status === 'deficit' || r.status === 'empty' ? 'short' : ''}"><td>${this.rlink(k)}</td><td>${fmt(v)}${r.reserved ? ` <small class="muted" title="reserved">(${fmt(r.reserved)} res.)</small>` : ''}</td><td>${r.inflow.toFixed(1)}</td><td>${r.outflow.toFixed(1)}</td><td class="${r.net < 0 ? 'neg' : 'pos'}">${rate(r.net)}</td><td>${r.lasts != null ? dur(r.lasts) : '—'}</td></tr>`;
    }
    return h + `</table><p class="muted small">Select a good to see what makes it, what uses it and what to do.</p>`;
  }

  // ---------------------------------------------------------------- resource detail
  tab_resources() {
    const S = this.S, D = S.defs, R = S.econ.resources || {};
    const list = D.GOODS.map((k) => { const r = R[k]; return `<button type="button" class="reslist ${this.good === k ? 'on' : ''} st-${r?.status || 'ok'}" data-res="${k}"><b>${esc(D.GOOD_NAMES[k])}</b><span>${fmt(S.econ.res[k] || 0)}</span><small class="${r && r.net < 0 ? 'neg' : 'pos'}">${r ? rate(r.net) : ''}</small></button>`; }).join('');
    return `<div class="ec-res"><nav class="ec-reslist" aria-label="Resources">${list}</nav><div class="ec-resbody">${this.detail(this.good)}</div></div>`;
  }
  detail(k) {
    const S = this.S, D = S.defs, e = S.econ, r = (e.resources || {})[k];
    if (!r) return '<p class="muted">No data yet.</p>';
    const CATS = D.LEDGER_CATS || {};
    let h = `<header class="res-hd"><h3>${esc(r.title.toUpperCase())}${r.kind ? ` <small>— ${esc(r.kind)}</small>` : ''}</h3><p>${esc(r.what)}</p></header>`;
    if (r.headline) h += `<div class="issue sev${r.status === 'empty' ? 3 : r.status === 'deficit' ? 2 : r.status === 'falling' ? 1 : 0}"><b>${esc(r.headline)}</b>${r.cause ? `<p>${esc(r.cause)}</p>` : ''}</div>`;
    h += this.actionsHtml(r.actions, k);
    h += `<div class="ws-cols">`;
    // production
    if (k === 'credits') {
      const inc = Object.entries(r.income || {}), exp = Object.entries(r.expense || {});
      h += `<div class="ws-card"><h4>Income</h4>${inc.length ? `<table class="grid">${inc.sort((a, b) => b[1] - a[1]).map(([c, v]) => `<tr><td>${esc(CATS[c]?.name || c)}<br><small class="muted">${esc(CATS[c]?.desc || '')}</small></td><td class="pos">+${v.toFixed(2)}/s</td></tr>`).join('')}</table>` : '<p class="muted">No income recorded yet.</p>'}
        <p class="muted small">Taxes scale with population and the tax level (Government). Markets employ merchants; trade comes from connected cities and trade agreements.</p></div>`;
      h += `<div class="ws-card"><h4>Expenses</h4>${exp.length ? `<table class="grid">${exp.sort((a, b) => b[1] - a[1]).map(([c, v]) => `<tr><td>${esc(CATS[c]?.name || c)}<br><small class="muted">${esc(CATS[c]?.desc || '')}</small></td><td class="neg">−${v.toFixed(2)}/s</td></tr>`).join('')}</table>` : '<p class="muted">No expenses recorded yet.</p>'}
        <p class="muted small">Army upkeep grows faster than the army itself; advanced units cost more to keep.${e.upkeep ? ` Standing army: ${e.upkeep.credits} credits/s.` : ''}</p></div>`;
    } else {
      h += `<div class="ws-card"><h4>Production</h4><ul class="log">${r.producers.map((p) => `<li><b>${esc(p.name)}</b>${p.type === 'town' ? ' <span class="muted">(every settlement hub, a little)</span>' : ''}
        ${!p.techKnown ? ` <span class="tag warn">needs ${esc(D.TECHS[p.tech]?.name || p.tech)}</span>` : !p.ageOk ? ` <span class="tag warn">later era</span>` : ''}
        ${p.place && p.type !== 'town' ? `<br><small class="muted">Built on ${esc(p.place)}.${p.needsRare ? ' Needs access to rare earths.' : ''}</small>` : ''}
        ${p.built || p.building ? `<br><small>${p.working}/${p.built} working${p.building ? `, ${p.building} under construction` : ''}${Object.keys(p.reasons).length ? ` — ${esc(Object.entries(p.reasons).map(([w, n]) => `${n} ${w}`).join(', '))}` : ''} · ${p.output.toFixed(2)}/s${p.potential > p.output + 0.05 ? ` of ${p.potential.toFixed(2)} possible` : ''}</small>` : p.techKnown && p.type !== 'town' ? '<br><small class="muted">None built.</small>' : ''}</li>`).join('') || '<li class="muted">Nothing produces it.</li>'}</ul>
        <p class="muted small">Output depends on staffing, power, inputs and stability.</p></div>`;
      h += `<div class="ws-card"><h4>Consumption</h4><ul class="log">${r.consumers.map((c) => `<li>${c.count} ${esc(c.name)}${c.count > 1 ? 's' : ''} <span class="muted">up to ${c.rate.toFixed(2)}/s</span></li>`).join('')}${k === 'food' ? '<li>Your population <span class="muted">and field rations for the army</span></li>' : ''}${r.unitUses ? `<li class="muted">Training: ${r.unitUses} unit type${r.unitUses > 1 ? 's' : ''} cost ${esc(r.title.toLowerCase())}</li>` : ''}${!r.consumers.length && k !== 'food' && !r.unitUses ? '<li class="muted">Nothing you have built uses it yet.</li>' : ''}</ul>${r.blocked.length ? `<p class="bad">Short right now: ${esc(r.blocked.join(', '))}.</p>` : ''}</div>`;
    }
    // current economy
    const prodN = r.producers.filter((p) => p.type !== 'town');
    h += `<div class="ws-card"><h4>Current economy</h4><dl class="kv">
      <dt>In storage</dt><dd>${fmt(r.stock)}${r.cap ? ` of ${fmt(r.cap)}` : ''}</dd>
      ${r.reserved ? `<dt>Reserved</dt><dd>${fmt(r.reserved)} <small class="muted">(era advance or national project)</small></dd><dt>Available</dt><dd>${fmt(r.available)}</dd>` : ''}
      ${r.local ? `<dt>In cut-off cities</dt><dd>${fmt(r.local)} <small class="muted">(local, not national)</small></dd>` : ''}
      <dt>Coming in</dt><dd class="${r.inflow > 0.005 ? 'pos' : ''}">${r.inflow > 0.005 ? '+' + r.inflow.toFixed(2) : '0.00'}/s</dd><dt>Going out</dt><dd class="${r.outflow > 0.005 ? 'neg' : ''}">${r.outflow > 0.005 ? '−' + r.outflow.toFixed(2) : '0.00'}/s</dd><dt>Net</dt><dd class="${r.net < 0 ? 'neg' : 'pos'}">${rate(r.net)}</dd>
      ${k !== 'credits' ? `<dt>Producers</dt><dd>${prodN.reduce((s, p) => s + p.working, 0)} working, ${prodN.reduce((s, p) => s + p.idle, 0)} idle</dd><dt>Consumers</dt><dd>${r.consumers.reduce((s, c) => s + c.count, 0)} buildings</dd>` : ''}
      <dt>${r.net < 0 ? 'Runs out in' : 'Depletion'}</dt><dd>${r.lasts != null ? dur(r.lasts) : 'not falling'}</dd></dl></div>`;
    // ledger breakdown
    const cats = Object.entries(r.cats || {}).sort((a, b) => b[1] - a[1]);
    h += `<div class="ws-card"><h4>Why it is ${r.net < -0.005 ? 'falling' : r.net > 0.005 ? 'rising' : 'steady'}</h4>${cats.length ? `<table class="grid ledger-t">${cats.map(([c, v]) => `<tr title="${esc(CATS[c]?.desc || '')}"><td>${esc(CATS[c]?.name || c)}</td><td class="${v < 0 ? 'neg' : 'pos'}">${rate(v)}</td><td class="bar"><i class="${v < 0 ? 'neg' : 'pos'}" style="width:${Math.min(100, (100 * Math.abs(v)) / Math.max(0.01, r.inflow, r.outflow))}%"></i></td></tr>`).join('')}</table>` : '<p class="muted">No movement in the last window.</p>'}
      <p class="muted small">Every change to the national stockpile, by cause. A transfer into supply trucks is not production or consumption.</p></div>`;
    return h + '</div>';
  }

  actionsHtml(actions, good) {
    if (!actions || !actions.length) return '';
    return `<div class="actions res-actions">${actions.map((a, i) => `<button type="button" class="btn small${i === 0 ? ' primary' : ''}" data-ract='${esc(JSON.stringify({ ...a, good: a.good || good }))}' ${a.disabled ? 'disabled' : ''} title="${esc(a.why || '')}">${esc(a.label)}${a.disabled && a.why ? ` <small>(${esc(a.why)})</small>` : ''}</button>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------- production chains
  tab_chains() {
    const S = this.S, D = S.defs, e = S.econ, R = e.resources || {};
    const good = this.chainGood || D.GOODS.find((k) => R[k] && (R[k].status === 'deficit' || R[k].status === 'empty') && k !== 'credits') || 'steel';
    const B = D.BUILDINGS;
    const makers = Object.entries(B).filter(([, d]) => d.produce && d.produce[good] && !d.rebelOnly).map(([t]) => t);
    const users = Object.entries(B).filter(([, d]) => d.consume && d.consume[good]).map(([t]) => t);
    const inputs = [...new Set(makers.flatMap((t) => Object.keys(B[t].consume || {})))];
    const r = R[good];
    const stat = (t) => r?.producers.find((p) => p.type === t);
    const stage = (t, role) => {
      const d = B[t], list = [...S.buildings.values()].filter((b) => b.o === S.civId && b.ty === t), done = list.filter((b) => b.d), run = done.filter((b) => b.s > 0).length;
      const ps = stat(t); const locked = d.tech && !e.techs.includes(d.tech);
      const bott = done.length && run < done.length;
      const gain = ps && ps.potential > ps.output + 0.05 ? ps.potential - ps.output : 0;
      return `<button type="button" class="stage ${locked ? 'locked' : !done.length ? '' : bott ? 'bad' : 'ok'}" data-ract='${esc(JSON.stringify({ a: done.length ? 'locate' : locked ? 'research' : 'build', type: t, tech: d.tech }))}'><b>${esc(d.name)}</b>
        <small>${locked ? `needs ${esc(D.TECHS[d.tech].name)}` : `${done.length} built · ${run} active${list.length > done.length ? ` · ${list.length - done.length} building` : ''}`}</small>
        ${ps && role === 'make' ? `<small>${ps.output.toFixed(2)}/s</small>` : ''}
        ${d.consume ? `<small class="muted">uses ${Object.keys(d.consume).map((k) => esc(D.GOOD_NAMES[k].toLowerCase())).join(', ')}${d.power < 0 ? ', power' : ''}</small>` : d.power < 0 ? '<small class="muted">uses power</small>' : ''}
        ${bott ? `<small class="bad">bottleneck: ${esc(Object.entries(ps?.reasons || {}).map(([w, n]) => `${n} ${w}`).join(', ') || 'idle')}</small>` : ''}
        ${gain ? `<small class="good">+${gain.toFixed(2)}/s if resolved</small>` : ''}</button>`;
    };
    const siteMaker = makers.filter((t) => D.SITE_HINT?.[t]).sort((a, b) => (B[a].tech && !e.techs.includes(B[a].tech)) - (B[b].tech && !e.techs.includes(B[b].tech)))[0];
    const site = siteMaker ? D.SITE_HINT[siteMaker] : null;
    let h = `<div class="ws-card"><h4>Production chain: <select data-chainsel="1" aria-label="Good">${D.GOODS.filter((k) => k !== 'credits').map((k) => `<option value="${k}" ${k === good ? 'selected' : ''}>${esc(D.GOOD_NAMES[k])}</option>`).join('')}</select></h4>`;
    h += `<div class="chain">`;
    if (site) h += `<button type="button" class="stage" data-ract='${esc(JSON.stringify({ a: 'find', type: siteMaker }))}'><b>${esc(site.res ? 'Deposit' : 'Site')}</b><small>for a ${esc(B[siteMaker].name)}: ${esc(D.PLACE_INFO?.[B[siteMaker].place] || '')}</small><small class="muted">click to find</small></button><span class="arrow">→</span>`;
    if (inputs.length) h += inputs.map((k) => `<button type="button" class="stage ${R[k] && R[k].status !== 'ok' ? 'bad' : 'ok'}" data-chaingo="${k}"><b>${esc(D.GOOD_NAMES[k])}</b><small>${fmt(e.res[k] || 0)} · ${R[k] ? rate(R[k].net) : ''}</small><small class="muted">input — open its chain</small></button>`).join('') + '<span class="arrow">→</span>';
    h += makers.map((t) => stage(t, 'make')).join('') || '<div class="stage">No producer</div>';
    h += `<span class="arrow">→</span><button type="button" class="stage ${r && r.status !== 'ok' && r.status !== 'falling' ? 'bad' : 'ok'}" data-res="${good}"><b>${esc(D.GOOD_NAMES[good])}</b><small>${fmt(e.res[good] || 0)} · ${r ? rate(r.net) : ''}</small><small class="muted">open resource</small></button>`;
    if (users.length) h += `<span class="arrow">→</span>${users.map((t) => stage(t, 'use')).join('')}`;
    const outs = [...new Set(users.flatMap((t) => Object.keys(B[t].produce || {})))].filter((k) => k !== 'research' && D.GOOD_NAMES[k]);
    if (outs.length) h += `<span class="arrow">→</span>${outs.map((k) => `<button type="button" class="stage" data-chaingo="${k}"><b>${esc(D.GOOD_NAMES[k])}</b><small class="muted">open its chain</small></button>`).join('')}`;
    const unitsUsing = Object.values(D.UNITS).filter((u) => u.cost[good]).map((u) => u.name);
    if (unitsUsing.length) h += `<span class="arrow">→</span><div class="stage"><b>Units</b><small class="muted">${esc(unitsUsing.slice(0, 6).join(', '))}${unitsUsing.length > 6 ? '…' : ''}</small></div>`;
    h += `</div><p class="muted small">Built from the game's own building definitions. Click a stage to locate those buildings, research them or start placing one.</p>`;
    if (D.IMPORT_PRICE[good]) h += `<p class="muted">Can also be imported through a market: ${D.IMPORT_PRICE[good]} credits each before trade discounts.</p>`;
    return h + '</div>';
  }

  // ---------------------------------------------------------------- cities
  tab_cities() {
    const S = this.S, D = S.defs, cities = [...S.cities.values()].filter((c) => c.o === S.civId);
    if (!this.planAt || S.time - this.planAt > 8) { this.planAt = S.time; for (const c of cities.slice(0, 10)) this.A.cmd({ c: 'cityPlan', city: c.id }).then((r) => { if (r && r.plan) this.plans[c.id] = r.plan; }); }
    let h = '<div class="ws-cols">';
    for (const c of cities) {
      const blds = [...S.buildings.values()].filter((b) => b.c === c.id && b.d && D.BUILDINGS[b.ty].produce);
      const out = {}; for (const b of blds) { const d = D.BUILDINGS[b.ty]; const share = d.jobs ? (b.s || 0) / d.jobs[1] : 1; for (const [k, v] of Object.entries(d.produce)) if (k !== 'research') out[k] = (out[k] || 0) + v * (d.jobs ? d.jobs[1] : 1) * share; }
      const p = this.plans[c.id];
      h += `<div class="ws-card"><h4><button type="button" class="rlink" data-jump="${c.t}" data-city="${c.id}">${esc(c.n)}</button>${c.cap ? ' ★' : ''} <small class="muted">pop ${Math.floor(c.pop)}/${c.h}</small></h4>
        <div class="opind"><span class="ind"><b>${c.lab ?? 0}</b>labour free</span><span class="ind ${c.un > 3 ? 'mid' : ''}"><b>${c.un ?? 0}</b>without work</span><span class="ind ${c.st < 35 ? 'bad' : ''}"><b>${c.st}</b>stability</span><span class="ind ${c.iso ? 'bad' : ''}"><b>${c.cap ? 'capital' : c.iso ? 'cut off' : c.fr < 0 ? '∞' : c.fr + '/s'}</b>freight</span></div>
        <p class="small">${Object.entries(out).filter(([, v]) => v > 0.01).map(([k, v]) => `${this.rlink(k, D.GOOD_NAMES[k])} ~${v.toFixed(2)}/s`).join(' · ') || '<span class="muted">No production yet.</span>'}</p>
        ${c.iso ? `<p class="small warn">Local stock: ${Object.entries(c.stock || {}).filter(([, v]) => v > 0).map(([k, v]) => `${fmt(v)} ${esc(D.GOOD_NAMES[k].toLowerCase())}`).join(', ') || 'empty'}</p>` : ''}
        ${p ? `${p.issues.map((i) => `<div class="rec alt">${esc(i)}</div>`).join('')}${p.recs.slice(0, 2).map((r, i) => `<div class="rec ${i ? 'alt' : ''}"><b>${i ? 'Alternative' : 'Recommended'}:</b> ${r.kind === 'upgrade' ? 'raise a housing block' : esc(D.BUILDINGS[r.type]?.name || r.type)} <span class="muted">— ${esc(r.reason)}</span></div>`).join('')}${p.avoid.slice(0, 1).map((a) => `<div class="rec no"><b>Not recommended:</b> <span class="muted">${esc(a)}</span></div>`).join('')}` : '<p class="muted small">…</p>'}</div>`;
    }
    return h + '</div>';
  }

  // ---------------------------------------------------------------- logistics
  tab_logistics() {
    const S = this.S, D = S.defs, e = S.econ, cities = [...S.cities.values()].filter((c) => c.o === S.civId);
    let h = '<div class="ws-cols">';
    h += `<div class="ws-card"><h4>Trade network</h4><table class="grid"><tr><th>City</th><th>Link</th><th>Freight</th><th>Shipping</th></tr>${cities.map((c) => `<tr data-jump="${c.t}"><td>${esc(c.n)}</td><td>${c.cap ? '<span class="tag good">capital</span>' : c.iso ? '<span class="tag bad">cut off</span>' : '<span class="tag">connected</span>'}</td><td>${c.cap ? '—' : c.iso ? '0' : c.fr < 0 ? '∞' : c.fr + '/s'}</td><td class="${!c.iso && c.fr > 0 && c.ship >= c.fr * 0.95 ? 'warn' : ''}">${c.ship ?? 0}/s${!c.iso && c.fr > 0 && c.ship >= c.fr * 0.95 ? ' (full)' : ''}</td></tr>`).join('')}</table>
      <p class="muted small">Cities share the national stockpile over road, rail and sea links; the weakest link limits how much moves. Cut-off cities live on local reserves.</p><div class="actions"><button type="button" class="btn small" data-ract='{"a":"road","label":"Plan road"}'>Plan a road</button></div></div>`;
    const cv = e.convoys || [];
    h += `<div class="ws-card"><h4>Supply trucks (${cv.length})</h4>${cv.length ? `<table class="grid"><tr><th>Truck</th><th>Status</th><th>Cargo</th><th>ETA</th></tr>${cv.map((c) => `<tr><td>#${c.truck}</td><td>${esc(c.state)}${c.note ? ` <small class="muted">${esc(c.note)}</small>` : ''}</td><td>${c.cargo}</td><td>${c.eta != null ? c.eta + 's' : '—'}</td></tr>`).join('')}</table>` : '<p class="muted">No supply trucks.</p>'}
      ${(e.caches || []).length ? `<p class="muted">${e.caches.length} field cache${e.caches.length > 1 ? 's' : ''}: ${e.caches.map((c) => `<button type="button" class="rlink" data-jump="${c.t}">${c.cargo} cargo</button>`).join(', ')}</p>` : ''}
      <p class="muted small">Loading a truck moves goods out of the stockpile (booked as Supply convoys); unused cargo comes back.</p></div>`;
    const roads = e.roads || [];
    h += `<div class="ws-card"><h4>Road projects (${roads.length})</h4>${roads.length ? `<ul class="log">${roads.map((r) => `<li><span class="tag ${r.status === 'blocked' || r.status === 'paused' ? 'warn' : r.status === 'complete' ? 'good' : ''}">${esc(r.status)}</span> ${esc(D.ROAD_TYPES[r.type].name)} ${r.done}/${r.total}</li>`).join('')}</ul>` : '<p class="muted">None under way.</p>'}</div>`;
    return h + '</div>';
  }

  // ---------------------------------------------------------------- spending
  tab_spending() {
    const S = this.S, D = S.defs, e = S.econ, CATS = D.LEDGER_CATS || {};
    const rates = e.ledger?.rates || {};
    const outCats = Object.entries(rates).filter(([c]) => !CATS[c]?.in).map(([c, g]) => [c, Object.entries(g).filter(([, v]) => v < 0)]).filter(([, g]) => g.length);
    let h = '<div class="ws-cols">';
    h += `<div class="ws-card"><h4>Where goods go</h4>${outCats.length ? `<table class="grid"><tr><th>Category</th><th>Per second</th></tr>${outCats.map(([c, g]) => `<tr title="${esc(CATS[c]?.desc || '')}"><td>${esc(CATS[c]?.name || c)}</td><td>${g.map(([k, v]) => `${this.rlink(k, D.GOOD_NAMES[k])} ${(-v).toFixed(2)}`).join(' · ')}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing spent in the last window.</p>'}<p class="muted small">Averaged over the last ${e.ledger?.window || 20} s.</p></div>`;
    const planned = [...S.buildings.values()].filter((b) => b.o === S.civId && b.st === 'planned');
    const tot = {}; for (const b of planned) for (const [k, v] of Object.entries(D.BUILDINGS[b.ty].cost)) tot[k] = (tot[k] || 0) + v;
    h += `<div class="ws-card"><h4>Commitments</h4><dl class="kv"><dt>Projects awaiting funds</dt><dd>${planned.length}${planned.length ? ` — ${this.costHtml(tot, e.res)}` : ''}</dd>
      <dt>Training queues</dt><dd>${[...S.buildings.values()].filter((b) => b.o === S.civId && b.q?.length).reduce((s, b) => s + b.q.length, 0)} units</dd>
      <dt>Army upkeep</dt><dd>${e.upkeep ? `${e.upkeep.credits} credits/s, ${e.upkeep.fuel} fuel/s` : '—'}</dd>
      ${e.saving ? `<dt>Reserved for the next era</dt><dd>${this.costHtml(e.saving)}</dd>` : ''}${e.natReserve ? `<dt>Reserved for a project</dt><dd>${esc(D.BUILDINGS[e.natReserve]?.name || e.natReserve)}</dd>` : ''}</dl></div>`;
    return h + '</div>';
  }

  // ---------------------------------------------------------------- construction
  tab_construction() {
    const S = this.S, D = S.defs, e = S.econ;
    const sites = [...S.buildings.values()].filter((b) => b.o === S.civId && (!b.d || b.st === 'damaged'));
    const types = [...new Set(sites.map((b) => b.ty))];
    let h = `<div class="actions"><label class="field inline"><span>Type</span><select data-cfilter="1"><option value="">All</option>${types.map((t) => `<option value="${t}" ${this.cfilter === t ? 'selected' : ''}>${esc(D.BUILDINGS[t].name)}</option>`).join('')}</select></label></div>`;
    const list = sites.filter((b) => !this.cfilter || b.ty === this.cfilter);
    if (!list.length) return h + '<p class="muted">No construction under way and nothing damaged.</p>';
    const byCity = new Map(); for (const b of list) { const a = byCity.get(b.c) || []; a.push(b); byCity.set(b.c, a); }
    h += '<div class="ws-cols">';
    for (const [cid, arr] of byCity) {
      const c = S.cities.get(cid);
      h += `<div class="ws-card"><h4>${esc(c ? c.n : 'Outlying')}</h4><ul class="log cons">`;
      for (const b of arr.sort((x, y) => (y.p || 0) - (x.p || 0))) {
        const d = D.BUILDINGS[b.ty];
        const stage = b.st === 'planned' ? ['Planned', 'warn', 'awaiting funds'] : b.st === 'damaged' ? ['Damaged', 'bad', 'repair recommended'] : !b.d ? ['Constructing', '', ''] : ['Complete', 'good', ''];
        const left = !b.d && b.st !== 'planned' ? ((1 - (b.p || 0) / 100) * d.time) / Math.max(0.2, b.cr || 1) : null;
        const missing = b.st === 'planned' ? Object.entries(d.cost).filter(([k, v]) => (e.res[k] || 0) < v).map(([k, v]) => `${Math.ceil(v - (e.res[k] || 0))} ${D.GOOD_NAMES[k].toLowerCase()}`) : [];
        const delay = b.st === 'planned' ? `waiting for ${missing.join(', ') || 'funds'}` : !b.d && (b.cr || 1) < 0.6 ? 'few hands free: crews are slow (idle workers and nearby engineers speed it up)' : stage[2];
        h += `<li><button type="button" class="rlink" data-jump="${b.t}" data-pulse="${b.id}">${esc(d.name)}</button> <span class="tag ${stage[1]}">${stage[0]}</span>
          ${!b.d && b.st !== 'planned' ? `<div class="bar sup"><i style="width:${b.p}%"></i></div><small>${b.p}% · about ${dur(left)} left · crew ×${(b.cr || 1).toFixed(1)}</small>` : ''}
          ${b.st === 'damaged' ? `<small>condition ${b.hp}%</small> <button type="button" class="btn tiny" data-repair="${b.id}">Repair</button>` : ''}
          <br><small class="muted">${this.costHtml(d.cost, b.st === 'planned' ? e.res : null)}${delay ? ` — ${esc(delay)}` : ''}</small></li>`;
      }
      h += '</ul></div>';
    }
    return h + '</div>';
  }

  // ---------------------------------------------------------------- input
  onClick(ev) {
    const t = ev.target.closest('[data-ectab],[data-res],[data-ract],[data-chaingo],[data-repair]'); if (!t) return false;
    const d = t.dataset;
    if (d.ectab) { this.tab = d.ectab; return true; }
    if (d.res) { this.good = d.res; this.tab = 'resources'; return true; }
    if (d.chaingo) { this.chainGood = d.chaingo; this.tab = 'chains'; return true; }
    if (d.repair) { this.A.cmd({ c: 'repair', id: +d.repair }); return true; }
    if (d.ract) { try { this.A.resourceAction(JSON.parse(d.ract)); } catch { /* malformed */ } return true; }
    return false;
  }
  onChange(ev) {
    const t = ev.target;
    if (t.dataset.chainsel) { this.chainGood = t.value; return true; }
    if (t.dataset.cfilter) { this.cfilter = t.value; return true; }
    return false;
  }
}

function whyWord(w, D) { return !w ? '' : w.startsWith('input:') ? 'missing ' + (D.GOOD_NAMES[w.slice(6)] || '').toLowerCase() : { staff: 'no workers', power: 'no power', full: 'storage full', rare: 'no rare earths', locked: 'locked' }[w] || (w.startsWith('prio:') ? 'lower priority' : w); }
function summarize(words) { const m = {}; for (const w of words) if (w) m[w] = (m[w] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', '); }

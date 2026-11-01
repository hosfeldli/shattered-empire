// Contextual command bar: only the commands that make sense for what is selected.
// Ground troops: Move / Attack / Hold / Fortify. Aircraft: Patrol / Strike / Return. Recon: Scout / Return.
// One-way drones: Strike / Cancel. Trucks: Deliver / Return. Everything else lives under "More".
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// what kind of thing a unit is, for command purposes
export function unitKind(D, type) {
  const d = D.UNITS[type];
  if (d.air) return d.role === 'recon' ? 'recon' : d.role === 'oneway' ? 'oneway' : 'air';
  if (type === 'supply_truck') return 'truck';
  if (type === 'colonist') return 'colonist';
  if (d.civilian) return 'civil';
  return 'ground';
}

const GROUPS = {
  ground: { label: 'Troops', cmds: [['moveMode', 'Move', 'Click a destination (or right-click / right-drag for a battle line)'], ['amove', 'Attack', 'Advance and fight anything on the way (Ctrl/Cmd+A)'], ['hold', 'Hold', 'Stay and fire at what comes in range (H)'], ['fortify', 'Fortify', 'Draw a trench line for national crews to dig']] },
  air: { label: 'Aircraft', cmds: [['patrolMode', 'Patrol', 'Click an area: aircraft orbit it, engage what they can, and cycle home to refuel'], ['strikeMode', 'Strike', 'Click a target: aircraft fly out, attack and return to rearm'], ['airReturn', 'Return', 'Fly home and service']] },
  recon: { label: 'Recon', cmds: [['scoutMode', 'Scout', 'Click an area to reveal: the drone orbits it and returns on fuel'], ['airReturn', 'Return', 'Fly home and service']] },
  oneway: { label: 'Strike drones', cmds: [['strikeMode', 'Strike', 'Click a target: the drone flies one way and detonates'], ['airReturn', 'Cancel', 'Abort the strike and land']] },
  truck: { label: 'Trucks', cmds: [['supply', 'Deliver', 'Load at the nearest store and carry supplies to the selected troops or their front'], ['withdraw', 'Return', 'Drive back to the nearest friendly city']] },
  colonist: { label: 'Colonists', cmds: [['found', 'Found city', 'Found a city here (F)'], ['autoSettle', 'Auto-settle', 'Pick a site and settle']] },
  civil: { label: 'Civilians', cmds: [['moveMode', 'Move', 'Click a destination']] },
};
// mirrors the server's canFly: which missions each aircraft role can fly
export function canFly(def, kind) {
  const r = def.role;
  if (kind === 'return') return true;
  if (r === 'recon') return kind === 'scout' || kind === 'patrol';
  if (r === 'oneway' || r === 'bomber') return kind === 'strike';
  if (r === 'fighter') return kind === 'patrol' || kind === 'strike';
  if (r === 'strike') return kind === 'strike' || kind === 'support';
  return kind === 'patrol' || kind === 'strike' || kind === 'support';
}
const CMD_MISSION = { patrolMode: 'patrol', strikeMode: 'strike', scoutMode: 'scout', supportMode: 'support' };
const MORE = [['stop', 'Stop'], ['withdraw', 'Withdraw (X)'], ['engageMode', 'Engage'], ['focusMode', 'Focus fire'], ['defendMode', 'Defend area'], ['army', 'Form army'], ['spread', 'Spread out'], ['supply', 'Request supply'], ['disband', 'Disband']];

export class CommandBar {
  constructor(S, el, act) { this.S = S; this.el = el; this.act = act; this.more = false; this.html = ''; el.addEventListener('click', (e) => this.onClick(e)); }
  onClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.more != null) { this.more = !this.more; this.html = ''; this.render(); return; }
    if (b.dataset.cb) this.act(b.dataset.cb, b.dataset.kind || null);
  }
  render() {
    const S = this.S, D = S.defs;
    const units = S.spectator ? [] : [...S.selUnits].map((id) => S.units.get(id)).filter((u) => u && u.owner === S.civId);
    const building = S.mode && ['build', 'road', 'trench', 'missile'].includes(S.mode.kind);   // construction tools own the bottom of the screen
    if (!units.length || building || !$bb()) { if (this.html) { this.html = ''; this.el.innerHTML = ''; } this.el.hidden = true; return; }
    const kinds = new Map(); for (const u of units) { const k = unitKind(D, u.type); kinds.set(k, (kinds.get(k) || 0) + 1); }
    const mode = S.mode?.kind || '';
    const on = (c) => ({ moveMode: 'move', amove: 'attackMove', patrolMode: 'airPatrol', strikeMode: 'airStrike', scoutMode: 'airScout', engageMode: 'engage', focusMode: 'focus' })[c] === mode;
    let h = '';
    for (const [k, n] of kinds) {
      const g = GROUPS[k]; if (!g) continue;
      const ofKind = units.filter((u) => unitKind(D, u.type) === k);
      const cmds = g.cmds.filter(([c]) => !CMD_MISSION[c] || ofKind.some((u) => canFly(D.UNITS[u.type], CMD_MISSION[c])));
      h += `<div class="cb-grp">${kinds.size > 1 ? `<span class="cb-l">${esc(g.label)} ${n}</span>` : ''}${cmds.map(([c, l, t]) => `<button type="button" class="cb${on(c) ? ' on' : ''}" data-cb="${c}" data-kind="${k}" title="${esc(t)}">${esc(l)}</button>`).join('')}</div>`;
    }
    // aircraft at a glance: how many are aloft, low on fuel, out of ammunition or being serviced
    const air = units.filter((u) => u.air && u.air.st);
    if (air.length) {
      const low = air.filter((u) => !u.air.grounded && u.air.fuel < 30).length, dry = air.filter((u) => D.UNITS[u.type].ammo && u.air.ammo <= 0).length, svc = air.filter((u) => u.air.st === 'servicing' || u.air.st === 'awaiting').length;
      const bits = [low && `<span class="tag warn">${low} low fuel</span>`, dry && `<span class="tag warn">${dry} no ammunition</span>`, svc && `<span class="tag">${svc} servicing</span>`].filter(Boolean);
      if (bits.length) h += `<div class="cb-grp">${bits.join('')}</div>`;
    }
    h += `<div class="cb-grp"><button type="button" class="cb ghost${this.more ? ' on' : ''}" data-more title="Stop, withdraw, engagement modes, armies and more">More ▾</button></div>`;
    if (this.more) h += `<div class="cb-more">${MORE.filter(([c]) => c !== 'supply' || kinds.has('ground')).map(([c, l]) => `<button type="button" class="cb" data-cb="${c}">${esc(l)}</button>`).join('')}</div>`;
    this.el.hidden = false;
    if (h !== this.html) { this.html = h; this.el.innerHTML = h; }
  }
}
const $bb = () => { const b = document.getElementById('buildbar'); return !b || b.hidden; };

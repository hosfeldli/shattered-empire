// The tutorial: a small, peaceful match with one relaxed rival and a short guided tour of every
// main system. Each step says what to do; it moves on by itself when you have done it (or with
// Next for the steps that are only something to look at). A small card, bottom left, out of the way.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STEPS = [
  { title: 'Look around', text: 'Pan with <b>W A S D</b> (or drag with the middle mouse button) and zoom with the <b>wheel</b>.', done: (S, T) => T.camMoved && T.zoomed },
  { title: 'Your city runs itself', text: 'Every city has a <b>governor</b> that builds, staffs and repairs on its own. Its banner says what it is doing right now. Click the <b>town hall</b> to see the city and its governor.', done: (S) => S.selBuilding != null && S.buildings.get(S.selBuilding)?.ty === 'town' },
  { title: 'Resources', text: 'The top bar shows your stockpiles; click one to see what makes it. Under every working building a small chip shows what it produces, and its goods float up from it now and then.', next: true },
  { title: 'Build', text: 'Press <b>B</b> for the build menu and place a <b>Farm</b>. If you cannot pay yet it is queued and starts when funded.', done: (S, T) => T.count(S, 'farm') > T.start.farm },
  { title: 'Build several at once', text: 'Pick <b>Housing Block</b>, then <b>drag across hexes</b> to place a row (Shift+drag fills an area). Escape ends placing.', done: (S, T) => T.count(S, 'house') >= T.start.house + 2 },
  { title: 'Upgrade instead of sprawl', text: '<b>Double-click</b> a building to select every one of that kind on screen, then upgrade them all from the panel. Bigger, better buildings beat many small ones.', next: true },
  { title: 'Research', text: 'Press <b>T</b>. Research picks itself whenever nothing is chosen; click a technology to research it now or queue it. Eras begin by themselves, but later technologies need goods (steel, fuel, electronics) to start.', done: (S, T) => T.hud.ws === 'research' },
  { title: 'Your army', text: 'Close research (Escape) and press <b>Q</b> to select every combat unit on screen.', done: (S) => S.selUnits.size >= 2 },
  { title: 'Defend, Attack, Explore', text: 'In the panel, set them to <b>Explore</b>: they scout on their own. <b>Attack</b> hunts nearby enemies and takes cover; <b>Defend</b> holds where you send them.', done: (S) => [...S.selUnits].some((id) => S.units.get(id)?.stance === 'explore') },
  { title: 'Move and fight', text: 'Select some troops and <b>right-click</b> the map to send them there. Right-clicking an enemy attacks it.', done: (S, T) => T.flags.moved },
  { title: 'Battle lines', text: 'With troops selected, <b>right-drag</b> a line: they spread out along it, facing away from your city, with guns behind.', done: (S, T) => T.flags.deployed },
  { title: 'Rally points', text: 'Select your <b>Barracks</b> (double-click selects all of them) and <b>right-click</b> the map: new units will gather there.', done: (S, T) => T.flags.rally },
  { title: 'Government', text: 'Open <b>Government</b> on the left rail. Each government has real effects and speeds up some branches of research; policies add more.', done: (S, T) => T.hud.ws === 'government' },
  { title: 'Front lines', text: 'Close it and press <b>L</b> until the <b>Front lines</b> view. When an enemy is near it shows the front and suggests a defensive line: click it to dig trenches there.', done: (S) => S.lens === 'front' },
  { title: 'You are ready', text: 'That is everything you need. The rival keeps the peace for the first fifteen minutes: build up, explore, and prepare. Good luck.', next: true, last: true },
];

export class Tutorial {
  constructor(S, hud, el) {
    this.S = S; this.hud = hud; this.el = el; this.i = 0; this.flags = {}; this.camMoved = false; this.zoomed = false;
    this.start = { farm: this.count(S, 'farm'), house: this.count(S, 'house') };
    this.cam0 = null;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tut]'); if (!b) return;
      if (b.dataset.tut === 'next') this.advance(); else if (b.dataset.tut === 'end') this.end();
    });
    this.render();
  }
  count(S, ty) { let n = 0; for (const b of S.buildings.values()) if (b.o === S.civId && b.ty === ty) n++; return n; }
  // called a few times a second
  tick(view) {
    if (!this.el.isConnected || this.done) return;
    const c = view.cam; if (!this.cam0) this.cam0 = { x: c.x, y: c.y, z: c.z };
    if (Math.hypot(c.x - this.cam0.x, c.y - this.cam0.y) > 60) this.camMoved = true;
    if (Math.abs(c.z - this.cam0.z) > 0.15) this.zoomed = true;
    const st = STEPS[this.i];
    if (st.done && st.done(this.S, this)) this.advance();
  }
  advance() {
    if (STEPS[this.i].last) return this.end();
    this.i++;
    if (STEPS[this.i].title === 'Build') this.start.farm = this.count(this.S, 'farm');
    if (STEPS[this.i].title === 'Build several at once') this.start.house = this.count(this.S, 'house');
    this.render();
  }
  end() { this.done = true; this.el.hidden = true; }
  render() {
    const st = STEPS[this.i];
    this.el.hidden = false;
    this.el.innerHTML = `<div class="tut-h"><span class="muted">Tutorial ${this.i + 1} / ${STEPS.length}</span><b>${esc(st.title)}</b></div><p>${st.text}</p>
      <div class="tut-bar"><i style="width:${Math.round((100 * this.i) / (STEPS.length - 1))}%"></i></div>
      <div class="actions">${st.next ? `<button class="btn small primary" data-tut="next">${st.last ? 'Finish' : 'Next'}</button>` : `<button class="btn small ghost" data-tut="next">Skip</button>`}<button class="btn small ghost" data-tut="end">End tutorial</button></div>`;
  }
}

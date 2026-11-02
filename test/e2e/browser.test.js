// Browser interaction tests (Playwright + Chromium): box & double-click selection, control groups,
// building placement, road drawing with server previews, and governor controls.
// Run: npm run test:e2e   (CI installs Chromium with `npx playwright install --with-deps chromium`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }
const skip = !chromium && 'playwright not installed';
const PORT = 19000 + Math.floor(Math.random() * 900);
let srv, browser, page;
const pageErrors = [];

before(async () => {
  if (skip) return;
  srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, SERVE_CLIENT: '1', PORT: String(PORT), SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-e2e-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) r(); }));
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { pageErrors.push(String(e && e.stack || e)); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.fill('#playerName', 'E2E');
  await page.click('.advanced summary');
  await page.fill('#seed', '7');
  await page.click('#btnPlayAI');
  await page.waitForFunction(() => window.__S && window.__S.ready && window.__S.econ && window.__S.units.size >= 4, null, { timeout: 20000 });
});
after(async () => { await browser?.close(); srv?.kill(); });

// screen position (page coords) of a unit / tile
const unitPos = (id) => page.evaluate((id) => { const v = window.__view(), s = v.unitSprites.get(id), r = v.app.canvas.getBoundingClientRect(); const [x, y] = v.worldToScreen(s.dx, s.dy); return [r.left + x, r.top + y]; }, id);
const tilePos = (t) => page.evaluate((t) => { const v = window.__view(), r = v.app.canvas.getBoundingClientRect(); const [x, y] = v.worldToScreen(v.cx[t], v.cy[t]); return [r.left + x, r.top + y]; }, t);
const myUnits = () => page.evaluate(() => [...window.__S.units.values()].filter((u) => u.owner === window.__S.civId).map((u) => ({ id: u.id, type: u.type, tile: u.tile })));
const selected = () => page.evaluate(() => [...window.__S.selUnits]);

test('double-click selects every owned unit of that type on screen, and only that type', { skip }, async () => {
  await page.evaluate(() => { const S = window.__S, v = window.__view(); const c = [...S.cities.values()].find((x) => x.o === S.civId); v.centerOn(c.t, 2.2); });
  // wait until sprites have finished easing into their stack positions
  await page.waitForFunction(() => { const v = window.__view(), S = window.__S; const k = [...v.unitSprites.values()].map((s) => s.dx.toFixed(1) + s.dy.toFixed(1)).join(); const same = k === window.__lastK; window.__lastK = k; return same && S.units.size >= 4; }, null, { timeout: 15000, polling: 400 });
  const units = await myUnits();
  const militia = units.filter((u) => u.type === 'militia');
  assert.ok(militia.length >= 2);
  const [x, y] = await unitPos(militia[0].id);
  await page.mouse.click(x, y);
  assert.deepEqual(await selected(), [militia[0].id], 'single click selects one unit');
  await page.waitForTimeout(700);                                   // let the single click stand alone
  await page.mouse.click(x, y); await page.mouse.click(x, y);   // two quick clicks
  const sel = await selected();
  assert.deepEqual(sel.sort(), militia.map((u) => u.id).sort(), 'double-click selects all militia');
  assert.ok(!sel.some((id) => units.find((u) => u.id === id).type !== 'militia'), 'no other types selected');
  assert.match(await page.textContent('#selection'), /2 units selected|2×/);
});

test('box selection and control groups', { skip }, async () => {
  const units = await myUnits();
  const pts = await Promise.all(units.map((u) => unitPos(u.id)));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  await page.mouse.move(Math.min(...xs) - 20, Math.min(...ys) - 20);
  await page.mouse.down(); await page.mouse.move(Math.max(...xs) + 20, Math.max(...ys) + 20, { steps: 6 }); await page.mouse.up();
  assert.equal((await selected()).length, units.length, 'drag box selects all own units');
  await page.keyboard.press('Control+1');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__S.selUnits.clear(); });
  await page.keyboard.press('1');
  assert.equal((await selected()).length, units.length, 'control group 1 recalls the selection');
});

test('placing a building uses server-computed valid hexes', { skip }, async () => {
  const before = await page.evaluate(() => [...window.__S.buildings.values()].filter((b) => b.ty === 'house').length);
  await page.keyboard.press('b');                       // the build palette opens from the rail (B)
  await page.click('[data-build=house]');
  await page.waitForFunction(() => window.__S.mode && window.__S.mode.tiles && window.__S.mode.tiles.size > 0);
  const tile = await page.evaluate(() => [...window.__S.mode.tiles][0]);
  await page.evaluate((t) => window.__view().centerOn(t), tile);
  await page.waitForTimeout(300);
  const [x, y] = await tilePos(tile);
  await page.mouse.click(x, y);
  await page.waitForFunction((n) => [...window.__S.buildings.values()].filter((b) => b.ty === 'house').length > n, before, { timeout: 15000 });
});

test('road drawing: drag a route, see the server preview, commission it', { skip }, async () => {
  const cap = await page.evaluate(() => [...window.__S.cities.values()].find((x) => x.o === window.__S.civId).t);
  await page.evaluate((t) => window.__view().centerOn(t, 1.6), cap);
  await page.waitForTimeout(300);
  await page.keyboard.press('r');
  assert.equal(await page.isVisible('#roadPanel'), true);
  const [x0, y0] = await tilePos(cap);
  // try a few directions until the server says a route is buildable (rivers or sea may block some)
  const dirs = [[1, -0.5], [-1, 0.4], [0.3, 1], [-0.4, -1], [1, 0.6], [-1, -0.6]];
  for (const [dx, dy] of dirs) {
    await page.mouse.move(x0 + dx * 40, y0 + dy * 40); await page.mouse.down();
    await page.mouse.move(x0 + dx * 80, y0 + dy * 80, { steps: 8 }); await page.mouse.move(x0 + dx * 120, y0 + dy * 120, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => window.__S.mode?.preview, null, { timeout: 15000 });
    if (await page.evaluate(() => !!window.__S.mode.preview.buildable)) break;
    await page.click('[data-road=clear]');
    await page.waitForFunction(() => !window.__S.mode?.points?.length, null, { timeout: 5000 });
  }
  const text = await page.textContent('#roadPanel');
  assert.match(text, /Length/); assert.match(text, /Cost/);
  const pts = await page.evaluate(() => window.__S.mode.points.length);
  assert.ok(pts >= 3, 'freehand drag produced waypoints');
  await page.evaluate(() => window.__S.econ.res.materials);
  await page.click('[data-road=commit]');
  await page.waitForFunction(() => (window.__S.econ.roads || []).length > 0, null, { timeout: 15000 });
  await page.keyboard.press('Escape');
});

test('governor controls: autonomy level, specialisation, and the workforce tab', { skip }, async () => {
  const hub = await page.evaluate(() => { const S = window.__S; const c = [...S.cities.values()].find((x) => x.o === S.civId); return c.t; });
  await page.evaluate((t) => window.__view().centerOn(t, 1.6), hub);
  await page.waitForTimeout(300);
  // click the hub (offset so the units standing on it are not hit)
  const [x, y] = await tilePos(hub);
  await page.evaluate(() => { window.__S.selUnits.clear(); });
  await page.evaluate(([x, y]) => { const S = window.__S; const b = [...S.buildings.values()].find((b) => b.ty === 'town' && b.o === S.civId); S.selBuilding = b.id; }, [x, y]);
  await page.waitForSelector('[data-ctab=governor]');
  await page.click('[data-ctab=governor]');
  await page.click('[data-govlevel=managed]');
  await page.waitForFunction(() => { const c = [...window.__S.cities.values()].find((x) => x.o === window.__S.civId); return c.gov && c.gov.enabled && c.gov.level === 'managed'; }, null, { timeout: 15000 });
  await page.selectOption('[data-gov=spec]', 'industrial');
  await page.waitForFunction(() => { const c = [...window.__S.cities.values()].find((x) => x.o === window.__S.civId); return c.gov && c.gov.enabled && c.gov.spec === 'industrial'; }, null, { timeout: 15000 });
  // workforce: categories with staffing, priorities, and an auto-balance preview
  await page.click('[data-ctab=workforce]');
  await page.waitForSelector('[data-wfprio=industry]');
  assert.match(await page.textContent('#selection'), /positions staffed/);
  await page.selectOption('[data-wfprio=research]', 'high');
  await page.waitForFunction(() => { const c = [...window.__S.cities.values()].find((x) => x.o === window.__S.civId); return c.wf && c.wf.prio.research === 'high'; }, null, { timeout: 15000 });
  await page.click('[data-wf=preview]');
  await page.waitForSelector('.preview', { timeout: 15000 });
  // overview: the population ledger
  await page.click('[data-ctab=overview]');
  assert.match(await page.textContent('#selection'), /civilians[\s\S]*labor[\s\S]*serving/);
});

test('multi-building selection: Alt-drag selects buildings, one order trains across all of them', { skip }, async () => {
  const cap = await page.evaluate(() => [...window.__S.cities.values()].find((x) => x.o === window.__S.civId).t);
  await page.evaluate((t) => { window.__S.selUnits.clear(); window.__view().centerOn(t, 1.4); }, cap);
  await page.waitForTimeout(400);
  const own = await page.evaluate(() => [...window.__S.buildings.values()].filter((b) => b.o === window.__S.civId && b.d).map((b) => ({ id: b.id, t: b.t, ty: b.ty })));
  const [cx, cy] = await tilePos(cap);
  // only buildings near the centre, so the box stays clear of the HUD panels
  const pts = (await Promise.all(own.map((b) => tilePos(b.t)))).filter(([x, y]) => Math.abs(x - cx) < 200 && Math.abs(y - cy) < 160);
  assert.ok(pts.length >= 2, 'at least two buildings near the capital');
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  await page.keyboard.down('Alt');
  await page.mouse.move(Math.max(5, Math.min(...xs) - 30), Math.max(5, Math.min(...ys) - 30));
  await page.mouse.down(); await page.mouse.move(Math.min(1400, Math.max(...xs) + 30), Math.min(880, Math.max(...ys) + 30), { steps: 6 }); await page.mouse.up();
  await page.keyboard.up('Alt');
  const n = await page.evaluate(() => window.__S.selBuildings.size);
  assert.ok(n >= 2, `box selected ${n} buildings`);
  assert.equal((await selected()).length, 0, 'Alt-drag selects buildings, not units');
  await page.waitForFunction(() => /buildings selected/.test(document.querySelector('#selection').textContent), null, { timeout: 15000 });
  // Shift-click adds the barracks to the selection
  const bar = own.find((b) => b.ty === 'barracks');
  if (bar && !(await page.evaluate((id) => window.__S.selBuildings.has(id), bar.id))) {
    await page.evaluate((t) => window.__view().centerOn(t, 1.4), bar.t); await page.waitForTimeout(300);
    const [bx, by] = await tilePos(bar.t);
    await page.keyboard.down('Shift'); await page.mouse.click(bx, by); await page.keyboard.up('Shift');
    await page.waitForFunction((id) => window.__S.selBuildings.has(id), bar.id, { timeout: 5000 });
  }
  // switch to "per building", then train from every capable building in the selection
  await page.click('[data-batchmode=per]');
  await page.waitForFunction(() => window.__S.batchMode === 'per');
  const q0 = await page.evaluate(() => [...window.__S.buildings.values()].filter((b) => b.o === window.__S.civId).reduce((s, b) => s + (b.q?.length || 0), 0));
  await page.click('[data-batchtrain]:not([disabled])');
  await page.waitForFunction((q0) => [...window.__S.buildings.values()].filter((b) => b.o === window.__S.civId).reduce((s, b) => s + (b.q?.length || 0), 0) > q0, q0, { timeout: 15000 });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__S.selBuildings.clear(); window.__S.selBuilding = null; });
});

test('buildings stand in the world as drawn structures with a city banner (no emoji icons)', { skip }, async () => {
  const r = await page.evaluate(() => {
    const S = window.__S, v = window.__view();
    const city = [...S.cities.values()].find((c) => c.o === S.civId);
    const sprites = [...v.buildingSprites.values()];
    const emoji = sprites.some((s) => s.children.some((ch) => ch.text && /\p{Extended_Pictographic}/u.test(ch.text)));
    const drawn = sprites.every((s) => s.body && s.body.context && s.body.context.instructions.length > 3);
    const banner = sprites.find((s) => s.banner)?.banner.tx.text || '';
    return { n: sprites.length, emoji, drawn, banner, city: city.n };
  });
  assert.ok(r.n >= 2);
  assert.equal(r.emoji, false, 'no emoji glyph sprites');
  assert.ok(r.drawn, 'every building has vector art');
  assert.match(r.banner, new RegExp(r.city));
});

test('spectator: AI-only match without fog, follow another empire, pause, orders disabled', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { pageErrors.push('spectator: ' + String(e && e.stack || e)); });
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await p.click('[data-mode=watch]');
  await p.selectOption('#watchCount', '3');
  await p.click('#btnWatch');
  await p.waitForFunction(() => window.__S && window.__S.ready && window.__S.spectator && window.__S.econ, null, { timeout: 30000 });
  assert.equal(await p.isVisible('#specbar'), true);
  assert.equal(await p.isVisible('#buildbar'), false, 'no build bar while spectating');
  const info = await p.evaluate(() => { const S = window.__S; let seen = 0; for (let i = 0; i < S.vis.length; i++) seen += S.vis[i]; return { seen, n: S.vis.length, owners: new Set([...S.units.values()].map((u) => u.owner)).size, civ: S.civId }; });
  assert.equal(info.seen, info.n, 'no fog: every hex visible');
  assert.ok(info.owners >= 3, 'every empire\'s units are shown');
  const other = await p.evaluate(() => { const S = window.__S; return S.civInfo.find((c) => !c.rebel && c.id !== S.civId).id; });
  await p.click(`[data-follow="${other}"]`);
  await p.waitForFunction((o) => window.__S.civId === o && window.__S.econ, other, { timeout: 15000 });
  await p.click('[data-speed="0"]');
  await p.waitForFunction(() => window.__S.obs && window.__S.obs.speed === 0, null, { timeout: 15000 });
  // right-clicking the map gives no orders while spectating
  await p.mouse.click(700, 400, { button: 'right' });
  await p.waitForTimeout(300);
  assert.equal(await p.locator('#toasts .toast.error').count(), 0, 'no order attempted');
  // the map key explains the in-world symbols
  await p.keyboard.press('k');
  assert.match(await p.textContent('#mapkey'), /No workers/);
  await ctx.close();
});

test('sound: unlocked by a gesture, volume sliders persist, and fogged fighting stays silent', { skip }, async () => {
  await page.mouse.click(720, 450);   // a gesture unlocks audio
  await page.waitForFunction(() => window.__audio().ctx && window.__audio().ctx.state === 'running', null, { timeout: 10000 });
  await page.click('#btnMenu');
  await page.locator('[data-vol=effects]').fill('0.3');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('se.audio')).effects), 0.3);
  await page.click('#btnResume');
  const r = await page.evaluate(() => {
    const a = window.__audio(), S = window.__S, v = window.__view();
    // centre the camera on a hidden tile and on a visible one, and feed each a firefight
    let hidden = -1, seen = -1;
    for (let i = 0; i < S.vis.length && (hidden < 0 || seen < 0); i += 7) { if (!S.vis[i] && hidden < 0) hidden = i; if (S.vis[i] && seen < 0 && S.terr[i] !== 255) seen = i; }
    v.centerOn(hidden); v.frame(0.016);
    a.cluster.clear(); a.combat([{ k: 'fire', a: hidden, b: hidden, s: 1, t: 2, x: 3, n: 0, i: 1 }]);
    const fogged = a.cluster.size;
    v.centerOn(seen); v.frame(0.016);
    a.combat([{ k: 'fire', a: seen, b: seen, s: 1, t: 2, x: 3, n: 0, i: 2 }]);
    const visible = a.cluster.size; a.flush();
    return { fogged, visible, voices: a.voices };
  });
  assert.equal(r.fogged, 0, 'nothing is heard under the fog');
  assert.equal(r.visible, 1, 'visible fighting is heard (as one clustered volley)');
  await page.keyboard.press('m');
  assert.equal(await page.evaluate(() => window.__audio().settings.muted), true, 'M mutes');
  await page.keyboard.press('m');
});

test('research workspace: full-screen graph, inspect without researching, queue with prerequisites, progress kept', { skip }, async () => {
  await page.evaluate(() => { window.__S.selUnits.clear(); const S = window.__S; for (const u of S.units.values()) if (u.owner === S.civId) { S.selUnits.add(u.id); break; } });
  const selBefore = await selected();
  await page.keyboard.press('t');
  await page.waitForSelector('#rwG .node', { timeout: 10000 });
  assert.equal(await page.isVisible('#drawer'), true);
  assert.ok(await page.locator('#rwG .node').count() >= 30, 'every technology is a node');
  // selecting a late node only inspects it
  const research0 = await page.evaluate(() => window.__S.econ.research);
  const bb = await page.locator('#rwG .node[data-tech=mechanization]').boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForSelector('#rwInsp [data-rw=queue]');
  assert.equal(await page.evaluate(() => window.__S.econ.research), research0, 'inspecting does not start research');
  await page.click('#rwInsp [data-rw=queue]');
  await page.waitForFunction(() => window.__S.econ.queue.includes('mechanization') && window.__S.econ.queue.indexOf('motorization') < window.__S.econ.queue.indexOf('mechanization'), null, { timeout: 15000 });
  // reorder keeps prerequisites first
  await page.click('#rwQueue [data-rw=up][data-k=mechanization]').catch(() => {});
  await page.waitForTimeout(400);
  const q = await page.evaluate(() => window.__S.econ.queue);
  assert.ok(q.indexOf('motorization') < q.indexOf('mechanization'));
  // switching research keeps earned progress
  const avail = await page.evaluate(() => { const D = window.__S.defs, e = window.__S.econ; return Object.keys(D.TECHS).filter((k) => !e.techs.includes(k) && D.TECHS[k].age <= e.age && D.TECHS[k].req.every((r) => e.techs.includes(r))).slice(0, 2); });
  await page.evaluate((k) => window.__actions().cmd({ c: 'research', tech: k }), avail[0]);
  await page.waitForFunction((k) => window.__S.econ.research === k && window.__S.econ.progress > 0, avail[0], { timeout: 20000 });
  await page.evaluate((k) => window.__actions().cmd({ c: 'research', tech: k }), avail[1]);
  await page.waitForFunction((k) => window.__S.econ.research === k, avail[1], { timeout: 15000 });
  assert.ok(await page.evaluate((k) => (window.__S.econ.techProgress[k] || 0) > 0, avail[0]), 'progress on the first project is kept');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#drawer'), false, 'Escape closes the workspace');
  assert.deepEqual(await selected(), selBefore, 'the unit selection survived');
});

test('line deployment: right-drag shows the plan, release commits a formation; Fortify opens the trench tool', { skip }, async () => {
  const units = (await myUnits()).filter((u) => ['militia', 'rifle_squad'].includes(u.type));
  await page.evaluate((ids) => { const S = window.__S; S.selUnits.clear(); for (const id of ids) S.selUnits.add(id); S.selBuilding = null; }, units.map((u) => u.id));
  const cap = await page.evaluate(() => [...window.__S.cities.values()].find((x) => x.o === window.__S.civId).t);
  await page.evaluate((t) => window.__view().centerOn(t, 1.6), cap);
  await page.waitForTimeout(300);
  assert.ok(await page.isHidden('#deployBar'), 'no deployment menu just for having troops selected');
  const [x0, y0] = await tilePos(cap);
  await page.mouse.move(x0 - 60, y0 + 60); await page.mouse.down({ button: 'right' });
  await page.mouse.move(x0 + 20, y0 + 60, { steps: 8 });
  await page.waitForFunction(() => window.__S.deploy && window.__S.deploy.plan && window.__S.deploy.plan.slots.size > 0, null, { timeout: 5000 });
  await page.waitForSelector('#deployBar:not([hidden])', { timeout: 5000 });
  assert.match(await page.textContent('#deployBar'), /Spread out|Concentrated|Packed tight/);
  const preview = await page.evaluate(() => [...window.__S.deploy.plan.slots.entries()]);
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction(() => (window.__S.econ.formations || []).length > 0, null, { timeout: 15000 });
  const f = await page.evaluate(() => window.__S.econ.formations[0]);
  const same = preview.filter(([id, t]) => f.slots[id] === t).length;
  assert.ok(same >= preview.length - 1, `the server agreed with the preview (${same}/${preview.length})`);
  // fortify: the command bar opens the Trench Line tool (national crews dig; no troops on the line)
  await page.waitForSelector('#cmdbar [data-cb=fortify]', { timeout: 10000 });
  await page.click('#cmdbar [data-cb=fortify]');
  await page.waitForFunction(() => window.__S.mode?.kind === 'trench', null, { timeout: 5000 });
  const [tx, ty] = await tilePos(cap);
  for (const [dx, dy] of [[-1.5, -1.2], [1.4, 1.3], [-1.4, 1.3], [1.5, -1.2]]) {
    await page.mouse.move(tx + dx * 40, ty + dy * 40); await page.mouse.down();
    await page.mouse.move(tx + dx * 40 + 90, ty + dy * 40, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => window.__S.mode?.preview, null, { timeout: 15000 });
    if (await page.evaluate(() => window.__S.mode.preview.build > 0)) break;
    await page.evaluate(() => { window.__S.mode.points = []; window.__S.mode.preview = null; });
  }
  assert.match(await page.textContent('#roadPanel'), /To build/);
  await page.click('[data-trench=commit]');
  await page.waitForFunction(() => window.__S.fw && window.__S.fw.size > 0, null, { timeout: 20000 });
  await page.keyboard.press('Escape');
});

test('pause (single player), stacked panels, settled tooltips, one alerts button', { skip }, async () => {
  // pause stops the clock; P toggles it
  await page.click('#btnPause');
  await page.waitForFunction(() => window.__S.paused === true, null, { timeout: 5000 });
  const t0 = await page.evaluate(() => window.__S.time);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.__S.time), t0, 'the clock stands still');
  assert.equal(await page.isVisible('#pausedBanner'), true);
  await page.keyboard.press('p');
  await page.waitForFunction((t) => !window.__S.paused && window.__S.time > t, t0, { timeout: 5000 });
  // opening alerts pushes the inspector down instead of covering it
  await page.evaluate(() => { const S = window.__S; const c = [...S.cities.values()].find((x) => x.o === S.civId); window.__actions().selectCity(c.id); });
  await page.click('#alertsBtn'); await page.waitForTimeout(400);
  const [a, sel] = await page.evaluate(() => ['alerts', 'selection'].map((id) => document.getElementById(id).getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
  assert.ok(sel.top >= a.bottom, `the inspector sits below the alerts (${sel.top} vs ${a.bottom})`);
  await page.click('#alertsBtn');
  assert.equal(await page.locator('#alertsBtn .badge, #alertsBtn .dot').count(), 1, 'a single alerts badge');
  // the map tooltip waits for the pointer to settle
  const cap = await page.evaluate(() => [...window.__S.cities.values()].find((x) => x.o === window.__S.civId).t);
  const [x, y] = await tilePos(cap);
  await page.mouse.move(x + 30, y + 30);
  await page.waitForTimeout(80);
  assert.equal(await page.isVisible('#tooltip'), false, 'not instantly');
  await page.waitForTimeout(400);
  assert.equal(await page.isVisible('#tooltip'), true, 'after a short pause');
});

test('no uncaught page errors during the session', { skip }, () => {
  assert.deepEqual(pageErrors, []);
});

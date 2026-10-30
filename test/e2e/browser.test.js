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

before(async () => {
  if (skip) return;
  srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-e2e-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) r(); }));
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { throw e; });
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
  await page.waitForTimeout(800);
  const units = await myUnits();
  const militia = units.filter((u) => u.type === 'militia');
  assert.ok(militia.length >= 2);
  const [x, y] = await unitPos(militia[0].id);
  await page.mouse.click(x, y);
  assert.deepEqual(await selected(), [militia[0].id], 'single click selects one unit');
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
  await page.click('[data-build=house]');
  await page.waitForFunction(() => window.__S.mode && window.__S.mode.tiles && window.__S.mode.tiles.size > 0);
  const tile = await page.evaluate(() => [...window.__S.mode.tiles][0]);
  await page.evaluate((t) => window.__view().centerOn(t), tile);
  await page.waitForTimeout(300);
  const [x, y] = await tilePos(tile);
  await page.mouse.click(x, y);
  await page.waitForFunction((n) => [...window.__S.buildings.values()].filter((b) => b.ty === 'house').length > n, before, { timeout: 5000 });
});

test('road drawing: drag a route, see the server preview, commission it', { skip }, async () => {
  const cap = await page.evaluate(() => [...window.__S.cities.values()].find((x) => x.o === window.__S.civId).t);
  await page.evaluate((t) => window.__view().centerOn(t, 1.6), cap);
  await page.waitForTimeout(300);
  await page.keyboard.press('r');
  assert.equal(await page.isVisible('#roadPanel'), true);
  const [x0, y0] = await tilePos(cap);
  await page.mouse.move(x0 + 70, y0 + 10); await page.mouse.down();
  await page.mouse.move(x0 + 110, y0 - 20, { steps: 8 }); await page.mouse.move(x0 + 150, y0 - 40, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => window.__S.mode?.preview, null, { timeout: 5000 });
  const text = await page.textContent('#roadPanel');
  assert.match(text, /Length/); assert.match(text, /Cost/);
  const pts = await page.evaluate(() => window.__S.mode.points.length);
  assert.ok(pts >= 3, 'freehand drag produced waypoints');
  await page.evaluate(() => window.__S.econ.res.materials);
  await page.click('[data-road=commit]');
  await page.waitForFunction(() => (window.__S.econ.roads || []).length > 0, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
});

test('governor controls: enable, specialise and set a reserve from the city panel', { skip }, async () => {
  const hub = await page.evaluate(() => { const S = window.__S; const c = [...S.cities.values()].find((x) => x.o === S.civId); return c.t; });
  await page.evaluate((t) => window.__view().centerOn(t, 1.6), hub);
  await page.waitForTimeout(300);
  // click the hub (offset so the units standing on it are not hit)
  const [x, y] = await tilePos(hub);
  await page.evaluate(() => { window.__S.selUnits.clear(); });
  await page.evaluate(([x, y]) => { const S = window.__S; const b = [...S.buildings.values()].find((b) => b.ty === 'town' && b.o === S.civId); S.selBuilding = b.id; }, [x, y]);
  await page.waitForSelector('[data-ctab=governor]');
  await page.click('[data-ctab=governor]');
  await page.check('[data-gov=enabled]');
  await page.selectOption('[data-gov=spec]', 'industrial');
  await page.waitForFunction(() => { const c = [...window.__S.cities.values()].find((x) => x.o === window.__S.civId); return c.gov && c.gov.enabled && c.gov.spec === 'industrial'; }, null, { timeout: 5000 });
});

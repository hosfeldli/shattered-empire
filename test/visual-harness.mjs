// Visual check (debug tool): run an AI exhibition at 8x until battles break out, then screenshot the
// fighting at several zoom levels.  node test/visual-harness.mjs <outDir> [minutes=24] [seed=5]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] || 'shots', minutes = +(process.argv[3] || 24), seed = process.argv[4] || '5';
fs.mkdirSync(out, { recursive: true });
const PORT = 19900 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, SERVE_CLIENT: '1', PORT: String(PORT), SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-vis-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) r(); }));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e.stack || e)));
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.fill('#playerName', 'Vis');
  await page.click('.advanced summary').catch(() => {});
  await page.fill('#seed', seed).catch(() => {});
  await page.click('[data-mode=watch]');
  await page.selectOption('#watchCount', '3').catch(() => {});
  await page.click('#btnWatch');
  await page.waitForFunction(() => window.__S && window.__S.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.__actions().speed(8));
  const t0 = Date.now();
  for (;;) {
    await page.waitForTimeout(5000);
    const st = await page.evaluate(() => ({ time: window.__S.time, battles: (window.__S.battles || []).length, craters: window.__S.bf?.c?.length || 0, units: window.__S.units.size }));
    process.stdout.write(`t=${Math.round(st.time / 60)}m battles ${st.battles} craters ${st.craters} units ${st.units}\n`);
    if (st.time > minutes * 60 && st.battles) break;
    if (Date.now() - t0 > 15 * 60e3) break;
  }
  await page.evaluate(() => window.__actions().speed(1));
  console.log('timings', await page.evaluate(() => { const v = window.__view(); const T = {}; for (const [k, fn] of [['ocean', () => v.ocean.frame(1)], ['clouds', () => v.clouds.frame(1)], ['wx', () => v.weatherFx.frame(1, 0.016)], ['ambient', () => v.ambient.frame(0.016, 1)], ['combat', () => v.combat.frame(0.016, 1)], ['res', () => v.resMarkers.frame(1)], ['whole', () => v.frame(0.016)]]) { const t0 = performance.now(); fn(); T[k] = +(performance.now() - t0).toFixed(1); } return T; }));
  console.log('frame ms', await page.evaluate(() => new Promise((res) => { const t0 = performance.now(); let n = 0; const f = () => { if (++n < 5) requestAnimationFrame(f); else res((performance.now() - t0) / 5); }; requestAnimationFrame(f); })));
  const spots = await page.evaluate(() => {
    const S = window.__S;
    const b = (S.battles || []).map((x) => x.t);
    const c = (S.bf?.c || []).sort((a, z) => z[1] - a[1]).map((x) => x[0]);
    return [...new Set([...b.slice(0, 2), ...c.slice(0, 2)])];
  });
  let i = 0;
  for (const t of spots) {
    for (const z of [3.2, 1.6, 0.7]) {
      await page.evaluate(([t, z]) => window.__view().centerOn(t, z), [t, z]);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(out, `spot${i}-z${z}.png`), timeout: 180000 });
    }
    i++;
  }
  // the biggest city up close, and a port city with its waterfront
  const cityShots = await page.evaluate(() => { const S = window.__S; const cs = [...S.cities.values()].sort((a, b) => b.pop - a.pop); const port = [...S.buildings.values()].find((b) => b.ty === 'port'); return [cs[0]?.t, cs[1]?.t, port?.t].filter((x) => x >= 0); });
  let ci = 0;
  for (const t of cityShots) { for (const z of [2.4, 1.2]) { await page.evaluate(([t, z]) => window.__view().centerOn(t, z), [t, z]); await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, `city${ci}-z${z}.png`), timeout: 120000 }); } ci++; }
  // a fogged view: follow one empire with its fog on and look across the continent
  await page.evaluate(() => { window.__actions().fog(true); });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const S = window.__S, c = [...S.cities.values()][0]; window.__view().centerOn(c.t, 0.45); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'fog-wide.png'), timeout: 180000 });
  console.log('shots in', out, errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
} finally { await browser.close(); srv.kill(); }

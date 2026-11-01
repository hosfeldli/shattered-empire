// Visual check (debug tool): start a game, inject a scripted battlefield (craters, scarred ground,
// wrecks, smoke) and replay combat events around the player's capital, then screenshot it.
//   node test/visual-inject.mjs <outDir> [script.js]   — the optional script runs in the page first
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] || 'shots';
fs.mkdirSync(out, { recursive: true });
const PORT = 19800 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, SERVE_CLIENT: '1', PORT: String(PORT), SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'se-vis-')) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) r(); }));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e.stack || e)));
const shot = (name) => page.screenshot({ path: path.join(out, name + '.png') });
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.fill('#playerName', 'Vis');
  await page.click('.advanced summary').catch(() => {});
  await page.fill('#seed', '7').catch(() => {});
  await page.click('#btnPlayAI');
  await page.waitForFunction(() => window.__S && window.__S.ready && window.__S.econ, null, { timeout: 60000 });
  await page.evaluate(() => window.__actions().cmd({ c: 'pause', on: true }));
  await page.waitForTimeout(800);
  const extra = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : '';
  const plan = await page.evaluate((extra) => {
    const S = window.__S, v = window.__view();
    const c = [...S.cities.values()].find((x) => x.o === S.civId);
    // a band of no man's land 3-6 hexes east of the capital
    const W = v.W, row = (c.t / W) | 0, col = c.t % W;
    const tiles = []; for (let r = -4; r <= 4; r++) for (let q = 3; q <= 6; q++) { const t = (row + r) * W + ((col + q) % W); if (S.terr[t] !== 255) tiles.push([t, q]); }
    const bf = { c: [], w: [], s: [], i: [], fp: [] };
    tiles.forEach(([t, q], k) => { bf.i.push([t, q === 4 || q === 5 ? 3 : q === 3 ? 2 : 1]); if (k % 2 === 0) bf.c.push([t, 1 + (k % 3)]); if (k % 5 === 0) bf.w.push([t, k % 2 ? 'tank' : 'apc', k % 3 === 0 ? 1 : 0, S.civId]); if (k % 7 === 0) bf.s.push([t, 7]); });
    S.battlefieldForced = bf;
    v.combat.syncBattlefield(bf);
    if (extra) (0, eval)(extra);
    return { capital: c.t, mid: tiles[Math.floor(tiles.length / 2)][0], tiles: tiles.map((x) => x[0]) };
  }, extra);
  // keep the forced battlefield on screen while snapshots arrive
  await page.evaluate(() => { const v = window.__view(), S = window.__S, sync = v.combat.syncBattlefield.bind(v.combat); v.combat.syncBattlefield = () => sync(S.battlefieldForced); });
  for (const z of [3.2, 1.6, 0.8, 0.4]) { await page.evaluate(([t, z]) => window.__view().centerOn(t, z), [plan.mid, z]); await page.waitForTimeout(900); await shot(`bf-z${z}`); }
  // replay a firefight: rifles and machine guns both ways, mortars and artillery landing, a missile strike
  await page.evaluate(({ mid, tiles, capital }) => {
    const S = window.__S, v = window.__view(), K = S.defs.WEAPON_KEYS, wi = (k) => Math.max(0, K.indexOf(k));
    const pick = (re) => K.find((k) => re.test(k)) || K[0];
    const rifle = wi(pick(/rifle/)), mg = wi(pick(/mg|machine/)), mortar = wi(pick(/mortar/)), art = wi(pick(/howitz|artil/)), aa = wi(pick(/flak|aa/));
    let n = 1, p = 1;
    window.__fight = () => {
      const evs = [];
      for (let i = 0; i < 6; i++) {
        const a = tiles[(i * 7) % tiles.length], b = tiles[(i * 11 + 3) % tiles.length];
        evs.push({ k: 'fire', a, b, s: 0, t: 0, w: i % 2 ? rifle : mg, x: 4, i: n++, n: 0 });
        if (i % 3 === 0) { const pid = 'p' + p++; evs.push({ k: 'launch', a: capital, b, p: pid, w: i % 2 ? mortar : art, f: 0.9, x: 1, i: n++, n: 0 }); setTimeout(() => v.combat.ingest([{ k: 'impact', a: capital, b, p: pid, w: i % 2 ? mortar : art, i: n++, n: S.tick }], 2), 900); }
      }
      v.combat.ingest(evs, 2);
    };
    window.__strike = () => v.combat.ingest([{ k: 'mimpact', a: -1, b: mid, i: n++, n: S.tick }], 2);
  }, plan);
  await page.evaluate(([t]) => window.__view().centerOn(t, 2.2), [plan.mid]);
  for (let k = 0; k < 4; k++) { await page.evaluate(() => window.__fight()); await page.waitForTimeout(260); }
  await shot('fight-a'); await page.waitForTimeout(500); await shot('fight-b');
  await page.evaluate(() => window.__strike());
  for (const ms of [80, 350, 900, 1800]) { await page.waitForTimeout(ms === 80 ? 80 : ms - 80); await shot(`strike-${ms}`); }
  console.log('shots in', out, errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
} finally { await browser.close(); srv.kill(); }

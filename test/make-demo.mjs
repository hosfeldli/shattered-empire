// Dev tool: simulate an AI match for N minutes and save it as a resumable snapshot.
// node test/make-demo.mjs <minutes> [id]  → .snapshots/<id>.json.gz ; rejoin with token "demo-token"
import zlib from 'node:zlib';
import fs from 'node:fs';
import { Game } from '../server/sim/game.js';
import { serializeGame } from '../server/sim/persist.js';
const minutes = +(process.argv[2] || 25), id = process.argv[3] || 'demo01';
const slots = [{ human: false, personality: 'builder', leader: 'Viewer' }, { human: false, personality: 'warlord' }, { human: false, personality: 'merchant' }];
const g = new Game({ id, seed: 7, slots });
for (let i = 0; i < minutes * 600; i++) { g.tick(); g.outbox.length = 0; }
const meta = { id, name: 'Demo: AI empires', mode: 'ai', created: Date.now(), seed: 7, mapSize: 128, rebels: true,
  slots: slots.map((s, i) => ({ human: false, name: i ? 'AI' : 'Viewer', personality: s.personality, token: i ? null : 'demo-token', civId: i })) };
fs.mkdirSync('.snapshots', { recursive: true });
fs.writeFileSync(`.snapshots/${id}.json.gz`, zlib.gzipSync(JSON.stringify({ meta, game: serializeGame(g) })));
console.log('saved', id, 't=', Math.round(g.time), 'age', g.civs[0].age, 'cities', g.cityOf(g.civs[0]).length, 'pop', Math.round(g.civs[0].popTotal), 'roads', g.roads.edges.size);

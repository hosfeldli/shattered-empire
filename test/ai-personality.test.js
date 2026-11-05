import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { serializeGame, restoreGame } from '../server/sim/persist.js';
import { resolvePersonality } from '../server/sim/ai.js';
import { NATIVE_RULESET } from '../server/sim/rulesets.js';
const create=()=>new Game({id:'varied',seed:4,slots:Array.from({length:3},()=>({human:false,personality:'mixed'})),rebels:false,ruleset:NATIVE_RULESET});
const exercise=g=>{for(let i=0;i<35;i++){g.tick();g.outbox.length=0;}assert.ok(g.civs.every(c=>c.researching||c.techs.size>0),'all AIs can research');};

test('the native Varied choice resolves to real personalities before AI setup',()=>{
 const g=create(); assert.deepEqual(g.civs.map(c=>c.personality),['merchant','warlord','builder']);
 assert.equal(resolvePersonality('warlord',2),'warlord');
 assert.equal(resolvePersonality('__proto__',2),'builder');
 assert.doesNotThrow(()=>exercise(g));
});

test('saved mixed/unknown AI personalities resume deterministically without losing the world',()=>{
 const g=create(), saved=serializeGame(g), time=saved.time;
 saved.civs[0].personality='mixed';saved.civs[1].personality='unsupported';
 const restored=restoreGame(saved);
 assert.equal(restored.time,time);assert.equal(restored.buildings.size,g.buildings.size);
 assert.deepEqual(restored.civs.map(c=>c.personality),['merchant','warlord','builder']);
 assert.doesNotThrow(()=>exercise(restored));
});

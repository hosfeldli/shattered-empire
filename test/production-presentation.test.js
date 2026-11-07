import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { economyStep } from '../server/sim/economy.js';
import { NATIVE_RULESET } from '../server/sim/rulesets.js';
import { disk, dist } from '../server/sim/hex.js';
import { T } from '../server/sim/constants.js';
import { autonomyStep } from '../server/sim/autonomy.js';

test('power production feedback reports actual generation without creating a power stockpile',()=>{
 const g=new Game({id:'output',seed:7,slots:[{human:true},{human:true}],rebels:false,ruleset:NATIVE_RULESET});
 const civ=g.civs[0], city=g.capital(civ); city.pop=70; civ.age=4;
 for(const good of Object.keys(civ.res))civ.res[good]=5000;
 civ.techs.add('electrification');
 const tile=disk(city.tile,3).find(t=>g.tileB[t]<0&&!g.world.river[t]);
 assert.ok(Number.isInteger(tile));
 const plant=g.makeBuilding(civ,'power_plant',tile,true);plant.cityId=city.id;plant.lock=4;
 economyStep(g,1);
 assert.ok(plant.staffed>0,'the fixture must actually generate power');
 assert.ok(plant.out.power>0);
 assert.equal(plant.out.power,civ.powerGen,'the rate matches the authoritative grid output');
 assert.equal(civ.res.power,undefined,'presentation does not add an economic resource');
 plant.off=true;economyStep(g,1);
 assert.ok(!plant.out.power,'inactive plants cannot keep showing production');
});

test('Explore can release selected units from a deployment while preserving their current movement',()=>{
 const g=new Game({id:'explore',seed:7,slots:[{human:true},{human:true}],rebels:false,ruleset:NATIVE_RULESET});
 const units=[...g.units.values()].filter(u=>u.owner===0&&u.type==='militia');
 assert.equal(units.length,2);
 const line=[units[0].tile,units[1].tile];
 const deployed=g.command(0,{c:'deploy',units:units.map(u=>u.id),line,behavior:'defend'});
 assert.ok(!deployed?.error,JSON.stringify(deployed));
 const before=units.map(u=>({path:[...u.path],order:structuredClone(u.order)}));
 const reply=g.command(0,{c:'stance',units:units.map(u=>u.id),stance:'explore',releaseFormation:true});
 assert.equal(reply,null);
 for(let i=0;i<units.length;i++) {
  assert.equal(units[i].stance,'explore');
  assert.equal(units[i].formation,0,'a fixed frontage cannot silently suppress exploration');
  assert.deepEqual(units[i].path,before[i].path,'the direct movement still finishes first');
  assert.deepEqual(units[i].order,before[i].order);
 }
});

test('Explore chooses a reachable unexplored destination instead of becoming stuck at an isolated one',()=>{
 const g=new Game({id:'explore-reachable',seed:7,slots:[{human:true},{human:true}],rebels:false,ruleset:NATIVE_RULESET});
 const civ=g.civs[0], u=[...g.units.values()].find(x=>x.owner===0&&x.type==='militia');
 g.world.terr.fill(T.PLAINS); g.world.owner.fill(-1); civ.explored.fill(1);
 const center=u.tile;
 const island=disk(center,4).find(t=>dist(center,t)===4);
 const shore=new Set(disk(island,1).filter(t=>t!==island));
 const reachable=disk(center,6).find(t=>dist(center,t)===6&&!shore.has(t)&&dist(t,island)>3);
 assert.ok(Number.isInteger(reachable));
 for(const t of shore)g.world.terr[t]=T.DEEP;
 civ.explored[island]=0; civ.explored[reachable]=0;
 g.roads.usable=()=>null;
 u.order={kind:'idle'};u.path=[];u.field=false;u.formation=0;u.stance='explore';u.idleSince=-10;
 autonomyStep(g);
 assert.equal(u.goal,reachable,'the isolated destination should not trap the explorer');
 assert.ok(u.path.length>0,'exploration should result in a real movement path');
});

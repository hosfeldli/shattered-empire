import { REMOVED_COMMANDS } from '../server/sim/rulesets.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const actions=JSON.parse(fs.readFileSync(new URL('../godot/recipes/ui_actions.json',import.meta.url)));
const file=(name)=>fs.readFileSync(new URL('../godot/scripts/'+name,import.meta.url),'utf8');

test('native UI action identifiers and typed fields are valid',()=>{
  assert.equal(new Set(actions.map(a=>a.id)).size,actions.length);
  for(const action of actions){
    assert.ok(action.page&&action.title&&action.command&&Array.isArray(action.fields),action.id);
    assert.equal(new Set(action.fields.map(f=>f.key)).size,action.fields.length,action.id);
    for(const field of action.fields)assert.ok(field.source||field.choices||['number','bool','text'].includes(field.kind),action.id+':'+field.key);
  }
});

test('every retained native gameplay command has a native UI or map interaction',()=>{
  const server=fs.readFileSync(new URL('../server/sim/game.js',import.meta.url),'utf8');
  const commandBody=server.slice(server.indexOf('\n  commandInner(civ, cmd)'));
  assert.ok(commandBody.length>1000,'server command dispatcher must be found');
  const commands=new Set([...commandBody.matchAll(/case '([A-Za-z]+)':/g)].map(m=>m[1]));
  const native=[file('input/NativeCommandTools.gd'),file('input/InputController.gd'),file('ui/NativeAppShell.gd'),file('ui/NativeCommandPanel.gd')].join('\n');
  const covered=new Set(actions.map(a=>a.command.c).filter(Boolean));
  for(const a of actions)if(a.preview_command)covered.add(a.preview_command);
  for(const match of native.matchAll(/"c"\s*:\s*"([A-Za-z]+)"/g))covered.add(match[1]);
  // These old spellings are aliases or explicitly retired server operations, not missing controls.
  const exceptions={unqueue:'researchQueue/remove',cancelSupplyRun:'returnSupplyTruck',autoTech:'server now automatically selects research',advance:'server now automatically advances eras',supplyRun:'server rejects: troops supplied automatically',supplyRunLegacy:'retired browser supply workflow'};
  const missing=[...commands].filter(c=>!covered.has(c)&&!exceptions[c]&&!REMOVED_COMMANDS.has(c)&&c!=='governor');
  assert.deepEqual(missing,[],'uncovered native commands: '+missing.join(', '));
});

test('streamlined native UI contains no trading or administration controls',()=>{
  for(const a of actions){ assert.ok(!REMOVED_COMMANDS.has(a.command.c),a.id); assert.notEqual(a.command.c,'governor'); if(a.command.c==='diplo')assert.ok(['war','disengage'].includes(a.command.action),'only hostilities and disengagement: '+a.command.action); }
  const nav=file('ui/NativeSectionNav.gd'); for(const title of ['World','Build','Cities','Military','Economy','Research','Rivals','Chronicle'])assert.ok(nav.includes('\"'+title+'\"'));
});

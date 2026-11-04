// Real-server native vertical slice; --visible also writes screenshot artifacts.
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSourceHash } from '../../test/perf/native-source-hash.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'se-lwe-live-'));
const out=path.resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||path.join(temp,'artifacts'));
const seed=Number(process.argv.find(a=>a.startsWith('--seed='))?.slice(7)||4);
let server, native, timeout;
let logs='';
const sourceHash=nativeSourceHash(root);
try {
  server=fork(path.join(root,'server/index.js'),[],{cwd:root,env:{...process.env,PORT:'8139',ADMIT_OFF:'1',SERVE_CLIENT:'1',SNAPSHOT_DIR:temp},stdio:['ignore','pipe','pipe','ipc']});
  server.stdout.on('data',d=>logs+=d); server.stderr.on('data',d=>logs+=d);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server startup timed out')),15000);
    server.on('message',m=>{if(m.t==='listening'){clearTimeout(timer);resolve();}});
    server.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited'));});
  });
  const args=[...(process.env.GODOT_EXPORTED==='1'?[]:['--path','godot']),'--resolution','1280x900'];
  if(!process.argv.includes('--visible')) args.push('--headless');
  const sessionFile=path.join(temp,'native-session.json');
  args.push('--','--server=ws://127.0.0.1:8139/ws','--mode=ai',`--seed=${seed}`,`--validate-lwe=${out}`,`--validation-session-out=${sessionFile}`,`--session-file=${sessionFile}`);
  native=spawn(process.env.GODOT_PATH||'godot',args,{cwd:root,stdio:['ignore','pipe','pipe']});
  native.stdout.on('data',d=>{logs+=d;process.stderr.write(d);});
  native.stderr.on('data',d=>{logs+=d;process.stderr.write(d);if(/SCRIPT ERROR:|ERROR:/.test(String(d)))native.kill('SIGTERM');});
  timeout=setTimeout(()=>native.kill('SIGTERM'),150000);
  const [code]=await once(native,'exit');
  if(code!==0||/SCRIPT ERROR:|Shader compilation failed|ERROR:/.test(logs)) throw new Error(logs);
  const validationPath=path.join(out,'validation.json');
  const report=JSON.parse(fs.readFileSync(validationPath,'utf8'));
  report.meta={created:new Date().toISOString(),source_hash:sourceHash,source_changed_during_run:nativeSourceHash(root)!==sourceHash,
    rendered:process.argv.includes('--visible'),exported:process.env.GODOT_EXPORTED==='1'};
  fs.writeFileSync(validationPath,JSON.stringify(report,null,2)+'\n');
  if(process.argv.includes('--compare')) {
    const {chromium}=await import('playwright');
    const browser=await chromium.launch({headless:false,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    try {
      const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});
      const session=JSON.parse(fs.readFileSync(sessionFile,'utf8'));
      const validation=JSON.parse(fs.readFileSync(path.join(out,'validation.json'),'utf8'));
      await context.addInitScript((record)=>localStorage.setItem('se.session',JSON.stringify(record)),session);
      const page=await context.newPage(); const errors=[];
      page.on('pageerror',error=>errors.push(String(error)));
      await page.goto('http://127.0.0.1:8139',{waitUntil:'domcontentloaded'});
      if(await page.locator('#btnRejoin').count()!==1){await page.screenshot({path:path.join(out,'pixi-comparison-error.png')});throw new Error('Comparison lobby missing: '+await page.title()+' '+(await page.locator('body').innerText()).slice(0,500));}
      await page.click('#btnRejoin');
      await page.waitForFunction(()=>window.__S?.ready&&window.__view?.()?.dirtyTiles.size===0,null,{timeout:30000});
      await page.evaluate(({tile,camera_size})=>{
        const view=window.__view();view.centerOn(tile,view.app.screen.height/(camera_size*12));
      },validation.view);
      await page.waitForTimeout(1500);
      await page.screenshot({path:path.join(out,'pixi-settlement.png')});
      if(errors.length) throw new Error(errors.join('\n'));
      const time=await page.evaluate(()=>window.__S.time);
      if(Math.abs(time-validation.view.server_time)>.5)throw new Error('Comparison match was not paused at the same state');
      fs.copyFileSync(path.join(out,'settlement.png'),path.join(out,'comparison-godot.png'));
      fs.writeFileSync(path.join(out,'comparison.html'),`<!doctype html><meta charset="utf-8"><title>Residential slice comparison</title><style>body{font:16px system-ui;background:#1a1f23;color:#eee;margin:24px}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%}figure{margin:0}figcaption{padding:8px 0}p{color:#b9c2c9}</style><h1>Residential slice · seed ${validation.view.seed}</h1><p>Same paused match, tile ${validation.view.tile}, time ${time}s. Both viewports 1280 × 900 at 1×. Orthographic Godot terrain uses a 60° inclination; PixiJS uses its existing map projection.</p><main><figure><img src="comparison-godot.png"><figcaption>Godot native · modeled residential kit</figcaption></figure><figure><img src="pixi-settlement.png"><figcaption>Existing PixiJS client</figcaption></figure></main>`);
    } finally { await browser.close(); }
  }
  console.log(fs.readFileSync(path.join(out,'validation.json'),'utf8'));
} finally {
  clearTimeout(timeout);
  if(native&&native.exitCode==null) native.kill('SIGTERM');
  if(server&&server.exitCode==null){const done=once(server,'exit');server.send({t:'shutdown'});const timer=setTimeout(()=>server.kill('SIGKILL'),10000);await done;clearTimeout(timer);}
  fs.rmSync(temp,{recursive:true,force:true});
}

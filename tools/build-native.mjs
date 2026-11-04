// Reproducible, local development exports. No upload, notarization or release/deploy side effects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeSourceHash } from '../test/perf/native-source-hash.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const opts=Object.fromEntries(process.argv.slice(2).map(s=>{const [key,...value]=s.replace(/^--/,'').split('=');return [key,value.join('=')||true];}));
const platform=String(opts.platform||'all');
if(!['all','macos','windows'].includes(platform))throw new Error('--platform must be all, macos or windows');
const out=path.resolve(String(opts.out||path.join(root,'dist/native')));
fs.mkdirSync(out,{recursive:true});
const engine=process.env.GODOT_PATH||'godot';
const manifest={kind:'development-preview',source_hash:nativeSourceHash(root),created:new Date().toISOString(),artifacts:[]};
async function run(command,args,label,env=process.env){
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let logs='';
    child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
    child.once('error',reject);
    child.once('exit',code=>{fs.writeFileSync(path.join(out,label+'.log'),logs);if(code!==0||/SCRIPT ERROR:/.test(logs))reject(new Error(label+' failed\n'+logs.slice(-8000)));else resolve();});
  });
}
function record(file,signing){const data=fs.readFileSync(file);manifest.artifacts.push({file:path.basename(file),bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),signing});}
await run(engine,['--headless','--editor','--path','godot','--quit'],'import');
if(platform==='all'||platform==='windows'){
  const file=path.join(out,'Shattered Empires Native.exe');
  await run(engine,['--headless','--path','godot','--export-release','Windows development',file],'windows-export');
  record(file,'unsigned development build');console.log('Built Windows x86_64 preview');
}
if(platform==='all'||platform==='macos'){
  const file=path.join(out,'Shattered Empires Native.zip');
  await run(engine,['--headless','--path','godot','--export-release','macOS development',file],'macos-export');
  let signing='unsigned development build';
  if(process.platform==='darwin'){
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'se-native-package-'));
    try {
      await run('unzip',['-q',file,'-d',temp],'macos-unpack');
      const name=fs.readdirSync(temp).find(f=>f.endsWith('.app'));
      if(!name)throw new Error('Export contains no app bundle');
      const app=path.join(temp,name);
      await run('codesign',['--force','--deep','--sign','-','--identifier','com.shatteredempires.native',app],'macos-adhoc-sign');
      await run('codesign',['--verify','--deep','--strict',app],'macos-signature-check');
      await run('ditto',['-c','-k','--keepParent',app,file],'macos-zip');
      const staging=path.join(out,'macos');fs.mkdirSync(staging,{recursive:true});
      fs.rmSync(path.join(staging,name),{recursive:true,force:true});
      fs.cpSync(app,path.join(staging,name),{recursive:true});
      signing='ad-hoc development signature; not notarized or signed with a project Developer ID';
      if(opts.smoke){
        const binary=path.join(staging,name,'Contents/MacOS',name.slice(0,-4));
        const env={...process.env,GODOT_PATH:binary,GODOT_EXPORTED:'1'};
        await run(process.execPath,['godot/tests/lwe-live.mjs',`--out=${path.join(out,'export-validation')}`],'macos-runtime-smoke',env);
        await run(process.execPath,['godot/tests/network-smoke.mjs'],'macos-reconnect-smoke',env);
      }
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
  }
  record(file,signing);console.log('Built macOS universal preview');
}
manifest.source_changed_during_build=nativeSourceHash(root)!==manifest.source_hash;
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
if(manifest.source_changed_during_build)throw new Error('Source changed during build; rebuild before sharing');
console.log('Development artifacts: '+out);

// Authoring-time conversion of the reference silhouette vocabulary to native SVG textures.
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../client/visual/UnitIcons.js',import.meta.url),'utf8');
const {ICONS}=vm.runInNewContext(source.slice(0,source.indexOf('const FALLBACK')).replace('export const ICONS','const ICONS')+';({ICONS})');
const out=new URL('../../godot/assets/icons/units/',import.meta.url);fs.mkdirSync(out,{recursive:true});
for(const [type,ops] of Object.entries(ICONS)) {
 const shapes=ops.map(([kind,...a])=>{
  let shape,hole=false;
  if(kind==='l')return `<polyline points="${a[0].join(' ')}" fill="none" stroke="#eee9dc" stroke-width="${a[1]}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if(kind==='p'){shape=`polygon points="${a[0].join(' ')}"`;hole=a[1]===1;}
  else if(kind==='c'){shape=`circle cx="${a[0]}" cy="${a[1]}" r="${a[2]}"`;hole=a[3]===1;}
  else if(kind==='r'){shape=`rect x="${a[0]}" y="${a[1]}" width="${a[2]}" height="${a[3]}"`;hole=a[4]===1;}
  else if(kind==='e'){shape=`ellipse cx="${a[0]}" cy="${a[1]}" rx="${a[2]}" ry="${a[3]}"`;hole=a[4]===1;}
  return `<${shape} fill="${hole?'#172229':'#eee9dc'}"/>`;
 }).join('');
 fs.writeFileSync(new URL(type+'.svg',out),`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-9 -9 18 18">${shapes}</svg>\n`);
}
console.log(`Wrote ${Object.keys(ICONS).length} native troop icons`);

// Reuse the reference client's material pictograms as independent native SVG assets.
// This is an authoring-time conversion; the native client has no browser dependency.
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../client/visual/ResourceIcons.js',import.meta.url),'utf8');
const {GOOD,DEPOSIT}=vm.runInNewContext(source.slice(source.indexOf('const GOOD'),source.indexOf('function trace'))+';({GOOD,DEPOSIT})');
const out=new URL('../../godot/assets/icons/resources/',import.meta.url); fs.mkdirSync(out,{recursive:true});
const color=n=>'#'+n.toString(16).padStart(6,'0');
function svg(ops) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-8 -8 16 16"><circle r="7.5" fill="#142027" fill-opacity=".94" stroke="#a7aaa0" stroke-width=".55"/>'+ops.map(([kind,...a])=>{
    let shape,fill,stroke;
    if(kind==='p'){shape=`polygon points="${a[0].join(' ')}"`;[fill,stroke]=a.slice(1);}
    else if(kind==='c'){shape=`circle cx="${a[0]}" cy="${a[1]}" r="${a[2]}"`;[fill,stroke]=a.slice(3);}
    else if(kind==='e'){shape=`ellipse cx="${a[0]}" cy="${a[1]}" rx="${a[2]}" ry="${a[3]}"`;[fill,stroke]=a.slice(4);}
    else if(kind==='r'||kind==='rr'){shape=`rect x="${a[0]}" y="${a[1]}" width="${a[2]}" height="${a[3]}"${kind==='rr'?` rx="${a[4]}"`:''}`;[fill,stroke]=a.slice(kind==='rr'?5:4);}
    else if(kind==='l')return `<polyline points="${a[0].join(' ')}" fill="none" stroke="${color(a[2])}" stroke-width="${a[1]}"/>`;
    return `<${shape} fill="${color(fill)}"${stroke===undefined?'':` stroke="${color(stroke)}" stroke-width=".55"`} stroke-linejoin="round"/>`;
  }).join('')+'</svg>\n';
}
for(const [key,ops] of Object.entries(GOOD))fs.writeFileSync(new URL(key+'.svg',out),svg(ops));
for(const [key,ops] of Object.entries(DEPOSIT))fs.writeFileSync(new URL('deposit-'+key+'.svg',out),svg(ops));
fs.writeFileSync(new URL('power.svg',out),svg([['p',[1,-6,-4,1,-.5,1,-1,6,4,-1,.5,-1],0xe2c969,0x6b5c32]]));
console.log(`Wrote ${Object.keys(GOOD).length+Object.keys(DEPOSIT).length+1} native resource icons`);

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Runtime sources and checked-in assets only; generated imports, tests and reports are excluded.
export function nativeSourceHash(root) {
  const hash=crypto.createHash('sha256');
  function visit(directory) {
    for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(['.godot','docs','tests'].includes(item.name)) continue;
      const file=path.join(directory,item.name);
      if(item.isDirectory()) visit(file);
      else if(/\.(gd|gdshader|tscn|tres|json|glb|png|svg|godot|cfg)$/.test(item.name)) {
        hash.update(path.relative(root,file));hash.update(fs.readFileSync(file));
      }
    }
  }
  visit(path.join(root,'godot'));
  return hash.digest('hex');
}

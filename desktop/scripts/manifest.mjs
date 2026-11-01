// Build the downloads manifest for a folder of installers (used by CI and by publish.sh):
//   node scripts/manifest.mjs <dir-with-installers> <version> > manifest.json
// Each file is uploaded to gs://<bucket>/downloads/<version>/<name>; the manifest points at it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [dir, version] = process.argv.slice(2);
if (!dir || !version) { console.error('usage: manifest.mjs <dir> <version>'); process.exit(1); }
const platformOf = (n) => (/\.dmg$|mac/i.test(n) ? 'mac' : /\.exe$|win/i.test(n) ? 'win' : /\.AppImage$|linux/i.test(n) ? 'linux' : null);
const labelOf = (n, p) => ({ mac: 'Download for macOS (.dmg)', win: 'Download for Windows (installer)', linux: 'Download for Linux (AppImage)' })[p] + (/arm64/.test(n) ? ' — Apple Silicon' : /x64/.test(n) && p === 'mac' ? ' — Intel' : '');
const files = fs.readdirSync(dir).filter((n) => /\.(dmg|exe|AppImage)$/.test(n) && !/blockmap/.test(n)).map((name) => {
  const p = path.join(dir, name), platform = platformOf(name);
  return { platform, name, label: labelOf(name, platform), size: fs.statSync(p).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), path: `${version}/${name}` };
}).filter((f) => f.platform);
process.stdout.write(JSON.stringify({ version, date: new Date().toISOString(), files }, null, 2) + '\n');

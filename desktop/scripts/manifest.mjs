// Build the downloads manifest for a folder of installers (used by CI and by publish.sh):
//   node scripts/manifest.mjs <dir-with-installers> <version> > manifest.json
// Each file is uploaded to gs://<bucket>/downloads/<version>/<name>; the manifest points at it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [dir, version] = process.argv.slice(2);
if (!dir || !version) { console.error('usage: manifest.mjs <dir> <version>'); process.exit(1); }
// kind: 'install' files are offered on the download page (macOS .dmg, Windows setup .exe);
// 'update' files are fetched by installed apps to replace themselves (the macOS .app zipped per
// architecture; on Windows the setup .exe doubles as the update, run silently).
const platformOf = (n) => (/\.dmg$|mac/i.test(n) ? 'mac' : /\.exe$|win/i.test(n) ? 'win' : /\.AppImage$|linux/i.test(n) ? 'linux' : null);
const archOf = (n) => (/arm64/i.test(n) ? 'arm64' : /x64|x86_64|amd64/i.test(n) ? 'x64' : '');
const kindOf = (n) => (/\.zip$/i.test(n) ? 'update' : 'install');
const labelOf = (n, p) => ({ mac: 'Download for macOS', win: 'Download for Windows', linux: 'Download for Linux (AppImage)' })[p] + (/arm64/.test(n) ? ' — Apple Silicon' : /x64/.test(n) && p === 'mac' ? ' — Intel' : '');
const files = fs.readdirSync(dir).filter((n) => /\.(dmg|zip|exe|AppImage)$/.test(n) && !/blockmap/.test(n)).map((name) => {
  const p = path.join(dir, name), platform = platformOf(name), kind = kindOf(name);
  return { platform, arch: archOf(name), kind, name, label: kind === 'install' ? labelOf(name, platform) : 'Update package', size: fs.statSync(p).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), path: `${version}/${name}` };
}).filter((f) => f.platform);
process.stdout.write(JSON.stringify({ version, date: new Date().toISOString(), files }, null, 2) + '\n');

// Copy the game (server + client + its package.json) into desktop/app so the desktop edition ships
// exactly the code that runs on game.liamhosfeld.com: same server, same client, same simulation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..'), root = path.join(desktop, '..'), app = path.join(desktop, 'app');
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
for (const d of ['server', 'client']) fs.cpSync(path.join(root, d), path.join(app, d), { recursive: true, filter: (src) => !src.includes(`${path.sep}.snapshots`) });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true }, null, 2));
// keep the desktop version in step with the game
const dpkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
if (dpkg.version !== pkg.version) { dpkg.version = pkg.version; fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(dpkg, null, 2) + '\n'); }
fs.mkdirSync(path.join(desktop, 'build'), { recursive: true });
fs.writeFileSync(path.join(desktop, 'build', 'steam_appid.txt'), '480\n');   // Spacewar: Valve's public test app
console.log('desktop/app prepared from', root, 'version', pkg.version);

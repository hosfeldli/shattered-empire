// Bundle the game client into desktop/app/client: the browser client, the simulation helper it
// shares with the server (deployment planner), and PixiJS — so the app never loads code from the
// network. Games themselves always run on the game server.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..'), root = path.join(desktop, '..'), app = path.join(desktop, 'app'), out = path.join(app, 'client');
fs.rmSync(app, { recursive: true, force: true });
fs.cpSync(path.join(root, 'client'), out, { recursive: true, filter: (src) => !src.includes(`${path.sep}dev`) });
fs.mkdirSync(path.join(out, 'shared'), { recursive: true });
fs.copyFileSync(path.join(root, 'server', 'sim', 'deploy.js'), path.join(out, 'shared', 'deploy.js'));
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
const require = createRequire(path.join(desktop, 'package.json'));
let pixi;
try { pixi = require.resolve('pixi.js/dist/pixi.min.js'); } catch { pixi = createRequire(path.join(root, 'package.json')).resolve('pixi.js/dist/pixi.min.js'); }
fs.copyFileSync(pixi, path.join(out, 'vendor', 'pixi.min.js'));
// keep the app's version in step with the game
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dpkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
if (dpkg.version !== pkg.version) { dpkg.version = pkg.version; fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(dpkg, null, 2) + '\n'); }
fs.mkdirSync(path.join(desktop, 'build'), { recursive: true });
fs.writeFileSync(path.join(desktop, 'build', 'steam_appid.txt'), '480\n');   // Spacewar: Valve's public test app
console.log('client bundled into', out, 'version', pkg.version);

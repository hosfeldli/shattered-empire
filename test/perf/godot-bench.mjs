// Isolated native benchmark: one server and one visible Godot window at a time, no parked matches.
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSourceHash } from './native-source-hash.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const options = Object.fromEntries(process.argv.slice(2).map((s) => {
  const [key, ...value] = s.replace(/^--/, '').split('=');
  return [key, value.join('=') || true];
}));
if (options.help) {
  console.log('node test/perf/godot-bench.mjs --scenario=all|early|late|large --seconds=30 --out=godot-bench.json');
  process.exit(0);
}
const scenario = String(options.scenario || 'all');
if (!['all', 'early', 'late', 'large'].includes(scenario)) throw new Error('Unknown scenario');
const seconds = Number(options.seconds || 30);
const resolution = String(options.resolution || '1024x768');
if (!/^\d{3,4}x\d{3,4}$/.test(resolution)) throw new Error('Invalid --resolution');
if (!(seconds > 0)) throw new Error('--seconds must be positive');
const results = {};
for (const scene of scenario === 'all' ? ['early', 'late'] : [scenario]) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-godot-bench-'));
  const server = fork(path.join(ROOT, 'server/index.js'), [], {
    cwd: ROOT, env: { ...process.env, PORT: '8139', ADMIT_OFF: '1', SNAPSHOT_DIR: temp },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  server.stdout.on('data', (data) => { logs = (logs + data).slice(-4000); });
  server.stderr.on('data', (data) => { logs = (logs + data).slice(-4000); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out\n' + logs)), 15000);
      server.on('message', (m) => { if (m.t === 'listening') { clearTimeout(timer); resolve(); } });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited\n' + logs)); });
    });
    const benchFile = path.join(temp, 'bench.json');
    const sourceHash=nativeSourceHash(ROOT);
    const args = ['--path', 'godot', '--resolution', resolution, '--', '--server=ws://127.0.0.1:8139/ws',
      `--bench=${seconds}`, `--bench-out=${benchFile}`, `--session-file=${path.join(temp,'session.json')}`];
    if (scene === 'early') args.push('--mode=ai', '--seed=7');
    else args.push('--mode=observe', '--seed=5', '--speed=8', '--bench-wait=720');
    if (scene === 'large') args.push('--map=large');
    console.error(`${scene}: running native benchmark`);
    const native = spawn(process.env.GODOT_PATH || 'godot', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    const timer = setTimeout(() => native.kill('SIGTERM'), 360000);
    const [code] = await once(native, 'exit');
    clearTimeout(timer);
    if (code !== 0 || !fs.existsSync(benchFile)) throw new Error(`Native benchmark failed (${code})`);
    results[scene] = JSON.parse(fs.readFileSync(benchFile, 'utf8'));
    results[scene].meta.source_hash=sourceHash;
    results[scene].meta.source_changed_during_run=nativeSourceHash(ROOT)!==sourceHash;
  } finally {
    if (server.exitCode == null) {
      const exited = once(server, 'exit');
      if (server.connected) server.send({ t: 'shutdown' });
      else server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
const out = path.resolve(String(options.out || 'godot-bench.json'));
fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
console.error(`Wrote ${out}`);

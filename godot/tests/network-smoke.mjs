// Live regression for threaded JSON decoding: handshake, real order/picking, server restart/rejoin.
// Uses an isolated port-8139 server and a temporary snapshot directory. No deployment changes.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-native-network-'));
let server, native, logs = '';
async function startServer() {
  const child = fork(path.join(root, 'server/index.js'), [], {
    cwd: root, env: { ...process.env, PORT: '8139', ADMIT_OFF: '1', SNAPSHOT_DIR: temp },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out\n' + logs)), 15000);
    child.on('message', (m) => { if (m.t === 'listening') { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited\n' + logs)); });
  });
  return child;
}
async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit');
  if (child.connected) child.send({ t: 'shutdown' });
  else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await exited;
  clearTimeout(timer);
}
let restartTimer, timeout;
try {
  server = await startServer();
  const probeFile = path.join(temp, 'probe.json');
  native = spawn(process.env.GODOT_PATH || 'godot', ['--path', 'godot', '--headless', '--',
    '--server=ws://127.0.0.1:8139/ws', '--mode=ai', '--seed=7', '--probe=25', '--order-test=5',
    '--pick-test', `--probe-out=${probeFile}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  native.stdout.on('data', (data) => { logs += data; });
  native.stderr.on('data', (data) => { logs += data; });
  const restart = new Promise((resolve, reject) => {
    restartTimer = setTimeout(() => {
      (async () => { await stopServer(server); server = await startServer(); resolve(); })().catch(reject);
    }, 9000);
  });
  timeout = setTimeout(() => native.kill('SIGTERM'), 45000);
  const [[code]] = await Promise.all([once(native, 'exit'), restart]);
  assert.equal(code, 0, logs);
  assert.ok(!/SCRIPT ERROR:/.test(logs), logs);
  const result = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
  assert.equal(result.net.state, 'ready');
  assert.equal(result.net.proto, 2);
  assert.ok(result.net.caps.includes('geo'));
  assert.ok(result.net.connections >= 2, 'must reconnect and negotiate after server restart');
  assert.ok(result.world.ready && result.world.snapshots > 50, 'must keep streaming after rejoin');
  assert.ok(result.extra.reply?.order?.reached > 0, 'server must acknowledge the move');
  assert.equal(result.extra.now_tile, result.extra.to, 'unit must reach its authoritative destination');
  assert.ok(result.extra.picking.every((p) => p.samples > 0 && p.accuracy === 1), 'picking regression');
  console.log('NETWORK_SMOKE ' + JSON.stringify({ connections: result.net.connections,
    snapshots: result.world.snapshots, rtt_ms: result.net.rtt_ms, order_reached: true, picking: true }));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  clearTimeout(restartTimer);
  clearTimeout(timeout);
  if (native && native.exitCode == null) native.kill('SIGTERM');
  await stopServer(server);
  fs.rmSync(temp, { recursive: true, force: true });
}

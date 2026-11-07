import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';

function nextMessage(worker, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off('message', onMessage); reject(new Error('worker message timed out')); }, timeout);
    function onMessage(message) {
      const messages = message.t === 'out' ? message.msgs.map((entry) => JSON.parse(entry[1])) : [message];
      const found = messages.find(predicate);
      if (found) { clearTimeout(timer); worker.off('message', onMessage); resolve(found); }
    }
    worker.on('message', onMessage);
  });
}

test('matches suspend without people and resume on reconnect, preserving a manual pause', { timeout: 20000 }, async () => {
  const worker = new Worker(new URL('../server/worker.js', import.meta.url), { workerData: {
    id: 'presence', seed: 7, mapSize: 128, wrap: true, rebels: false,
    slots: [{ human: true, leader: 'Player' }, { human: false, leader: 'AI' }],
  } });
  try {
    await nextMessage(worker, m => m.t === 'ready');
    let welcome = nextMessage(worker, m => m.t === 'welcome');
    worker.postMessage({ t: 'welcome', civId: 0 });
    await welcome;
    const progressing = await nextMessage(worker, m => m.t === 's' && m.time >= 0.5);
    worker.postMessage({ t: 'connect', civId: 0, on: false });
    await sleep(1200);
    welcome = nextMessage(worker, m => m.t === 'welcome');
    worker.postMessage({ t: 'welcome', civId: 0 });
    const resumed = await welcome;
    assert.ok(resumed.time - progressing.time < 0.3, `unattended match advanced ${resumed.time-progressing.time}s`);
    await nextMessage(worker, m => m.t === 's' && m.time > resumed.time + 0.3);
    const paused = nextMessage(worker, m => m.rid === 51);
    worker.postMessage({ t: 'cmd', civId: 0, rid: 51, cmd: { c: 'pause', on: true } });
    assert.equal((await paused).paused, true);
    worker.postMessage({ t: 'connect', civId: 0, on: false });
    await sleep(300);
    welcome = nextMessage(worker, m => m.t === 'welcome');
    worker.postMessage({ t: 'welcome', civId: 0 });
    assert.equal((await welcome).paused, true, 'reconnecting must not undo a manual pause');
  } finally { await worker.terminate(); }
});

test('a spectator keeps an AI exhibition running', { timeout: 20000 }, async () => {
  const worker = new Worker(new URL('../server/worker.js', import.meta.url), { workerData: {
    id: 'presence-watch', seed: 9, mapSize: 128, wrap: true, rebels: false, observe: true,
    slots: [{ human: false, leader: 'AI 1' }, { human: false, leader: 'AI 2' }],
  } });
  try {
    await nextMessage(worker, m => m.t === 'ready');
    const welcome = nextMessage(worker, m => m.t === 'welcome');
    worker.postMessage({ t: 'obsWelcome' });
    const start = await welcome;
    const later = await nextMessage(worker, m => m.t === 's' && m.time > start.time + 0.3);
    assert.ok(later.time > start.time);
  } finally { await worker.terminate(); }
});

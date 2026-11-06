import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeSourceHash } from './perf/native-source-hash.mjs';

test('native source hashes include baked image assets but exclude test artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-source-hash-'));
  try {
    fs.mkdirSync(path.join(root, 'godot', 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'godot', 'tests'));
    const image = path.join(root, 'godot', 'assets', 'ground.jpg');
    fs.writeFileSync(image, 'first');
    const initial = nativeSourceHash(root);
    fs.writeFileSync(path.join(root, 'godot', 'tests', 'result.png'), 'ignored');
    assert.equal(nativeSourceHash(root), initial);
    fs.writeFileSync(image, 'second');
    assert.notEqual(nativeSourceHash(root), initial);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

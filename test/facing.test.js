// AI formation facing: one orientation frame (forward toward the threat, right = forward turned
// clockwise on screen) shared by the AI's line builder and the deployment planner, seam-safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facingFrame, lineAcross, planDeployment, hexXY } from '../server/sim/deploy.js';
import { W, H } from '../server/sim/constants.js';
import { idx, dist } from '../server/sim/hex.js';

const env = { W, H, wrap: true, passable: () => true, capacity: () => 3, occupied: () => 0 };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unwrapped = (t, ref) => { const [x, y] = hexXY(t, W), P = Math.sqrt(3) * W; return [x + Math.round((ref - x) / P) * P, y]; };

test('forward points at the threat, right is forward turned clockwise (screen y down)', () => {
  const c = idx(40, 30);
  const east = facingFrame(env, c, idx(48, 30)), north = facingFrame(env, c, idx(40, 20));
  assert.ok(east.forward[0] > 0.99 && Math.abs(east.forward[1]) < 0.01);
  assert.deepEqual(east.right.map((v) => +v.toFixed(3)), [0, 1].map((v) => +v.toFixed(3)), 'facing east, right is south');
  assert.ok(north.forward[1] < -0.95 && north.right[0] > 0.95, 'facing north, right is east');
});

test('the AI line faces the threat in every direction, including across the world seam', () => {
  const centers = [idx(40, 30), idx(0, 30), idx(W - 1, 31), idx(1, 12), idx(W - 2, 40)];
  const dirs = [[8, 0], [-8, 0], [4, -7], [-4, -7], [4, 7], [-4, 7], [0, 10], [0, -10], [10, 3]];
  let n = 0;
  for (const c of centers) for (const [dq, dr] of dirs) {
    const q = c % W, r = (c / W) | 0; if (r + dr < 1 || r + dr >= H - 1) continue;
    const toward = idx(q + dq, r + dr);
    const line = lineAcross(env, c, toward, 5);
    assert.ok(line, `a line for ${dq},${dr}`);
    const f = facingFrame(env, c, toward);
    const plan = planDeployment(env, [], line);
    assert.ok(dot(plan.facing, f.forward) > 0.75, `deployment facing agrees with forward (${dq},${dr} at q=${q}): ${dot(plan.facing, f.forward).toFixed(2)}`);
    // the line stands between the center and the threat, a few hexes out, and is about n hexes long
    const [ax] = unwrapped(line[0], hexXY(c, W)[0]), [bx] = unwrapped(line[1], hexXY(c, W)[0]);
    assert.ok(Math.abs(ax - bx) < W, 'endpoints are on the same side of the seam');
    assert.ok(dist(line[0], line[1]) >= 3 && dist(line[0], line[1]) <= 5, `frontage ${dist(line[0], line[1])}`);
    assert.ok(Math.min(dist(line[0], toward), dist(line[1], toward)) < dist(c, toward) + 2, 'not behind the center');
    n++;
  }
  assert.ok(n >= 40);
});

test('a reverse deployment faces away; a degenerate threat yields no line', () => {
  const c = idx(40, 30), t = idx(48, 30);
  const line = lineAcross(env, c, t, 4);
  assert.ok(dot(planDeployment(env, [], line, { reverse: true }).facing, facingFrame(env, c, t).forward) < -0.75);
  assert.equal(lineAcross(env, c, c, 4), null);
  assert.equal(lineAcross(env, c, -1, 4), null);
});

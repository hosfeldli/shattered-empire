// The worker's reply to a game command (`{t:'cmd', rid, cmd}`): a command's own `reply` message when it
// has one, otherwise an ack carrying the refusal (`error`) and its machine-readable `code` (`territory`,
// `road`, `spacing`, `ring`, `era`, `foundation`, ...) so clients can show a specific message.
// 2026-11-17: a successful ack also carries the order's small numeric summary when the command gives one
// (terrain / trench strokes: hexes and skipped; roads: edges and skipped; base perimeter: placed and skipped).
const SUMMARY = ['hexes', 'edges', 'placed', 'skipped', 'crossings'];
export function commandAck(res, rid) {
  if (res && res.reply) return { ...res.reply, rid };
  const ack = { t: 'ack', rid, error: res ? res.error : undefined, code: res?.error ? res.code : undefined };
  if (res && !res.error) for (const key of SUMMARY) if (Number.isFinite(res[key])) ack[key] = res[key];
  return ack;
}

// The worker's reply to a game command (`{t:'cmd', rid, cmd}`): a command's own `reply` message when it
// has one, otherwise an ack carrying the refusal (`error`) and its machine-readable `code` (`territory`,
// `road`, `spacing`, `ring`, `era`, `foundation`, ...) so clients can show a specific message.
export function commandAck(res, rid) {
  if (res && res.reply) return { ...res.reply, rid };
  return { t: 'ack', rid, error: res ? res.error : undefined, code: res?.error ? res.code : undefined };
}

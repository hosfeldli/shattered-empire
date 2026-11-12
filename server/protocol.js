// Versioned protocol handshake. A client may open with { t: 'hello', proto, caps: [...], client } before
// anything else; the server answers with the version it speaks and the optional capabilities it
// accepted for this connection. A client that never says hello (the PixiJS client) is a protocol-1
// client with no capabilities and sees exactly the messages it always has.
//   proto 1: the original lobby / match / snapshot protocol
//   proto 2: adds the handshake and optional capabilities
// Capabilities (each adds messages; none changes an existing one):
//   geo: terrain geometry in 'geo' messages (server/sim/terrainGeo.js), fog-filtered like tile records
export const PROTOCOL_VERSION = 2;
export const PROTOCOL_MIN = 1;
export const CAPABILITIES = ['geo', 'udelta', 'action-rts', 'ring-cities-v1'];

export function negotiate(msg) {
  const proto = Number.isInteger(msg.proto) ? msg.proto : 1;
  if (proto < PROTOCOL_MIN) return { error: `Protocol ${proto} is too old; this server speaks ${PROTOCOL_MIN} to ${PROTOCOL_VERSION}` };
  const speaks = Math.min(proto, PROTOCOL_VERSION);
  const asked = Array.isArray(msg.caps) ? msg.caps.filter((c) => typeof c === 'string').slice(0, 16) : [];
  const caps = speaks >= 2 ? CAPABILITIES.filter((c) => asked.includes(c)) : [];
  return { proto: speaks, caps };
}

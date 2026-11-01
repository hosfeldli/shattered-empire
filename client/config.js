// Where the game server lives. The client ships inside the desktop app and talks to the deployed,
// authoritative game server (game.liamhosfeld.com); there is no offline mode. For development and
// tests the server can also serve this client (SERVE_CLIENT=1), and then it uses its own origin.
const desktop = typeof window !== 'undefined' ? window.desktop : null;
const web = typeof location !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:');
export const SERVER = (desktop && desktop.server) || (web ? location.origin : 'https://game.liamhosfeld.com');
export const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws';
export const api = (p) => SERVER + p;

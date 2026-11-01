// The app keeps itself up to date: on start and every 30 minutes it asks the game server's download
// site for the latest build, downloads the update for this platform and architecture in the
// background (verifying its SHA-256), and tells the game, which offers "Restart to update". The
// install is replaced in place — nothing to download from the site or reinstall by hand.
//   macOS:   the new .app (zipped) is unpacked next to the old one and swapped in after quitting.
//   Windows: the per-user setup .exe runs silently over the install and relaunches the game.
const { app, net, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { pickUpdate, macBundle, macSwapScript, winInstallArgs } = require('./update-core.cjs');

class Updater {
  constructor({ server, send = () => {}, log = () => {} }) {
    this.server = server; this.send = send; this.log = log;
    this.state = { state: 'idle', current: app.getVersion() };
    this.busy = null; this.timer = null;
  }
  set(s) { this.state = { current: app.getVersion(), ...s }; this.send(this.state); }
  status() { return this.state; }

  start() {
    if (!app.isPackaged && !process.env.SE_UPDATE_TEST) { this.set({ state: 'dev', note: 'updates apply to installed builds only' }); return; }
    setTimeout(() => this.check().catch(() => {}), 4000);
    this.timer = setInterval(() => this.check().catch(() => {}), 30 * 60 * 1000);
  }

  async check() {
    if (this.busy) return this.busy;
    if (this.state.state === 'ready' || this.state.state === 'installing') return this.state;
    this.busy = (async () => {
      try {
        this.set({ state: 'checking' });
        const r = await net.fetch(this.server + '/api/downloads', { cache: 'no-store' });
        if (!r.ok) throw new Error('download site answered ' + r.status);
        const m = await r.json();
        const up = pickUpdate(m, { version: app.getVersion(), platform: process.platform, arch: process.arch });
        if (!up) { this.set({ state: 'current', latest: m.version || app.getVersion(), checked: Date.now() }); return this.state; }
        if (process.platform === 'darwin') { const b = macBundle(process.execPath); if (b.why) { this.set({ state: 'manual', version: up.version, note: b.why }); return this.state; } }
        await this.download(up);
        return this.state;
      } catch (e) {
        this.log('update check failed:', e.message);
        this.set({ state: 'error', note: e.message });
        return this.state;
      } finally { this.busy = null; }
    })();
    return this.busy;
  }

  async download({ version, file }) {
    const dir = path.join(app.getPath('temp'), 'shattered-empires-update');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file.name);
    if (fs.existsSync(dest) && file.sha256 && sha256(dest) === file.sha256) return this.prepared(version, dest);
    this.set({ state: 'downloading', version, progress: 0 });
    const r = await net.fetch(this.server + '/download/file/' + encodeURIComponent(file.name), { cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error('download failed: ' + r.status);
    const total = +(r.headers.get('x-file-size') || file.size || 0);
    const out = fs.createWriteStream(dest + '.part');
    const hash = crypto.createHash('sha256');
    let got = 0, lastSent = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value); got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
      if (total && Date.now() - lastSent > 400) { lastSent = Date.now(); this.set({ state: 'downloading', version, progress: Math.min(99, Math.round((100 * got) / total)) }); }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (file.sha256 && hash.digest('hex') !== file.sha256) { fs.rmSync(dest + '.part', { force: true }); throw new Error('the update was corrupted in transit; it will be fetched again'); }
    fs.renameSync(dest + '.part', dest);
    return this.prepared(version, dest);
  }

  async prepared(version, file) {
    if (process.platform === 'darwin') {
      // unpack now (ditto keeps the bundle's symlinks and signature) so the restart is instant
      const stage = path.join(path.dirname(file), 'stage-' + version);
      fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
      await new Promise((res, rej) => execFile('/usr/bin/ditto', ['-x', '-k', file, stage], (e) => (e ? rej(e) : res())));
      const bundle = fs.readdirSync(stage).find((n) => n.endsWith('.app'));
      if (!bundle) throw new Error('the update did not contain the app');
      this.ready = { version, fresh: path.join(stage, bundle) };
    } else this.ready = { version, file };
    this.set({ state: 'ready', version });
    return this.state;
  }

  // quit and replace the install, then start the new version
  install() {
    if (!this.ready) return { ok: false, error: 'no update is ready' };
    try {
      if (process.platform === 'darwin') {
        const { app: bundle, why } = macBundle(process.execPath);
        if (why) { shell.openExternal(this.server + '/'); return { ok: false, error: why }; }
        // the new bundle must sit on the same volume as the old one for an atomic rename
        const fresh = path.join(path.dirname(bundle), '.' + path.basename(bundle) + '.update');
        fs.rmSync(fresh, { recursive: true, force: true });
        execFileSync('/usr/bin/ditto', [this.ready.fresh, fresh]);     // keeps symlinks, modes and the signature intact
        const script = path.join(os.tmpdir(), 'se-update-' + Date.now() + '.sh');
        fs.writeFileSync(script, macSwapScript({ pid: process.pid, app: bundle, fresh, log: path.join(os.tmpdir(), 'se-update.log') }), { mode: 0o755 });
        spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'win32') {
        spawn(this.ready.file, winInstallArgs(), { detached: true, stdio: 'ignore' }).unref();
      } else return { ok: false, error: 'updates are not supported on this platform' };
      this.set({ state: 'installing', version: this.ready.version });
      setTimeout(() => app.quit(), 300);
      return { ok: true };
    } catch (e) {
      this.log('install failed:', e.message);
      this.set({ state: 'error', note: 'could not install the update: ' + e.message });
      return { ok: false, error: e.message };
    }
  }
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

module.exports = { Updater };

// Match snapshot storage: Cloud Storage in production (SNAPSHOT_BUCKET, authenticated with the
// Cloud Run service account via the metadata server), a local folder in development.
import fs from 'node:fs/promises';
import path from 'node:path';

export function makeStore(log, dir = process.env.SNAPSHOT_DIR || '.snapshots') {
  const bucket = process.env.SNAPSHOT_BUCKET;
  return bucket ? gcsStore(bucket, log) : fileStore(dir);
}

function fileStore(dir) {
  return {
    kind: 'file:' + dir,
    async save(id, buf) { await fs.mkdir(dir, { recursive: true }); const tmp = path.join(dir, id + '.tmp'); await fs.writeFile(tmp, buf); await fs.rename(tmp, path.join(dir, id + '.json.gz')); },
    async load(id) { return fs.readFile(path.join(dir, id + '.json.gz')); },
    async list() {
      try { const names = await fs.readdir(dir); return Promise.all(names.filter((n) => n.endsWith('.json.gz')).map(async (n) => ({ id: n.slice(0, -8), updated: (await fs.stat(path.join(dir, n))).mtimeMs }))); } catch { return []; }
    },
    async remove(id) { await fs.rm(path.join(dir, id + '.json.gz'), { force: true }); },
  };
}

function gcsStore(bucket, log) {
  let token = null, expires = 0;
  async function auth() {
    if (token && Date.now() < expires - 60_000) return token;
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
    if (!r.ok) throw new Error('metadata token ' + r.status);
    const j = await r.json(); token = j.access_token; expires = Date.now() + j.expires_in * 1000;
    return token;
  }
  const obj = (id) => encodeURIComponent('matches/' + id + '.json.gz');
  const api = 'https://storage.googleapis.com';
  return {
    kind: 'gcs:' + bucket,
    async save(id, buf) {
      const r = await fetch(`${api}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${obj(id)}`, { method: 'POST', headers: { authorization: 'Bearer ' + (await auth()), 'content-type': 'application/gzip' }, body: buf });
      if (!r.ok) throw new Error('gcs save ' + r.status + ' ' + (await r.text()).slice(0, 200));
    },
    async load(id) {
      const r = await fetch(`${api}/storage/v1/b/${bucket}/o/${obj(id)}?alt=media`, { headers: { authorization: 'Bearer ' + (await auth()) } });
      if (!r.ok) throw new Error('gcs load ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
    async list() {
      const r = await fetch(`${api}/storage/v1/b/${bucket}/o?prefix=matches/`, { headers: { authorization: 'Bearer ' + (await auth()) } });
      if (!r.ok) { log.warn?.('gcs list ' + r.status); return []; }
      const j = await r.json();
      return (j.items || []).map((it) => ({ id: it.name.slice(8, -8), updated: Date.parse(it.updated) }));
    },
    async remove(id) { await fetch(`${api}/storage/v1/b/${bucket}/o/${obj(id)}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + (await auth()) } }); },
  };
}

// Minimal BigQuery REST client for telemetry: an OAuth token from the Cloud Run metadata server (or a static
// token for local smoke tests), tabledata.insertAll, and the few dataset/table calls tools/telemetry-setup.mjs
// needs. No SDK: global fetch (Node >= 20) only.

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const API = 'https://bigquery.googleapis.com/bigquery/v2';

/**
 * Token source. TELEMETRY_ACCESS_TOKEN (a short-lived `gcloud auth print-access-token`, local smoke tests only)
 * wins; otherwise the runtime service account's token from the metadata server, cached until a minute before
 * it expires.
 */
export function tokenSource({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let cached = null, until = 0;
  return async function token() {
    if (env.TELEMETRY_ACCESS_TOKEN) return env.TELEMETRY_ACCESS_TOKEN;
    if (cached && Date.now() < until) return cached;
    const r = await fetchImpl(`${METADATA}/instance/service-accounts/default/token`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`metadata token ${r.status}`);
    const j = await r.json();
    cached = j.access_token; until = Date.now() + Math.max(30, (j.expires_in || 300) - 60) * 1000;
    return cached;
  };
}

/** The GCP project: TELEMETRY_PROJECT / GOOGLE_CLOUD_PROJECT, else the metadata server's. */
export async function projectId({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.TELEMETRY_PROJECT) return env.TELEMETRY_PROJECT;
  if (env.GOOGLE_CLOUD_PROJECT) return env.GOOGLE_CLOUD_PROJECT;
  const r = await fetchImpl(`${METADATA}/project/project-id`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`metadata project ${r.status}`);
  return (await r.text()).trim();
}

/**
 * tabledata.insertAll. Returns { ok, status, inserted, rejected, error, bytes, retry }. Never throws.
 * skipInvalidRows + ignoreUnknownValues: one bad row (or a column added before the table was updated) never
 * costs the batch.
 */
export async function insertAll({ project, dataset, table, rows, token, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const body = JSON.stringify({ kind: 'bigquery#tableDataInsertAllRequest', skipInvalidRows: true, ignoreUnknownValues: true,
    rows: rows.map((r) => ({ insertId: r.insertId, json: r.json })) });
  let res;
  try {
    res = await fetchImpl(`${API}/projects/${project}/datasets/${dataset}/tables/${table}/insertAll`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, status: 0, inserted: 0, rejected: 0, error: String(e?.message || e), bytes: body.length, retry: true };
  }
  let j = null; try { j = await res.json(); } catch { /* empty */ }
  if (!res.ok) return { ok: false, status: res.status, inserted: 0, rejected: 0, error: j?.error?.message || `HTTP ${res.status}`, bytes: body.length, retry: res.status >= 500 || res.status === 429 };
  const errs = j?.insertErrors || [];
  // with skipInvalidRows, rows listed in insertErrors with a real reason were dropped; 'stopped' ones were not
  const bad = errs.filter((e) => (e.errors || []).some((x) => x.reason && x.reason !== 'stopped'));
  return { ok: true, status: res.status, inserted: rows.length - bad.length, rejected: bad.length, error: bad[0]?.errors?.[0]?.message || null, bytes: body.length, retry: false };
}

/** A JSON REST call for the setup tool: { status, body }. */
export async function rest(method, url, token, body, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url.startsWith('http') ? url : API + url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: j };
}

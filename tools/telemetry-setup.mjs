#!/usr/bin/env node
// Creates or updates the BigQuery telemetry dataset, tables, views and the runtime service account's access,
// idempotently, from server/telemetry/schema.js (docs/TELEMETRY.md).
//
//   node tools/telemetry-setup.mjs [--project stem-471602] [--runtime se-runtime@stem-471602.iam.gserviceaccount.com] [--dry-run]
//
// Token: TELEMETRY_ACCESS_TOKEN, else `gcloud auth print-access-token` (gcloud.cmd on Windows; honours CLOUDSDK_CONFIG).
// Safe to re-run: existing tables only gain new columns (BigQuery cannot drop or retype one), their description,
// partition expiration and clustering are brought up to date, and the dataset's access list keeps every entry it has.
import { execSync } from 'node:child_process';
import { DATASET, PARTITION_EXPIRATION_MS, TABLES, VIEWS, tableResource } from '../server/telemetry/schema.js';
import { rest } from '../server/telemetry/bigquery.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry-run');
const gcloud = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
const run = (a) => execSync([gcloud, ...a].join(' '), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();   // fixed arguments only
const PROJECT = arg('--project', process.env.TELEMETRY_PROJECT || run(['config', 'get-value', 'project']));
const RUNTIME = arg('--runtime', `se-runtime@${PROJECT}.iam.gserviceaccount.com`);
const LOCATION = arg('--location', 'US');
const token = process.env.TELEMETRY_ACCESS_TOKEN || run(['auth', 'print-access-token']);
const base = `/projects/${PROJECT}/datasets`;
const say = (...a) => console.log(...a);

async function call(method, url, body) {
  if (DRY && method !== 'GET') { say(`  [dry-run] ${method} ${url}`); return { status: 200, body: body || {} }; }
  const r = await rest(method, url, token, body);
  if (r.status >= 400 && !(method === 'GET' && r.status === 404)) throw new Error(`${method} ${url}: ${r.status} ${r.body?.error?.message || ''}`);
  return r;
}

// merge new columns into an existing schema (recursively for RECORDs); never removes or retypes
function mergeFields(have, want) {
  const out = have.map((f) => ({ ...f }));
  for (const w of want) {
    const h = out.find((f) => f.name === w.name);
    if (!h) { out.push(w); continue; }
    if (h.type === 'RECORD' && w.fields) h.fields = mergeFields(h.fields || [], w.fields);
    if (w.description && h.description !== w.description) h.description = w.description;
  }
  return out;
}

say(`project ${PROJECT}, dataset ${DATASET} (${LOCATION}), runtime ${RUNTIME}${DRY ? ' [dry run]' : ''}`);

// 1. dataset
let ds = await call('GET', `${base}/${DATASET}`);
if (ds.status === 404) {
  say(`creating dataset ${DATASET}`);
  ds = await call('POST', base, { datasetReference: { projectId: PROJECT, datasetId: DATASET }, location: LOCATION,
    description: 'Shattered Empires diagnostics and benchmarking telemetry (docs/TELEMETRY.md). Rows expire after 180 days.',
    defaultPartitionExpirationMs: String(PARTITION_EXPIRATION_MS), labels: { app: 'shattered-empires', kind: 'telemetry' } });
  if (!DRY) ds = await call('GET', `${base}/${DATASET}`);
} else say(`dataset ${DATASET} exists (${ds.body.location})`);

// 2. dataset-level access for the runtime service account: roles/bigquery.dataEditor (legacy name WRITER).
//    Streaming inserts (tabledata.insertAll) need no job, so roles/bigquery.jobUser is not granted.
const access = ds.body?.access || [];
const has = access.some((a) => (a.userByEmail || '').toLowerCase() === RUNTIME.toLowerCase() && ['WRITER', 'OWNER', 'roles/bigquery.dataEditor', 'roles/bigquery.dataOwner'].includes(a.role));
if (has) say(`${RUNTIME} already has dataEditor on ${DATASET}`);
else { say(`granting roles/bigquery.dataEditor on ${DATASET} to ${RUNTIME}`); await call('PATCH', `${base}/${DATASET}`, { access: [...access, { role: 'WRITER', userByEmail: RUNTIME }] }); }

// 3. tables
for (const name of Object.keys(TABLES)) {
  const want = tableResource(PROJECT, name);
  const t = await call('GET', `${base}/${DATASET}/tables/${name}`);
  if (t.status === 404) { say(`creating table ${name} (${want.schema.fields.length} columns)`); await call('POST', `${base}/${DATASET}/tables`, want); continue; }
  const fields = mergeFields(t.body.schema?.fields || [], want.schema.fields);
  const added = fields.length - (t.body.schema?.fields || []).length;
  const patch = { description: want.description, schema: { fields }, clustering: want.clustering, labels: want.labels };
  if (t.body.timePartitioning?.field === 'event_time') patch.timePartitioning = want.timePartitioning;
  else say(`  warning: ${name} is not partitioned on event_time; partitioning cannot change in place`);
  say(`updating table ${name}${added ? ` (+${added} columns)` : ''}`);
  await call('PATCH', `${base}/${DATASET}/tables/${name}`, patch);
}

// 4. saved views
for (const [name, sql] of Object.entries(VIEWS)) {
  const body = { tableReference: { projectId: PROJECT, datasetId: DATASET, tableId: name }, view: { query: sql.replaceAll('{project}', PROJECT).trim(), useLegacySql: false },
    description: 'Telemetry benchmark view (docs/TELEMETRY.md)', labels: { app: 'shattered-empires', kind: 'telemetry' } };
  const v = await call('GET', `${base}/${DATASET}/tables/${name}`);
  say(`${v.status === 404 ? 'creating' : 'updating'} view ${name}`);
  if (v.status === 404) await call('POST', `${base}/${DATASET}/tables`, body);
  else await call('PATCH', `${base}/${DATASET}/tables/${name}`, { view: body.view, description: body.description });
}
say('done');

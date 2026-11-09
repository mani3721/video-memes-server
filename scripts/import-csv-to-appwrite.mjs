#!/usr/bin/env node
// One-off: rebuild the Appwrite tables from the Supabase CSV export.
//
// The console CSV import created rows in tables that had no columns, so every
// value was dropped and the original ids were replaced. This script:
//   1. creates the columns each table needs (skips ones that already exist),
//   2. deletes the empty placeholder rows — ONLY in a table that had zero
//      columns when the script started, so a re-run never deletes real data,
//   3. upserts every CSV row, keeping the original id as the row $id,
//   4. creates the indexes the app filters / sorts / dedupes on,
//   5. prints CSV vs Appwrite row counts.
//
// Usage (dry run prints the plan only):
//   node scripts/import-csv-to-appwrite.mjs <csv-folder>
//   node scripts/import-csv-to-appwrite.mjs <csv-folder> --apply
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client, TablesDB, Query, TablesDBIndexType, OrderBy } from 'node-appwrite';
import { readCsv } from './lib/csv.mjs';

const csvDir = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!csvDir || !existsSync(csvDir)) {
  console.error('Usage: node scripts/import-csv-to-appwrite.mjs <csv-folder> [--apply]');
  process.exit(1);
}
for (const k of ['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY', 'APPWRITE_DATABASE_ID']) {
  if (!process.env[k]) { console.error(`Missing ${k} in server/.env`); process.exit(1); }
}

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const db = new TablesDB(client);
const databaseId = process.env.APPWRITE_DATABASE_ID;

// ---------------------------------------------------------------------------
// Column specs. Types follow server/db/schema.sql + migrations; string sizes
// leave headroom over the longest value in the export.
// ---------------------------------------------------------------------------
const str = (size, extra = {}) => ({ type: 'varchar', size, ...extra });
const text = () => ({ type: 'text' });
const int = (def) => ({ type: 'integer', def });
const bool = (def) => ({ type: 'boolean', def });
const dt = () => ({ type: 'datetime' });

const TABLES = {
  memes: {
    idFrom: 'id',
    columns: {
      title: str(256), creator_name: str(64, { def: 'anonymous' }),
      spaces_key: str(512), public_url: str(1024),
      thumbnail_spaces_key: str(512), thumbnail_url: str(1024), filename: str(256),
      format: str(16), category: str(16), mood_tags: str(64, { array: true }),
      license: str(16, { def: 'CC0' }), duration_seconds: int(), file_size_bytes: int(),
      width_px: int(), height_px: int(), has_alpha: bool(false), green_screen: bool(false),
      download_count: int(0), laugh_count: int(0), fire_count: int(0), skull_count: int(0),
      view_count: int(0), uploader_id: str(36), is_published: bool(false), is_hot: bool(false),
      is_flagged: bool(false), flagged_reason: str(500), flagged_at: dt(),
      description_long: text(), last_updated_by: str(36), needs_description: bool(false),
      content_status: str(16), language: str(16), created_at: dt(), updated_at: dt(),
    },
    indexes: [
      ['category', ['category']], ['format', ['format']], ['published', ['is_published']],
      ['created', ['created_at'], ['desc']], ['downloads', ['download_count'], ['desc']],
      ['views', ['view_count'], ['desc']], ['hot', ['is_hot']], ['uploader', ['uploader_id']],
      ['spaces_key', ['spaces_key'], null, 'unique'], ['title_ft', ['title'], null, 'fulltext'],
      // mood_tags is an array column; Appwrite cannot index arrays.
    ],
  },
  profiles: {
    idFrom: 'id',
    columns: {
      email: str(320), display_name: str(128), role: str(16, { def: 'user' }),
      preferred_language: str(16), created_at: dt(),
    },
    indexes: [['email', ['email']], ['role', ['role']]],
  },
  favorites: {
    idFrom: 'id',
    columns: { user_id: str(36), meme_id: str(36), created_at: dt() },
    indexes: [['user', ['user_id']], ['meme', ['meme_id']], ['user_meme', ['user_id', 'meme_id'], null, 'unique']],
  },
  collections: {
    idFrom: 'id',
    columns: {
      user_id: str(36), name: str(64), emoji: str(16), is_default: bool(false),
      created_at: dt(), updated_at: dt(),
    },
    indexes: [['user', ['user_id']], ['user_default', ['user_id', 'is_default']]],
  },
  collection_items: {
    idFrom: 'id',
    columns: { collection_id: str(36), meme_id: str(36), user_id: str(36), added_at: dt() },
    indexes: [
      ['collection', ['collection_id']], ['user', ['user_id']], ['meme', ['meme_id']],
      ['collection_meme', ['collection_id', 'meme_id'], null, 'unique'],
    ],
  },
  reaction_events: {
    idFrom: 'id',
    columns: { meme_id: str(36), reaction: str(16), actor_key: str(64), created_at: dt() },
    indexes: [
      ['meme', ['meme_id']],
      ['meme_reaction_actor', ['meme_id', 'reaction', 'actor_key'], null, 'unique'],
    ],
  },
  download_events: {
    idFrom: 'id',
    columns: { meme_id: str(36), country: str(8), created_at: dt() },
    indexes: [['meme_created', ['meme_id', 'created_at'], ['asc', 'desc']], ['created', ['created_at'], ['desc']]],
  },
  notifications: {
    idFrom: 'id',
    columns: {
      user_id: str(36), type: str(32), title: str(256), message: str(2000), link: str(512),
      thumbnail: str(1024), segment_language: str(16), dedupe_key: str(128), created_at: dt(),
    },
    indexes: [['user', ['user_id']], ['created', ['created_at'], ['desc']], ['dedupe', ['dedupe_key'], null, 'unique']],
  },
  notification_reads: {
    idFrom: ['notification_id', 'user_id'],
    columns: { notification_id: str(36), user_id: str(36), read_at: dt() },
    indexes: [['user', ['user_id']], ['notif_user', ['notification_id', 'user_id'], null, 'unique']],
  },
  blog_posts: {
    idFrom: 'id',
    columns: {
      slug: str(128), title: str(256), excerpt: str(512), body: text(), cover_url: str(1024),
      status: str(16, { def: 'draft' }), author_id: str(36), last_updated_by: str(36),
      published_at: dt(), created_at: dt(), updated_at: dt(),
    },
    indexes: [['slug', ['slug'], null, 'unique'], ['status_pub', ['status', 'published_at'], ['asc', 'desc']]],
  },
  feature_flags: {
    idFrom: 'key',
    columns: { key: str(64), enabled: bool(true), updated_at: dt() },
    indexes: [['key', ['key'], null, 'unique']],
  },
  user_consent: {
    idFrom: 'user_id',
    columns: { user_id: str(36), consent_status: str(16), consent_version: str(16), updated_at: dt() },
    indexes: [['user', ['user_id'], null, 'unique']],
  },
};

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------
function toIsoDate(v) {
  // "2026-09-04 07:10:41.565664+00" -> "2026-09-04T07:10:41.565Z"
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(:?\d{2})?$/);
  if (!m) throw new Error(`Unrecognised timestamp: ${v}`);
  const frac = (m[3] || '.000').slice(0, 4).padEnd(4, '0');
  const tz = `${m[4]}:${(m[5] || '00').replace(':', '')}`;
  const d = new Date(`${m[1]}T${m[2]}${frac}${tz}`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${v}`);
  return d.toISOString();
}

function convert(value, spec) {
  if (spec.array) {
    if (value === '' || value === '{}' || value === '[]') return [];
    if (value.startsWith('[')) return JSON.parse(value);
    return value.slice(1, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
  }
  if (value === '') return null;
  switch (spec.type) {
    case 'integer': return Number.parseInt(value, 10);
    case 'boolean': return value === 'true';
    case 'datetime': return toIsoDate(value);
    default: return value;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (err) {
      const retryable = err.code === 429 || err.code >= 500 || err.code === 0 || err.code === undefined;
      if (!retryable || attempt >= 6) throw new Error(`${label}: ${err.message}`);
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function waitFor(listFn, keys, label) {
  for (let i = 0; i < 240; i++) {
    const items = await listFn();
    const pending = items.filter((c) => keys.includes(c.key) && c.status !== 'available');
    const failed = pending.filter((c) => c.status === 'failed' || c.status === 'stuck');
    if (failed.length) throw new Error(`${label} failed: ${failed.map((c) => `${c.key} (${c.error || c.status})`).join(', ')}`);
    if (!pending.length) return;
    await sleep(1500);
  }
  throw new Error(`${label}: timed out waiting for columns/indexes to become available`);
}

async function createColumn(tableId, key, spec) {
  const base = { databaseId, tableId, key, required: false };
  if (spec.array) base.array = true;
  const def = spec.array ? undefined : spec.def;
  switch (spec.type) {
    case 'varchar': return db.createVarcharColumn({ ...base, size: spec.size, xdefault: def });
    case 'text': return db.createTextColumn(base);
    case 'integer': return db.createIntegerColumn({ ...base, xdefault: def });
    case 'boolean': return db.createBooleanColumn({ ...base, xdefault: def });
    case 'datetime': return db.createDatetimeColumn(base);
    default: throw new Error(`Unknown column type ${spec.type}`);
  }
}

// Appwrite caps `total` at 5000, so page through ids for an exact count above that.
async function countRows(tableId) {
  const res = await db.listRows({ databaseId, tableId, queries: [Query.limit(1)] });
  if (res.total < 5000) return res.total;
  let n = 0;
  let cursor;
  for (;;) {
    const queries = [Query.limit(5000), Query.select(['$id'])];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await db.listRows({ databaseId, tableId, queries });
    n += page.rows.length;
    if (page.rows.length < 5000) return n;
    cursor = page.rows.at(-1).$id;
  }
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { tables } = await db.listTables({ databaseId, queries: [Query.limit(100)] });
const tableIdByName = Object.fromEntries(tables.map((t) => [t.name, t.$id]));

const plan = [];
for (const [name, cfg] of Object.entries(TABLES)) {
  const file = `${csvDir}/${name}_rows.csv`;
  if (!existsSync(file)) throw new Error(`Missing CSV: ${file}`);
  const tableId = tableIdByName[name];
  if (!tableId) throw new Error(`Appwrite table "${name}" not found`);
  const { header, records } = readCsv(file);
  const unknown = header.filter((h) => h !== 'id' && !(h in cfg.columns));
  if (unknown.length) throw new Error(`${name}: CSV columns with no spec: ${unknown.join(', ')}`);

  const rows = records.map((r) => {
    const row = {};
    // Composite keys get a deterministic hash id so re-runs upsert, not duplicate.
    row.$id = Array.isArray(cfg.idFrom)
      ? createHash('sha1').update(cfg.idFrom.map((k) => r[k]).join('|')).digest('hex').slice(0, 32)
      : r[cfg.idFrom];
    for (const [col, spec] of Object.entries(cfg.columns)) {
      if (col in r) row[col] = convert(r[col], spec);
    }
    return row;
  });
  const existingCols = (await db.listColumns({ databaseId, tableId, queries: [Query.limit(100)] })).columns;
  const existingRows = await countRows(tableId);
  plan.push({ name, tableId, cfg, rows, existingCols, existingRows });
  console.log(`${name.padEnd(20)} csv=${String(rows.length).padStart(6)}  appwrite rows=${String(existingRows).padStart(6)}  columns now=${existingCols.length}  to add=${Object.keys(cfg.columns).length - existingCols.filter((c) => c.key in cfg.columns).length}  ${existingCols.length === 0 ? '(empty rows will be deleted)' : '(rows kept, upsert)'}`);
}

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to make these changes.');
  process.exit(0);
}

for (const p of plan) {
  const { name, tableId, cfg, rows, existingCols } = p;
  console.log(`\n== ${name}`);

  // 1. Columns
  const have = new Set(existingCols.map((c) => c.key));
  const toAdd = Object.entries(cfg.columns).filter(([k]) => !have.has(k));
  for (const [key, spec] of toAdd) {
    await withRetry(() => createColumn(tableId, key, spec), `${name}.${key} column`);
  }
  await waitFor(
    async () => (await db.listColumns({ databaseId, tableId, queries: [Query.limit(100)] })).columns,
    Object.keys(cfg.columns), `${name} columns`,
  );
  console.log(`   columns ready (${toAdd.length} added)`);

  // 2. Delete placeholder rows — only when the table started with no columns,
  //    i.e. the rows cannot hold any data.
  if (existingCols.length === 0 && p.existingRows > 0) {
    let remaining = p.existingRows;
    while (remaining > 0) {
      await withRetry(() => db.deleteRows({ databaseId, tableId, queries: [Query.limit(1000)] }), `${name} delete`);
      remaining = await countRows(tableId);
    }
    console.log(`   deleted ${p.existingRows} empty rows`);
  }

  // 3. Rows
  const BATCH = 100;
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  let done = 0;
  await mapLimit(batches, 4, async (batch) => {
    await withRetry(() => db.upsertRows({ databaseId, tableId, rows: batch }), `${name} upsert`);
    done += batch.length;
    if (batches.length > 20 && done % 10000 < BATCH) console.log(`   ${done}/${rows.length}`);
  });
  console.log(`   upserted ${rows.length} rows`);

  // 4. Indexes
  const existingIdx = new Set((await db.listIndexes({ databaseId, tableId, queries: [Query.limit(100)] })).indexes.map((i) => i.key));
  const idxKeys = [];
  for (const [key, columns, orders, type = 'key'] of cfg.indexes) {
    idxKeys.push(key);
    if (existingIdx.has(key)) continue;
    await withRetry(() => db.createIndex({
      databaseId, tableId, key, columns,
      type: type === 'unique' ? TablesDBIndexType.Unique : type === 'fulltext' ? TablesDBIndexType.Fulltext : TablesDBIndexType.Key,
      orders: orders ? orders.map((o) => (o === 'desc' ? OrderBy.Desc : OrderBy.Asc)) : undefined,
    }), `${name}.${key} index`);
  }
  await waitFor(
    async () => (await db.listIndexes({ databaseId, tableId, queries: [Query.limit(100)] })).indexes,
    idxKeys, `${name} indexes`,
  );
  console.log(`   indexes ready (${idxKeys.length})`);
}

// 5. Verify
console.log('\n== Verification');
let ok = true;
for (const p of plan) {
  const n = await countRows(p.tableId);
  const match = n === p.rows.length;
  ok &&= match;
  console.log(`${p.name.padEnd(20)} csv=${String(p.rows.length).padStart(6)}  appwrite=${String(n).padStart(6)}  ${match ? 'OK' : 'MISMATCH'}`);
}
process.exit(ok ? 0 : 2);

// Convert the Supabase CSV exports into SQL files for Cloudflare D1 (SQLite).
//
//   node scripts/csv-to-d1-sql.mjs [csvDir] [outDir]
//
// Defaults: csvDir = ../client/SUPABSECSV, outDir = ./d1-sql
// Produces one <table>.sql per CSV (DROP + CREATE TABLE + batched INSERTs)
// plus all.sql that contains every table in one file.
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv } from './lib/csv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const csvDir = resolve(process.argv[2] ?? join(here, '../../client/SUPABSECSV'));
const outDir = resolve(process.argv[3] ?? join(here, '../d1-sql'));

// D1 rejects single statements over ~100 KB, so batch by size.
const MAX_STMT_BYTES = 90_000;
const MAX_ROWS_PER_STMT = 200;

const PRIMARY_KEYS = {
  feature_flags: ['key'],
  user_consent: ['user_id'],
  notification_reads: ['notification_id', 'user_id'],
};

const INT_RE = /^-?\d+$/;
const REAL_RE = /^-?\d+\.\d+(e[+-]?\d+)?$/i;
const BOOL = new Set(['true', 'false']);

function inferType(values) {
  const present = values.filter((v) => v !== '');
  if (!present.length) return 'TEXT';
  if (present.every((v) => BOOL.has(v))) return 'INTEGER'; // booleans -> 0/1
  if (present.every((v) => INT_RE.test(v) && Math.abs(Number(v)) <= Number.MAX_SAFE_INTEGER)) return 'INTEGER';
  if (present.every((v) => INT_RE.test(v) || REAL_RE.test(v))) return 'REAL';
  return 'TEXT';
}

const isBoolCol = (values) => {
  const present = values.filter((v) => v !== '');
  return present.length > 0 && present.every((v) => BOOL.has(v));
};

// Postgres text[] like {a,b,"c d"} -> JSON '["a","b","c d"]'
function pgArrayToJson(v) {
  const inner = v.slice(1, -1);
  if (!inner) return '[]';
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      if (c === '\\') { cur += inner[++i]; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return JSON.stringify(out);
}

const sqlStr = (s) => `'${s.replace(/'/g, "''")}'`;
const ident = (s) => `"${s.replace(/"/g, '""')}"`;

function literal(v, col) {
  if (v === '') return 'NULL';
  if (col.bool) return v === 'true' ? '1' : '0';
  if (col.type === 'INTEGER' || col.type === 'REAL') return v;
  if (col.pgArray && v.startsWith('{') && v.endsWith('}')) return sqlStr(pgArrayToJson(v));
  return sqlStr(v);
}

function convert(table, { header, records }) {
  const cols = header.map((name) => {
    const values = records.map((r) => r[name]);
    const present = values.filter((v) => v !== '');
    return {
      name,
      type: inferType(values),
      bool: isBoolCol(values),
      pgArray: present.length > 0 && present.every((v) => v.startsWith('{') && v.endsWith('}')) && name !== 'description_long',
    };
  });

  const pk = PRIMARY_KEYS[table] ?? (header.includes('id') ? ['id'] : []);
  const defs = cols.map((c) => `  ${ident(c.name)} ${c.type}${pk.length === 1 && pk[0] === c.name ? ' PRIMARY KEY' : ''}`);
  if (pk.length > 1) defs.push(`  PRIMARY KEY (${pk.map(ident).join(', ')})`);

  const parts = [
    `DROP TABLE IF EXISTS ${ident(table)};`,
    `CREATE TABLE ${ident(table)} (\n${defs.join(',\n')}\n);`,
  ];

  const prefix = `INSERT INTO ${ident(table)} (${header.map(ident).join(', ')}) VALUES\n`;
  let batch = [], size = prefix.length;
  const flush = () => {
    if (batch.length) parts.push(prefix + batch.join(',\n') + ';');
    batch = []; size = prefix.length;
  };
  for (const r of records) {
    const tuple = `(${cols.map((c) => literal(r[c.name], c)).join(', ')})`;
    if (batch.length && (size + tuple.length > MAX_STMT_BYTES || batch.length >= MAX_ROWS_PER_STMT)) flush();
    batch.push(tuple); size += tuple.length + 2;
  }
  flush();
  return { sql: parts.join('\n\n') + '\n', cols, rows: records.length };
}

mkdirSync(outDir, { recursive: true });
const all = [];
for (const file of readdirSync(csvDir).filter((f) => f.endsWith('.csv')).sort()) {
  const table = file.replace(/_rows\.csv$/, '').replace(/\.csv$/, '');
  const { sql, cols, rows } = convert(table, readCsv(join(csvDir, file)));
  writeFileSync(join(outDir, `${table}.sql`), sql);
  all.push(sql);
  console.log(`${table.padEnd(20)} ${String(rows).padStart(7)} rows  ${cols.length} cols  -> ${table}.sql`);
}
writeFileSync(join(outDir, 'all.sql'), all.join('\n'));
console.log(`\nWrote ${outDir}/all.sql`);

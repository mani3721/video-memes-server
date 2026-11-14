/**
 * Server-side Cloudflare D1 client (via the D1 HTTP API) — replaces the
 * Appwrite TablesDB layer. It keeps the same helper surface the routes already
 * used (listRows / getRow / createRow / … and a small Query builder), so routes
 * only change their import.
 *
 * Required env (server only — never VITE_-prefixed):
 *   CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN (D1 edit scope)
 *
 * Rows come back in the same plain shape as before: `id` is the primary key,
 * booleans are real booleans (SQLite stores 0/1), mood_tags is an array.
 */

import { createHash, randomUUID } from 'node:crypto'

const REQUIRED = ['CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']

/** Error with an HTTP-like `code` (404 not found, 409 conflict) like the old AppwriteException. */
export class DbError extends Error {
  constructor(message, code = 500) {
    super(message)
    this.name = 'DbError'
    this.code = code
  }
}

// ── Table metadata ───────────────────────────────────────────────────────────
// pk: primary key column(s). autoId: INTEGER PRIMARY KEY assigned by SQLite.
const TABLES = {
  memes: { pk: 'id', bool: ['has_alpha', 'green_screen', 'is_published', 'is_hot', 'is_flagged', 'needs_description'], json: ['mood_tags', 'description_long'], num: ['duration_seconds'] },
  profiles: { pk: 'id' },
  favorites: { pk: 'id' },
  collections: { pk: 'id', bool: ['is_default'] },
  collection_items: { pk: 'id', autoId: true },
  reaction_events: { pk: 'id', autoId: true },
  download_events: { pk: 'id', autoId: true },
  notifications: { pk: 'id' },
  notification_reads: { pk: ['notification_id', 'user_id'] },
  blog_posts: { pk: 'id' },
  feature_flags: { pk: 'key', bool: ['enabled'] },
  user_consent: { pk: 'user_id' },
  download_history: { pk: 'id' },
}

function meta(table) {
  const m = TABLES[table]
  if (!m) throw new DbError(`Unknown table "${table}"`)
  return m
}

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new DbError(`Invalid column name "${s}"`, 400)
  return `"${s}"`
}

/** `$id` (old Appwrite name) → the table's single primary-key column. */
function col(table, name) {
  if (name === '$id') {
    const { pk } = meta(table)
    if (Array.isArray(pk)) throw new DbError(`${table} has a composite key`)
    return ident(pk)
  }
  return ident(name)
}

function toParam(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

function writeValue(table, key, v) {
  const m = meta(table)
  if (m.json?.includes(key) && v !== null && typeof v === 'object') return JSON.stringify(v)
  return toParam(v)
}

/** SQLite row → the plain shape the app expects. */
export function toPlain(table, row) {
  if (!row) return row
  const m = meta(table)
  const out = { ...row }
  delete out.__total
  for (const k of m.bool ?? []) if (k in out && out[k] !== null) out[k] = Boolean(out[k])
  for (const k of m.num ?? []) if (out[k] !== null && out[k] !== undefined && out[k] !== '') out[k] = Number(out[k])
  for (const k of m.json ?? []) {
    if (typeof out[k] === 'string') {
      try { out[k] = JSON.parse(out[k]) } catch { out[k] = k === 'mood_tags' ? [] : null }
    }
  }
  if (typeof m.pk === 'string' && m.pk !== 'id' && m.pk in out) out.id = out[m.pk]
  return out
}

// ── HTTP transport ───────────────────────────────────────────────────────────
function config() {
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim())
  if (missing.length) throw new DbError(`D1 not configured: missing ${missing.join(', ')}`)
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID.trim()}/d1/database/${process.env.D1_DATABASE_ID.trim()}/query`,
    token: process.env.CLOUDFLARE_API_TOKEN.trim(),
  }
}

/**
 * Run one SQL statement. Returns { results, meta }.
 * UNIQUE / PRIMARY KEY violations become DbError(409).
 */
export async function sql(statement, params = []) {
  const { url, token } = config()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: statement, params: params.map(toParam) }),
    })
  } catch (err) {
    throw new DbError(`D1 request failed: ${err.message}`, 503)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    const msg = body.errors?.map((e) => e.message).join('; ') || res.statusText
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(msg)) throw new DbError(msg, 409)
    throw new DbError(`D1 ${res.status}: ${msg}`, res.status === 429 ? 429 : 500)
  }
  const first = body.result?.[0] ?? {}
  return { results: first.results ?? [], meta: first.meta ?? {} }
}

// ── Query builder (same names the routes used with Appwrite) ─────────────────
export const Query = {
  equal: (c, v) => ({ op: 'equal', c, v }),
  notEqual: (c, v) => ({ op: 'notEqual', c, v }),
  greaterThanEqual: (c, v) => ({ op: 'gte', c, v }),
  lessThanEqual: (c, v) => ({ op: 'lte', c, v }),
  isNull: (c) => ({ op: 'isNull', c }),
  contains: (c, v) => ({ op: 'contains', c, v }),
  containsAny: (c, v) => ({ op: 'containsAny', c, v }),
  search: (c, v) => ({ op: 'contains', c, v }),
  or: (qs) => ({ op: 'or', qs }),
  and: (qs) => ({ op: 'and', qs }),
  select: (cols) => ({ op: 'select', cols }),
  orderAsc: (c) => ({ op: 'order', c, dir: 'ASC' }),
  orderDesc: (c) => ({ op: 'order', c, dir: 'DESC' }),
  limit: (n) => ({ op: 'limit', n }),
  offset: (n) => ({ op: 'offset', n }),
}

const FILTER_OPS = new Set(['equal', 'notEqual', 'gte', 'lte', 'isNull', 'contains', 'containsAny', 'or', 'and'])

function where(table, q, params) {
  const m = meta(table)
  const c = q.c ? col(table, q.c) : null
  const isJson = q.c && m.json?.includes(q.c)
  switch (q.op) {
    case 'equal': {
      const vals = Array.isArray(q.v) ? q.v : [q.v]
      if (!vals.length) return '0'
      params.push(...vals)
      return vals.length === 1 ? `${c} = ?` : `${c} IN (${vals.map(() => '?').join(', ')})`
    }
    case 'notEqual': {
      // Appwrite's notEqual kept NULLs; SQL "!=" drops them, so include them explicitly.
      const vals = Array.isArray(q.v) ? q.v : [q.v]
      params.push(...vals)
      return `(${c} IS NULL OR ${c} NOT IN (${vals.map(() => '?').join(', ')}))`
    }
    case 'gte': params.push(q.v); return `${c} >= ?`
    case 'lte': params.push(q.v); return `${c} <= ?`
    case 'isNull': return `${c} IS NULL`
    case 'contains': {
      const vals = Array.isArray(q.v) ? q.v : [q.v]
      if (isJson) {
        params.push(...vals)
        return `EXISTS (SELECT 1 FROM json_each(${c}) WHERE value IN (${vals.map(() => '?').join(', ')}))`
      }
      params.push(...vals.map((v) => `%${String(v).replace(/[\\%_]/g, '\\$&')}%`))
      return `(${vals.map(() => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`
    }
    case 'containsAny': return where(table, { ...q, op: 'contains' }, params)
    case 'or': return `(${q.qs.map((s) => where(table, s, params)).join(' OR ')})`
    case 'and': return `(${q.qs.map((s) => where(table, s, params)).join(' AND ')})`
    default: throw new DbError(`Unsupported query op ${q.op}`)
  }
}

function build(table, queries = [], { count = false } = {}) {
  const params = []
  const filters = queries.filter((q) => FILTER_OPS.has(q.op)).map((q) => where(table, q, params))
  const sel = queries.find((q) => q.op === 'select')
  const cols = sel ? sel.cols.map((c) => (c === '$id' ? `${col(table, c)}` : ident(c))) : ['*']
  const pk = meta(table).pk
  if (sel && typeof pk === 'string' && pk !== 'id' && !sel.cols.includes(pk)) cols.push(ident(pk))
  const orders = queries.filter((q) => q.op === 'order').map((q) => `${col(table, q.c)} ${q.dir}`)
  const limit = queries.find((q) => q.op === 'limit')?.n
  const offset = queries.find((q) => q.op === 'offset')?.n

  let s = `SELECT ${cols.join(', ')}${count ? ', COUNT(*) OVER () AS __total' : ''} FROM ${ident(table)}`
  if (filters.length) s += ` WHERE ${filters.join(' AND ')}`
  if (orders.length) s += ` ORDER BY ${orders.join(', ')}`
  if (limit !== undefined) { s += ' LIMIT ?'; params.push(Number(limit)) }
  if (offset) { if (limit === undefined) s += ' LIMIT -1'; s += ' OFFSET ?'; params.push(Number(offset)) }
  return { s, params, filters: { sql: filters, params } }
}

/** One page of rows plus the exact total matching the filters. */
export async function listRows(table, queries = []) {
  const hasLimit = queries.some((q) => q.op === 'limit')
  const q = hasLimit ? queries : [...queries, Query.limit(25)]
  const { s, params } = build(table, q, { count: true })
  const { results } = await sql(s, params)
  let total = results[0]?.__total
  if (total === undefined) total = await countRows(table, queries)
  return { rows: results.map((r) => toPlain(table, r)), total: Number(total) }
}

export async function countRows(table, queries = []) {
  const params = []
  const filters = queries.filter((q) => FILTER_OPS.has(q.op)).map((q) => where(table, q, params))
  const { results } = await sql(
    `SELECT COUNT(*) AS n FROM ${ident(table)}${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}`,
    params,
  )
  return Number(results[0]?.n ?? 0)
}

/** Every row matching `queries`, paged so no single response gets huge. */
export async function listAllRows(table, queries = [], { pageSize = 1000, cap = 100_000 } = {}) {
  const base = queries.filter((q) => q.op !== 'limit' && q.op !== 'offset')
  const out = []
  while (out.length < cap) {
    const n = Math.min(pageSize, cap - out.length)
    const { s, params } = build(table, [...base, Query.limit(n), Query.offset(out.length)])
    const { results } = await sql(s, params)
    out.push(...results.map((r) => toPlain(table, r)))
    if (results.length < n) break
  }
  return out
}

function pkWhere(table, rowId, params) {
  const { pk } = meta(table)
  if (Array.isArray(pk)) throw new DbError(`${table} has a composite key; use deleteRowsWhere`)
  params.push(rowId)
  return `${ident(pk)} = ?`
}

export async function getRow(table, rowId) {
  const params = []
  const { results } = await sql(`SELECT * FROM ${ident(table)} WHERE ${pkWhere(table, rowId, params)} LIMIT 1`, params)
  return toPlain(table, results[0]) ?? null
}

/**
 * Insert a row. `rowId` sets the text primary key (a UUID by default);
 * tables with an INTEGER autoincrement key ignore it. Duplicate → DbError(409).
 */
export async function createRow(table, data, rowId) {
  const m = meta(table)
  const row = { ...data }
  if (m.pk === 'id' && !m.autoId && row.id === undefined) row.id = rowId ?? randomUUID()
  if (m.autoId) delete row.id
  const keys = Object.keys(row)
  const { results } = await sql(
    `INSERT INTO ${ident(table)} (${keys.map(ident).join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`,
    keys.map((k) => writeValue(table, k, row[k])),
  )
  return toPlain(table, results[0])
}

export async function updateRow(table, rowId, data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined)
  if (!keys.length) return getRow(table, rowId)
  const params = keys.map((k) => writeValue(table, k, data[k]))
  const { results } = await sql(
    `UPDATE ${ident(table)} SET ${keys.map((k) => `${ident(k)} = ?`).join(', ')} WHERE ${pkWhere(table, rowId, params)} RETURNING *`,
    params,
  )
  return toPlain(table, results[0]) ?? null
}

/** Insert or replace a row by primary key. */
export async function upsertRow(table, rowId, data) {
  const { pk } = meta(table)
  const row = { ...data, [pk]: rowId }
  const keys = Object.keys(row)
  const updates = keys.filter((k) => k !== pk)
  const { results } = await sql(
    `INSERT INTO ${ident(table)} (${keys.map(ident).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
     ON CONFLICT(${ident(pk)}) DO UPDATE SET ${updates.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(', ')} RETURNING *`,
    keys.map((k) => writeValue(table, k, row[k])),
  )
  return toPlain(table, results[0])
}

/** Delete a row by primary key; false when it did not exist. */
export async function deleteRow(table, rowId) {
  const params = []
  const { meta: m } = await sql(`DELETE FROM ${ident(table)} WHERE ${pkWhere(table, rowId, params)}`, params)
  return (m.changes ?? 0) > 0
}

/** Delete every row matching the filter queries; returns how many. */
export async function deleteRowsWhere(table, queries) {
  const params = []
  const filters = queries.filter((q) => FILTER_OPS.has(q.op)).map((q) => where(table, q, params))
  if (!filters.length) throw new DbError('Refusing to delete without a filter')
  const { meta: m } = await sql(`DELETE FROM ${ident(table)} WHERE ${filters.join(' AND ')}`, params)
  return m.changes ?? 0
}

/** Atomic counter update. Missing row → DbError(404). Never goes below `min`. */
export async function incrementColumn(table, rowId, column, value = 1, { min = 0 } = {}) {
  const c = ident(column)
  const params = [value, min]
  const { results } = await sql(
    `UPDATE ${ident(table)} SET ${c} = MAX(COALESCE(${c}, 0) + ?, ?) WHERE ${pkWhere(table, rowId, params)} RETURNING *`,
    params,
  )
  if (!results[0]) throw new DbError(`${table} ${rowId} not found`, 404)
  return toPlain(table, results[0])
}

export const decrementColumn = (table, rowId, column, value = 1) => incrementColumn(table, rowId, column, -value)

/** Stable ID derived from a composite key (for text-keyed tables). */
export function stableId(...parts) {
  return 'k' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 35)
}

/** Safe diagnostic for /health: env var names and error codes only, never values. */
export async function d1Status() {
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim())
  if (missing.length) return { ok: false, missing }
  try {
    const { results } = await sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'")
    return { ok: true, tables: results[0]?.n ?? 0 }
  } catch (err) {
    return { ok: false, code: err.code ?? null, message: err.message }
  }
}

// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), and
// newlines inside quoted fields. Returns an array of objects keyed by header.
import { readFileSync } from 'node:fs';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const [header, ...data] = nonEmpty;
  if (header?.[0]?.charCodeAt(0) === 0xfeff) header[0] = header[0].slice(1);
  return {
    header,
    records: data.map((r) => {
      if (r.length !== header.length) {
        throw new Error(`CSV row has ${r.length} fields, expected ${header.length}`);
      }
      return Object.fromEntries(header.map((h, i) => [h, r[i]]));
    }),
  };
}

export function readCsv(path) {
  return parseCsv(readFileSync(path, 'utf8'));
}

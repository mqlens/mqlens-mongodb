// Pure serialize/parse helpers for exporting/importing the result grid.
// No I/O — file access happens in the caller via the Tauri dialog/fs plugins.

type Doc = Record<string, unknown>;

export function toJson(docs: Doc[]): string {
  return JSON.stringify(docs, null, 2);
}

// Quote a CSV field when it contains a comma, double-quote, or newline.
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function toCsv(docs: Doc[]): string {
  // Header = union of top-level keys, in first-seen order.
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const k of Object.keys(doc)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const header = keys.map(csvCell).join(',');
  const rows = docs.map((doc) => keys.map((k) => csvCell(doc[k])).join(','));
  return [header, ...rows].join('\n');
}

export function parseJson(text: string): Doc[] {
  const value = JSON.parse(text);
  if (!Array.isArray(value)) {
    throw new Error('Expected a JSON array of documents');
  }
  return value as Doc[];
}

// Split CSV text into rows/fields, honoring quoting/escaping ("" -> ") and
// newlines inside quoted cells.
function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      cur += ch;
    }
  }
  row.push(cur);
  rows.push(row);
  return rows.filter((r) => r.some((cell) => cell.length > 0));
}

// A cell becomes its JSON value when parseable (number/bool/object/array/quoted
// string), otherwise the raw string.
function parseCell(cell: string): unknown {
  if (cell === '') return '';
  try {
    return JSON.parse(cell);
  } catch {
    return cell;
  }
}

export function parseCsv(text: string): Doc[] {
  const rows = splitCsvRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0];
  const docs: Doc[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length !== headers.length) {
      throw new Error(
        `Malformed CSV: row ${i + 1} has ${cells.length} columns, expected ${headers.length}`
      );
    }
    const doc: Doc = {};
    headers.forEach((h, idx) => {
      doc[h] = parseCell(cells[idx]);
    });
    docs.push(doc);
  }
  return docs;
}

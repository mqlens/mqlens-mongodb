// Pure serialize helpers for exporting the result grid (JSON / NDJSON / CSV).
// No I/O — file access happens in the caller via the Tauri dialog/fs plugins.
// File import parsing lives in the Rust backend (import_collection_file).

type Doc = Record<string, unknown>;

export function toJson(docs: Doc[]): string {
  return JSON.stringify(docs, null, 2);
}

// Newline-delimited JSON (NDJSON/JSONL): one compact document per line, no array
// brackets. Documents are already relaxed-EJSON objects, so this round-trips.
export function toNdjson(docs: Doc[]): string {
  return docs.map((doc) => JSON.stringify(doc)).join('\n');
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


// Export, import, mongodump and mongorestore, copying collections and databases,
// and the local audit log (#396).
//
// On the built-in sample server, exports read its data, imports and copies are
// checked and counted but write nothing, and the database tools refuse it, as
// in the backend.
import type { Backend, Handler } from '../backend';
import { fromBsonBase64, toBsonBase64 } from '../bson';
import { collectionForWrite, collectionOf, databaseOf, guardWritable, isMock, serverOf } from '../lookup';
import { aggregate, bsonEqual, find, includePath, inferSchema, jsonEqual, matches, mockFind, newObjectId } from '../mongo';
import type { Doc } from '../seed';
import type { E2EState } from '../state';
import { recordTask } from '../tasks';
import { duplicateIndexKey, duplicateKey, parallelArrays, parallelArraysOver } from '../unique';
import { validationError } from '../validation';
import { defineView } from '../views';

interface ExportOptions {
  fields?: string[];
  csv?: { delimiter?: string; includeHeaders?: boolean };
  xlsx?: { includeHeaders?: boolean };
}

interface CsvOptions {
  delimiter?: string;
  quote?: string;
  skipLines?: number;
  hasHeaders?: boolean;
  columnTypes?: Record<string, string>;
}

/**
 * Records in delimited text, as the `csv` crate reads them for an import: a
 * quoted field may hold the delimiter, a doubled quote and line breaks, rows
 * may differ in length, and blank lines are skipped.
 */
function csvRecords(text: string, delimiter: string, quote: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let pending = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== quote) field += char;
      else if (text[i + 1] === quote) {
        field += quote;
        i += 1;
      } else quoted = false;
    } else if (char === quote) {
      quoted = true;
      pending = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
      pending = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
      field = '';
      pending = false;
    } else {
      field += char;
      pending = true;
    }
  }
  if (pending) records.push([...record, field]);
  return records;
}

type DumpScope = { kind: 'server' } | { kind: 'db'; db: string } | { kind: 'collection'; db: string; coll: string };

interface DumpOptions {
  scope: DumpScope;
  target: { kind: 'folder'; out: string } | { kind: 'archive'; file: string };
  gzip?: boolean;
  query?: string;
  forceTableScan?: boolean;
  dumpUsersAndRoles?: boolean;
  oplog?: boolean;
}

interface RestoreOptions {
  source: { kind: 'folder'; dir: string } | { kind: 'archive'; file: string };
  selections?: Array<{ db: string; coll: string; renameTo?: string }>;
  drop?: boolean;
  gzip?: boolean;
}

interface CopyTarget {
  connectionId: string;
  db: string;
  collection: string;
}

interface AuditFilter {
  limit?: number;
  offset?: number;
  summaryContains?: string;
  op?: string;
  ok?: boolean | null;
}

type ConflictMode = 'skip' | 'merge' | 'overwrite';

const MOCK_AGGREGATE = 'Aggregation pipelines are not supported on mock connections';
const MOCK_TOOLS = 'MongoDB Database Tools require a real connection, not a mock connection';
/** How many documents an import writes at a time (`IMPORT_BATCH_SIZE`). */
const IMPORT_BATCH_SIZE = 500;
/** The most documents an export reads from the sample server. */
const MOCK_EXPORT_LIMIT = 1000;

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** An argument sent as JSON text; blank means none. */
function jsonArg<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/** A copy's conflict mode, parsed as `ConflictMode::parse` does. */
function conflictModeOf(value: unknown): ConflictMode {
  const mode = String(value ?? 'merge').trim().toLowerCase();
  if (mode === 'skip' || mode === 'merge' || mode === 'overwrite') return mode;
  throw `Unknown conflict mode '${mode}'`;
}

/** The value at a dotted path through embedded documents, never into arrays, as a CSV cell reads it. */
function valueAtPath(doc: Doc, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, part) => (typeof node === 'object' && node !== null && !Array.isArray(node) ? (node as Doc)[part] : undefined), doc);
}

/** A tabular export's columns when no fields are chosen: every top-level field, in sorted order, as the backend collects them. */
const sortedColumns = (docs: Doc[]) => [...new Set(docs.flatMap((doc) => Object.keys(doc)))].sort();

/**
 * Documents written out in an export format. With fields selected, JSON keeps
 * a dotted path nested (`{ address: { city } }`), as the backend's projection
 * does, and CSV has a column named by each selected path.
 */
function formatDocs(docs: Doc[], format: string, options: ExportOptions = {}): string {
  const fields = options.fields?.length ? options.fields : undefined;
  const shaped = fields
    ? docs.map((doc) => {
        const out: Doc = {};
        for (const field of fields) includePath(out, doc, field);
        return out;
      })
    : docs;
  switch (format) {
    case 'json':
      return JSON.stringify(shaped, null, 2);
    case 'ndjson':
      return shaped.map((doc) => JSON.stringify(doc)).join('\n');
    case 'csv': {
      const delimiter = options.csv?.delimiter || ',';
      const columns = fields ?? sortedColumns(docs);
      const cell = (value: unknown) => {
        const text =
          value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        return /["\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const rows = docs.map((doc) => columns.map((column) => cell(valueAtPath(doc, column))).join(delimiter));
      return [...(options.csv?.includeHeaders === false ? [] : [columns.join(delimiter)]), ...rows].join('\n');
    }
    case 'bson':
      // The .bson file's bytes, base64-encoded: the fake records written files as text.
      return toBsonBase64(shaped);
    case 'xlsx': {
      // The sheet's rows as the Excel writer fills them (src-tauri/src/db/export/xlsx.rs),
      // as JSON: the fake records written files as text, not as a workbook.
      const columns = fields ?? sortedColumns(docs);
      const cell = (value: unknown): unknown => {
        if (value === undefined || value === null) return null;
        if (typeof value !== 'object') return value;
        const wrapped = value as Record<string, unknown>;
        if (typeof wrapped.$oid === 'string') return wrapped.$oid;
        if ('$date' in wrapped) {
          const date = wrapped.$date;
          return new Date(typeof date === 'object' && date !== null ? Number((date as Doc).$numberLong) : (date as string | number)).toISOString();
        }
        return JSON.stringify(value);
      };
      const rows = docs.map((doc) => columns.map((column) => cell(valueAtPath(doc, column))));
      return JSON.stringify({ sheet: [...(options.xlsx?.includeHeaders === false ? [] : [columns]), ...rows] });
    }
    default:
      throw `e2e fake backend cannot write ${format} files`;
  }
}

/** A parsed JSON value as an import document; the backend refuses anything but an object. */
function asDocument(value: unknown): Doc {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw 'Expected a JSON object (e.g. { "field": value })';
  return value as Doc;
}

const INTEGER = /^[+-]?\d+$/;
const RFC_3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * One CSV cell under its column's type, as `convert_csv_cell` converts it
 * (src-tauri/src/db/documents.rs). An untyped cell becomes its JSON value when
 * it parses as JSON and stays text otherwise. `row` counts data rows from 1.
 */
function convertCsvCell(cell: string, column: string, type: string | undefined, row: number): unknown {
  const fail = (name: string): never => {
    throw `CSV row ${row}, column "${column}": cannot convert "${cell}" to ${name}`;
  };
  const trimmed = cell.trim();
  switch (type ?? 'auto') {
    case 'auto':
      if (cell === '') return '';
      try {
        return JSON.parse(cell);
      } catch {
        return cell;
      }
    case 'string':
      return cell;
    case 'number':
      return trimmed !== '' && !Number.isNaN(Number(trimmed)) ? Number(trimmed) : fail('number');
    case 'boolean':
      if (trimmed.toLowerCase() === 'true') return true;
      if (trimmed.toLowerCase() === 'false') return false;
      return fail('boolean');
    case 'date': {
      const millis = INTEGER.test(trimmed) ? Number(trimmed) : RFC_3339.test(trimmed) ? Date.parse(trimmed) : NaN;
      return Number.isNaN(millis) ? fail('date (RFC-3339 or epoch millis)') : { $date: new Date(millis).toISOString() };
    }
    case 'json':
      try {
        return JSON.parse(cell);
      } catch {
        return fail('json');
      }
    default:
      throw `e2e fake backend has no CSV column type ${type}`;
  }
}

function parseImport(text: string, format: string, csv: CsvOptions = {}): { docs: Doc[]; columns: string[] } {
  switch (format) {
    case 'json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw `Invalid JSON: ${String(error)}`;
      }
      if (!Array.isArray(parsed)) throw 'Expected a JSON array of documents';
      // One element that isn't an object refuses the whole file.
      return { docs: parsed.map(asDocument), columns: [] };
    }
    case 'ndjson':
    case 'jsonl':
      return {
        docs: text.split(/\r?\n/).flatMap((line, i) => {
          if (line.trim() === '') return [];
          try {
            return [asDocument(JSON.parse(line))];
          } catch (error) {
            throw `NDJSON line ${i + 1}: ${error instanceof SyntaxError ? `Invalid JSON: ${String(error)}` : String(error)}`;
          }
        }),
        columns: [],
      };
    case 'csv': {
      const delimiter = csv.delimiter ?? ',';
      const quote = csv.quote ?? '"';
      if (delimiter.length !== 1) throw 'CSV delimiter must be a single ASCII character';
      if (quote.length !== 1) throw 'CSV text qualifier must be a single ASCII character';
      // Skipped lines are dropped as plain lines before the CSV reader sees the text.
      const records = csvRecords(text.split(/\r?\n/).slice(csv.skipLines ?? 0).join('\n'), delimiter, quote);
      const header = csv.hasHeaders === false ? (records[0] ?? []).map((_, i) => `field${i + 1}`) : (records.shift() ?? []);
      return {
        // Each column takes its cell, an empty one when the row is short; cells past the last column are dropped.
        docs: records.map((cells, row) =>
          Object.fromEntries(
            header.map((column, i) => [column, convertCsvCell(cells[i] ?? '', column, csv.columnTypes?.[column], row + 1)]),
          ),
        ),
        columns: header,
      };
    }
    case 'bson':
      // A .bson file's documents one after another; the fake's files are text, so its bytes are base64-encoded.
      try {
        return { docs: fromBsonBase64(text), columns: [] };
      } catch (error) {
        throw typeof error === 'string' ? error : `Invalid BSON: ${String(error)}`;
      }
    default:
      throw `Unsupported import format: ${format}`;
  }
}

const scopeLabel = (scope: DumpScope) =>
  scope.kind === 'server' ? 'server' : scope.kind === 'db' ? scope.db : `${scope.db}.${scope.coll}`;

function dumpCommand(tool: string, options: DumpOptions): string {
  const parts = [tool, '--uri=<connection>'];
  if (options.scope.kind !== 'server') parts.push(`--db=${options.scope.db}`);
  if (options.scope.kind === 'collection') parts.push(`--collection=${options.scope.coll}`);
  if (options.query) parts.push(`--query=${options.query}`);
  parts.push(options.target.kind === 'folder' ? `--out=${options.target.out}` : `--archive=${options.target.file}`);
  if (options.gzip) parts.push('--gzip');
  if (options.forceTableScan) parts.push('--forceTableScan');
  if (options.dumpUsersAndRoles) parts.push('--dumpDbUsersAndRoles');
  if (options.oplog) parts.push('--oplog');
  return parts.join(' ');
}

function restoreCommand(tool: string, options: RestoreOptions): string {
  const parts = [tool, '--uri=<connection>'];
  if (options.drop) parts.push('--drop');
  if (options.gzip) parts.push('--gzip');
  for (const selection of options.selections ?? []) parts.push(`--nsInclude=${selection.db}.${selection.coll}`);
  parts.push(options.source.kind === 'folder' ? options.source.dir : `--archive=${options.source.file}`);
  return parts.join(' ');
}

export function registerTransferHandlers(backend: Backend, state: E2EState): void {
  let tombstoneSerial = 0;

  const sourceText = (source: unknown): string => {
    const { path, text } = (source ?? {}) as { path?: string; text?: string };
    if (typeof text === 'string') return text;
    if (path !== undefined && state.files[path] !== undefined) return state.files[path];
    throw `No such file: ${String(path)}`;
  };
  /** An import's source text. BSON is binary, which the backend reads only from a file. */
  const importText = (source: unknown, format: unknown): string => {
    if (String(format) === 'bson' && typeof (source as { text?: unknown } | null)?.text === 'string') {
      throw 'BSON import requires a file source';
    }
    return sourceText(source);
  };

  /** The documents a filtered export, its preview or its field scan covers. */
  const queried = (args: Record<string, unknown>): Doc[] => {
    const docs = collectionOf(state, args.id, args.database, args.collection).docs;
    const mock = isMock(state, args.id);
    const pipeline = jsonArg<Doc[] | null>(args.pipeline, null);
    if (pipeline) {
      if (mock) throw MOCK_AGGREGATE;
      return aggregate(docs, pipeline);
    }
    const options = {
      filter: jsonArg<Doc>(args.filter, {}),
      sort: jsonArg<Doc>(args.sort, {}),
      skip: Number(args.skip ?? 0),
      limit: Number(args.limit ?? 0),
    };
    // The sample server ignores the projection and reads no more than 1000 documents.
    if (mock) return mockFind(docs, { ...options, limit: options.limit > 0 ? options.limit : MOCK_EXPORT_LIMIT });
    return find(docs, { ...options, projection: jsonArg<Doc>(args.projection, {}) });
  };

  const copyCollection = (
    source: { id: unknown; db: unknown; coll: unknown },
    target: { id: unknown; db: unknown; coll: unknown },
    filter: Doc,
    includeIndexes: boolean,
    conflictMode: ConflictMode,
  ) => {
    const from = collectionOf(state, source.id, source.db, source.coll);
    const databases = serverOf(state, target.id).databases;
    const existed = databases[String(target.db)]?.[String(target.coll)] !== undefined;
    // A skipped collection copies and skips no documents (`was_skipped` in src-tauri/src/db/copy.rs):
    // documentsSkipped counts only rows merge mode refuses as duplicates.
    if (existed && conflictMode === 'skip') {
      return { documentsCopied: 0, documentsSkipped: 0, indexesCreated: 0, skipped: true };
    }
    // Overwrite drops the target first, and its own indexes go with it.
    if (existed && conflictMode === 'overwrite') delete databases[String(target.db)][String(target.coll)];
    const to = collectionForWrite(state, target.id, target.db, target.coll);
    const ns = `${String(target.db)}.${String(target.coll)}`;
    let documentsCopied = 0;
    let documentsSkipped = 0;
    // Written unordered. A row MongoDB refuses as a duplicate key, on `_id` or on
    // any unique index, is retried alone and counted as skipped; any other
    // refusal, such as the target's validator, fails the copy.
    for (const doc of from.docs.filter((candidate) => matches(candidate, filter))) {
      const refused = validationError(to, doc) ?? parallelArrays(to, doc);
      if (refused) throw `Insert into target failed: ${refused}`;
      if (duplicateKey(ns, to, doc)) {
        documentsSkipped += 1;
        continue;
      }
      to.docs.push(structuredClone(doc));
      documentsCopied += 1;
    }
    // Indexes are built after the documents are in. One the target already has is
    // left alone, and one the documents can't satisfy fails the copy: parallel
    // arrays under a compound key, or a key a unique index finds twice.
    let indexesCreated = 0;
    if (includeIndexes) {
      for (const index of from.indexes) {
        if (to.indexes.some((existing) => existing.name === index.name)) continue;
        const clash =
          parallelArraysOver(index.keys, to.docs) ??
          (index.unique ? duplicateIndexKey(ns, index.name, index.keys, to.docs, Boolean(index.sparse)) : null);
        if (clash) throw `Failed to create index on target: ${clash}`;
        to.indexes.push(structuredClone(index));
        indexesCreated += 1;
      }
    }
    return { documentsCopied, documentsSkipped, indexesCreated, skipped: false };
  };

  const auditMatches = (filter: AuditFilter) =>
    state.audit.events
      .filter(
        (event) =>
          (!filter.op || event.op === filter.op) &&
          (filter.ok === undefined || filter.ok === null || event.ok === filter.ok) &&
          (!filter.summaryContains || String(event.summary).toLowerCase().includes(filter.summaryContains.toLowerCase())),
      )
      // Newest first, as the audit store orders them before it pages.
      .sort((a, b) => Number(b.ts) - Number(a.ts));

  const handlers: Record<string, Handler> = {
    // Export
    format_current_docs: ({ docs, format, options, path }) => {
      const text = formatDocs(docs as Doc[], String(format), options as ExportOptions);
      if (path === null || path === undefined) return text;
      state.writtenFiles[String(path)] = text;
      return null;
    },
    preview_export: (args) => formatDocs(queried(args).slice(0, 5), String(args.format), args.options as ExportOptions),
    sample_export_fields: (args) =>
      inferSchema(queried({ ...args, sort: null, projection: null, skip: 0, limit: 0 }), 100).fields.map((field) => field.path),
    start_collection_export: ({ id, database, collection, format, path, options }) => {
      const all = collectionOf(state, id, database, collection).docs;
      const docs = isMock(state, id) ? all.slice(0, MOCK_EXPORT_LIMIT) : all;
      state.writtenFiles[String(path)] = formatDocs(docs, String(format), options as ExportOptions);
      return recordTask(state, {
        kind: 'collection_export',
        label: `Export ${String(database)}.${String(collection)} as ${String(format).toUpperCase()}`,
        startMessage: 'Queued',
        message: 'Export complete',
        processed: docs.length,
        total: docs.length,
        path: String(path),
      });
    },
    start_filtered_export: (args) => {
      const docs = queried(args);
      state.writtenFiles[String(args.path)] = formatDocs(docs, String(args.format), args.options as ExportOptions);
      return recordTask(state, {
        kind: 'filtered_export',
        label: `Export ${String(args.database)}.${String(args.collection)} (filtered) as ${String(args.format).toUpperCase()}`,
        startMessage: 'Queued',
        message: 'Export complete',
        processed: docs.length,
        total: docs.length,
        path: String(args.path),
      });
    },

    // Import
    preview_import: ({ source, format, csvOptions, limit }) => {
      try {
        const { docs, columns } = parseImport(importText(source, format), String(format), csvOptions as CsvOptions);
        return {
          docs: docs.slice(0, Number(limit ?? 20)).map((doc) => JSON.stringify(doc)),
          columns,
          totalHint: docs.length,
          error: null,
        };
      } catch (error) {
        return { docs: [], columns: [], totalHint: null, error: String(error) };
      }
    },
    start_import_task: ({ id, database, collection, source, format, csvOptions, mode }) => {
      guardWritable(state, id);
      const importMode = String(mode ?? 'skip');
      if (importMode !== 'skip' && importMode !== 'update' && importMode !== 'abort') {
        throw 'Import mode must be skip, update, or abort';
      }
      const { docs } = parseImport(importText(source, format), String(format), csvOptions as CsvOptions);
      const counts = { inserted: 0, updated: 0, skipped: 0 };
      let error: string | undefined;
      if (isMock(state, id)) {
        // The sample server parses and counts every row and writes none of them.
        if (importMode === 'update') counts.updated = docs.length;
        else counts.inserted = docs.length;
      } else {
        const target = collectionForWrite(state, id, database, collection);
        const ns = `${String(database)}.${String(collection)}`;
        // The backend finds stored ids with `$in`, so an id matches a stored one of equal
        // BSON value: `1` and `{ $numberLong: "1" }` are the same document.
        const stored = (doc: Doc) => (doc._id === undefined ? -1 : target.docs.findIndex((existing) => bsonEqual(existing._id, doc._id)));
        // Every write goes through the collection's validator and unique indexes. A
        // refusal fails the import with MongoDB's error, prefixed as the backend's
        // write prefixes it, and what was written before it stays, as with ordered writes.
        try {
          for (let start = 0; start < docs.length; start += IMPORT_BATCH_SIZE) {
            const batch = docs.slice(start, start + IMPORT_BATCH_SIZE);
            // The backend looks up which of a batch's ids are stored before writing
            // any of it. Two new documents sharing an id are both inserted, and the
            // second fails; they aren't taken for a stored document.
            const storedIds = [...new Set(batch.map(stored).filter((at) => at >= 0))].map((at) => target.docs[at]._id);
            // Abort checks a batch before writing any of it, counting the stored documents
            // it found; the batches before it are already written.
            if (importMode === 'abort' && storedIds.length > 0) {
              throw `Import aborted: ${storedIds.length} document(s) already exist`;
            }
            for (const doc of batch) {
              const at = doc._id !== undefined && storedIds.some((id) => bsonEqual(id, doc._id)) ? stored(doc) : -1;
              if (at < 0) {
                const incoming = doc._id === undefined ? { _id: { $oid: newObjectId() }, ...doc } : doc;
                const refusal = validationError(target, incoming) ?? parallelArrays(target, incoming) ?? duplicateKey(ns, target, incoming);
                if (refusal) throw `Failed to ${importMode === 'update' ? 'import (insert)' : 'import'}: ${refusal}`;
                target.docs.push(incoming);
                counts.inserted += 1;
              } else if (importMode === 'update') {
                const clash =
                  validationError(target, doc, target.docs[at]) ?? parallelArrays(target, doc) ?? duplicateKey(ns, target, doc, target.docs[at]);
                if (clash) throw `Failed to import (update): ${clash}`;
                // replace_one's modified count: an identical document isn't counted.
                if (!jsonEqual(target.docs[at], doc)) counts.updated += 1;
                target.docs[at] = doc;
              } else {
                counts.skipped += 1;
              }
            }
          }
        } catch (failure) {
          error = String(failure);
        }
      }
      const { path } = (source ?? {}) as { path?: string };
      return recordTask(state, {
        kind: 'import',
        label: `Import ${String(database)}.${String(collection)} from ${path ? basename(path) : 'pasted text'}`,
        startMessage: 'Queued',
        message: error ? 'Task failed' : `Import complete: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.skipped} skipped`,
        error,
        processed: counts.inserted + counts.updated + counts.skipped,
        total: docs.length,
      });
    },

    // mongodump and mongorestore
    detect_mongo_tools: () => structuredClone(state.mongoTools),
    preview_dump_command: ({ id, toolPath, options }) => {
      serverOf(state, id);
      return dumpCommand(String(toolPath), options as DumpOptions);
    },
    start_dump_task: ({ id, toolPath, options }) => {
      if (isMock(state, id)) throw MOCK_TOOLS;
      const server = serverOf(state, id);
      const dump = options as DumpOptions;
      if (!toolPath) throw 'mongodump was not found';
      const destination = dump.target.kind === 'folder' ? dump.target.out : dump.target.file;
      const databases = dump.scope.kind === 'server' ? Object.keys(server.databases) : [dump.scope.db];
      const onlyCollection = dump.scope.kind === 'collection' ? dump.scope.coll : null;
      // A dump to a folder leaves one a later restore can browse.
      if (dump.target.kind === 'folder') {
        state.dumpFolders[destination] = {
          dbs: databases.map((db) => ({
            name: db,
            collections: Object.keys(server.databases[db] ?? {})
              .filter((name) => onlyCollection === null || name === onlyCollection)
              .map((name) => ({ name, hasMetadata: true, gzip: Boolean(dump.gzip) })),
          })),
        };
      }
      return recordTask(state, {
        kind: 'dump',
        label: `Dump ${scopeLabel(dump.scope)} → ${basename(destination)}`,
        startMessage: 'Starting mongodump…',
        message: 'mongodump finished',
        processed: databases.length,
        path: destination,
      });
    },
    browse_dump_folder: ({ path }) => {
      const folder = state.dumpFolders[String(path)];
      if (!folder) throw `No mongodump output found in ${String(path)}`;
      return structuredClone(folder);
    },
    preview_restore_command: ({ id, toolPath, options }) => {
      serverOf(state, id);
      return restoreCommand(String(toolPath), options as RestoreOptions);
    },
    start_restore_task: ({ id, toolPath, options }) => {
      guardWritable(state, id);
      if (isMock(state, id)) throw MOCK_TOOLS;
      if (!toolPath) throw 'mongorestore was not found';
      const restore = options as RestoreOptions;
      const source = restore.source.kind === 'folder' ? restore.source.dir : restore.source.file;
      // Reported, not performed: a fake dump folder holds no documents to restore.
      return recordTask(state, {
        kind: 'restore',
        label: `Restore ${basename(source)}`,
        startMessage: 'Starting mongorestore…',
        message: 'mongorestore finished',
        processed: restore.selections?.length ?? 0,
        path: source,
      });
    },

    // Copying between connections
    preflight_copy: ({ sourceId, sourceDb, sourceCollections, targets }) => {
      const list = (targets ?? []) as CopyTarget[];
      const sources = (sourceCollections ?? []) as string[];
      return {
        conflicts: list.map((target) => {
          const existing = serverOf(state, target.connectionId).databases[target.db]?.[target.collection];
          return { ...target, targetExists: existing !== undefined, targetDocCount: existing?.docs.length ?? 0 };
        }),
        selfOverwrite: list.some(
          (target) => target.connectionId === sourceId && target.db === sourceDb && sources.includes(target.collection),
        ),
      };
    },
    start_collection_copy: (args) => {
      guardWritable(state, args.targetId);
      const mode = conflictModeOf(args.conflictMode);
      const filter = jsonArg<Doc>(args.filter, {});
      // A hard stop whatever the mode, whatever the app's preflight warned about.
      if (args.sourceId === args.targetId && args.sourceDb === args.targetDb && args.sourceCollection === args.targetCollection) {
        throw 'Source and target are the same collection — copy would overwrite itself';
      }
      const label = `Copy ${String(args.sourceDb)}.${String(args.sourceCollection)} → ${String(args.targetDb)}.${String(args.targetCollection)}`;
      if (isMock(state, args.sourceId) || isMock(state, args.targetId)) {
        // Simulated: every source document is reported copied, the filter and indexes are ignored, and nothing is written.
        const count = collectionOf(state, args.sourceId, args.sourceDb, args.sourceCollection).docs.length;
        return recordTask(state, {
          kind: 'collection_copy',
          label,
          startMessage: 'Queued',
          message: 'Copy complete',
          processed: count,
          total: count,
          summary: { collectionsCopied: 1, documentsCopied: count, documentsSkipped: 0, indexesCreated: 0, skipped: [], failed: [] },
        });
      }
      let result: ReturnType<typeof copyCollection>;
      try {
        result = copyCollection(
          { id: args.sourceId, db: args.sourceDb, coll: args.sourceCollection },
          { id: args.targetId, db: args.targetDb, coll: args.targetCollection },
          filter,
          Boolean(args.includeIndexes),
          mode,
        );
      } catch (failure) {
        // The copy's task fails with the error; what it wrote before failing stays.
        return recordTask(state, { kind: 'collection_copy', label, startMessage: 'Queued', message: 'Task failed', error: String(failure), processed: 0 });
      }
      return recordTask(state, {
        kind: 'collection_copy',
        label,
        startMessage: 'Queued',
        message: 'Copy complete',
        processed: result.documentsCopied,
        total: result.documentsCopied + result.documentsSkipped,
        summary: {
          collectionsCopied: result.skipped ? 0 : 1,
          documentsCopied: result.documentsCopied,
          documentsSkipped: result.documentsSkipped,
          indexesCreated: result.indexesCreated,
          skipped: result.skipped ? [String(args.sourceCollection)] : [],
          failed: [],
        },
      });
    },
    start_database_copy: (args) => {
      guardWritable(state, args.targetId);
      const mode = conflictModeOf(args.conflictMode);
      if (args.sourceId === args.targetId && args.sourceDb === args.targetDb) {
        throw 'Source and target database are the same — copy would overwrite itself';
      }
      const source = databaseOf(state, args.sourceId, args.sourceDb);
      const chosen = args.collections as string[] | null;
      const names = Object.keys(source).filter((name) => !chosen || chosen.includes(name));
      const totals = {
        collectionsCopied: 0,
        documentsCopied: 0,
        documentsSkipped: 0,
        indexesCreated: 0,
        skipped: [] as string[],
        failed: [] as unknown[],
      };
      const label = `Copy ${String(args.sourceDb)} → ${String(args.targetDb)}`;
      if (isMock(state, args.sourceId) || isMock(state, args.targetId)) {
        // Simulated, and counting every chosen collection, time series included.
        totals.collectionsCopied = names.length;
        totals.documentsCopied = names.reduce((sum, name) => sum + (source[name]?.docs.length ?? 0), 0);
        return recordTask(state, {
          kind: 'database_copy',
          label,
          startMessage: 'Queued',
          message: 'Copy complete',
          processed: names.length,
          total: names.length,
          summary: totals,
        });
      }
      for (const name of names) {
        const definition = source[name].view;
        if (source[name].type === 'view') {
          // A view is recreated from its definition, reading its source by name in
          // the target database, or skipped when views aren't asked for.
          if (!args.includeViews || !definition) {
            totals.skipped.push(name);
            continue;
          }
          const targetDb = (serverOf(state, args.targetId).databases[String(args.targetDb)] ??= {});
          const ns = `${String(args.targetDb)}.${name}`;
          if (targetDb[name]) totals.failed.push({ collection: name, error: `Failed to create view: Collection already exists. NS: ${ns}` });
          else {
            targetDb[name] = defineView(targetDb, ns, definition.on, definition.pipeline);
            totals.collectionsCopied += 1;
          }
          continue;
        }
        if (source[name].type === 'timeseries') {
          // Copying a time series collection is out of scope; it's reported as skipped.
          totals.skipped.push(`${name} (timeseries)`);
          continue;
        }
        let result: ReturnType<typeof copyCollection>;
        try {
          result = copyCollection(
            { id: args.sourceId, db: args.sourceDb, coll: name },
            { id: args.targetId, db: args.targetDb, coll: name },
            {},
            Boolean(args.includeIndexes),
            mode,
          );
        } catch (failure) {
          // A collection that fails is listed with its error, and the copy carries on.
          totals.failed.push({ collection: name, error: String(failure) });
          continue;
        }
        if (result.skipped) totals.skipped.push(name);
        else totals.collectionsCopied += 1;
        totals.documentsCopied += result.documentsCopied;
        totals.documentsSkipped += result.documentsSkipped;
        totals.indexesCreated += result.indexesCreated;
      }
      return recordTask(state, {
        kind: 'database_copy',
        label,
        startMessage: 'Queued',
        message: 'Copy complete',
        processed: totals.collectionsCopied,
        total: names.length,
        summary: totals,
      });
    },

    // The local audit log
    audit_status: () => structuredClone(state.audit.status),
    audit_list: ({ filter }) => {
      if (state.vault !== 'unlocked') throw 'vault is locked';
      const matching = auditMatches((filter ?? {}) as AuditFilter);
      const { limit, offset = 0 } = (filter ?? {}) as AuditFilter;
      return structuredClone(matching.slice(offset, limit === undefined ? undefined : offset + limit));
    },
    audit_export: ({ filter, path }) => {
      const events = auditMatches((filter ?? {}) as AuditFilter);
      state.writtenFiles[String(path)] = events.map((event) => JSON.stringify(event)).join('\n');
      return events.length;
    },
    // Discarding a damaged log keeps the tombstones of earlier discards and adds
    // one for this discard, so a discarded log never looks like it never existed.
    audit_discard_damaged_log: () => {
      const reason = state.audit.status.integrityError;
      if (!reason) {
        throw 'the activity log is intact, so there is nothing to discard. Old events are removed automatically by the retention setting.';
      }
      const tombstones = state.audit.events.filter((event) => event.op === 'audit_log_discarded');
      const discarded = state.audit.events.length - tombstones.length;
      tombstoneSerial += 1;
      state.audit.events = [
        ...tombstones,
        {
          id: `discarded-${tombstoneSerial}`,
          ts: Date.now(),
          connectionId: null,
          profileName: null,
          database: null,
          collection: null,
          op: 'audit_log_discarded',
          source: 'ui',
          ok: false,
          error: String(reason),
          durationMs: 0,
          summary: `damaged activity log discarded — ${discarded} readable event(s) removed, the rest unverifiable; verified 0 record(s) up to chain unknown`,
          argsJson: null,
          levelAtRecord: '-',
          schemaVersion: 1,
        },
      ];
      state.audit.status = { ...state.audit.status, integrityError: null };
      return discarded;
    },
  };

  backend.register(handlers);
}

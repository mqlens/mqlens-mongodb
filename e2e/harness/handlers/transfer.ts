// Export, import, mongodump and mongorestore, copying collections and databases,
// and the local audit log (#396).
import type { Backend, Handler } from '../backend';
import { collectionForWrite, collectionOf, databaseOf, serverOf } from '../lookup';
import { aggregate, find, inferSchema, matches, newObjectId } from '../mongo';
import type { Doc } from '../seed';
import type { E2EState } from '../state';
import { recordTask } from '../tasks';

interface ExportOptions {
  fields?: string[];
  csv?: { delimiter?: string; includeHeaders?: boolean };
}

interface CsvOptions {
  delimiter?: string;
  skipLines?: number;
  hasHeaders?: boolean;
  columnTypes?: Record<string, string>;
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

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** An argument sent as JSON text; blank means none. */
function jsonArg<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function formatDocs(docs: Doc[], format: string, options: ExportOptions = {}): string {
  const fields = options.fields?.length ? options.fields : undefined;
  const shaped = fields
    ? docs.map((doc) => Object.fromEntries(fields.filter((field) => field in doc).map((field) => [field, doc[field]])))
    : docs;
  switch (format) {
    case 'json':
      return JSON.stringify(shaped, null, 2);
    case 'ndjson':
      return shaped.map((doc) => JSON.stringify(doc)).join('\n');
    case 'csv': {
      const delimiter = options.csv?.delimiter || ',';
      const columns = [...new Set(shaped.flatMap((doc) => Object.keys(doc)))];
      const cell = (value: unknown) => {
        const text =
          value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        return /["\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const rows = shaped.map((doc) => columns.map((column) => cell(doc[column])).join(delimiter));
      return [...(options.csv?.includeHeaders === false ? [] : [columns.join(delimiter)]), ...rows].join('\n');
    }
    default:
      throw `e2e fake backend cannot write ${format} files`;
  }
}

function parseImport(text: string, format: string, csv: CsvOptions = {}): { docs: Doc[]; columns: string[] } {
  switch (format) {
    case 'json': {
      const parsed = JSON.parse(text) as Doc | Doc[];
      return { docs: Array.isArray(parsed) ? parsed : [parsed], columns: [] };
    }
    case 'ndjson':
    case 'jsonl':
      return {
        docs: text
          .split(/\r?\n/)
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as Doc),
        columns: [],
      };
    case 'csv': {
      // Plain delimited cells: enough for the specs' files, not a CSV parser.
      const delimiter = csv.delimiter || ',';
      const lines = text
        .split(/\r?\n/)
        .slice(csv.skipLines ?? 0)
        .filter((line) => line.trim() !== '');
      const split = (line: string) => line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1'));
      const header =
        csv.hasHeaders === false ? split(lines[0] ?? '').map((_, i) => `field${i + 1}`) : split(lines.shift() ?? '');
      const typed = (column: string, value: string): unknown => {
        const type = csv.columnTypes?.[column];
        if (type === 'number' || type === 'int' || type === 'double') return Number(value);
        if (type === 'boolean' || type === 'bool') return value === 'true';
        return value;
      };
      return {
        docs: lines.map((line) => Object.fromEntries(split(line).map((value, i) => [header[i], typed(header[i], value)]))),
        columns: header,
      };
    }
    default:
      throw `e2e fake backend cannot read ${format} files`;
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
  const sourceText = (source: unknown): string => {
    const { path, text } = (source ?? {}) as { path?: string; text?: string };
    if (typeof text === 'string') return text;
    if (path !== undefined && state.files[path] !== undefined) return state.files[path];
    throw `No such file: ${String(path)}`;
  };

  /** The documents a filtered export, its preview or its field scan covers. */
  const queried = (args: Record<string, unknown>): Doc[] => {
    const docs = collectionOf(state, args.id, args.database, args.collection).docs;
    const pipeline = jsonArg<Doc[] | null>(args.pipeline, null);
    if (pipeline) return aggregate(docs, pipeline);
    return find(docs, {
      filter: jsonArg<Doc>(args.filter, {}),
      sort: jsonArg<Doc>(args.sort, {}),
      projection: jsonArg<Doc>(args.projection, {}),
      skip: Number(args.skip ?? 0),
      limit: Number(args.limit ?? 0),
    });
  };

  const copyCollection = (
    source: { id: unknown; db: unknown; coll: unknown },
    target: { id: unknown; db: unknown; coll: unknown },
    filter: Doc,
    includeIndexes: boolean,
    conflictMode: string,
  ) => {
    const from = collectionOf(state, source.id, source.db, source.coll);
    const existed = serverOf(state, target.id).databases[String(target.db)]?.[String(target.coll)] !== undefined;
    if (existed && conflictMode === 'skip') {
      return { documentsCopied: 0, documentsSkipped: from.docs.length, indexesCreated: 0, skipped: true };
    }
    const to = collectionForWrite(state, target.id, target.db, target.coll);
    if (conflictMode === 'replace' || conflictMode === 'overwrite') to.docs = [];
    let documentsCopied = 0;
    let documentsSkipped = 0;
    for (const doc of from.docs.filter((candidate) => matches(candidate, filter))) {
      if (to.docs.some((existing) => JSON.stringify(existing._id) === JSON.stringify(doc._id))) {
        documentsSkipped += 1;
        continue;
      }
      to.docs.push(structuredClone(doc));
      documentsCopied += 1;
    }
    let indexesCreated = 0;
    if (includeIndexes) {
      for (const index of from.indexes) {
        if (to.indexes.some((existing) => existing.name === index.name)) continue;
        to.indexes.push(structuredClone(index));
        indexesCreated += 1;
      }
    }
    return { documentsCopied, documentsSkipped, indexesCreated, skipped: false };
  };

  const auditMatches = (filter: AuditFilter) =>
    state.audit.events.filter(
      (event) =>
        (!filter.op || event.op === filter.op) &&
        (filter.ok === undefined || filter.ok === null || event.ok === filter.ok) &&
        (!filter.summaryContains || String(event.summary).toLowerCase().includes(filter.summaryContains.toLowerCase())),
    );

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
      const docs = collectionOf(state, id, database, collection).docs;
      state.writtenFiles[String(path)] = formatDocs(docs, String(format), options as ExportOptions);
      return recordTask(state, {
        kind: 'collection_export',
        label: `Export ${String(database)}.${String(collection)} as ${String(format).toUpperCase()}`,
        startMessage: 'Queued',
        message: `Exported ${docs.length} documents`,
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
        message: `Exported ${docs.length} documents`,
        processed: docs.length,
        total: docs.length,
        path: String(args.path),
      });
    },

    // Import
    preview_import: ({ source, format, csvOptions, limit }) => {
      try {
        const { docs, columns } = parseImport(sourceText(source), String(format), csvOptions as CsvOptions);
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
      const { docs } = parseImport(sourceText(source), String(format), csvOptions as CsvOptions);
      const target = collectionForWrite(state, id, database, collection);
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let error: string | undefined;
      for (const doc of docs) {
        const incoming = doc._id === undefined ? { _id: { $oid: newObjectId() }, ...doc } : doc;
        const at = target.docs.findIndex((existing) => JSON.stringify(existing._id) === JSON.stringify(incoming._id));
        if (at < 0) {
          target.docs.push(incoming);
          inserted += 1;
        } else if (mode === 'update') {
          target.docs[at] = incoming;
          updated += 1;
        } else if (mode === 'abort') {
          error = `Duplicate _id ${JSON.stringify(incoming._id)}: import stopped`;
          break;
        } else {
          skipped += 1;
        }
      }
      const { path } = (source ?? {}) as { path?: string };
      return recordTask(state, {
        kind: 'import',
        label: `Import ${String(database)}.${String(collection)} from ${path ? basename(path) : 'pasted text'}`,
        startMessage: 'Queued',
        message: `Inserted ${inserted}, updated ${updated}, skipped ${skipped}`,
        error,
        processed: inserted + updated + skipped,
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
      serverOf(state, id);
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
      const result = copyCollection(
        { id: args.sourceId, db: args.sourceDb, coll: args.sourceCollection },
        { id: args.targetId, db: args.targetDb, coll: args.targetCollection },
        jsonArg<Doc>(args.filter, {}),
        Boolean(args.includeIndexes),
        String(args.conflictMode ?? 'merge'),
      );
      return recordTask(state, {
        kind: 'collection_copy',
        label: `Copy ${String(args.sourceDb)}.${String(args.sourceCollection)} → ${String(args.targetDb)}.${String(args.targetCollection)}`,
        startMessage: 'Queued',
        message: `Copied ${result.documentsCopied} documents`,
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
      const source = databaseOf(state, args.sourceId, args.sourceDb);
      const names = ((args.collections as string[] | null) ?? Object.keys(source)).filter(
        (name) => Boolean(args.includeViews) || source[name]?.type !== 'view',
      );
      const totals = {
        collectionsCopied: 0,
        documentsCopied: 0,
        documentsSkipped: 0,
        indexesCreated: 0,
        skipped: [] as string[],
        failed: [] as unknown[],
      };
      for (const name of names) {
        const result = copyCollection(
          { id: args.sourceId, db: args.sourceDb, coll: name },
          { id: args.targetId, db: args.targetDb, coll: name },
          {},
          Boolean(args.includeIndexes),
          String(args.conflictMode ?? 'merge'),
        );
        if (result.skipped) totals.skipped.push(name);
        else totals.collectionsCopied += 1;
        totals.documentsCopied += result.documentsCopied;
        totals.documentsSkipped += result.documentsSkipped;
        totals.indexesCreated += result.indexesCreated;
      }
      return recordTask(state, {
        kind: 'database_copy',
        label: `Copy ${String(args.sourceDb)} → ${String(args.targetDb)}`,
        startMessage: 'Queued',
        message: `Copied ${totals.collectionsCopied} collections`,
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
    audit_discard_damaged_log: () => {
      const discarded = state.audit.events.length;
      state.audit.events = [];
      state.audit.status = { ...state.audit.status, integrityError: null };
      return discarded;
    },
  };

  backend.register(handlers);
}

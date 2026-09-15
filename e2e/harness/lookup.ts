// Finding a connection's server, databases and collections in the fake backend's
// state, and the checks the backend makes before it touches them (#396).
import { SAMPLE_URI } from './seed';
import type { Collection, E2EState, Server } from './state';

export function serverOf(state: E2EState, id: unknown): Server {
  const conn = state.connections[String(id)];
  if (!conn) throw `Connection not found: ${String(id)}`;
  return state.servers[conn.uri];
}

export function databaseOf(state: E2EState, id: unknown, db: unknown): Record<string, Collection> {
  const found = serverOf(state, id).databases[String(db)];
  if (!found) throw `Database not found: ${String(db)}`;
  return found;
}

export function collectionOf(state: E2EState, id: unknown, db: unknown, coll: unknown): Collection {
  const found = databaseOf(state, id, db)[String(coll)];
  if (!found) throw `Collection not found: ${String(db)}.${String(coll)}`;
  return found;
}

/** A collection to write into, created with its database when they don't exist yet, as a write does in MongoDB. */
export function collectionForWrite(state: E2EState, id: unknown, db: unknown, coll: unknown): Collection {
  const databases = serverOf(state, id).databases;
  const collections = (databases[String(db)] ??= {});
  return (collections[String(coll)] ??= { type: 'collection', docs: [], indexes: [] });
}

/**
 * Whether a connection is the built-in sample server (`connection_is_mock` in
 * src-tauri/src/lib.rs). The backend treats it as a demo: its writes are
 * checked and then dropped, and some features refuse it outright.
 */
export function isMock(state: E2EState, id: unknown): boolean {
  const conn = state.connections[String(id)];
  if (!conn) throw `Connection not found: ${String(id)}`;
  return conn.uri === SAMPLE_URI;
}

export const READ_ONLY_ERROR =
  'This connection is read-only (production safeguard). Change the connection mode in its settings to modify data.';
export const CONFIRM_DESTRUCTIVE_ERROR =
  'This operation modifies production data on a safeguarded connection. Confirm by typing the collection name.';

/**
 * The backend's write guard (src-tauri/src/write_guard.rs). A read-only
 * connection refuses every write; a confirm-destructive one refuses a
 * destructive write the app hasn't sent `confirmed: true` for. It runs before
 * the sample server's shortcuts, so it applies there too.
 */
export function guardWritable(
  state: E2EState,
  id: unknown,
  { destructive = false, confirmed }: { destructive?: boolean; confirmed?: unknown } = {},
): void {
  const conn = state.connections[String(id)];
  if (!conn) throw `Connection not found: ${String(id)}`;
  if (conn.mode === 'read_only') throw READ_ONLY_ERROR;
  if (destructive && conn.mode === 'confirm_destructive' && confirmed !== true) throw CONFIRM_DESTRUCTIVE_ERROR;
}

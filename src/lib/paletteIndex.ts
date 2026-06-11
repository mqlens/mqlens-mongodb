import { invoke } from '@tauri-apps/api/core';
import { fuzzyMatch } from './fuzzyMatch';

// Lazily-built namespace index for the command palette: databases and
// collections per active connection, cached per connection id so opening the
// palette repeatedly does not refetch. The cache lives for the app session;
// a reconnect gets a new connection id and therefore a fresh entry.
export interface NamespaceEntry {
  connectionId: string;
  connectionName: string;
  db: string;
  collections: string[];
}

export interface NamespaceScopeTarget {
  connectionName: string;
  db: string;
  collection: string;
}

interface CacheEntry {
  loadedAt: number;
  promise: Promise<NamespaceEntry[]>;
}

export const NAMESPACE_CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

export function clearNamespaceIndex(connectionId?: string) {
  if (connectionId) cache.delete(connectionId);
  else cache.clear();
}

export function matchesNamespaceScope(scope: string, target: NamespaceScopeTarget): boolean {
  const q = scope.trim();
  if (!q) return true;
  return fuzzyMatch(q, `${target.connectionName} ${target.db} ${target.collection}`);
}

async function fetchConnection(id: string, name: string): Promise<NamespaceEntry[]> {
  try {
    const dbs = await invoke<string[]>('list_databases', { id });
    return await Promise.all(
      dbs.map(async (db) => ({
        connectionId: id,
        connectionName: name,
        db,
        collections: (await invoke<{ name: string }[]>('list_collections', { id, db })).map((c) => c.name),
      })),
    );
  } catch {
    return [];
  }
}

export async function loadNamespaceIndex(
  connections: { id: string; name: string }[],
  options: { forceRefresh?: boolean; ttlMs?: number } = {},
): Promise<NamespaceEntry[]> {
  const now = Date.now();
  const ttlMs = options.ttlMs ?? NAMESPACE_CACHE_TTL_MS;
  const perConnection = await Promise.all(
    connections.map((c) => {
      let entry = cache.get(c.id);
      const isExpired = entry ? now - entry.loadedAt > ttlMs : true;
      if (!entry || options.forceRefresh || isExpired) {
        entry = { loadedAt: now, promise: fetchConnection(c.id, c.name) };
        cache.set(c.id, entry);
      }
      return entry.promise;
    }),
  );
  return perConnection.flat();
}

export const __clearNamespaceIndex = clearNamespaceIndex;

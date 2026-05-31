import { invoke } from '@tauri-apps/api/core';
import type { GeneratedQuery } from './mongoCommand';

// The persisted body of a saved/history/default query — the same shape the
// DocumentViewer builder produces and applies.
export type SavedQueryBody = GeneratedQuery;

export interface SavedQuery {
  id: string;
  name: string;
  query: SavedQueryBody;
  createdAt: string;
}

export interface HistoryEntry {
  query: SavedQueryBody;
  ranAt: string;
}

export interface CollectionQueries {
  saved: SavedQuery[];
  history: HistoryEntry[];
  default: SavedQueryBody | null;
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const nowIso = (): string => new Date().toISOString();

export async function loadCollectionQueries(
  connectionName: string,
  db: string,
  collection: string
): Promise<CollectionQueries> {
  return invoke<CollectionQueries>('load_collection_queries', {
    connectionName,
    db,
    collection,
  });
}

export async function saveQuery(
  connectionName: string,
  db: string,
  collection: string,
  name: string,
  query: SavedQueryBody
): Promise<void> {
  await invoke('save_query', {
    connectionName,
    db,
    collection,
    saved: { id: newId(), name, query, createdAt: nowIso() },
  });
}

export async function deleteSavedQuery(
  connectionName: string,
  db: string,
  collection: string,
  id: string
): Promise<void> {
  await invoke('delete_saved_query', { connectionName, db, collection, id });
}

export async function recordHistory(
  connectionName: string,
  db: string,
  collection: string,
  query: SavedQueryBody
): Promise<void> {
  await invoke('record_history', {
    connectionName,
    db,
    collection,
    entry: { query, ranAt: nowIso() },
  });
}

export async function setDefaultQuery(
  connectionName: string,
  db: string,
  collection: string,
  query: SavedQueryBody | null
): Promise<void> {
  await invoke('set_default_query', { connectionName, db, collection, default: query });
}

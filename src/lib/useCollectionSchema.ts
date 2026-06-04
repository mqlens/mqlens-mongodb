import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FieldSchema } from './mongoCompletions';

export type SchemaMap = Map<string, FieldSchema>;

interface RawFieldStat { path: string; types: { type: string; count: number }[]; enumValues?: string[]; }
interface RawReport { sampled: number; fields: RawFieldStat[]; }

const cache = new Map<string, Promise<SchemaMap>>();
const EMPTY: SchemaMap = new Map();

export function __clearSchemaCache() { cache.clear(); }

function buildMap(report: RawReport): SchemaMap {
  const m: SchemaMap = new Map();
  for (const f of report.fields) {
    const type = f.types.slice().sort((a, b) => b.count - a.count)[0]?.type;
    m.set(f.path, { type, enumValues: f.enumValues });
  }
  return m;
}

function fetchSchema(connectionId: string, db: string, coll: string): Promise<SchemaMap> {
  const key = `${connectionId}::${db}::${coll}`;
  let p = cache.get(key);
  if (!p) {
    p = invoke<string>('analyze_schema', { id: connectionId, database: db, collection: coll, sampleSize: 500 })
      .then((json) => buildMap(JSON.parse(json) as RawReport))
      .catch(() => EMPTY);
    cache.set(key, p);
  }
  return p;
}

export function useCollectionSchema(connectionId?: string, db?: string, coll?: string): { schema: SchemaMap; ready: boolean } {
  const [schema, setSchema] = useState<SchemaMap>(EMPTY);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!connectionId || !db || !coll) { setSchema(EMPTY); setReady(false); return; }
    let alive = true;
    setReady(false);
    fetchSchema(connectionId, db, coll).then((m) => { if (alive) { setSchema(m); setReady(true); } });
    return () => { alive = false; };
  }, [connectionId, db, coll]);
  return { schema, ready };
}

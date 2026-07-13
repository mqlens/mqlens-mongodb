import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatBytes } from '@/lib/format';

interface DbStatsUi {
  collections: number;
  views: number;
  objects: number;
  avgObjSize: number;
  dataSize: number;
  storageSize: number;
  indexes: number;
  totalIndexSize: number;
}

interface CollStatsUi {
  count: number;
  avgObjSize: number;
  size: number;
  storageSize: number;
  nindexes: number;
  totalIndexSize: number;
  capped: boolean;
}

interface IndexStatUi {
  name: string;
  sizeBytes: number;
  ops: number;
  sinceMs: number;
}

const CARD_CLASS = 'flex w-max min-w-72 max-w-[28rem] flex-col gap-1.5 text-xs';

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div>
    <span className="text-muted-foreground">{label}:</span> {value}
  </div>
);

const RefreshLink: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    className="mt-0.5 self-start text-primary underline-offset-2 hover:underline"
    onClick={onClick}
    data-testid="stats-refresh"
  >
    Refresh
  </button>
);

interface DbStatsCardProps {
  connectionId: string;
  db: string;
}

/** Compact database-level stats summary (issue #178). Fetches once on mount
 *  — i.e. once per popover open — so there is no background polling cost.
 *  Refresh re-runs the fetch in place via the `nonce` bump below. */
export const DbStatsCard: React.FC<DbStatsCardProps> = ({ connectionId, db }) => {
  const [data, setData] = useState<DbStatsUi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    invoke<DbStatsUi>('db_stats', { id: connectionId, db })
      .then((s) => {
        if (alive) setData(s);
      })
      .catch((e: unknown) => {
        if (alive) setErr(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [connectionId, db, nonce]);

  const refresh = () => {
    setErr(null);
    setData(null);
    setNonce((n) => n + 1);
  };

  return (
    <div className={CARD_CLASS} data-testid="db-stats-card">
      {err && <div className="text-destructive">{err}</div>}
      {!err && !data && <div className="text-muted-foreground">Loading database stats…</div>}
      {!err && data && (
        <>
          <div>
            Database: <span className="font-semibold text-foreground">{db}</span>
          </div>
          <Row label="Collections" value={data.collections.toLocaleString()} />
          <Row label="Views" value={data.views.toLocaleString()} />
          <Row label="Objects" value={data.objects.toLocaleString()} />
          <Row label="Avg. object size" value={formatBytes(data.avgObjSize)} />
          <Row label="Data size" value={formatBytes(data.dataSize)} />
          <Row label="Storage size" value={formatBytes(data.storageSize)} />
          <Row label="Indexes" value={data.indexes.toLocaleString()} />
          <Row label="Total index size" value={formatBytes(data.totalIndexSize)} />
        </>
      )}
      {(data || err) && <RefreshLink onClick={refresh} />}
    </div>
  );
};

interface CollStatsCardProps {
  connectionId: string;
  db: string;
  collection: string;
}

/** Compact collection-level stats summary (issue #178). Same fetch-once +
 *  nonce-refresh pattern as DbStatsCard. */
export const CollStatsCard: React.FC<CollStatsCardProps> = ({ connectionId, db, collection }) => {
  const [data, setData] = useState<CollStatsUi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    invoke<CollStatsUi>('coll_stats', { id: connectionId, db, collection })
      .then((s) => {
        if (alive) setData(s);
      })
      .catch((e: unknown) => {
        if (alive) setErr(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [connectionId, db, collection, nonce]);

  const refresh = () => {
    setErr(null);
    setData(null);
    setNonce((n) => n + 1);
  };

  return (
    <div className={CARD_CLASS} data-testid="coll-stats-card">
      {err && <div className="text-destructive">{err}</div>}
      {!err && !data && <div className="text-muted-foreground">Loading collection stats…</div>}
      {!err && data && (
        <>
          <div>
            Collection:{' '}
            <span className="font-semibold text-foreground">
              {db}.{collection}
            </span>
          </div>
          <Row label="Documents" value={data.count.toLocaleString()} />
          <Row label="Avg. object size" value={formatBytes(data.avgObjSize)} />
          <Row label="Data size" value={formatBytes(data.size)} />
          <Row label="Storage size" value={formatBytes(data.storageSize)} />
          <Row label="Indexes" value={data.nindexes.toLocaleString()} />
          <Row label="Total index size" value={formatBytes(data.totalIndexSize)} />
          {data.capped && <Row label="Capped" value="yes" />}
        </>
      )}
      {(data || err) && <RefreshLink onClick={refresh} />}
    </div>
  );
};

interface IndexStatsCardProps {
  connectionId: string;
  db: string;
  collection: string;
  indexName: string;
}

/** Compact single-index stats summary (issue #178). `index_stats` returns
 *  every index on the collection; this card picks the one matching
 *  `indexName` out of that array. */
export const IndexStatsCard: React.FC<IndexStatsCardProps> = ({ connectionId, db, collection, indexName }) => {
  const [data, setData] = useState<IndexStatUi[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    invoke<IndexStatUi[]>('index_stats', { id: connectionId, db, collection })
      .then((s) => {
        if (alive) setData(s);
      })
      .catch((e: unknown) => {
        if (alive) setErr(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [connectionId, db, collection, nonce]);

  const refresh = () => {
    setErr(null);
    setData(null);
    setNonce((n) => n + 1);
  };

  const entry = data?.find((i) => i.name === indexName) ?? null;

  return (
    <div className={CARD_CLASS} data-testid="index-stats-card">
      {err && <div className="text-destructive">{err}</div>}
      {!err && !data && <div className="text-muted-foreground">Loading index stats…</div>}
      {!err && data && (
        <>
          <div>
            Index:{' '}
            <span className="font-semibold text-foreground">
              {indexName} on {db}.{collection}
            </span>
          </div>
          {!entry && <div className="text-muted-foreground">No stats for this index.</div>}
          {entry && (
            <>
              <Row label="Size" value={formatBytes(entry.sizeBytes)} />
              {entry.sinceMs > 0 ? (
                <>
                  <Row label="Usage" value={`${entry.ops.toLocaleString()} ops`} />
                  <Row label="Since" value={new Date(entry.sinceMs).toLocaleDateString()} />
                </>
              ) : entry.ops === 0 ? (
                <Row label="Usage" value="n/a (no data since restart)" />
              ) : (
                <Row label="Usage" value={`${entry.ops.toLocaleString()} ops`} />
              )}
            </>
          )}
        </>
      )}
      {(data || err) && <RefreshLink onClick={refresh} />}
    </div>
  );
};

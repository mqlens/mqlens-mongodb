import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
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

export interface IndexStatUi {
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

const RefreshLink: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { t } = useTranslation('admin');
  return (
    <button
      type="button"
      className="mt-0.5 self-start text-primary underline-offset-2 hover:underline"
      onClick={onClick}
      data-testid="stats-refresh"
    >
      {t('statsCards.actions.refresh')}
    </button>
  );
};

interface DbStatsCardProps {
  connectionId: string;
  db: string;
}

/** Compact database-level stats summary (issue #178). Fetches once on mount
 *  — i.e. once per popover open — so there is no background polling cost.
 *  Refresh re-runs the fetch in place via the `nonce` bump below. */
export const DbStatsCard: React.FC<DbStatsCardProps> = ({ connectionId, db }) => {
  const { t } = useTranslation('admin');
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
      {!err && !data && <div className="text-muted-foreground">{t('statsCards.dbStats.loading')}</div>}
      {!err && data && (
        <>
          <div>
            {t('statsCards.dbStats.database')} <span className="font-semibold text-foreground">{db}</span>
          </div>
          <Row label={t('statsCards.dbStats.labels.collections')} value={data.collections.toLocaleString()} />
          <Row label={t('statsCards.dbStats.labels.views')} value={data.views.toLocaleString()} />
          <Row label={t('statsCards.dbStats.labels.objects')} value={data.objects.toLocaleString()} />
          <Row label={t('statsCards.dbStats.labels.avgObjectSize')} value={formatBytes(data.avgObjSize)} />
          <Row label={t('statsCards.dbStats.labels.dataSize')} value={formatBytes(data.dataSize)} />
          <Row label={t('statsCards.dbStats.labels.storageSize')} value={formatBytes(data.storageSize)} />
          <Row label={t('statsCards.dbStats.labels.indexes')} value={data.indexes.toLocaleString()} />
          <Row label={t('statsCards.dbStats.labels.totalIndexSize')} value={formatBytes(data.totalIndexSize)} />
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
  const { t } = useTranslation('admin');
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
      {!err && !data && <div className="text-muted-foreground">{t('statsCards.collStats.loading')}</div>}
      {!err && data && (
        <>
          <div>
            {t('statsCards.collStats.collection')}{' '}
            <span className="font-semibold text-foreground">
              {db}.{collection}
            </span>
          </div>
          <Row label={t('statsCards.collStats.labels.documents')} value={data.count.toLocaleString()} />
          <Row label={t('statsCards.collStats.labels.avgObjectSize')} value={formatBytes(data.avgObjSize)} />
          <Row label={t('statsCards.collStats.labels.dataSize')} value={formatBytes(data.size)} />
          <Row label={t('statsCards.collStats.labels.storageSize')} value={formatBytes(data.storageSize)} />
          <Row label={t('statsCards.collStats.labels.indexes')} value={data.nindexes.toLocaleString()} />
          <Row label={t('statsCards.collStats.labels.totalIndexSize')} value={formatBytes(data.totalIndexSize)} />
          {data.capped && <Row label={t('statsCards.collStats.labels.capped')} value={t('statsCards.collStats.yes')} />}
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
  const { t } = useTranslation('admin');
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
      {!err && !data && <div className="text-muted-foreground">{t('statsCards.indexStats.loading')}</div>}
      {!err && data && (
        <>
          <div>
            {t('statsCards.indexStats.index')}{' '}
            <span className="font-semibold text-foreground">
              {t('statsCards.indexStats.indexOnNamespace', { indexName, namespace: `${db}.${collection}` })}
            </span>
          </div>
          {!entry && <div className="text-muted-foreground">{t('statsCards.indexStats.noStatsForIndex')}</div>}
          {entry && (
            <>
              <Row label={t('statsCards.indexStats.labels.size')} value={formatBytes(entry.sizeBytes)} />
              {entry.sinceMs > 0 ? (
                <>
                  <Row label={t('statsCards.indexStats.labels.usage')} value={t('statsCards.indexStats.opsCount', { ops: entry.ops.toLocaleString() })} />
                  <Row label={t('statsCards.indexStats.labels.since')} value={new Date(entry.sinceMs).toLocaleDateString()} />
                </>
              ) : entry.ops === 0 ? (
                <Row label={t('statsCards.indexStats.labels.usage')} value={t('statsCards.indexStats.usageNoData')} />
              ) : (
                <Row label={t('statsCards.indexStats.labels.usage')} value={t('statsCards.indexStats.opsCount', { ops: entry.ops.toLocaleString() })} />
              )}
            </>
          )}
        </>
      )}
      {(data || err) && <RefreshLink onClick={refresh} />}
    </div>
  );
};

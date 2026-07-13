import React, { useEffect, useState } from 'react';
import { replSetStatus, type ReplSetStatus } from '@/lib/monitoringApi';
import { lagText, lagClass, memberDotClass, memberUnhealthy, uriUser, uriReadPreference } from '@/lib/clusterHealth';
import { cn } from '@/lib/utils';

interface ClusterHealthCardProps {
  connectionId: string;
  connectionName?: string;
  connectionUri?: string;
  onOpenMonitoring?: (connectionId: string) => void;
}

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Compact replica-set health summary. Fetches once on mount — i.e. once per
 *  popover open — so there is no background polling cost. Refresh re-runs
 *  the fetch in place via the `nonce` bump below. */
export const ClusterHealthCard: React.FC<ClusterHealthCardProps> = ({
  connectionId,
  connectionName,
  connectionUri,
  onOpenMonitoring,
}) => {
  const [data, setData] = useState<ReplSetStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    replSetStatus(connectionId)
      .then((s) => {
        if (alive) setData(s);
      })
      .catch((e: unknown) => {
        if (alive) setErr(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [connectionId, nonce]);

  const user = connectionUri ? uriUser(connectionUri) : null;
  const readPref = connectionUri ? uriReadPreference(connectionUri) : null;

  return (
    <div className="flex w-max min-w-64 max-w-96 flex-col gap-1.5 text-xs" data-testid="cluster-health-card">
      {err && <div className="text-destructive">{err}</div>}
      {!err && !data && <div className="text-muted-foreground">Loading cluster health…</div>}
      {(data || err) && connectionName && (
        <div data-testid="cluster-card-connection">
          Connection: <span className="font-semibold text-foreground">{connectionName}</span>
          {data?.isReplicaSet && (
            <>
              {' '}
              [replica set: <span className="font-semibold text-foreground">{data.set}</span>]
            </>
          )}
        </div>
      )}
      {(data || err) && user && <div data-testid="cluster-card-user">User: {user}</div>}
      {!err && data && !data.isReplicaSet && data.clusterType === 'sharded' && (
        <div className="text-muted-foreground" data-testid="cluster-card-sharded">
          Sharded cluster (mongos).
        </div>
      )}
      {!err && data && !data.isReplicaSet && data.clusterType !== 'sharded' && (
        <div className="text-muted-foreground" data-testid="cluster-card-standalone">
          Standalone server — no replica set.
        </div>
      )}
      {!err && data && data.isReplicaSet && (
        <>
          <div className="text-muted-foreground">Server(s):</div>
          <div className="flex flex-col gap-1">
            {data.members.map((m) => {
              const unhealthy = memberUnhealthy(m);
              const isPrimary = m.stateStr === 'PRIMARY';
              return (
                <div
                  key={m.name}
                  className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-0.5', unhealthy && 'text-destructive')}
                  data-testid={`cluster-card-member-${m.name}`}
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', memberDotClass(m))} />
                  <span className="whitespace-nowrap font-mono">{m.name}</span>
                  <span className="whitespace-nowrap text-muted-foreground">
                    {unhealthy ? (
                      '— Offline [(not reachable/healthy)]'
                    ) : isPrimary ? (
                      '— Online [PRIMARY]'
                    ) : (
                      <>
                        — Online [{m.stateStr}] · <span className={lagClass(m.lagSecs)}>lag {lagText(m.lagSecs)}</span>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {readPref && (
            <div data-testid="cluster-card-read-pref">Read preference mode: {capitalize(readPref)}</div>
          )}
        </>
      )}
      {!err && data && data.mongoVersion && (
        <div data-testid="cluster-card-version">Server version: {data.mongoVersion}</div>
      )}
      {!err && data && data.isReplicaSet && (
        <div className="mt-0.5 flex items-center gap-2">
          <button
            type="button"
            className="self-start text-primary underline-offset-2 hover:underline"
            onClick={() => {
              setErr(null);
              setData(null);
              setNonce((n) => n + 1);
            }}
            data-testid="cluster-card-refresh"
          >
            Refresh
          </button>
          {onOpenMonitoring && (
            <button
              type="button"
              className="self-start text-primary underline-offset-2 hover:underline"
              onClick={() => onOpenMonitoring(connectionId)}
              data-testid="cluster-card-open-monitoring"
            >
              Open Monitoring →
            </button>
          )}
        </div>
      )}
    </div>
  );
};

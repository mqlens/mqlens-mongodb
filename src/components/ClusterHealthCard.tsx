import React, { useEffect, useState } from 'react';
import { replSetStatus, type ReplSetStatus } from '@/lib/monitoringApi';
import { lagText, lagClass, memberDotClass, memberUnhealthy } from '@/lib/clusterHealth';
import { cn } from '@/lib/utils';

interface ClusterHealthCardProps {
  connectionId: string;
  onOpenMonitoring?: (connectionId: string) => void;
}

/** Compact replica-set health summary. Fetches once on mount — i.e. once per
 *  popover open — so there is no background polling cost. */
export const ClusterHealthCard: React.FC<ClusterHealthCardProps> = ({ connectionId, onOpenMonitoring }) => {
  const [data, setData] = useState<ReplSetStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
  }, [connectionId]);

  return (
    <div className="flex w-64 flex-col gap-1.5 text-xs" data-testid="cluster-health-card">
      {err && <div className="text-red-500">{err}</div>}
      {!err && !data && <div className="text-muted-foreground">Loading cluster health…</div>}
      {!err && data && !data.isReplicaSet && (
        <div className="text-muted-foreground" data-testid="cluster-card-standalone">
          Standalone server — no replica set.
        </div>
      )}
      {!err && data && data.isReplicaSet && (
        <>
          <div className="text-muted-foreground">
            <span className="font-semibold text-foreground">{data.set}</span>
            {data.myStateStr && <> · you: {data.myStateStr}</>}
          </div>
          <div className="flex flex-col gap-1">
            {data.members.map((m) => (
              <div
                key={m.name}
                className={cn('flex items-center gap-1.5', memberUnhealthy(m) && 'text-destructive')}
                data-testid={`cluster-card-member-${m.name}`}
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', memberDotClass(m))} />
                <span className="min-w-0 flex-1 truncate font-mono">{m.name}</span>
                <span
                  className={cn('shrink-0', m.stateStr === 'PRIMARY' ? 'text-muted-foreground' : lagClass(m.lagSecs))}
                >
                  {m.stateStr === 'PRIMARY'
                    ? 'PRIMARY'
                    : memberUnhealthy(m)
                      ? m.stateStr
                      : `lag ${lagText(m.lagSecs)}`}
                </span>
              </div>
            ))}
          </div>
          {onOpenMonitoring && (
            <button
              type="button"
              className="mt-0.5 self-start text-primary underline-offset-2 hover:underline"
              onClick={() => onOpenMonitoring(connectionId)}
              data-testid="cluster-card-open-monitoring"
            >
              Open Monitoring →
            </button>
          )}
        </>
      )}
    </div>
  );
};

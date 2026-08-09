import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Radio, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  CHANGE_OPERATIONS,
  describeEvent,
  mergeEvents,
  pauseChangeStream,
  pollChangeStream,
  resumeChangeStream,
  startChangeStream,
  stopChangeStream,
  type ChangeEvent,
  type ChangeOperation,
  type StreamStatus,
} from '../lib/changeStream';

/** How often to ask the backend for new events. Fast enough to feel live,
 *  slow enough that an idle tail is not a busy loop. */
const POLL_MS = 700;
/** What the VIEW keeps. The backend caps its own buffer; a tab left open for
 *  hours would otherwise grow past both. */
const VIEW_CAP = 1_000;

interface WatchPanelProps {
  connectionId: string;
  databaseName: string;
  /** Omitted to watch the whole database. */
  collectionName?: string;
  /** Identifies this tail to the backend; stable per tab. */
  streamId: string;
}

export const WatchPanel: React.FC<WatchPanelProps> = ({
  connectionId,
  databaseName,
  collectionName,
  streamId,
}) => {
  const { t } = useTranslation('shell');
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('starting');
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [selected, setSelected] = useState<ChangeEvent | null>(null);
  const [operations, setOperations] = useState<ChangeOperation[]>([]);
  // The last sequence handed to the view. A ref because the poll loop reads it
  // on every tick and must not restart when it moves.
  const lastSeqRef = useRef<number | undefined>(undefined);

  // One tail per tab, torn down with it. A cursor is a server-side resource:
  // leaving it open because a component went away is the same mistake the shell
  // sessions had to unlearn, in the other direction — here nothing outlives the
  // tab, so the tab is exactly where it ends.
  useEffect(() => {
    let alive = true;
    void startChangeStream({
      streamId,
      connectionId,
      database: databaseName,
      collection: collectionName,
      operationTypes: operations,
    }).catch(() => undefined);

    const tick = async () => {
      const poll = await pollChangeStream(streamId, lastSeqRef.current);
      if (!alive || !poll) return;
      setStatus(poll.status);
      setError(poll.error);
      setDropped(poll.dropped);
      if (poll.events.length > 0) {
        lastSeqRef.current = poll.lastSeq;
        setEvents((prev) => mergeEvents(prev, poll.events, VIEW_CAP));
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();

    return () => {
      alive = false;
      clearInterval(timer);
      void stopChangeStream(streamId);
    };
    // Restarting on a filter change is deliberate: the `$match` lives in the
    // server-side pipeline, so a new filter is a new cursor.
  }, [streamId, connectionId, databaseName, collectionName, operations]);

  const toggleOperation = (op: ChangeOperation) => {
    setEvents([]);
    lastSeqRef.current = undefined;
    setOperations((prev) => (prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]));
  };

  const paused = status === 'paused';
  const target = collectionName ? `${databaseName}.${collectionName}` : databaseName;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="watch-panel">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Radio
          size={13}
          className={cn(
            status === 'running' ? 'text-primary' : 'text-muted-foreground',
            status === 'running' && 'animate-pulse'
          )}
        />
        <span className="text-xs font-medium">{target}</span>
        <Badge variant="outline" className="text-[10px]" data-testid="watch-status">
          {t(`watch.status.${status}`)}
        </Badge>

        <div className="ml-auto flex items-center gap-1">
          {CHANGE_OPERATIONS.map((op) => (
            <Button
              key={op}
              type="button"
              variant={operations.includes(op) ? 'default' : 'outline'}
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => toggleOperation(op)}
              data-testid={`watch-filter-${op}`}
            >
              {t(`watch.operations.${op}`)}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={paused ? t('watch.actions.resume') : t('watch.actions.pause')}
            onClick={() => void (paused ? resumeChangeStream(streamId) : pauseChangeStream(streamId))}
            data-testid="watch-toggle"
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('watch.actions.clear')}
            onClick={() => {
              setEvents([]);
              setSelected(null);
            }}
            data-testid="watch-clear"
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>

      {status === 'unsupported' && (
        <div
          className="border-b border-border bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground"
          data-testid="watch-unsupported"
        >
          {error ?? t('watch.unsupported')}
        </div>
      )}
      {status === 'error' && error && (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-[11px] text-destructive" data-testid="watch-error">
          {error}
        </div>
      )}
      {dropped > 0 && (
        <div className="border-b border-border px-3 py-1 text-[10px] text-muted-foreground" data-testid="watch-dropped">
          {t('watch.dropped', { count: dropped })}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-1/2 overflow-y-auto border-r border-border" data-testid="watch-events">
          {events.length === 0 ? (
            <div className="p-4 text-[11px] text-muted-foreground" data-testid="watch-empty">
              {status === 'unsupported' ? t('watch.unsupported') : t('watch.waiting')}
            </div>
          ) : (
            events.map((event) => (
              <button
                key={event.seq}
                type="button"
                onClick={() => setSelected(event)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-border/50 px-3 py-1.5 text-left text-[11px] hover:bg-accent',
                  selected?.seq === event.seq && 'bg-accent'
                )}
                data-testid="watch-event"
              >
                <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
                  {event.operationType}
                </Badge>
                <span className="truncate font-mono">{describeEvent(event)}</span>
              </button>
            ))
          )}
        </div>
        <div className="w-1/2 overflow-auto p-3" data-testid="watch-detail">
          {selected ? (
            <pre className="m-0 whitespace-pre-wrap font-mono text-[10.5px] text-foreground">
              {JSON.stringify(
                selected.fullDocument ?? selected.updatedFields ?? selected.documentKey ?? selected,
                null,
                2
              )}
            </pre>
          ) : (
            <div className="text-[11px] text-muted-foreground">{t('watch.selectPrompt')}</div>
          )}
        </div>
      </div>
    </div>
  );
};

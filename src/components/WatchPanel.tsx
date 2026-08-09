import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Radio, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DataGrid } from './DataGrid';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  CHANGE_OPERATIONS,
  collectionsSeen,
  eventDocumentId,
  filterByNamespace,
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

/**
 * One colour per operation, so a scrolling tail is readable at a glance —
 * inserts and deletes are the two a reader is usually hunting for, so they get
 * the strongest signals (green and red) and the edits sit between them.
 */
const OPERATION_STYLES: Record<string, { badge: string; rail: string }> = {
  insert: { badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', rail: 'bg-emerald-500' },
  update: { badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400', rail: 'bg-amber-500' },
  replace: { badge: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400', rail: 'bg-sky-500' },
  delete: { badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400', rail: 'bg-rose-500' },
  drop: { badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400', rail: 'bg-rose-500' },
  rename: { badge: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400', rail: 'bg-violet-500' },
  invalidate: { badge: 'border-muted-foreground/40 bg-muted text-muted-foreground', rail: 'bg-muted-foreground' },
};

const styleFor = (op: string) =>
  OPERATION_STYLES[op] ?? {
    badge: 'border-muted-foreground/40 bg-muted text-muted-foreground',
    rail: 'bg-muted-foreground',
  };

interface WatchPanelProps {
  connectionId: string;
  /** Omitted to watch the whole deployment. */
  databaseName?: string;
  /** Omitted to watch the whole database. */
  collectionName?: string;
  /** Identifies this tail to the backend; stable per tab. */
  streamId: string;
  density?: 'roomy' | 'cozy' | 'compact';
}

export const WatchPanel: React.FC<WatchPanelProps> = ({
  connectionId,
  databaseName,
  collectionName,
  streamId,
  density,
}) => {
  const { t } = useTranslation('shell');
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('starting');
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [selected, setSelected] = useState<ChangeEvent | null>(null);
  const [operations, setOperations] = useState<ChangeOperation[]>([]);
  // Which namespace to show. Client-side: it narrows what is already buffered,
  // so it costs nothing and — unlike the operation filter, which lives in the
  // server-side pipeline — does not restart the cursor.
  const [namespace, setNamespace] = useState<string | null>(null);
  // The last sequence handed to the view. A ref because the poll loop reads it
  // on every tick and must not restart when it moves.
  const lastSeqRef = useRef<number | undefined>(undefined);

  // One tail per tab, torn down with it. A cursor is a server-side resource and
  // nothing here outlives the tab, so the tab is exactly where it ends.
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
    setSelected(null);
    lastSeqRef.current = undefined;
    setOperations((prev) => (prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]));
  };

  const paused = status === 'paused';
  const target = collectionName
    ? `${databaseName}.${collectionName}`
    : (databaseName ?? t('watch.deployment'));

  /** The body worth showing: the document for an insert/replace, what changed
   *  for an update, and the key for a delete — falling back to the raw event so
   *  nothing is ever a blank pane. */
  const namespaces = useMemo(() => collectionsSeen(events), [events]);
  const shown = useMemo(() => filterByNamespace(events, namespace), [events, namespace]);

  const detailDocument = useMemo(() => {
    if (!selected) return null;
    const body =
      selected.fullDocument ??
      selected.updatedFields ??
      selected.documentKey ??
      (selected as unknown);
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : { value: body };
  }, [selected]);

  return (
    <div className="flex h-full flex-col bg-background" data-testid="watch-panel">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Radio
          size={13}
          className={cn(
            status === 'running' ? 'text-primary' : 'text-muted-foreground',
            status === 'running' && 'animate-pulse'
          )}
        />
        <span className="truncate text-xs font-medium">{target}</span>
        <Badge variant="outline" className="shrink-0 text-[10px]" data-testid="watch-status">
          {t(`watch.status.${status}`)}
        </Badge>
        <span className="ml-1 text-[10px] text-muted-foreground" data-testid="watch-count">
          {t('watch.eventCount', { count: events.length })}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
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

      {/* Its own row rather than crowded into the toolbar: the filter is the
          control a reader reaches for most, and it has to be legible at any
          pane width. */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('watch.filterLabel')}
        </span>
        <Button
          type="button"
          variant={operations.length === 0 ? 'default' : 'outline'}
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => {
            setEvents([]);
            setSelected(null);
            lastSeqRef.current = undefined;
            setOperations([]);
          }}
          data-testid="watch-filter-all"
        >
          {t('watch.filterAll')}
        </Button>
        {CHANGE_OPERATIONS.map((op) => {
          const active = operations.includes(op);
          return (
            <Button
              key={op}
              type="button"
              variant="outline"
              size="sm"
              className={cn('h-6 gap-1.5 px-2 text-[10px]', active && styleFor(op).badge)}
              onClick={() => toggleOperation(op)}
              data-testid={`watch-filter-${op}`}
              aria-pressed={active}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', styleFor(op).rail)} />
              {t(`watch.operations.${op}`)}
            </Button>
          );
        })}

        {/* Namespace narrowing, offered only once more than one has appeared —
            on a single-collection tail there is nothing to choose between.
            Built from what has arrived, because a deployment-wide tail cannot
            know in advance which collections will show up. */}
        {namespaces.length > 1 && (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <select
              className="h-6 rounded border border-input bg-background px-1.5 text-[10px]"
              value={namespace ?? ''}
              onChange={(e) => {
                setNamespace(e.target.value || null);
                setSelected(null);
              }}
              data-testid="watch-filter-namespace"
              aria-label={t('watch.filterCollection')}
            >
              <option value="">{t('watch.allCollections')}</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </>
        )}
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
        <div
          className="border-b border-border bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
          data-testid="watch-error"
        >
          {error}
        </div>
      )}
      {dropped > 0 && (
        <div
          className="border-b border-border px-3 py-1 text-[10px] text-muted-foreground"
          data-testid="watch-dropped"
        >
          {t('watch.dropped', { count: dropped })}
        </div>
      )}

      {/* Draggable split — the namespaces in a real deployment are long, and a
          fixed 40% left the identifier truncated with no way to widen it. The
          group id keeps the drag across tab switches, like the query builder's. */}
      <ResizablePanelGroup
        id="watch-workspace"
        orientation="horizontal"
        className="flex min-h-0 flex-1"
      >
        <ResizablePanel id="watch-events" defaultSize="45%" minSize="20%" className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="watch-events">
            {shown.length === 0 ? (
              <div className="p-4 text-[11px] text-muted-foreground" data-testid="watch-empty">
                {status === 'unsupported'
                  ? t('watch.unsupported')
                  : namespace
                    ? t('watch.noneInCollection')
                    : t('watch.waiting')}
              </div>
            ) : (
              shown.map((event) => {
                const style = styleFor(event.operationType);
                const id = eventDocumentId(event);
                return (
                  <button
                    key={event.seq}
                    type="button"
                    onClick={() => setSelected(event)}
                    className={cn(
                      'flex w-full items-stretch gap-0 border-b border-border/50 text-left hover:bg-accent',
                      selected?.seq === event.seq && 'bg-accent'
                    )}
                    data-testid="watch-event"
                  >
                    <span className={cn('w-0.5 shrink-0', style.rail)} aria-hidden />
                    {/* Columns rather than one run-on string: the operation, the
                        collection and the id are three different questions, and
                        a deployment-wide tail repeats the database on every row
                        where only the collection differs. */}
                    <span className="flex min-w-0 flex-1 items-baseline gap-2 px-2.5 py-1.5 text-[11px]">
                      <Badge
                        variant="outline"
                        className={cn('shrink-0 text-[9px] uppercase', style.badge)}
                      >
                        {t(`watch.operations.${event.operationType}`, {
                          defaultValue: event.operationType,
                        })}
                      </Badge>
                      <span className="min-w-0 shrink truncate font-mono font-medium" title={event.collection}>
                        {event.collection ?? event.database}
                      </span>
                      {id && (
                        <span
                          className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground"
                          title={id}
                        >
                          {id.length > 12 ? `…${id.slice(-10)}` : id}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {/* The database is constant for every row unless this is a
              deployment tail, so it belongs here once rather than repeated. */}
          {!collectionName && (
            <div className="flex-shrink-0 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
              {namespace ?? (databaseName ? databaseName : t('watch.allNamespaces'))}
            </div>
          )}
        </ResizablePanel>
        <ResizableHandle withHandle data-testid="watch-resizer" />
        <ResizablePanel id="watch-detail" minSize="25%" className="flex min-h-0 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="watch-detail">
            {detailDocument ? (
              // Chromeless: a change event has no explain plan, no chart worth
              // drawing and nothing to page through, so offering those tabs
              // reads as broken rather than empty.
              <DataGrid documents={[detailDocument]} density={density} chromeless />
            ) : (
              <div className="p-4 text-[11px] text-muted-foreground">{t('watch.selectPrompt')}</div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};

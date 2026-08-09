import React, { useEffect, useMemo, useRef, useState } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { useTranslation } from 'react-i18next';
import { Database, Layers, Pause, Play, Radio, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DataGrid } from './DataGrid';
import { Combobox } from '@/components/ui/combobox';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  CHANGE_OPERATIONS,
  changedFieldCount,
  describeEvent,
  collectionsSeen,
  eventDocumentId,
  eventTime,
  filterByNamespace,
  mergeEvents,
  pauseChangeStream,
  pollChangeStream,
  resumeChangeStream,
  startChangeStream,
  describeChangeStream,
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

/** Height of one row, in px. Fixed so the list can be virtualized — with a
 *  thousand events on screen, rendering them all is what made this feel slow. */
const ROW_HEIGHT = 26;

interface EventRowExtra {
  events: ChangeEvent[];
  selectedSeq: number | null;
  onSelect: (event: ChangeEvent) => void;
  perRowDatabase: boolean;
  gridCols: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * One event row, hoisted out so the virtualized list can own it.
 *
 * Not memoised, and it does not need to be: virtualization already keeps the
 * rendered set to what fits on screen, which is the cost that mattered.
 */
const EventRow = ({
  index,
  style,
  events,
  selectedSeq,
  onSelect,
  perRowDatabase,
  gridCols,
  t,
}: RowComponentProps<EventRowExtra>) => {
  const event = events[index];
  if (!event) return null;
  const opStyle = styleFor(event.operationType);
  const id = eventDocumentId(event);
  const changed = changedFieldCount(event);
  return (
      <button
        type="button"
        style={style}
        onClick={() => onSelect(event)}
        className={cn(
          'grid w-full items-center gap-2 border-b border-border/40 pr-2.5 text-left text-[11px] hover:bg-accent',
          gridCols,
          selectedSeq === event.seq && 'bg-accent'
        )}
        data-testid="watch-event"
      >
        <span className={cn('h-full w-0.5 justify-self-start', opStyle.rail)} aria-hidden />
        <Badge
          variant="outline"
          className={cn('justify-center px-0 text-[9px] uppercase', opStyle.badge)}
        >
          {t(`watch.operations.${event.operationType}`, { defaultValue: event.operationType })}
        </Badge>
        {perRowDatabase && (
          <span className="flex min-w-0 items-center gap-1.5">
            <Database size={10} className="shrink-0 text-amber-500" />
            <span className="truncate font-mono text-muted-foreground" title={event.database}>
              {event.database}
            </span>
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5">
          <Layers size={10} className="shrink-0 text-emerald-500" />
          <span className="truncate font-mono font-medium" title={event.collection}>
            {event.collection ?? event.database}
          </span>
          {changed !== undefined && (
            <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">
              {/* Namespace spelled out: this row is hoisted out of the panel so
                  the virtualized list can own it, and takes `t` as a prop —
                  which leaves the extractor no way to infer where the key
                  lives, so it files it under `common`. */}
              {t('shell:watch.fieldsChanged', { count: changed })}
            </span>
          )}
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground" title={id}>
          {id ?? '—'}
        </span>
        <span className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">
          {eventTime(event)}
        </span>
      </button>
  );
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
  // Read inside the start effect, which must not re-run when it changes.
  const pausedRef = useRef(false);
  // Whether the filter above has been reconciled with the running stream.
  //
  // `operations` is component state and this component is unmounted whenever
  // its tab is inactive, so a filtered watch comes back with an empty filter.
  // Starting on that would send different operation types, which the backend
  // reads as a different stream — buffer discarded, cursor restarted
  // unfiltered, and the user's filter silently cleared. So: ask what is
  // running, adopt it, and only then start.
  const [adopted, setAdopted] = useState(false);

  useEffect(() => {
    let alive = true;
    void describeChangeStream(streamId).then((info) => {
      if (!alive) return;
      if (info) setOperations(info.operationTypes as ChangeOperation[]);
      setAdopted(true);
    });
    return () => {
      alive = false;
    };
  }, [streamId]);

  // Started once per tab and NOT stopped on unmount. `PaneView` renders only
  // the active tab, so an inactive watch tab is unmounted while still open —
  // tearing the cursor down here would drop its resume token and silently miss
  // every change until the user came back. The tab's close path stops it, the
  // same way a shell session is ended.
  useEffect(() => {
    // Nothing may start before the filter has been reconciled above, or the
    // first start would be the unfiltered one this is here to avoid.
    if (!adopted) return;
    let alive = true;
    // One poll at a time. The interval fires every 700ms regardless of how
    // long a poll takes, and two in flight share an `afterSeq`, so both return
    // the same events — duplicated rows and duplicated React keys.
    let polling = false;

    const started = startChangeStream({
      streamId,
      connectionId,
      database: databaseName,
      collection: collectionName,
      operationTypes: operations,
    })
      .then(() => {
        // A filter change is a new cursor, since the `$match` lives in the
        // server-side pipeline — but it must not quietly resume a stream the
        // user paused. Re-pause immediately if that is where they left it.
        if (alive && pausedRef.current) void pauseChangeStream(streamId);
      })
      .catch(() => undefined);

    const tick = async () => {
      if (polling) return;
      polling = true;
      try {
        // After the start, always. On a filter change the previous stream is
        // still installed under this id until the replacement takes its place,
        // so a poll that overtook the start would read the OLD buffer and push
        // `lastSeqRef` up to its sequence — while the replacement starts
        // counting from zero again. Every event it then produced would look
        // already-seen, and the tail would sit there looking idle.
        await started;
        if (!alive) return;
        const poll = await pollChangeStream(streamId, lastSeqRef.current);
        if (!alive || !poll) return;
        // Only when they actually move. These fire every 700ms, and setting an
        // unchanged value still costs a render pass — on an idle tail that was
        // a re-render a second for nothing.
        setStatus((prev) => (prev === poll.status ? prev : poll.status));
        setError((prev) => (prev === poll.error ? prev : poll.error));
        setDropped((prev) => (prev === poll.dropped ? prev : poll.dropped));
        if (poll.events.length > 0) {
          lastSeqRef.current = poll.lastSeq;
          setEvents((prev) => mergeEvents(prev, poll.events, VIEW_CAP));
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [streamId, connectionId, databaseName, collectionName, operations, adopted]);

  const applyOperations = (next: ChangeOperation[]) => {
    setEvents([]);
    setSelected(null);
    // The namespace filter hides itself once fewer than two namespaces have
    // been seen, so a stale selection could survive with no visible control to
    // clear it — leaving an empty list and no way out.
    setNamespace(null);
    lastSeqRef.current = undefined;
    setOperations(next);
  };

  const toggleOperation = (op: ChangeOperation) => {
    applyOperations(
      operations.includes(op) ? operations.filter((o) => o !== op) : [...operations, op]
    );
  };

  const paused = status === 'paused';
  pausedRef.current = paused;
  // On a deployment tail the database differs from row to row, so it belongs
  // ON the row. Below that it is the same for every event and repeating it
  // would be noise, so it sits once at the foot of the list instead.
  const perRowDatabase = !databaseName;
  // One template for the header and every row, which is what makes them line
  // up. The rail is a hairline; the identifier and time are fixed so they do
  // not shuffle as values change width.
  // The document column is fixed, not proportional: a UUID is 36 characters
  // and an ObjectId 24, so a share of the width cuts them mid-value — which
  // reads as broken rather than abbreviated. 224px fits a full UUID at this
  // size; the namespace columns take whatever is left, since a collection name
  // truncates gracefully where an identifier does not.
  const gridCols = perRowDatabase
    ? 'grid-cols-[2px_66px_minmax(0,0.9fr)_minmax(0,1.3fr)_224px_56px]'
    : 'grid-cols-[2px_66px_minmax(0,1fr)_224px_56px]';
  const target = collectionName
    ? `${databaseName}.${collectionName}`
    : (databaseName ?? t('watch.deployment'));

  /** The body worth showing: the document for an insert/replace, what changed
   *  for an update, and the key for a delete — falling back to the raw event so
   *  nothing is ever a blank pane. */
  // Accumulated rather than recomputed: `collectionsSeen` walks every buffered
  // event, and doing that on each 700ms poll is work proportional to the whole
  // buffer for a dropdown that gains an entry perhaps once a minute.
  const [namespaces, setNamespaces] = useState<string[]>([]);
  useEffect(() => {
    setNamespaces((prev) => {
      const seen = collectionsSeen(events);
      // The selection stays offered even once its own events have aged out of
      // the view: otherwise the combobox hides itself below two entries while
      // the filter is still applied, leaving an empty list and no way back.
      const next =
        namespace && !seen.includes(namespace) ? [...seen, namespace].sort() : seen;
      // Same list, same reference — otherwise the Combobox re-renders on every
      // poll for nothing.
      return next.length === prev.length && next.every((n, i) => n === prev[i]) ? prev : next;
    });
  }, [events, namespace]);
  const shown = useMemo(() => filterByNamespace(events, namespace), [events, namespace]);

  const detailDocument = useMemo(() => {
    if (!selected) return null;
    // An update that only `$unset`s carries `updatedFields: {}` — present, so
    // a nullish chain picks it and hides the removals entirely. Both halves of
    // an update description belong together.
    const updated = selected.updatedFields as Record<string, unknown> | undefined;
    const removed = selected.removedFields;
    const isUpdate = updated !== undefined || (removed?.length ?? 0) > 0;
    const body = selected.fullDocument
      ? selected.fullDocument
      : isUpdate
        ? { ...(updated ?? {}), ...(removed?.length ? { $removed: removed } : {}) }
        : selected.renamedTo
          ? { renamedTo: selected.renamedTo, ...(selected.documentKey as object) }
          : (selected.documentKey ?? (selected as unknown));
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
        {(namespaces.length > 1 || namespace) && (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <Combobox
              options={namespaces.map((ns) => {
                const dot = ns.indexOf('.');
                return {
                  value: ns,
                  label: ns.slice(dot + 1),
                  hint: ns.slice(0, dot),
                  // The sidebar's own icons, so the list reads as the same
                  // collections rather than as anonymous menu entries.
                  icon: <Layers size={11} className="shrink-0 text-emerald-500" />,
                  hintIcon: <Database size={9} className="shrink-0 text-amber-500" />,
                };
              })}
              value={namespace}
              onChange={(next) => {
                setNamespace(next);
                setSelected(null);
              }}
              placeholder={t('watch.allCollections')}
              searchPlaceholder={t('watch.searchCollections')}
              emptyMessage={t('watch.noCollectionMatch')}
              emptyOptionLabel={t('watch.allCollections')}
              emptyOptionIcon={<Database size={11} className="shrink-0 text-amber-500" />}
              triggerClassName="min-w-[140px] max-w-[220px]"
              data-testid="watch-filter-namespace"
              aria-label={t('watch.filterCollection')}
            />
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
        <ResizablePanel
          id="watch-events"
          defaultSize={selected ? '45%' : '100%'}
          minSize="20%"
          className="flex min-h-0 flex-col"
        >
          {/* A real grid, not flex with an auto margin. Every row shares one
              column template, so the values line up in columns instead of
              drifting apart and leaving a gulf down the middle. */}
          <div className={cn('grid flex-shrink-0 items-center gap-2 border-b border-border bg-muted/30 py-1 pr-2.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground', gridCols)}>
            <span aria-hidden />
            <span>{t('watch.columns.operation')}</span>
            {perRowDatabase && <span>{t('watch.columns.database')}</span>}
            <span>{t('watch.columns.collection')}</span>
            <span>{t('watch.columns.document')}</span>
            <span className="text-right">{t('watch.columns.time')}</span>
          </div>
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
              // Virtualized: a thousand rows in the DOM, re-rendered on every
              // 700ms poll, is what made this feel slow. Only what fits on
              // screen is built now.
              <List<EventRowExtra>
                rowCount={shown.length}
                rowHeight={ROW_HEIGHT}
                rowComponent={EventRow}
                rowProps={{
                  events: shown,
                  selectedSeq: selected?.seq ?? null,
                  onSelect: setSelected,
                  perRowDatabase,
                  gridCols,
                  t,
                }}
              />
            )}
          </div>
          {databaseName && !collectionName && (
            <div className="flex flex-shrink-0 items-center gap-1.5 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
              <Database size={9} className="shrink-0 text-amber-500" />
              {namespace ?? databaseName}
            </div>
          )}
        </ResizablePanel>
        {/* Only once an event is chosen. An always-present pane spends half the
            width on a "select an event" placeholder, and the list is the thing
            being read — a tail is scanned far more often than it is inspected. */}
        {selected && (
          <>
            <ResizableHandle withHandle data-testid="watch-resizer" />
            <ResizablePanel id="watch-detail" minSize="25%" className="flex min-h-0 flex-col">
              <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <Badge
                  variant="outline"
                  className={cn('shrink-0 text-[9px] uppercase', styleFor(selected.operationType).badge)}
                >
                  {t(`watch.operations.${selected.operationType}`, {
                    defaultValue: selected.operationType,
                  })}
                </Badge>
                <span className="truncate font-mono text-[11px]" title={describeEvent(selected)}>
                  {describeEvent(selected)}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {eventTime(selected)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0"
                  onClick={() => setSelected(null)}
                  title={t('watch.actions.closeDetail')}
                  data-testid="watch-detail-close"
                >
                  <X size={11} />
                </Button>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="watch-detail">
                {/* Chromeless: a change event has no explain plan, no chart
                    worth drawing and nothing to page through. */}
                <DataGrid documents={[detailDocument!]} density={density} chromeless />
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
};

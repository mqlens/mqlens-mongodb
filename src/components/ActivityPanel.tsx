import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface AuditEvent {
  id: string;
  ts: number;
  connectionId?: string | null;
  profileName?: string | null;
  database?: string | null;
  collection?: string | null;
  op: string;
  source: string;
  ok: boolean;
  error?: string | null;
  durationMs?: number | null;
  summary: string;
  argsJson?: string | null;
  levelAtRecord: string;
  schemaVersion: number;
}

export interface AuditFilter {
  connectionId?: string;
  database?: string;
  collection?: string;
  op?: string;
  source?: string;
  ok?: boolean;
  tsFrom?: number;
  tsTo?: number;
  summaryContains?: string;
  limit?: number;
  offset?: number;
}

/// Whether auditing is actually recording, and why not when it isn't.
export interface AuditStatus {
  active: boolean;
  degradedReason?: string | null;
  /** Set when the on-disk log failed verification: recording has stopped. */
  integrityError?: string | null;
  droppedCount: number;
}

type StatusFilter = 'all' | 'ok' | 'error';

function isVaultLockedError(err: unknown): boolean {
  return String(err).toLowerCase().includes('vault is locked');
}

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function namespaceOf(ev: AuditEvent): string {
  if (ev.database && ev.collection) return `${ev.database}.${ev.collection}`;
  if (ev.database) return ev.database;
  return '—';
}

export const ActivityPanel: React.FC = () => {
  const { t } = useTranslation('shell');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [integrityError, setIntegrityError] = useState<string | null>(null);
  const [summaryContains, setSummaryContains] = useState('');
  const [opFilter, setOpFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const buildFilter = useCallback((): AuditFilter => {
    const filter: AuditFilter = { limit: 200, offset: 0 };
    const summary = summaryContains.trim();
    if (summary) filter.summaryContains = summary;
    const op = opFilter.trim();
    if (op) filter.op = op;
    if (statusFilter === 'ok') filter.ok = true;
    if (statusFilter === 'error') filter.ok = false;
    return filter;
  }, [summaryContains, opFilter, statusFilter]);

  const buildExportFilter = useCallback((): AuditFilter => {
    const { limit: _limit, offset: _offset, ...rest } = buildFilter();
    return rest;
  }, [buildFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Status first, and never let it throw: a failed audit session reports the
    // same "vault is locked" error as an actually-locked vault, and the two must
    // not look the same to the user.
    const status = await invoke<AuditStatus>('audit_status').catch(
      (): AuditStatus => ({ active: true, degradedReason: null, droppedCount: 0 }),
    );
    setDropped(status.droppedCount);
    setIntegrityError(status.integrityError ?? null);
    const degraded = status.active ? null : (status.degradedReason ?? '');
    try {
      const list = await invoke<AuditEvent[]>('audit_list', { filter: buildFilter() });
      setEvents(list);
      setDegradedReason(degraded);
      setLocked(false);
    } catch (err) {
      if (isVaultLockedError(err)) {
        setEvents([]);
        // Unlocked but unable to audit is a degraded state, not a locked vault.
        setDegradedReason(degraded);
        setLocked(degraded === null);
      } else {
        setError(String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [buildFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const onExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await save({
        defaultPath: 'mqlens-audit.jsonl',
        filters: [{ name: t('activity.exportFileType'), extensions: ['jsonl'] }],
      });
      if (!path) return;
      if (!window.confirm(t('activity.exportPlaintextWarning'))) return;
      const n = await invoke<number>('audit_export', { filter: buildExportFilter(), path });
      setError(null);
      window.alert(t('activity.exportDone', { count: n }));
    } catch (err) {
      if (isVaultLockedError(err)) setLocked(true);
      else setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // Only offered for a log that failed verification. There is deliberately no
  // way to erase an intact log: retention removes old events on its own, and a
  // one-click wipe would defeat the integrity checks it sits behind.
  const onDiscardDamaged = async () => {
    if (!window.confirm(t('activity.discardConfirm'))) return;
    setBusy(true);
    try {
      const removed = await invoke<number>('audit_discard_damaged_log');
      await load();
      window.alert(t('activity.discardDone', { count: removed }));
    } catch (err) {
      if (isVaultLockedError(err)) setLocked(true);
      else setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (locked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8" data-testid="activity-locked">
        <p className="text-sm font-medium text-foreground">{t('activity.lockedTitle')}</p>
        <p className="max-w-md text-center text-xs text-muted-foreground">{t('activity.lockedBody')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="activity-panel">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t('activity.header.title')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('activity.header.subtitle')}</p>
            {/* Says why there is no "clear" button on an intact log. */}
            <p className="mt-0.5 text-xs text-muted-foreground">{t('activity.retentionNote')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading || busy}
              data-testid="activity-refresh-btn"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              {t('activity.actions.refresh')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onExport()}
              disabled={busy || loading}
              data-testid="activity-export-btn"
            >
              <Download className="h-3.5 w-3.5" />
              {t('activity.actions.export')}
            </Button>
            {integrityError !== null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void onDiscardDamaged()}
                disabled={busy || loading}
                data-testid="activity-discard-btn"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('activity.actions.discardDamaged')}
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="activity-filter-summary">{t('activity.filters.summary')}</Label>
            <Input
              id="activity-filter-summary"
              data-testid="activity-filter-summary"
              value={summaryContains}
              onChange={(e) => setSummaryContains(e.target.value)}
              placeholder={t('activity.filters.summaryPlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="activity-filter-op">{t('activity.filters.op')}</Label>
            <Input
              id="activity-filter-op"
              data-testid="activity-filter-op"
              value={opFilter}
              onChange={(e) => setOpFilter(e.target.value)}
              placeholder={t('activity.filters.opPlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('activity.filters.status')}</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as StatusFilter)}
            >
              <SelectTrigger data-testid="activity-filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('activity.filters.statusAll')}</SelectItem>
                <SelectItem value="ok">{t('activity.filters.statusOk')}</SelectItem>
                <SelectItem value="error">{t('activity.filters.statusError')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      {integrityError !== null && (
        <div
          className="shrink-0 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive"
          data-testid="activity-integrity-banner"
        >
          {t('activity.integrityBanner', { reason: integrityError })}
        </div>
      )}

      {degradedReason !== null && integrityError === null && (
        <div
          className="shrink-0 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive"
          data-testid="activity-degraded-banner"
        >
          {t('activity.degradedBanner', {
            reason: degradedReason || t('activity.degradedUnknownReason'),
          })}
        </div>
      )}

      {dropped > 0 && (
        <div
          className="shrink-0 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning"
          data-testid="activity-dropped-banner"
        >
          {t('activity.droppedBanner', { count: dropped })}
        </div>
      )}

      {error && (
        <div className="shrink-0 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && events.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">{t('activity.loading')}</p>
        ) : events.length === 0 ? (
          <div className="space-y-1 p-4 text-xs text-muted-foreground" data-testid="activity-empty">
            <p>{t('activity.empty')}</p>
            <p>{t('activity.emptyLevelHint')}</p>
          </div>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr className="border-b border-border text-muted-foreground">
                <th className="w-6 px-2 py-2" />
                <th className="px-2 py-2 font-medium">{t('activity.columns.time')}</th>
                <th className="px-2 py-2 font-medium">{t('activity.columns.op')}</th>
                <th className="px-2 py-2 font-medium">{t('activity.columns.connection')}</th>
                <th className="px-2 py-2 font-medium">{t('activity.columns.namespace')}</th>
                <th className="px-2 py-2 font-medium">{t('activity.columns.source')}</th>
                <th className="px-2 py-2 font-medium">{t('activity.columns.status')}</th>
                <th className="px-2 py-2 font-medium">{t('activity.columns.summary')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const open = expandedId === ev.id;
                return (
                  <React.Fragment key={ev.id}>
                    <tr
                      className="cursor-pointer border-b border-border/60 hover:bg-muted/40"
                      data-testid={`activity-row-${ev.id}`}
                      onClick={() => setExpandedId(open ? null : ev.id)}
                    >
                      <td className="px-2 py-2 text-muted-foreground">
                        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono">{formatTs(ev.ts)}</td>
                      <td className="px-2 py-2 font-mono">{ev.op}</td>
                      <td className="px-2 py-2">{ev.profileName || ev.connectionId || '—'}</td>
                      <td className="max-w-[320px] truncate px-2 py-2 font-mono" title={namespaceOf(ev)}>
                        {namespaceOf(ev)}
                      </td>
                      <td className="px-2 py-2">{ev.source}</td>
                      <td className="px-2 py-2">
                        <span className={ev.ok ? 'text-success' : 'text-destructive'}>
                          {ev.ok ? t('activity.statusOk') : t('activity.statusError')}
                        </span>
                      </td>
                      <td className="max-w-0 truncate px-2 py-2" title={ev.summary}>
                        {ev.summary}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-border bg-muted/20" data-testid={`activity-detail-${ev.id}`}>
                        <td colSpan={8} className="px-4 py-3">
                          <dl className="grid gap-2 sm:grid-cols-2">
                            {/* The row truncates these to stay scannable, so the
                                expanded view has to show them in full. */}
                            <div className="sm:col-span-2">
                              <dt className="text-muted-foreground">{t('activity.columns.summary')}</dt>
                              <dd className="break-words font-mono">{ev.summary}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">{t('activity.columns.namespace')}</dt>
                              <dd className="break-words font-mono">{namespaceOf(ev)}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">{t('activity.columns.connection')}</dt>
                              <dd className="break-words font-mono">
                                {ev.profileName || ev.connectionId || '—'}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">{t('activity.detail.level')}</dt>
                              <dd className="font-mono">{ev.levelAtRecord}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">{t('activity.detail.duration')}</dt>
                              <dd className="font-mono">
                                {ev.durationMs != null ? `${ev.durationMs} ms` : '—'}
                              </dd>
                            </div>
                            {ev.error && (
                              <div className="sm:col-span-2">
                                <dt className="text-muted-foreground">{t('activity.detail.error')}</dt>
                                <dd className="whitespace-pre-wrap font-mono text-destructive">{ev.error}</dd>
                              </div>
                            )}
                            {ev.argsJson && (
                              <div className="sm:col-span-2">
                                <dt className="text-muted-foreground">{t('activity.detail.args')}</dt>
                                <dd>
                                  <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-background p-2 font-mono text-[11px]">
                                    {ev.argsJson}
                                  </pre>
                                </dd>
                              </div>
                            )}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

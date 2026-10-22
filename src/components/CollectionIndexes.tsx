import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDown, ArrowUp, Edit, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatBytes } from '@/lib/format';
import type { IndexInfo } from './Sidebar';
import type { IndexStatUi } from './StatsCards';

interface CollectionIndexesProps {
  connectionId: string;
  databaseName: string;
  collectionName: string;
  /** Bumped after an index is created, edited or dropped. */
  refreshKey?: number;
  onOpenIndex: (indexName: string) => void;
  onCreateIndex?: () => void;
  onEditIndex?: (indexName: string, keys: Record<string, number>, unique: boolean, sparse: boolean) => void;
  onDeleteIndex?: (indexName: string) => void;
}

type SortKey = 'name' | 'size' | 'usage';
type KeyPattern = Record<string, number | string>;

const parseKeys = (keys: string): KeyPattern => {
  try {
    const parsed = JSON.parse(keys);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

type IndexKind = 'regular' | 'compound' | 'text' | '2dsphere' | '2d' | 'hashed' | 'wildcard';

const indexKind = (keys: KeyPattern): IndexKind => {
  const fields = Object.keys(keys);
  const values = Object.values(keys);
  if (values.includes('text')) return 'text';
  if (values.includes('2dsphere')) return '2dsphere';
  if (values.includes('2d')) return '2d';
  if (values.includes('hashed')) return 'hashed';
  if (fields.some((f) => f === '$**' || f.endsWith('.$**'))) return 'wildcard';
  return fields.length > 1 ? 'compound' : 'regular';
};

/** Editing drops and re-creates the index from ±1 keys, so only a plain
 *  ascending/descending index survives it; a 2dsphere, text or hashed key
 *  would come back as `1`. */
const isEditable = (keys: KeyPattern): boolean =>
  Object.values(keys).every((d) => d === 1 || d === -1 || d === '1' || d === '-1');

const keyChip = (dir: number | string): string =>
  dir === 1 || dir === '1' ? '↑' : dir === -1 || dir === '-1' ? '↓' : String(dir);

export const CollectionIndexes: React.FC<CollectionIndexesProps> = ({
  connectionId,
  databaseName,
  collectionName,
  refreshKey,
  onOpenIndex,
  onCreateIndex,
  onEditIndex,
  onDeleteIndex,
}) => {
  const { t, i18n } = useTranslation('sidebar');
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<IndexStatUi[] | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  // Geo types are MongoDB's own names, so they stay untranslated.
  const kindLabel: Record<IndexKind, string> = {
    regular: t('indexesView.type.regular'),
    compound: t('indexesView.type.compound'),
    text: t('indexesView.type.text'),
    hashed: t('indexesView.type.hashed'),
    wildcard: t('indexesView.type.wildcard'),
    '2dsphere': '2dsphere',
    '2d': '2d',
  };

  useEffect(() => {
    let cancelled = false;
    const args = { id: connectionId, db: databaseName, collection: collectionName };
    setError(null);
    invoke<IndexInfo[]>('list_indexes', args)
      .then((list) => !cancelled && setIndexes(list))
      .catch((err) => !cancelled && setError(String(err)));
    // Separate from the list: without stats the definitions still render.
    invoke<IndexStatUi[]>('index_stats', args).then(
      (s) => {
        if (!cancelled) {
          setStats(s);
          setStatsError(null);
        }
      },
      (err) => {
        if (!cancelled) {
          setStats(null);
          setStatsError(String(err));
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId, databaseName, collectionName, refreshKey]);

  const rows = useMemo(() => {
    const merged = (indexes ?? []).map((info) => ({
      info,
      keys: parseKeys(info.keys),
      stat: stats?.find((s) => s.name === info.name) ?? null,
    }));
    if (!sort) return merged;
    const value = (r: (typeof merged)[number]) =>
      sort.key === 'size' ? (r.stat?.sizeBytes ?? -1) : (r.stat?.ops ?? -1);
    const sorted = [...merged].sort((a, b) =>
      sort.key === 'name' ? a.info.name.localeCompare(b.info.name) : value(a) - value(b)
    );
    return sort.desc ? sorted.reverse() : sorted;
  }, [indexes, stats, sort]);

  // Names read A→Z first; numbers biggest first, since the question is
  // "which index is largest / busiest".
  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev?.key === key ? { key, desc: !prev.desc } : { key, desc: key !== 'name' }));

  const header = (key: SortKey, label: string) => (
    <th
      className="px-4 py-2 font-medium"
      aria-sort={sort?.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(key)}>
        {label}
        {sort?.key === key && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
      </button>
    </th>
  );

  const shell = (body: React.ReactNode) => (
    <div className="flex h-full flex-col" data-testid="collection-indexes" data-connection-id={connectionId}>
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-warning" />
          <h1 className="text-sm font-semibold text-foreground">{t('indexesView.title')}</h1>
          <span className="text-xs text-muted-foreground">{databaseName}.{collectionName}</span>
        </div>
        {onCreateIndex && (
          <Button type="button" variant="outline" size="sm" className="h-7 text-[11px]" onClick={onCreateIndex} data-testid="indexes-create-btn">
            <Plus size={12} />
            {t('ctx.createIndex')}
          </Button>
        )}
      </div>
      {body}
    </div>
  );

  if (error) {
    return shell(
      <div className="select-text p-6 font-mono text-sm text-destructive" data-testid="collection-indexes-error">
        {error}
      </div>
    );
  }
  if (!indexes) {
    return shell(
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t('indexesView.loading')}</span>
      </div>
    );
  }
  if (indexes.length === 0) {
    return shell(
      <div className="p-6 text-sm text-muted-foreground" data-testid="collection-indexes-empty">
        {t('indexesView.empty')}
      </div>
    );
  }

  return shell(
    <>
      {statsError && (
        <div className="flex items-start gap-2 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning" data-testid="index-stats-unavailable">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="select-text">{t('indexesView.statsUnavailable', { detail: statsError })}</span>
        </div>
      )}
      <ScrollArea className="relative flex-1">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
            <tr className="text-left text-muted-foreground">
              {header('name', t('indexesView.columns.name'))}
              <th className="px-4 py-2 font-medium">{t('indexesView.columns.keys')}</th>
              <th className="px-4 py-2 font-medium">{t('indexesView.columns.type')}</th>
              {header('size', t('indexesView.columns.size'))}
              {header('usage', t('indexesView.columns.usage'))}
              <th className="px-4 py-2 font-medium">{t('indexesView.columns.properties')}</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ info, keys, stat }) => {
              const isId = info.name === '_id_';
              return (
                <tr
                  key={info.name}
                  data-testid={`index-row-${info.name}`}
                  data-index-name={info.name}
                  className="cursor-pointer border-t border-border hover:bg-accent/50"
                  onClick={() => onOpenIndex(info.name)}
                >
                  <td className="px-4 py-1.5 font-mono text-foreground">{info.name}</td>
                  <td className="px-4 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(keys).map(([field, dir]) => (
                        <Badge key={field} variant="outline" className="font-mono text-[10px]">
                          {field} {keyChip(dir)}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-1.5 text-muted-foreground">{kindLabel[indexKind(keys)]}</td>
                  <td className="px-4 py-1.5 tabular-nums" data-testid="index-size">
                    {stat ? formatBytes(stat.sizeBytes) : '—'}
                  </td>
                  <td className="px-4 py-1.5 tabular-nums" data-testid="index-usage">
                    {stat ? (
                      <>
                        <div>{t('indexesView.usage.ops', { ops: stat.ops.toLocaleString('en-US') })}</div>
                        {stat.sinceMs > 0 && (
                          <div className="text-[10px] text-muted-foreground">
                            {t('indexesView.usage.since', { date: new Date(stat.sinceMs).toLocaleDateString(i18n.language) })}
                          </div>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {isId && <Badge variant="secondary" className="text-[9px]">{t('indexesView.properties.default')}</Badge>}
                      {info.unique && <Badge variant="success" className="text-[9px]">{t('indexesView.properties.unique')}</Badge>}
                      {info.sparse && <Badge variant="secondary" className="text-[9px]">{t('indexesView.properties.sparse')}</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-1.5">
                    {!isId && (
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        {onEditIndex && isEditable(keys) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            title={t('indexesView.actions.edit')}
                            aria-label={t('indexesView.actions.edit')}
                            data-testid={`edit-index-${info.name}`}
                            onClick={() =>
                              onEditIndex(
                                info.name,
                                Object.fromEntries(
                                  Object.entries(keys).map(([f, d]) => [f, Number(d)])
                                ),
                                info.unique,
                                info.sparse
                              )
                            }
                          >
                            <Edit size={12} />
                          </Button>
                        )}
                        {onDeleteIndex && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            title={t('ctx.deleteIndex')}
                            aria-label={t('ctx.deleteIndex')}
                            data-testid={`drop-index-${info.name}`}
                            onClick={() => onDeleteIndex(info.name)}
                          >
                            <Trash2 size={12} />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollArea>
    </>
  );
};

import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  KeyRound,
  Database,
  Info,
  Hash,
  Cpu,
  FileJson,
  Layers,
  Copy,
  Check,
  Edit,
  Trash2,
  Loader2,
  HardDrive,
  Activity,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/format';
import type { IndexInfo } from './Sidebar';
import type { IndexStatUi } from './StatsCards';
import { useDialogs } from './dialogs/DialogProvider';

interface IndexViewerProps {
  connectionId: string;
  databaseName: string;
  collectionName: string;
  indexName: string;
  onEditIndex?: (indexName: string, keys: Record<string, number>, unique: boolean, sparse: boolean) => void;
  onDeleteIndex?: (indexName: string) => void;
}

export const IndexViewer: React.FC<IndexViewerProps> = ({
  connectionId,
  databaseName,
  collectionName,
  indexName,
  onEditIndex,
  onDeleteIndex,
}) => {
  const { confirm } = useDialogs();
  const [copied, setCopied] = useState(false);
  const [info, setInfo] = useState<IndexInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<IndexStatUi[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInfo(null);
    setStats(null);

    (async () => {
      try {
        const list = await invoke<IndexInfo[]>('list_indexes', {
          id: connectionId,
          db: databaseName,
          collection: collectionName,
        });
        if (cancelled) return;
        const match = list.find((i) => i.name === indexName) || null;
        if (!match) {
          setError(`Index "${indexName}" was not found on ${databaseName}.${collectionName}.`);
        } else {
          setInfo(match);
        }
      } catch (err: any) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // Fetched independently, in its own try/catch: a stats failure must
    // never block rendering the index definition above.
    (async () => {
      try {
        const s = await invoke<IndexStatUi[]>('index_stats', {
          id: connectionId,
          db: databaseName,
          collection: collectionName,
        });
        if (!cancelled) setStats(s);
      } catch {
        // Usage/size stats are a nice-to-have; ignore failures silently.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId, databaseName, collectionName, indexName]);

  const statEntry = useMemo(() => stats?.find((s) => s.name === indexName) ?? null, [stats, indexName]);

  const indexSpecs = useMemo(() => {
    let keyPattern: Record<string, number | string> = {};
    if (info) {
      try {
        const parsed = JSON.parse(info.keys);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          keyPattern = parsed;
        }
      } catch {
        keyPattern = {};
      }
    }

    const fieldCount = Object.keys(keyPattern).length;
    const type = fieldCount > 1 ? 'Compound' : 'Single Field';
    const unique = info?.unique ?? false;
    const sparse = info?.sparse ?? false;
    const isId = indexName === '_id_';
    const description = isId
      ? 'System primary key index. Automatically created by MongoDB.'
      : `User-created index on ${Object.keys(keyPattern).join(', ') || '(unknown fields)'}.`;

    const rawJson = JSON.stringify(
      {
        v: 2,
        key: keyPattern,
        name: indexName,
        ns: `${databaseName}.${collectionName}`,
        unique: unique ? true : undefined,
        sparse: sparse ? true : undefined,
      },
      null,
      2
    );

    return { keyPattern, type, unique, sparse, fieldCount, description, rawJson };
  }, [info, indexName, databaseName, collectionName]);

  const editableKeyPattern = useMemo(() => {
    const out: Record<string, number> = {};
    Object.entries(indexSpecs.keyPattern).forEach(([field, dir]) => {
      out[field] = dir === -1 || dir === '-1' ? -1 : typeof dir === 'number' ? dir : 1;
    });
    return out;
  }, [indexSpecs.keyPattern]);

  const handleCopy = () => {
    navigator.clipboard.writeText(indexSpecs.rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderHighlightedJson = (json: string) => {
    const regex = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|(\b(?:true|false|null)\b)|(\b-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b)/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(json)) !== null) {
      if (match.index > lastIndex) {
        parts.push(json.substring(lastIndex, match.index));
      }

      const [_, str, colon, boolVal, numVal] = match;

      if (str) {
        if (colon) {
          parts.push(<span key={match.index} className="text-syntax-key">{str}</span>);
          parts.push(colon);
        } else {
          parts.push(<span key={match.index} className="text-syntax-string">{str}</span>);
        }
      } else if (boolVal) {
        parts.push(<span key={match.index} className="text-syntax-boolean">{boolVal}</span>);
      } else if (numVal) {
        parts.push(<span key={match.index} className="text-syntax-number">{numVal}</span>);
      }

      lastIndex = regex.lastIndex;
    }

    if (lastIndex < json.length) {
      parts.push(json.substring(lastIndex));
    }

    return parts;
  };

  if (loading) {
    return (
      <div className="flex h-full flex-col" data-testid="index-viewer" data-connection-id={connectionId}>
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading index definition…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col" data-testid="index-viewer" data-connection-id={connectionId}>
        <div className="select-text p-6 font-mono text-sm text-destructive" data-testid="index-viewer-error">
          {error}
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full" data-testid="index-viewer" data-connection-id={connectionId}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10">
              <KeyRound size={22} className="text-warning" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold tracking-tight text-foreground">{indexName}</h1>
                <Badge variant="secondary">Index</Badge>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Database size={11} className="text-warning" />
                <span>{databaseName}.{collectionName}</span>
              </p>
            </div>
          </div>

          {indexName !== '_id_' && (onEditIndex || onDeleteIndex) && (
            <div className="flex items-center gap-2">
              {onEditIndex && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onEditIndex(indexName, editableKeyPattern, indexSpecs.unique, indexSpecs.sparse)}
                  title="Edit Index"
                  data-testid="edit-index-btn"
                >
                  <Edit size={13} />
                  Edit Index
                </Button>
              )}
              {onDeleteIndex && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: 'Delete index',
                        message: `Are you sure you want to delete index "${indexName}"?`,
                        confirmLabel: 'Delete',
                        destructive: true,
                      })
                    ) {
                      onDeleteIndex(indexName);
                    }
                  }}
                  title="Delete Index"
                  data-testid="delete-index-btn"
                >
                  <Trash2 size={13} />
                  Delete Index
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <Card className="relative overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Cpu size={12} className="text-primary" />
                Definition
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-lg font-semibold text-foreground">{indexSpecs.type}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(indexSpecs.keyPattern).map(([key, dir]) => {
                  const isDesc = dir === -1 || dir === '-1';
                  const isAsc = dir === 1 || dir === '1';
                  const label = isDesc ? 'DESC (-1)' : isAsc ? 'ASC (1)' : String(dir);
                  return (
                    <Badge key={key} variant="outline" className="gap-1 font-mono text-[10px]">
                      <span>{key}</span>
                      <span className={cn(isDesc ? 'text-destructive' : 'text-success')}>{label}</span>
                    </Badge>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Layers size={12} className="text-success" />
                Constraints
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-lg font-semibold text-foreground">
                {indexSpecs.unique ? 'Unique' : 'Non-Unique'}
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', indexSpecs.sparse ? 'bg-success' : 'bg-muted-foreground/40')} />
                {indexSpecs.sparse ? 'Sparse index' : 'Non-sparse (indexes all documents)'}
              </p>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Hash size={12} className="text-warning" />
                Key Fields
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-lg font-semibold text-foreground">{indexSpecs.fieldCount}</div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {indexSpecs.fieldCount === 1 ? 'Single-field index' : `${indexSpecs.fieldCount} fields (compound)`}
              </p>
            </CardContent>
          </Card>

          {statEntry && (
            <Card className="relative overflow-hidden" data-testid="index-size-card">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <HardDrive size={12} className="text-primary" />
                  Size
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-lg font-semibold text-foreground">{formatBytes(statEntry.sizeBytes)}</div>
                <p className="mt-1 text-[11px] text-muted-foreground">On-disk index size</p>
              </CardContent>
            </Card>
          )}

          {statEntry && (
            <Card className="relative overflow-hidden" data-testid="index-usage-card">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Activity size={12} className="text-success" />
                  Usage
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <div className="text-lg font-semibold text-foreground">{statEntry.ops.toLocaleString()} ops</div>
                  {statEntry.ops === 0 && (
                    <Badge variant="outline" data-testid="index-unused-badge">
                      Unused
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">Index accesses since last restart</p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <Info size={13} className="text-primary" />
                Properties &amp; Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="text-muted-foreground">Index Name</span>
                <span className="select-text font-mono text-foreground">{indexName}</span>
              </div>
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="text-muted-foreground">Unique Constraint</span>
                {indexSpecs.unique ? (
                  <Badge variant="success">Unique</Badge>
                ) : (
                  <Badge variant="outline">Non-Unique</Badge>
                )}
              </div>
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="text-muted-foreground">Sparse Constraint</span>
                {indexSpecs.sparse ? (
                  <Badge variant="secondary">Sparse</Badge>
                ) : (
                  <Badge variant="outline">Non-Sparse</Badge>
                )}
              </div>
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="text-muted-foreground">Operational Status</span>
                <Badge variant="success">Active</Badge>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-primary">
                  <Info size={12} />
                  Description &amp; Guidelines
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{indexSpecs.description}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileJson size={13} className="text-warning" />
                Raw Specification (BSON Metadata)
              </CardTitle>
              <Button type="button" variant="outline" size="sm" className="h-7 text-[11px]" onClick={handleCopy} title="Copy to Clipboard">
                {copied ? (
                  <>
                    <Check size={11} className="text-success" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy size={11} />
                    Copy JSON
                  </>
                )}
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="select-text whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground">
                {renderHighlightedJson(indexSpecs.rawJson)}
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>
    </ScrollArea>
  );
};

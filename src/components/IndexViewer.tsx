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
  Trash2
} from 'lucide-react';
import type { IndexInfo } from './Sidebar';
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

  // Fetch the REAL index definition from the backend (no more guessing from the name).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInfo(null);

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

    return () => {
      cancelled = true;
    };
  }, [connectionId, databaseName, collectionName, indexName]);

  // Derive view data from the real spec.
  const indexSpecs = useMemo(() => {
    // keyPattern values can be numbers (1 / -1) or strings ("text", "2dsphere", "hashed").
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

  // Coerce the real key pattern into the {field: 1 | -1} shape the edit modal accepts.
  const editableKeyPattern = useMemo(() => {
    const out: Record<string, number> = {};
    Object.entries(indexSpecs.keyPattern).forEach(([field, dir]) => {
      out[field] = dir === -1 || dir === '-1' ? -1 : typeof dir === 'number' ? dir : 1;
    });
    return out;
  }, [indexSpecs.keyPattern]);

  // Copy BSON to clipboard helper
  const handleCopy = () => {
    navigator.clipboard.writeText(indexSpecs.rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Custom JSON Syntax Highlighter for BSON Metadata codeblock
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
      <div className="index-viewer-container" data-testid="index-viewer" data-connection-id={connectionId}>
        <div className="p-6 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--accent-blue)]" />
          <span>Loading index definition…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="index-viewer-container" data-testid="index-viewer" data-connection-id={connectionId}>
        <div className="p-6 text-sm text-rose-400 font-mono select-text" data-testid="index-viewer-error">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="index-viewer-container" data-testid="index-viewer" data-connection-id={connectionId}>
      {/* Title Header */}
      <div className="index-header-bar justify-between">
        <div className="flex items-center gap-3">
          <div className="index-header-icon-box">
            <KeyRound size={22} className="text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight text-[var(--text-main)]">{indexName}</h1>
              <span className="badge-pill info">
                Index
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 mt-0.5">
              <Database size={11} className="text-amber-400" />
              <span>{databaseName}.{collectionName}</span>
            </p>
          </div>
        </div>

        {/* Edit and Delete Actions */}
        {indexName !== '_id_' && (onEditIndex || onDeleteIndex) && (
          <div className="flex items-center gap-2 pr-1">
            {onEditIndex && (
              <button
                onClick={() => onEditIndex(indexName, editableKeyPattern, indexSpecs.unique, indexSpecs.sparse)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-item-hover)] cursor-pointer transition-all"
                title="Edit Index"
                data-testid="edit-index-btn"
              >
                <Edit size={13} />
                <span>Edit Index</span>
              </button>
            )}
            {onDeleteIndex && (
              <button
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border border-rose-900/30 bg-rose-950/10 text-rose-400 hover:bg-rose-950/20 cursor-pointer transition-all"
                title="Delete Index"
                data-testid="delete-index-btn"
              >
                <Trash2 size={13} />
                <span>Delete Index</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Grid Dashboard */}
      <div className="index-metric-grid">
        {/* Card 1: Index Type & Keys */}
        <div className="index-metric-card">
          <div className="index-metric-header">
            <Cpu size={12} className="text-sky-400" />
            <span>Definition</span>
          </div>
          <div className="index-metric-value">{indexSpecs.type}</div>
          <div className="index-keys-container">
            {Object.entries(indexSpecs.keyPattern).map(([key, dir]) => {
              const isDesc = dir === -1 || dir === '-1';
              const isAsc = dir === 1 || dir === '1';
              const label = isDesc ? 'DESC (-1)' : isAsc ? 'ASC (1)' : String(dir);
              return (
                <div key={key} className="index-key-tag">
                  <span>{key}</span>
                  <span className={`index-key-direction ${isDesc ? 'desc' : 'asc'}`}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="index-metric-card-bg-accent text-sky-500" />
        </div>

        {/* Card 2: Constraints (real) */}
        <div className="index-metric-card">
          <div className="index-metric-header">
            <Layers size={12} className="text-emerald-400" />
            <span>Constraints</span>
          </div>
          <div className="index-metric-value">{indexSpecs.unique ? 'Unique' : 'Non-Unique'}</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1 flex items-center gap-1.5">
            <span className={`status-pulse ${indexSpecs.sparse ? 'text-[var(--accent-green)]' : 'text-[var(--text-dim)]'}`} />
            <span>{indexSpecs.sparse ? 'Sparse index' : 'Non-sparse (indexes all documents)'}</span>
          </div>
          <div className="index-metric-card-bg-accent text-emerald-500" />
        </div>

        {/* Card 3: Key field count (real) */}
        <div className="index-metric-card">
          <div className="index-metric-header">
            <Hash size={12} className="text-amber-400" />
            <span>Key Fields</span>
          </div>
          <div className="index-metric-value">{indexSpecs.fieldCount}</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            {indexSpecs.fieldCount === 1 ? 'Single-field index' : `${indexSpecs.fieldCount} fields (compound)`}
          </div>
          <div className="index-metric-card-bg-accent text-amber-500" />
        </div>
      </div>

      {/* Details Sections */}
      <div className="index-details-grid">
        
        {/* Left Section: Info and Specs */}
        <div className="index-details-card">
          <div className="index-details-header">
            <Info size={13} className="text-sky-400" />
            <span>Properties & Details</span>
          </div>

          <div className="index-property-list">
            <div className="index-property-row">
              <span className="index-property-label">Index Name</span>
              <span className="index-property-value select-text">{indexName}</span>
            </div>
            <div className="index-property-row">
              <span className="index-property-label">Unique Constraint</span>
              {indexSpecs.unique ? (
                <span className="badge-pill success-active">
                  <span className="status-pulse text-[var(--accent-green)]" />
                  <span>Unique</span>
                </span>
              ) : (
                <span className="badge-pill muted">
                  <span>Non-Unique</span>
                </span>
              )}
            </div>
            <div className="index-property-row">
              <span className="index-property-label">Sparse Constraint</span>
              {indexSpecs.sparse ? (
                <span className="badge-pill success">
                  <span>Sparse</span>
                </span>
              ) : (
                <span className="badge-pill muted">
                  <span>Non-Sparse</span>
                </span>
              )}
            </div>
            <div className="index-property-row">
              <span className="index-property-label">Operational Status</span>
              <span className="badge-pill success-active">
                <span className="status-pulse text-[var(--accent-green)]" />
                <span>Active</span>
              </span>
            </div>

            <div className="index-description-block">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--accent-blue)] mb-1">
                <Info size={12} />
                <span>Description & Guidelines</span>
              </div>
              <p className="index-description-text">
                {indexSpecs.description}
              </p>
            </div>
          </div>
        </div>

        {/* Right Section: JSON Specification */}
        <div className="bson-metadata-card">
          <div className="bson-metadata-header">
            <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-main)]">
              <FileJson size={13} className="text-amber-500" />
              <span>Raw Specification (BSON Metadata)</span>
            </div>
            <button 
              onClick={handleCopy}
              className="bson-metadata-copy-btn"
              title="Copy to Clipboard"
            >
              {copied ? (
                <>
                  <Check size={11} className="text-[var(--accent-green)]" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy size={11} />
                  <span>Copy JSON</span>
                </>
              )}
            </button>
          </div>
          <div className="bson-metadata-body select-text">
            <pre className="m-0 select-text leading-relaxed whitespace-pre-wrap">
              {renderHighlightedJson(indexSpecs.rawJson)}
            </pre>
          </div>
        </div>

      </div>
    </div>
  );
};

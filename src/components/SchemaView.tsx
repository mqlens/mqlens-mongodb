import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Table2, Loader2, AlertCircle, ArrowUpDown } from 'lucide-react';

interface TypeCount {
  type: string;
  count: number;
}
interface FieldStat {
  path: string;
  types: TypeCount[];
  presence: number;
  coverage: number;
}
interface SchemaReport {
  sampled: number;
  fields: FieldStat[];
}

interface SchemaViewProps {
  connectionId: string;
  databaseName: string;
  collectionName: string;
  sampleSize?: number;
}

type SortKey = 'field' | 'coverage';

// Render a field's observed types; when mixed, show each type's share.
const TypesCell: React.FC<{ field: FieldStat }> = ({ field }) => {
  const total = field.types.reduce((sum, t) => sum + t.count, 0) || 1;
  return (
    <span data-testid={`schema-types-${field.path}`} className="flex flex-wrap gap-x-3 gap-y-0.5">
      {field.types.map((t) => (
        <span key={t.type} className="text-[var(--text-main)]">
          {t.type}
          {field.types.length > 1 && (
            <span className="text-[var(--text-dim)]"> {Math.round((t.count / total) * 100)}%</span>
          )}
        </span>
      ))}
    </span>
  );
};

export const SchemaView: React.FC<SchemaViewProps> = ({
  connectionId,
  databaseName,
  collectionName,
  sampleSize = 1000,
}) => {
  const [report, setReport] = useState<SchemaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('field');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReport(null);

    (async () => {
      try {
        const json = await invoke<string>('analyze_schema', {
          id: connectionId,
          database: databaseName,
          collection: collectionName,
          sampleSize,
        });
        if (cancelled) return;
        setReport(JSON.parse(json) as SchemaReport);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId, databaseName, collectionName, sampleSize]);

  const sortedFields = useMemo(() => {
    if (!report) return [];
    const fields = [...report.fields];
    if (sortKey === 'coverage') {
      fields.sort((a, b) => b.coverage - a.coverage || a.path.localeCompare(b.path));
    } else {
      fields.sort((a, b) => a.path.localeCompare(b.path));
    }
    return fields;
  }, [report, sortKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] gap-2 text-sm">
        <Loader2 size={16} className="animate-spin" />
        Analyzing schema…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="flex items-center gap-2 text-rose-400 text-sm font-mono">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!report || report.sampled === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-2 text-sm">
        <Table2 size={20} />
        Collection is empty — nothing to analyze.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="schema-view">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-main)]">
          <Table2 size={14} className="text-emerald-500" />
          <span>
            Schema: {databaseName}.{collectionName}
          </span>
        </div>
        <span className="text-[11px] text-[var(--text-dim)] font-mono">
          sampled {report.sampled} docs · {report.fields.length} fields
        </span>
      </div>

      {/* Field table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead className="sticky top-0 bg-[var(--bg-sidebar)]">
            <tr className="text-left text-[var(--text-muted)]">
              <th className="px-4 py-2 font-medium">
                <button
                  className="inline-flex items-center gap-1 hover:text-[var(--text-main)]"
                  onClick={() => setSortKey('field')}
                  data-testid="schema-sort-field"
                >
                  field <ArrowUpDown size={10} />
                </button>
              </th>
              <th className="px-4 py-2 font-medium">types</th>
              <th className="px-4 py-2 font-medium">
                <button
                  className="inline-flex items-center gap-1 hover:text-[var(--text-main)]"
                  onClick={() => setSortKey('coverage')}
                  data-testid="schema-sort-coverage"
                >
                  coverage <ArrowUpDown size={10} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedFields.map((field) => {
              const pct = Math.round(field.coverage * 100);
              return (
                <tr
                  key={field.path}
                  className="border-t border-[var(--border-color)] hover:bg-[var(--bg-item-hover)]"
                  data-testid={`schema-row-${field.path}`}
                >
                  <td className="px-4 py-1.5 font-mono text-[var(--text-main)]">{field.path}</td>
                  <td className="px-4 py-1.5">
                    <TypesCell field={field} />
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 rounded bg-[var(--bg-item-active)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent-blue)]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[var(--text-muted)] tabular-nums">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

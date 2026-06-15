import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Table2, Loader2, AlertCircle, ArrowUpDown, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface TypeCount {
  type: string;
  count: number;
}
interface FieldStat {
  path: string;
  types: TypeCount[];
  presence: number;
  coverage: number;
  enumValues?: string[];
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

const TypesCell: React.FC<{ field: FieldStat }> = ({ field }) => {
  const total = field.types.reduce((sum, t) => sum + t.count, 0) || 1;
  return (
    <span data-testid={`schema-types-${field.path}`} className="flex flex-wrap gap-x-3 gap-y-0.5">
      {field.types.map((t) => (
        <span key={t.type} className="text-foreground">
          {t.type}
          {field.types.length > 1 && (
            <span className="text-muted-foreground"> {Math.round((t.count / total) * 100)}%</span>
          )}
        </span>
      ))}
    </span>
  );
};

const SchemaFieldTable: React.FC<{
  report: SchemaReport;
  onSortKeyChange: (key: SortKey) => void;
  sortedFields: FieldStat[];
}> = ({ report, onSortKeyChange, sortedFields }) => (
  <>
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Table2 size={14} className="text-success" />
        <span>
          Schema: {report.sampled > 0 ? '' : ''}
        </span>
      </div>
      <span className="font-mono text-[11px] text-muted-foreground">
        sampled {report.sampled} docs · {report.fields.length} fields
      </span>
    </div>
    <ScrollArea className="flex-1">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
          <tr className="text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => onSortKeyChange('field')}
                data-testid="schema-sort-field"
              >
                field <ArrowUpDown size={10} />
              </Button>
            </th>
            <th className="px-4 py-2 font-medium">types</th>
            <th className="px-4 py-2 font-medium">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => onSortKeyChange('coverage')}
                data-testid="schema-sort-coverage"
              >
                coverage <ArrowUpDown size={10} />
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedFields.map((field) => {
            const pct = Math.round(field.coverage * 100);
            return (
              <tr
                key={field.path}
                className="border-t border-border hover:bg-accent/50"
                data-testid={`schema-row-${field.path}`}
              >
                <td className="px-4 py-1.5 font-mono text-foreground">{field.path}</td>
                <td className="px-4 py-1.5">
                  <TypesCell field={field} />
                </td>
                <td className="px-4 py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-muted-foreground">{pct}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollArea>
  </>
);

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
  const [tab, setTab] = useState('fields');

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
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        Analyzing schema…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex items-center gap-2 font-mono text-sm text-destructive">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!report || report.sampled === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <Table2 size={20} />
        Collection is empty — nothing to analyze.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="schema-view">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Table2 size={14} className="text-success" />
          <span>
            {databaseName}.{collectionName}
          </span>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {report.fields.length} fields
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-4">
          <TabsList className="h-9 bg-transparent p-0">
            <TabsTrigger
              value="fields"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
              data-testid="schema-tab-fields"
            >
              Field Analysis
            </TabsTrigger>
            <TabsTrigger
              value="validation"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
              data-testid="schema-tab-validation"
            >
              Validation Rules
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="fields" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <SchemaFieldTable
            report={report}
            onSortKeyChange={setSortKey}
            sortedFields={sortedFields}
          />
        </TabsContent>

        <TabsContent
          value="validation"
          className="mt-0 flex min-h-0 flex-1 flex-col"
          data-testid="schema-validation-placeholder"
        >
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <ShieldCheck size={28} className="text-muted-foreground/50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Validation Rules</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Collection validation schema viewer coming soon (#93). This tab will show
                <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">$jsonSchema</code>
                and validator rules for {databaseName}.{collectionName}.
              </p>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              Planned
            </Badge>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

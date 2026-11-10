import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useTranslation } from 'react-i18next';
import { Table2, Loader2, AlertCircle, ArrowUpDown, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type FieldStat, type SchemaReport, schemaToMarkdown, topValues } from '@/lib/schemaExport';
import { ValidationRulesView } from './ValidationRulesView';

const SAMPLE_SIZES = [100, 250, 500, 1000];

interface SchemaViewProps {
  connectionId: string;
  databaseName: string;
  collectionName: string;
  sampleSize?: number;
  /** Called after the Validation Rules tab applies a validator. */
  onValidatorApplied?: () => void;
  /** The connection may not set validators (set_validator is blocked): no Validation Rules tab. */
  validationBlocked?: boolean;
}

type SortKey = 'field' | 'coverage';

const ValuesRow: React.FC<{ field: FieldStat }> = ({ field }) => {
  const { t } = useTranslation('documents');
  const values = topValues(field);
  return (
    <tr className="bg-muted/30" data-testid={`schema-values-${field.path}`}>
      <td colSpan={3} className="px-6 py-2">
        {values.length === 0 ? (
          <span className="text-muted-foreground">{t('schemaView.labels.noValues')}</span>
        ) : (
          <div className="space-y-1">
            {values.map(([value, count]) => {
              const pct = Math.round((count / (field.presence || 1)) * 100);
              return (
                <div key={value} className="flex items-center gap-2">
                  <span className="w-40 truncate font-mono text-foreground" title={value}>
                    {value}
                  </span>
                  <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-chart-2" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="tabular-nums text-muted-foreground">
                    {count} · {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </td>
    </tr>
  );
};

const TypesCell: React.FC<{ field: FieldStat }> = ({ field }) => {
  const total = field.types.reduce((sum, ty) => sum + ty.count, 0) || 1;
  return (
    <span data-testid={`schema-types-${field.path}`} className="flex flex-wrap gap-x-3 gap-y-0.5">
      {field.types.map((ty) => (
        <span key={ty.type} className="text-foreground">
          {ty.type}
          {field.types.length > 1 && (
            <span className="text-muted-foreground"> {Math.round((ty.count / total) * 100)}%</span>
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
}> = ({ report, onSortKeyChange, sortedFields }) => {
  const { t } = useTranslation('documents');
  const [openPath, setOpenPath] = useState<string | null>(null);
  return (
  <>
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Table2 size={14} className="text-success" />
        <span>
          {t('schemaView.labels.schemaPrefix')} {report.sampled > 0 ? '' : ''}
        </span>
      </div>
      <span className="font-mono text-[11px] text-muted-foreground">
        {t('schemaView.labels.sampledSummary', { sampled: report.sampled, fields: report.fields.length })}
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
                {t('schemaView.labels.field')} <ArrowUpDown size={10} />
              </Button>
            </th>
            <th className="px-4 py-2 font-medium">{t('schemaView.labels.types')}</th>
            <th className="px-4 py-2 font-medium">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => onSortKeyChange('coverage')}
                data-testid="schema-sort-coverage"
              >
                {t('schemaView.labels.coverage')} <ArrowUpDown size={10} />
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedFields.map((field) => {
            const pct = Math.round(field.coverage * 100);
            return (
              <React.Fragment key={field.path}>
              <tr
                className="border-t border-border hover:bg-accent/50"
                data-testid={`schema-row-${field.path}`}
              >
                <td className="px-4 py-1.5 font-mono text-foreground">
                  <button
                    type="button"
                    className="text-left hover:underline focus-visible:underline focus-visible:outline-none"
                    aria-expanded={openPath === field.path}
                    title={t('schemaView.labels.showValues')}
                    onClick={() => setOpenPath((p) => (p === field.path ? null : field.path))}
                  >
                    {field.path}
                  </button>
                </td>
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
              {openPath === field.path && <ValuesRow field={field} />}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </ScrollArea>
  </>
  );
};

export const SchemaView: React.FC<SchemaViewProps> = ({
  connectionId,
  databaseName,
  collectionName,
  sampleSize: initialSampleSize = 1000,
  onValidatorApplied = () => {},
  validationBlocked = false,
}) => {
  const { t } = useTranslation('documents');
  const [report, setReport] = useState<SchemaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('field');
  const [tab, setTab] = useState('fields');
  const [sampleSize, setSampleSize] = useState(initialSampleSize);
  const [first, setFirst] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportSchema = async (format: 'json' | 'md') => {
    if (!report) return;
    setExportError(null);
    try {
      const path = await save({
        defaultPath: `${databaseName}.${collectionName}.schema.${format}`,
        filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [format] }],
      });
      if (!path) return;
      const text =
        format === 'json'
          ? JSON.stringify(report, null, 2)
          : schemaToMarkdown(`${databaseName}.${collectionName}`, report);
      await writeTextFile(path, text);
    } catch (err: any) {
      setExportError(t('schemaView.export.failed', { error: String(err?.message || err) }));
    }
  };

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
          first,
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
  }, [connectionId, databaseName, collectionName, sampleSize, first]);

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

  // Loading and errors stay inside Field Analysis: the Validation Rules tab
  // must stay mounted while the fields are sampled again, or its draft is lost.
  let fieldsBody: React.ReactNode;
  if (loading) {
    fieldsBody = (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        {t('schemaView.labels.analyzing')}
      </div>
    );
  } else if (error || !report) {
    fieldsBody = (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex items-center gap-2 font-mono text-sm text-destructive">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  } else if (report.sampled === 0) {
    fieldsBody = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <Table2 size={20} />
        {t('schemaView.empty.title')}
      </div>
    );
  } else {
    fieldsBody = <SchemaFieldTable report={report} onSortKeyChange={setSortKey} sortedFields={sortedFields} />;
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
        <div className="flex items-center gap-2">
          <select
            value={sampleSize}
            onChange={(e) => setSampleSize(Number(e.target.value))}
            className="h-7 rounded-md border border-border bg-background px-1 text-[11px]"
            aria-label={t('schemaView.sample.size')}
            data-testid="schema-sample-size"
          >
            {SAMPLE_SIZES.map((n) => (
              <option key={n} value={n}>
                {t('schemaView.sample.docs', { count: n })}
              </option>
            ))}
          </select>
          <select
            value={first ? 'first' : 'random'}
            onChange={(e) => setFirst(e.target.value === 'first')}
            className="h-7 rounded-md border border-border bg-background px-1 text-[11px]"
            aria-label={t('schemaView.sample.mode')}
            data-testid="schema-sample-mode"
          >
            <option value="random">{t('schemaView.sample.random')}</option>
            <option value="first">{t('schemaView.sample.first')}</option>
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => exportSchema('json')}
            disabled={!report}
            data-testid="schema-export-json"
          >
            <Download size={12} /> {t('schemaView.export.json')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => exportSchema('md')}
            disabled={!report}
            data-testid="schema-export-md"
          >
            <Download size={12} /> {t('schemaView.export.markdown')}
          </Button>
          {report && (
            <Badge variant="outline" className="text-[10px]">
              {t('schemaView.labels.fieldsCount', { count: report.fields.length })}
            </Badge>
          )}
        </div>
      </div>
      {exportError && (
        <div className="border-b border-border px-4 py-1.5 text-xs text-destructive" data-testid="schema-export-error">
          {exportError}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-4">
          <TabsList className="h-9 bg-transparent p-0">
            <TabsTrigger
              value="fields"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
              data-testid="schema-tab-fields"
            >
              {t('schemaView.tabs.fieldAnalysis')}
            </TabsTrigger>
            {!validationBlocked && (
            <TabsTrigger
              value="validation"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
              data-testid="schema-tab-validation"
            >
              {t('schemaView.tabs.validationRules')}
            </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="fields" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          {fieldsBody}
        </TabsContent>

        {/* Kept mounted while hidden, so an unapplied validator survives a look at the fields. */}
        {!validationBlocked && (
        <TabsContent
          value="validation"
          forceMount
          className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <ValidationRulesView
            connectionId={connectionId}
            databaseName={databaseName}
            collectionName={collectionName}
            onApplied={onValidatorApplied}
          />
        </TabsContent>
        )}
      </Tabs>
    </div>
  );
};

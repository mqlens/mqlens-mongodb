import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render-with-providers';
import { DialogProvider, useDialogs } from '../dialogs/DialogProvider';
import { ExportView, DEFAULT_EXPORT_OPTIONS } from '../ExportView';

// QueryEditor wraps @monaco-editor/react, which has no usable DOM under jsdom.
// Mock it with a textarea that round-trips value/onChange and forwards the
// data-testid so the filter/sort/projection/pipeline inputs stay drivable.
vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onChange,
    wrapperProps,
  }: {
    value: string;
    onChange?: (v: string) => void;
    wrapperProps?: Record<string, unknown>;
  }) => (
    <textarea
      data-testid={wrapperProps?.['data-testid'] as string | undefined}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

const mockInvoke = vi.fn();
const saveMock = vi.fn();
const writeTextFileMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...args: unknown[]) => writeTextFileMock(...args),
}));

const baseProps = {
  connectionName: 'Local',
  databaseName: 'sales_db',
  collectionName: 'customers',
  currentResultCount: 3,
  onExport: vi.fn(),
  onOpenTasks: vi.fn(),
};

function renderExportView(
  overrides: Partial<ComponentProps<typeof ExportView>> = {}
) {
  const props = { ...baseProps, ...overrides };
  return renderWithProviders(
    <DialogProvider>
      <ExportView {...props} />
    </DialogProvider>
  );
}

type ExportFormat = 'json' | 'csv' | 'bson' | 'ndjson' | 'xlsx';

/** Mirrors App handleExportForTab enough to exercise invoke + error toasts. */
function ExportViewHarness({
  currentResultCount = 3,
  invokeFails = false,
}: {
  currentResultCount?: number;
  invokeFails?: boolean;
}) {
  const { toast } = useDialogs();

  const onExport = async (
    format: ExportFormat,
    scope: 'current' | 'full' | 'filtered'
  ) => {
    if (scope === 'current' && currentResultCount === 0) return;
    try {
      const path = await saveMock({
        defaultPath: `customers${scope === 'full' ? '.full' : ''}.${format}`,
      });
      if (!path) return;
      if (scope === 'full') {
        if (invokeFails) throw new Error('disk full');
        await mockInvoke('start_collection_export', {
          id: 'conn-1',
          database: 'sales_db',
          collection: 'customers',
          format,
          path,
        });
        return;
      }
      await writeTextFileMock(path, '[]');
      toast(`Exported ${currentResultCount} document(s) to ${path}`, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Export failed: ${message}`, 'error');
    }
  };

  return (
    <ExportView
      connectionName="Local"
      databaseName="sales_db"
      collectionName="customers"
      currentResultCount={currentResultCount}
      onExport={onExport}
      onOpenTasks={vi.fn()}
    />
  );
}

describe('ExportView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue('/tmp/customers.json');
    writeTextFileMock.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue({
      id: 'task-1',
      kind: 'collection_export',
      label: 'Export sales_db.customers as JSON',
      status: 'running',
      processed: 0,
      total: null,
      message: 'Queued',
      path: '/tmp/customers.full.json',
      error: null,
      createdAtMs: 1,
      finishedAtMs: null,
    });
  });

  it('renders namespace and result count', () => {
    renderExportView();
    expect(screen.getByTestId('export-view')).toBeInTheDocument();
    expect(screen.getByText(/Local \/ sales_db\.customers/)).toBeInTheDocument();
    expect(screen.getByText('3 loaded documents')).toBeInTheDocument();
  });

  it('offers all five formats in the picker', () => {
    renderExportView();
    for (const fmt of ['json', 'ndjson', 'bson', 'csv', 'xlsx'] as const) {
      expect(screen.getByTestId(`export-format-${fmt}`)).toBeInTheDocument();
    }
  });

  it('disables the current-result export button when there are no loaded documents', () => {
    renderExportView({ currentResultCount: 0 });
    expect(screen.getByTestId('export-current-btn')).toBeDisabled();
  });

  it('exports current results in the default (JSON) format', () => {
    const onExport = vi.fn();
    renderExportView({ onExport });
    fireEvent.click(screen.getByTestId('export-current-btn'));
    expect(onExport).toHaveBeenCalledWith('json', 'current', DEFAULT_EXPORT_OPTIONS, undefined);
  });

  it('exports current results in the selected format', () => {
    const onExport = vi.fn();
    renderExportView({ onExport });
    fireEvent.click(screen.getByTestId('export-format-ndjson'));
    fireEvent.click(screen.getByTestId('export-current-btn'));
    expect(onExport).toHaveBeenCalledWith('ndjson', 'current', DEFAULT_EXPORT_OPTIONS, undefined);
  });

  it('exports the full collection in the selected format', () => {
    const onExport = vi.fn();
    renderExportView({ onExport });
    fireEvent.click(screen.getByTestId('export-format-bson'));
    fireEvent.click(screen.getByTestId('export-full-btn'));
    expect(onExport).toHaveBeenCalledWith('bson', 'full', DEFAULT_EXPORT_OPTIONS, undefined);
  });

  it('shows the Excel format and per-format options panel', () => {
    renderExportView();
    expect(screen.getByTestId('export-format-xlsx')).toBeInTheDocument();

    // JSON selected by default → JSON mode radio group visible
    expect(screen.getByTestId('export-options-json-mode')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-format-csv'));
    expect(screen.getByTestId('export-options-csv-delimiter')).toBeInTheDocument();
    expect(screen.getByTestId('export-options-csv-headers')).toBeChecked();

    fireEvent.click(screen.getByTestId('export-format-xlsx'));
    expect(screen.getByTestId('export-options-xlsx-bold')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-format-bson'));
    expect(screen.queryByTestId('export-options-panel')).not.toBeInTheDocument();
  });

  it('passes chosen options through onExport', () => {
    const onExport = vi.fn();
    renderExportView({ onExport });
    fireEvent.click(screen.getByTestId('export-format-csv'));
    fireEvent.change(screen.getByTestId('export-options-csv-delimiter'), {
      target: { value: ';' },
    });
    fireEvent.click(screen.getByTestId('export-options-csv-headers'));
    fireEvent.click(screen.getByTestId('export-full-btn'));
    expect(onExport).toHaveBeenCalledWith(
      'csv',
      'full',
      expect.objectContaining({
        csv: expect.objectContaining({ delimiter: ';', includeHeaders: false }),
      }),
      undefined
    );
  });

  it('disables export while a custom delimiter is invalid', () => {
    renderExportView();
    fireEvent.click(screen.getByTestId('export-format-csv'));
    fireEvent.change(screen.getByTestId('export-options-csv-delimiter'), {
      target: { value: 'custom' },
    });
    const custom = screen.getByTestId('export-options-csv-delimiter-custom');
    fireEvent.change(custom, { target: { value: 'ab' } });
    expect(screen.getByTestId('export-full-btn')).toBeDisabled();
    fireEvent.change(custom, { target: { value: '|' } });
    expect(screen.getByTestId('export-full-btn')).toBeEnabled();
  });

  it('seeds the filter editor and keeps filtered export enabled by default', () => {
    renderExportView({ filtered: { kind: 'find', filter: '{}', matchCount: null } });
    const input = screen.getByTestId('query-filter-input') as HTMLTextAreaElement;
    expect(input.value).toBe('{}');
    expect(screen.getByTestId('export-filtered-btn')).not.toBeDisabled();
  });

  it('seeds from the active find query and exports the edited query', () => {
    const onExport = vi.fn();
    renderExportView({
      onExport,
      filtered: {
        kind: 'find',
        filter: '{"tier":"gold"}',
        sort: '{"name":1}',
        projection: '{}',
        matchCount: 1234,
      },
    });
    const filterInput = screen.getByTestId('query-filter-input') as HTMLTextAreaElement;
    expect(filterInput.value).toBe('{"tier":"gold"}');
    expect(screen.getByText('1,234 matching documents')).toBeInTheDocument();

    fireEvent.change(filterInput, { target: { value: '{"tier":"silver"}' } });
    fireEvent.click(screen.getByTestId('export-filtered-btn'));
    expect(onExport).toHaveBeenCalledWith(
      'json',
      'filtered',
      DEFAULT_EXPORT_OPTIONS,
      {
        kind: 'find',
        filter: '{"tier":"silver"}',
        sort: '{"name":1}',
        projection: '{}',
        skip: 0,
        limit: 0,
      }
    );
  });

  it('disables filtered export and shows an error when the filter JSON is invalid', () => {
    renderExportView({ filtered: { kind: 'find', filter: '{}' } });
    fireEvent.change(screen.getByTestId('query-filter-input'), {
      target: { value: '{bad' },
    });
    expect(screen.getByTestId('export-filtered-btn')).toBeDisabled();
    expect(screen.getAllByText('Invalid JSON').length).toBeGreaterThan(0);
  });

  it('counts matches only when the Count button is clicked', async () => {
    const onCountFilter = vi.fn().mockResolvedValue(42);
    renderExportView({ filtered: { kind: 'find', filter: '{}', matchCount: null }, onCountFilter });

    // Editing the filter must NOT trigger a count on its own.
    fireEvent.change(screen.getByTestId('query-filter-input'), {
      target: { value: '{"active":true}' },
    });
    expect(onCountFilter).not.toHaveBeenCalled();
    expect(screen.getByTestId('export-filtered-count')).toHaveTextContent('Count not run yet');

    fireEvent.click(screen.getByTestId('export-filtered-count-btn'));
    await waitFor(() => {
      expect(onCountFilter).toHaveBeenCalledWith('{"active":true}');
      expect(screen.getByText('42 matching documents')).toBeInTheDocument();
    });
    expect(onCountFilter).toHaveBeenCalledTimes(1);
  });

  it('disables the Count button while the filter JSON is invalid', () => {
    const onCountFilter = vi.fn().mockResolvedValue(0);
    renderExportView({ filtered: { kind: 'find', filter: '{}' }, onCountFilter });
    fireEvent.change(screen.getByTestId('query-filter-input'), {
      target: { value: '{bad' },
    });
    expect(screen.getByTestId('export-filtered-count-btn')).toBeDisabled();
  });

  it('edits and exports an aggregation pipeline', () => {
    const onExport = vi.fn();
    renderExportView({
      onExport,
      filtered: { kind: 'aggregate', pipeline: '[\n  { "$match": {} }\n]' },
    });
    // Aggregate mode has no pre-count UI (count is determined when the export runs).
    expect(screen.queryByTestId('export-filtered-count-btn')).not.toBeInTheDocument();
    const pipelineInput = screen.getByTestId(
      'export-filtered-pipeline-input'
    ) as HTMLTextAreaElement;
    expect(pipelineInput.value).toContain('$match');

    fireEvent.change(pipelineInput, { target: { value: '[{"$limit":5}]' } });
    fireEvent.click(screen.getByTestId('export-format-csv'));
    fireEvent.click(screen.getByTestId('export-filtered-btn'));
    expect(onExport).toHaveBeenCalledWith(
      'csv',
      'filtered',
      DEFAULT_EXPORT_OPTIONS,
      {
        kind: 'aggregate',
        pipeline: '[{"$limit":5}]',
      }
    );
  });

  it('opens the Tasks tab from the header action', () => {
    const onOpenTasks = vi.fn();
    renderExportView({ onOpenTasks });
    fireEvent.click(screen.getByRole('button', { name: 'View Tasks' }));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it('starts a background export via invoke when full collection is chosen', async () => {
    renderWithProviders(
      <DialogProvider>
        <ExportViewHarness />
      </DialogProvider>
    );

    fireEvent.click(screen.getByTestId('export-full-btn'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith('start_collection_export', {
        id: 'conn-1',
        database: 'sales_db',
        collection: 'customers',
        format: 'json',
        path: '/tmp/customers.json',
      });
    });
  });

  it('surfaces export failures from invoke as an error toast', async () => {
    renderWithProviders(
      <DialogProvider>
        <ExportViewHarness invokeFails />
      </DialogProvider>
    );

    fireEvent.click(screen.getByTestId('export-full-btn'));

    expect(await screen.findByText('Export failed: disk full')).toBeInTheDocument();
  });

  it('scans fields and applies the selection to options', async () => {
    const onScanFields = vi.fn().mockResolvedValue(['_id', 'name', 'addr.city']);
    const onExport = vi.fn();
    renderExportView({ onScanFields, onExport });
    fireEvent.click(screen.getByTestId('export-scan-fields-btn'));
    expect(await screen.findByTestId('export-field-addr.city')).toBeChecked();

    // Deselect one field → selection becomes active and flows into onExport
    fireEvent.click(screen.getByTestId('export-field-_id'));
    fireEvent.click(screen.getByTestId('export-full-btn'));
    expect(onExport).toHaveBeenCalledWith(
      'json', 'full',
      expect.objectContaining({ fields: ['name', 'addr.city'] }),
      undefined
    );
    // Projection editor disabled with hint while selection is active
    expect(screen.getByTestId('export-field-selection-hint')).toBeInTheDocument();
  });

  it('all-selected scan sends no fields restriction', async () => {
    const onScanFields = vi.fn().mockResolvedValue(['_id', 'name']);
    const onExport = vi.fn();
    renderExportView({ onScanFields, onExport });
    fireEvent.click(screen.getByTestId('export-scan-fields-btn'));
    await screen.findByTestId('export-field-name');
    fireEvent.click(screen.getByTestId('export-full-btn'));
    expect(onExport.mock.calls[0][2].fields).toBeUndefined();
  });

  it('deselecting every field disables export buttons', async () => {
    const onScanFields = vi.fn().mockResolvedValue(['name']);
    renderExportView({ onScanFields });
    fireEvent.click(screen.getByTestId('export-scan-fields-btn'));
    fireEvent.click(await screen.findByTestId('export-field-name'));
    expect(screen.getByTestId('export-full-btn')).toBeDisabled();
  });

  it('includes skip and limit in the filtered query', () => {
    const onExport = vi.fn();
    renderExportView({ onExport, filtered: { kind: 'find', filter: '{}' } });
    fireEvent.change(screen.getByTestId('export-filtered-skip'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('export-filtered-limit'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('export-filtered-btn'));
    expect(onExport.mock.calls[0][3]).toMatchObject({ kind: 'find', skip: 10, limit: 50 });
  });

  it('copy-to-clipboard enabled for text formats only', () => {
    const onCopyCurrent = vi.fn();
    renderExportView({ onCopyCurrent, currentResultCount: 3 });
    expect(screen.getByTestId('export-copy-current-btn')).toBeEnabled();
    fireEvent.click(screen.getByTestId('export-format-xlsx'));
    expect(screen.getByTestId('export-copy-current-btn')).toBeDisabled();
  });

  it('renders a preview from onPreview', async () => {
    const onPreview = vi.fn().mockResolvedValue('{"a":1}\n');
    renderExportView({ onPreview, currentResultCount: 1 });
    fireEvent.click(screen.getByTestId('export-preview-btn'));
    expect(await screen.findByTestId('export-preview-output')).toHaveTextContent('{"a":1}');
    // binary format → button disabled
    fireEvent.click(screen.getByTestId('export-format-bson'));
    expect(screen.getByTestId('export-preview-btn')).toBeDisabled();
  });
});

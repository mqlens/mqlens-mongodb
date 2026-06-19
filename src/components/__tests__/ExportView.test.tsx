import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render-with-providers';
import { DialogProvider, useDialogs } from '../dialogs/DialogProvider';
import { ExportView } from '../ExportView';

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

function renderExportView(overrides: Partial<typeof baseProps> = {}) {
  const props = { ...baseProps, ...overrides };
  return renderWithProviders(
    <DialogProvider>
      <ExportView {...props} />
    </DialogProvider>
  );
}

/** Mirrors App handleExportForTab enough to exercise invoke + error toasts. */
function ExportViewHarness({
  currentResultCount = 3,
  invokeFails = false,
}: {
  currentResultCount?: number;
  invokeFails?: boolean;
}) {
  const { toast } = useDialogs();

  const onExport = async (format: 'json' | 'csv', scope: 'current' | 'full') => {
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

  it('disables current-result export buttons when there are no loaded documents', () => {
    renderExportView({ currentResultCount: 0 });
    expect(screen.getByTestId('export-current-json-btn')).toBeDisabled();
    expect(screen.getByTestId('export-current-csv-btn')).toBeDisabled();
  });

  it('starts a current-results JSON export with the selected format', () => {
    const onExport = vi.fn();
    renderExportView({ onExport });
    fireEvent.click(screen.getByTestId('export-current-json-btn'));
    expect(onExport).toHaveBeenCalledWith('json', 'current');
    fireEvent.click(screen.getByTestId('export-current-csv-btn'));
    expect(onExport).toHaveBeenCalledWith('csv', 'current');
  });

  it('starts a full-collection export in the chosen format', () => {
    const onExport = vi.fn();
    renderExportView({ onExport });
    fireEvent.click(screen.getByTestId('export-full-json-btn'));
    expect(onExport).toHaveBeenCalledWith('json', 'full');
    fireEvent.click(screen.getByTestId('export-full-csv-btn'));
    expect(onExport).toHaveBeenCalledWith('csv', 'full');
  });

  it('opens the Tasks tab from the header action', () => {
    const onOpenTasks = vi.fn();
    renderExportView({ onOpenTasks });
    fireEvent.click(screen.getByRole('button', { name: 'View Tasks' }));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it('starts a background export via invoke when full collection JSON is chosen', async () => {
    renderWithProviders(
      <DialogProvider>
        <ExportViewHarness />
      </DialogProvider>
    );

    fireEvent.click(screen.getByTestId('export-full-json-btn'));

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

    fireEvent.click(screen.getByTestId('export-full-json-btn'));

    expect(await screen.findByText('Export failed: disk full')).toBeInTheDocument();
  });
});

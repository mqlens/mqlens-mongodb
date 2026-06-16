import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/render-with-providers';
import App from '../../App';

vi.mock('../../lib/vault', () => ({
  getVaultStatus: vi.fn().mockResolvedValue('unlocked'),
  initializeVault: vi.fn(),
  unlockVault: vi.fn(),
  lockVault: vi.fn(),
  changeVaultPassword: vi.fn(),
  resetVault: vi.fn(),
  biometricStatus: vi.fn().mockResolvedValue({ available: false, biometryType: 0, enrolled: false }),
  biometricEnable: vi.fn(),
  biometricDisable: vi.fn(),
  notifyVaultUnlocked: vi.fn(),
}));

// Mock Tauri invoke function
const mockInvoke = vi.fn();
// Monaco does not render a usable DOM under jsdom. The aggregation stage editor
// (QueryEditor) wraps @monaco-editor/react, so mock it with a plain <textarea>
// that round-trips value/onChange — this keeps the existing stage tests, which
// drive `pipeline-stage-N textarea`, working against the real component shape.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, wrapperProps }: { value: string; onChange?: (v: string) => void; wrapperProps?: Record<string, unknown> }) => (
    <textarea
      data-testid={wrapperProps?.['data-testid'] as string | undefined}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: () => Promise.resolve('0.3.1'),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appConfigDir: () => Promise.resolve('/tmp/MQLens'),
}));

const saveMock = vi.fn();
const openMock = vi.fn();
const writeTextFileMock = vi.fn();
const readTextFileMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...a: any[]) => saveMock(...a),
  open: (...a: any[]) => openMock(...a),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...a: any[]) => writeTextFileMock(...a),
  readTextFile: (...a: any[]) => readTextFileMock(...a),
}));

// Mock Sidebar component
vi.mock('../Sidebar', () => ({
  Sidebar: ({ onSelectCollection, onSelectIndex, onCreateIndex, onDeleteIndex, onOpenSettings }: any) => (
    <div data-testid="mock-sidebar">
      <button data-testid="select-collection-btn" onClick={() => onSelectCollection('conn-1', 'sales_db', 'customers')}>
        Select Collection
      </button>
      <button data-testid="select-orders-collection-btn" onClick={() => onSelectCollection('conn-1', 'sales_db', 'orders')}>
        Select Orders
      </button>
      <button data-testid="select-index-btn" onClick={() => onSelectIndex('conn-1', 'sales_db', 'customers', 'email_1')}>
        Select Index
      </button>
      <button data-testid="create-index-btn" onClick={() => onCreateIndex && onCreateIndex('conn-1', 'sales_db', 'customers')}>
        Create Index
      </button>
      <button data-testid="mock-delete-index-btn" onClick={() => onDeleteIndex && onDeleteIndex('conn-1', 'sales_db', 'customers', 'email_1')}>
        Delete Index
      </button>
      <button data-testid="open-settings-btn" onClick={() => onOpenSettings && onOpenSettings()}>
        Open Settings
      </button>
    </div>
  ),
}));

describe('App Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_app_settings') {
        return Promise.resolve({});
      }
      return Promise.resolve([]);
    });
  });

  it('opens the Quick Start tab by default and shows bottom status bar with version info', async () => {
    renderWithProviders(<App />);

    // VaultGate resolves asynchronously — wait for workspace to mount.
    expect(await screen.findByTestId('quickstart-tab')).toBeInTheDocument();
    // Quick Start welcome hero + primary CTA text.
    expect(screen.getByText('Welcome to MQLens')).toBeInTheDocument();
    expect(screen.getAllByText('New connection').length).toBeGreaterThan(0);

    // Check Bottom status bar
    const bottomBar = screen.getByTestId('bottom-bar');
    expect(bottomBar).toBeInTheDocument();
    expect(screen.getByText('MQLens Engine Online')).toBeInTheDocument();
    // App version comes from getVersion() (no longer hardcoded); Tauri version removed.
    expect(await screen.findByText('MQLens v0.3.1')).toBeInTheDocument();
    expect(screen.queryByText(/Tauri v/)).toBeNull();
  });

  it('opens collection tab and index tab, and shows REAL index details (not fabricated)', async () => {
    // The index is named "email_1" but its real key pattern is { city: 1 } and it is
    // NON-unique. The old code guessed keys from the name and flagged anything containing
    // "email" as unique — so asserting "city" + Non-Unique proves real data is used.
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([
          JSON.stringify({ _id: '1', name: 'John Doe' })
        ]);
      }
      if (cmd === 'list_indexes') {
        return Promise.resolve([
          { name: '_id_', keys: '{"_id":1}', unique: true, sparse: false },
          { name: 'email_1', keys: '{"city":1}', unique: false, sparse: false },
        ]);
      }
      return Promise.resolve([]);
    });

    const { fireEvent } = await import('@testing-library/react');

    renderWithProviders(<App />);
    // Wait for VaultGate to resolve and Workspace to mount.
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(screen.getAllByText('customers')[0]).toBeInTheDocument();
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('select-index-btn'));
    expect(await screen.findByText('city')).toBeInTheDocument();
    expect(await screen.findByTestId('index-viewer')).toBeInTheDocument();

    // Real key field from the fetched spec, NOT derived from the name.
    expect(await screen.findByText('city')).toBeInTheDocument();
    expect(screen.queryByText('email')).not.toBeInTheDocument();
    // Real unique flag — the fabrication would have shown "Unique" for an *email* index.
    // (Appears in both the Constraints card and the properties list.)
    expect(screen.getAllByText('Non-Unique').length).toBeGreaterThan(0);
    expect(screen.queryByText('Unique')).not.toBeInTheDocument();
    // The old fabricated description must be gone.
    expect(screen.queryByText(/User-defined single field index/i)).not.toBeInTheDocument();
  });

  it('edits an index using its REAL spec, not specs guessed from the name (C2 regression)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'list_indexes') {
        return Promise.resolve([
          { name: 'email_1', keys: '{"city":1}', unique: false, sparse: false },
        ]);
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    fireEvent.click(screen.getByTestId('select-index-btn'));

    // Open the edit modal from the index viewer, then save unchanged.
    fireEvent.click(await screen.findByTestId('edit-index-btn'));
    expect(screen.getByTestId('index-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('save-index-btn'));

    // create_index must be called with the REAL key pattern + unique flag.
    await waitFor(() => {
      const createCall = calls.find((c) => c.cmd === 'create_index');
      expect(createCall).toBeTruthy();
      expect(createCall.args.keys).toBe('{"city":1}');
      expect(createCall.args.unique).toBe(false);
    });
  });

  it('handles create_index and delete_index flows', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'create_index') {
        return Promise.resolve();
      }
      if (cmd === 'delete_index') {
        return Promise.resolve();
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    // Click Create Index button in mock sidebar
    const createIndexBtn = screen.getByTestId('create-index-btn');
    fireEvent.click(createIndexBtn);

    // Verify IndexModal is open
    expect(screen.getByTestId('index-modal')).toBeInTheDocument();

    // Fill in index name
    const nameInput = screen.getByTestId('index-name-input');
    fireEvent.change(nameInput, { target: { value: 'custom_index' } });

    // Click Save Index
    const saveBtn = screen.getByTestId('save-index-btn');
    fireEvent.click(saveBtn);

    // Modal should close and create_index invoke should be called
    await waitFor(() => {
      expect(screen.queryByTestId('index-modal')).not.toBeInTheDocument();
    });
    expect(mockInvoke).toHaveBeenCalledWith('create_index', expect.objectContaining({
      id: 'conn-1',
      database: 'sales_db',
      collection: 'customers',
      indexName: 'custom_index',
    }));

    // Click Delete Index button in mock sidebar
    const deleteIndexBtn = screen.getByTestId('mock-delete-index-btn');
    fireEvent.click(deleteIndexBtn);

    // Verify delete_index invoke was called
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('delete_index', expect.objectContaining({
        id: 'conn-1',
        database: 'sales_db',
        collection: 'customers',
        indexName: 'email_1',
      }));
    });
  });

  it('deletes a document by its real _id (C1)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([
          JSON.stringify({ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'John Doe' }),
        ]);
      }
      if (cmd === 'delete_document') return Promise.resolve(1);
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId('delete-doc-btn')[0]);

    // Confirm via the in-app dialog instead of a native confirm().
    fireEvent.click(await screen.findByTestId('dialog-confirm'));

    await waitFor(() => {
      const del = calls.find((c) => c.cmd === 'delete_document');
      expect(del).toBeTruthy();
      expect(del.args).toMatchObject({
        id: 'conn-1',
        database: 'sales_db',
        collection: 'customers',
        filter: '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}',
      });
      expect(screen.getByText(/Document deleted from customers/)).toBeInTheDocument();
    });
  });

  it('deletes many by the current filter after a counted confirm (M7)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query')
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      if (cmd === 'count_documents') return Promise.resolve(7);
      if (cmd === 'delete_many') return Promise.resolve(7);
      return Promise.resolve([]);
    });
    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('delete-many-btn'));
    fireEvent.click(await screen.findByTestId('dialog-confirm'));

    await waitFor(() => {
      const dm = calls.find((c) => c.cmd === 'delete_many');
      expect(dm).toBeTruthy();
      expect(dm.args).toMatchObject({ database: 'sales_db', collection: 'customers' });
    });
  });

  it('updates many via an operator prompt + confirm (M7)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query')
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      if (cmd === 'count_documents') return Promise.resolve(3);
      if (cmd === 'update_many') return Promise.resolve(3);
      return Promise.resolve([]);
    });
    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('update-many-btn'));
    // Prompt for the update doc, then submit it.
    const input = await screen.findByTestId('dialog-input');
    fireEvent.change(input, { target: { value: '{"$set":{"tier":"Gold"}}' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    // Then the counted confirm dialog.
    fireEvent.click(await screen.findByTestId('dialog-confirm'));

    await waitFor(() => {
      const um = calls.find((c) => c.cmd === 'update_many');
      expect(um).toBeTruthy();
      expect(um.args).toMatchObject({
        database: 'sales_db',
        collection: 'customers',
        update: '{"$set":{"tier":"Gold"}}',
      });
    });
  });

  it('blocks update-many when the update is not operator-keyed (M7)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query')
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      if (cmd === 'count_documents') return Promise.resolve(3);
      return Promise.resolve([]);
    });
    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('update-many-btn'));
    const input = await screen.findByTestId('dialog-input');
    fireEvent.change(input, { target: { value: '{"tier":"Gold"}' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));

    // Validation blocks submit; no update_many call.
    expect(await screen.findByTestId('dialog-error')).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === 'update_many')).toBeFalsy();
  });

  it('inserts a new document (C1)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'insert_document') return Promise.resolve('"new-id"');
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('insert-doc-btn'));
    const input = await screen.findByTestId('document-json-input');
    fireEvent.change(input, { target: { value: '{"name":"Ada"}' } });
    fireEvent.click(screen.getByTestId('document-save-btn'));

    await waitFor(() => {
      const ins = calls.find((c) => c.cmd === 'insert_document');
      expect(ins).toBeTruthy();
      expect(ins.args.document).toBe('{"name":"Ada"}');
      expect(screen.getByText(/Document inserted into customers/)).toBeInTheDocument();
    });
  });

  it('edits a document via replace by _id (C1)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'update_document') return Promise.resolve(1);
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId('edit-doc-btn')[0]);
    const input = await screen.findByTestId('document-json-input');
    fireEvent.change(input, { target: { value: '{"_id":"1","name":"Ada"}' } });
    fireEvent.click(screen.getByTestId('document-save-btn'));

    await waitFor(() => {
      const upd = calls.find((c) => c.cmd === 'update_document');
      expect(upd).toBeTruthy();
      expect(upd.args.filter).toBe('{"_id":"1"}');
      expect(upd.args.replacement).toBe('{"_id":"1","name":"Ada"}');
      expect(screen.getByText(/Document saved in customers/)).toBeInTheDocument();
    });
  });

  it('opens settings as a workspace tab', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_app_settings') {
        return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
      }
      return Promise.resolve([]);
    });

    const { fireEvent } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-settings-btn'));

    expect(await screen.findByTestId('settings-view')).toBeInTheDocument();
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('settings-tab-mongosh'));
    expect(await screen.findByTestId('mongosh-path-input')).toHaveValue('/usr/local/bin/mongosh');
  });

  it('runs an aggregation pipeline via execute_aggregate, not a collapsed find (C4)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'execute_aggregate') {
        return Promise.resolve([JSON.stringify({ _id: null, count: 42 })]);
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    // Switch the query builder to aggregation mode and define a $group stage —
    // a stage the find-fallback path would silently drop.
    fireEvent.click(screen.getByTestId('mode-aggregate-tab'));
    const stage0 = screen.getByTestId('pipeline-stage-0');
    fireEvent.change(stage0.querySelector('select')!, { target: { value: '$group' } });
    fireEvent.change(stage0.querySelector('textarea')!, {
      target: { value: '{"_id":null,"count":{"$sum":1}}' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    // The full pipeline runs through execute_aggregate with the real $group stage.
    await waitFor(() => {
      const aggCall = calls.find((c) => c.cmd === 'execute_aggregate');
      expect(aggCall).toBeTruthy();
      expect(aggCall.args).toMatchObject({
        id: 'conn-1',
        database: 'sales_db',
        collection: 'customers',
        pipeline: JSON.stringify([{ $group: { _id: null, count: { $sum: 1 } } }]),
      });
    });
    // The aggregate result renders in the grid.
    expect(await screen.findByText(/42/)).toBeInTheDocument();
  });

  it('records query history after a successful run (H1)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    await waitFor(() => {
      const rec = calls.find((c) => c.cmd === 'record_history');
      expect(rec).toBeTruthy();
      expect(rec.args).toMatchObject({
        db: 'sales_db',
        collection: 'customers',
      });
      expect(rec.args.entry.query.queryType).toBe('find');
    });
  });

  it('loads a pinned default query when opening a collection (H1)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({
          saved: [],
          history: [],
          default: { queryType: 'find', filter: { vip: true }, sort: {}, projection: {}, limit: 50, skip: 0 },
        });
      }
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '9', name: 'VIP Vic' })]);
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));

    await waitFor(() => {
      const run = calls.find(
        (c) => c.cmd === 'execute_mql_query' && c.args.filter === '{"vip":true}'
      );
      expect(run).toBeTruthy();
    });
    expect(await screen.findByText(/"VIP Vic"/)).toBeInTheDocument();
  });

  it('imports documents from a JSON file via import_documents (H5)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'import_documents') {
        return Promise.resolve({ inserted: 2, updated: 0, skipped: 0 });
      }
      return Promise.resolve([]);
    });
    openMock.mockResolvedValue('/tmp/data.json');
    readTextFileMock.mockResolvedValue('[{"name":"Ada"},{"name":"Bob"}]');

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('import-btn'));

    // Pick the duplicate-handling mode via the in-app choose dialog.
    fireEvent.click(await screen.findByTestId('dialog-choice-skip'));

    await waitFor(() => {
      const imp = calls.find((c) => c.cmd === 'import_documents');
      expect(imp).toBeTruthy();
      expect(imp.args).toMatchObject({
        database: 'sales_db',
        collection: 'customers',
        mode: 'skip',
      });
      expect(imp.args.docs).toEqual([{ name: 'Ada' }, { name: 'Bob' }]);
    });
  });

  it('starts a background task for full collection export', async () => {
    const calls: any[] = [];
    const task = {
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
    };
    let tasks: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'start_collection_export') {
        tasks = [task];
        return Promise.resolve(task);
      }
      if (cmd === 'list_export_tasks') {
        return Promise.resolve(tasks);
      }
      return Promise.resolve([]);
    });
    saveMock.mockResolvedValue('/tmp/customers.full.json');

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-btn'));
    expect(await screen.findByTestId('export-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('export-full-json-btn'));

    await waitFor(() => {
      const exp = calls.find((c) => c.cmd === 'start_collection_export');
      expect(exp).toBeTruthy();
      expect(exp.args).toMatchObject({
        database: 'sales_db',
        collection: 'customers',
        format: 'json',
        path: '/tmp/customers.full.json',
      });
    });
    expect(await screen.findByTestId('task-manager')).toBeInTheDocument();
  });

  it('does not load profiles until the vault is unlocked', async () => {
    const vault = await import('../../lib/vault');
    (vault.getVaultStatus as any).mockResolvedValueOnce('locked');
    renderWithProviders(<App />);
    expect(await screen.findByTestId('vault-unlock')).toBeInTheDocument();
    // load_connection_profiles must not have been invoked while locked.
    expect(mockInvoke).not.toHaveBeenCalledWith('load_connection_profiles');
  });

  it('counts on collection open and advances skip on Next without recounting (M4)', async () => {
    const calls: Array<{ cmd: string; args?: any }> = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') return Promise.resolve(['{"_id":1}']);
      if (cmd === 'count_documents') return Promise.resolve(120);
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    // Open the collection — triggers execute_mql_query then count_documents.
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"_id"/)).toBeInTheDocument();

    // Wait for pager to appear (totalCount set after count).
    const pager = await screen.findByTestId('pager');
    expect(pager).toBeInTheDocument();

    // Page 1 / 3 (skip=0, limit=50, total=120, ceil(120/50)=3).
    await waitFor(() => {
      expect(screen.getByTestId('pager-page')).toHaveTextContent('1');
      expect(screen.getByTestId('pager-page')).toHaveTextContent('3');
      expect(screen.getByTestId('pager-total')).toHaveTextContent('120');
    });

    // count_documents was called exactly once (on open).
    const countCallsBefore = calls.filter(c => c.cmd === 'count_documents').length;
    expect(countCallsBefore).toBe(1);

    // Click Next — should call execute_mql_query with skip:50, NOT recount.
    fireEvent.click(screen.getByTestId('pager-next'));

    await waitFor(() => {
      const execCalls = calls.filter(c => c.cmd === 'execute_mql_query');
      expect(execCalls.some(c => c.args?.skip === 50)).toBe(true);
    });

    // count_documents must NOT have been called again (same filter).
    const countCallsAfter = calls.filter(c => c.cmd === 'count_documents').length;
    expect(countCallsAfter).toBe(1);
  });

  it('resets to page 1 and recounts when page size changes (M4)', async () => {
    const calls: Array<{ cmd: string; args?: any }> = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') return Promise.resolve(['{"_id":1}']);
      if (cmd === 'count_documents') return Promise.resolve(200);
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    await screen.findByTestId('pager');
    await waitFor(() => expect(screen.getByTestId('pager-total')).toHaveTextContent('200'));

    const countBefore = calls.filter(c => c.cmd === 'count_documents').length;
    expect(countBefore).toBe(1);

    // Change page size to 100 — filter is same so NO recount (skip resets to 0).
    fireEvent.change(screen.getByTestId('pager-size'), { target: { value: '100' } });

    await waitFor(() => {
      const execCalls = calls.filter(c => c.cmd === 'execute_mql_query');
      expect(execCalls.some(c => c.args?.limit === 100 && c.args?.skip === 0)).toBe(true);
    });

    // No extra count: same filter.
    const countAfter = calls.filter(c => c.cmd === 'count_documents').length;
    expect(countAfter).toBe(1);
  });

  it('aborts import on a malformed file without calling the backend (H5)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      return Promise.resolve([]);
    });
    openMock.mockResolvedValue('/tmp/bad.json');
    readTextFileMock.mockResolvedValue('{not valid json');

    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('import-btn'));

    // The malformed file surfaces an in-app error toast and no write happens.
    expect(await screen.findByText(/Import aborted/)).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === 'import_documents')).toBeFalsy();
  });

  it('isolates query editor state per collection tab (#120)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'Sample' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'count_documents') {
        return Promise.resolve(1);
      }
      return Promise.resolve([]);
    });

    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    // Open customers, type a custom filter.
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    await screen.findByText(/"Sample"/);
    fireEvent.click(screen.getByTestId('toggle-query-builder'));
    const filterInput = screen.getByTestId('query-filter-input') as HTMLTextAreaElement;
    fireEvent.change(filterInput, { target: { value: '{"status":"active"}' } });
    expect(filterInput.value).toContain('"status"');

    // Switch to orders — editor must reset to default {}, not carry over the filter.
    fireEvent.click(screen.getByTestId('select-orders-collection-btn'));
    await screen.findByText(/"Sample"/);
    fireEvent.click(screen.getByTestId('toggle-query-builder'));
    const ordersFilter = screen.getByTestId('query-filter-input') as HTMLTextAreaElement;
    expect(ordersFilter.value).toBe('{}');

    // Type a different filter on orders.
    fireEvent.change(ordersFilter, { target: { value: '{"shipped":true}' } });
    expect(ordersFilter.value).toContain('"shipped"');

    // Switch back to customers — customers filter must be restored.
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    await screen.findByText(/"Sample"/);
    fireEvent.click(screen.getByTestId('toggle-query-builder'));
    const customersFilterAgain = screen.getByTestId('query-filter-input') as HTMLTextAreaElement;
    expect(customersFilterAgain.value).toContain('"status"');

    // Switch back to orders — orders filter must be restored.
    fireEvent.click(screen.getByTestId('select-orders-collection-btn'));
    await screen.findByText(/"Sample"/);
    fireEvent.click(screen.getByTestId('toggle-query-builder'));
    const ordersFilterAgain = screen.getByTestId('query-filter-input') as HTMLTextAreaElement;
    expect(ordersFilterAgain.value).toContain('"shipped"');
  });
});

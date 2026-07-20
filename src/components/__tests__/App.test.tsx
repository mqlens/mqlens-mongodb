import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/render-with-providers';
import { resetUpdateTabStateDebounce } from '../../workspace/workspaceStore';
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

// Phase 3 Task 4: `listen` mocked to capture registered callbacks per event
// name so tests can fire a `workspace-changed`/`connections-changed` payload
// manually (Tauri has no real event channel under jsdom). `windowLabel()`
// itself is left unmocked — `@tauri-apps/api/webviewWindow`'s real
// `getCurrentWebviewWindow()` throws under jsdom (no `__TAURI_INTERNALS__`),
// which is exactly the fallback-to-`"main"` path every test below relies on
// ("running as main").
const eventListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();
function fireMockEvent(eventName: string, payload: unknown) {
  for (const cb of eventListeners.get(eventName) ?? []) cb({ payload });
}
vi.mock('@tauri-apps/api/event', () => ({
  listen: (eventName: string, cb: (event: { payload: unknown }) => void) => {
    const arr = eventListeners.get(eventName) ?? [];
    arr.push(cb);
    eventListeners.set(eventName, arr);
    return Promise.resolve(() => {
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    });
  },
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
const writeFileMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...a: any[]) => saveMock(...a),
  open: (...a: any[]) => openMock(...a),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...a: any[]) => writeTextFileMock(...a),
  writeFile: (...a: any[]) => writeFileMock(...a),
}));

// Mock Sidebar component
vi.mock('../Sidebar', () => ({
  Sidebar: ({ onSelectCollection, onSelectIndex, onCreateIndex, onDeleteIndex, onOpenSettings, onOpenDump, onOpenRestore, onEditValidation, onOpenGenerate, onDatabaseRenamed, activeConnections }: any) => (
    <div data-testid="mock-sidebar">
      {/* Phase 3 Task 6 (b): mirrors the real Sidebar's dependence on the
          `activeConnections` prop for its "Connections" tree — lets tests
          assert a connection landed in this window's sidebar without
          rendering the (heavy) real component. */}
      <ul data-testid="mock-sidebar-connections">
        {(activeConnections ?? []).map((c: any) => (
          <li key={c.id} data-testid={`sidebar-conn-${c.id}`}>{c.name}</li>
        ))}
      </ul>
      <button data-testid="select-collection-btn" onClick={() => onSelectCollection('conn-1', 'sales_db', 'customers')}>
        Select Collection
      </button>
      <button data-testid="select-orders-collection-btn" onClick={() => onSelectCollection('conn-1', 'sales_db', 'orders')}>
        Select Orders
      </button>
      <button
        data-testid="rename-db-btn"
        onClick={() => onDatabaseRenamed && onDatabaseRenamed('conn-1', 'sales_db', 'sales_db2')}
      >
        Rename sales_db
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
      <button data-testid="open-dump-db-btn" onClick={() => onOpenDump && onOpenDump('conn-1', 'sales_db')}>
        Dump sales_db
      </button>
      <button data-testid="open-restore-btn" onClick={() => onOpenRestore && onOpenRestore('conn-1')}>
        Restore
      </button>
      <button
        data-testid="open-validation-btn"
        onClick={() => onEditValidation && onEditValidation('conn-1', 'sales_db', 'customers')}
      >
        Validation Rules
      </button>
      <button
        data-testid="open-generate-coll-btn"
        onClick={() => onOpenGenerate && onOpenGenerate('conn-1', 'sales_db', 'customers')}
      >
        Generate Data (collection)
      </button>
      <button
        data-testid="open-generate-db-btn"
        onClick={() => onOpenGenerate && onOpenGenerate('conn-1', 'sales_db')}
      >
        Generate Data (database)
      </button>
    </div>
  ),
}));

// Mock ConnectionManager: the real component's full add/edit/test/connect
// form is exercised by its own dedicated test suite (ConnectionManager.test.tsx).
// Here only the `onConnect` callback's WIRING through App.tsx matters (Phase
// 3 Task 6's set_connection_meta call) — a single button that fires it with
// fixed args, gated on `isOpen` like the real modal.
vi.mock('../ConnectionManager', () => ({
  ConnectionManager: ({ isOpen, onConnect }: any) =>
    isOpen ? (
      <div data-testid="mock-connection-manager">
        <button
          data-testid="mock-cm-connect-btn"
          onClick={() => onConnect('cm-live-1', 'Staging Cluster', 'mongodb://staging', 'p-cm', '#fff')}
        >
          Connect
        </button>
      </div>
    ) : null,
}));

describe('App Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_app_settings') {
        return Promise.resolve({});
      }
      return Promise.resolve([]);
    });
    // `updateTabState`'s 500ms debounce (workspaceStore.ts) lives in
    // MODULE-level state, not component state — a real `setTimeout` a
    // previous test schedules (e.g. via a revived tab's eager query re-run)
    // outlives that test's own render/cleanup and can fire mid-WAY through
    // a later, unrelated test, recording a stray `workspace_apply` call
    // into THAT test's `calls` array (final fix wave: found while adding a
    // new test to this file shifted timing enough to expose it). Clearing
    // it here, before every test, keeps each test's `mockInvoke` call log
    // free of debounced fallout from whatever ran before it.
    resetUpdateTabStateDebounce();
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
    fireEvent.click(screen.getByTestId('settings-tab-tools'));
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

  it('opens the Import tab and starts a background import task', async () => {
    const calls: any[] = [];
    const task = {
      id: 'task-3',
      kind: 'import',
      label: 'Import into sales_db.customers',
      status: 'running',
      processed: 0,
      total: null,
      message: 'Queued',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: null,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'preview_import') {
        return Promise.resolve({ docs: [], columns: [], totalHint: null, error: null });
      }
      if (cmd === 'start_import_task') {
        return Promise.resolve(task);
      }
      if (cmd === 'list_export_tasks') {
        return Promise.resolve([task]);
      }
      return Promise.resolve([]);
    });
    openMock.mockResolvedValue('/tmp/d.jsonl');

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('import-btn'));
    expect(await screen.findByTestId('import-view')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('import-pick-file-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('import-file-path')).toHaveTextContent('/tmp/d.jsonl'));

    fireEvent.click(screen.getByTestId('import-run-btn'));

    await waitFor(() => {
      const imp = calls.find((c) => c.cmd === 'start_import_task');
      expect(imp).toBeTruthy();
      expect(imp.args).toMatchObject({
        database: 'sales_db',
        collection: 'customers',
        source: { path: '/tmp/d.jsonl' },
        format: 'ndjson',
        mode: 'skip',
      });
    });
    expect(await screen.findByTestId('task-manager')).toBeInTheDocument();
  });

  it('refreshes the source collection tab once its import task completes', async () => {
    vi.useFakeTimers();
    try {
      const calls: any[] = [];
      const runningTask = {
        id: 'task-import-refresh',
        kind: 'import',
        label: 'Import sales_db.customers from d.jsonl',
        status: 'running',
        processed: 0,
        total: null,
        message: 'Queued',
        path: null,
        error: null,
        createdAtMs: 1,
        finishedAtMs: null,
      };
      let taskStatus = 'running';
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'execute_mql_query') {
          return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
        }
        if (cmd === 'load_collection_queries') {
          return Promise.resolve({ saved: [], history: [], default: null });
        }
        if (cmd === 'preview_import') {
          return Promise.resolve({ docs: [], columns: [], totalHint: null, error: null });
        }
        if (cmd === 'start_import_task') {
          return Promise.resolve(runningTask);
        }
        if (cmd === 'list_export_tasks') {
          return Promise.resolve([{ ...runningTask, status: taskStatus }]);
        }
        return Promise.resolve([]);
      });
      openMock.mockResolvedValue('/tmp/d.jsonl');

      const { fireEvent } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await vi.waitFor(() => expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('select-collection-btn'));
      await vi.waitFor(() => expect(screen.getByText(/"John Doe"/)).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('import-btn'));
      await vi.waitFor(() => expect(screen.getByTestId('import-view')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('import-pick-file-btn'));
      await vi.waitFor(() =>
        expect(screen.getByTestId('import-file-path')).toHaveTextContent('/tmp/d.jsonl'));

      fireEvent.click(screen.getByTestId('import-run-btn'));
      await vi.waitFor(() =>
        expect(calls.some((c) => c.cmd === 'start_import_task')).toBe(true));

      const execCallsBefore = calls.filter((c) => c.cmd === 'execute_mql_query').length;

      // The task completes; the next poll tick should notice and re-run the
      // source collection tab's query.
      taskStatus = 'completed';
      await vi.advanceTimersByTimeAsync(1000);

      await vi.waitFor(() => {
        const execCallsAfter = calls.filter((c) => c.cmd === 'execute_mql_query').length;
        expect(execCallsAfter).toBeGreaterThan(execCallsBefore);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('previews through preview_import', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'preview_import') {
        return Promise.resolve({ docs: [], columns: [], totalHint: null, error: null });
      }
      return Promise.resolve([]);
    });
    openMock.mockResolvedValue('/tmp/d.jsonl');

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('import-btn'));
    fireEvent.click(screen.getByTestId('import-pick-file-btn'));

    await waitFor(
      () => {
        const prev = calls.find((c) => c.cmd === 'preview_import');
        expect(prev).toBeTruthy();
        expect(prev.args).toMatchObject({ format: 'ndjson', limit: 20 });
      },
      { timeout: 2000 }
    );
  });

  it('opens the Dump tab from a database context menu and detects mongo tools', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') {
        return Promise.resolve({
          mongodump: { path: '/usr/local/bin/mongodump', version: '100.9.4' },
          mongorestore: null,
        });
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));

    expect(await screen.findByTestId('dump-view')).toBeInTheDocument();
    expect(screen.getByText('Dump: sales_db')).toBeInTheDocument();
    await waitFor(() => {
      const detect = calls.find((c) => c.cmd === 'detect_mongo_tools');
      expect(detect).toBeTruthy();
      expect(detect.args).toMatchObject({ configuredDir: null });
    });
  });

  it('runs a dump (payload includes toolPath), opens Tasks, and cancels the running task', async () => {
    const calls: any[] = [];
    const dumpTask = {
      id: 'task-dump-1',
      kind: 'dump',
      label: 'Dump sales_db → out',
      status: 'running',
      processed: 0,
      total: null,
      message: 'Running',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: null,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') {
        return Promise.resolve({
          mongodump: { path: '/usr/local/bin/mongodump', version: '100.9.4' },
          mongorestore: null,
        });
      }
      if (cmd === 'preview_dump_command') return Promise.resolve('mongodump --db=sales_db');
      if (cmd === 'start_dump_task') return Promise.resolve(dumpTask);
      if (cmd === 'list_export_tasks') return Promise.resolve([dumpTask]);
      if (cmd === 'cancel_task') return Promise.resolve();
      return Promise.resolve([]);
    });
    openMock.mockResolvedValue('/tmp/dumpout');

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    expect(await screen.findByTestId('dump-view')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('dump-dest-path')).toHaveTextContent('/tmp/dumpout'));

    await waitFor(() => expect(screen.getByTestId('dump-run-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('dump-run-btn'));

    await waitFor(() => {
      const started = calls.find((c) => c.cmd === 'start_dump_task');
      expect(started).toBeTruthy();
      expect(started.args).toMatchObject({
        id: 'conn-1',
        toolPath: '/usr/local/bin/mongodump',
        options: expect.objectContaining({
          scope: { kind: 'db', db: 'sales_db' },
          target: { kind: 'folder', out: '/tmp/dumpout' },
        }),
      });
    });

    // Starting the dump opens the Tasks tab with the running task, cancellable.
    expect(await screen.findByTestId('task-manager')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      const cancelled = calls.find((c) => c.cmd === 'cancel_task');
      expect(cancelled).toBeTruthy();
      expect(cancelled.args).toMatchObject({ id: 'task-dump-1' });
    });
  });

  it('opens the Restore tab from the connection context menu', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'detect_mongo_tools') {
        return Promise.resolve({ mongodump: null, mongorestore: null });
      }
      return Promise.resolve([]);
    });

    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-restore-btn'));

    expect(await screen.findByTestId('restore-view')).toBeInTheDocument();
    expect(screen.getByText('Restore: conn-1')).toBeInTheDocument();
  });

  it('opens the Validation Rules tab from the collection context menu', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'get_collection_options') {
        return Promise.resolve({ validator: '{}', validationLevel: '', validationAction: '' });
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-validation-btn'));

    expect(await screen.findByTestId('validation-rules-view')).toBeInTheDocument();
    expect(screen.getByText('Validation: customers')).toBeInTheDocument();
    await waitFor(() => {
      const opts = calls.find((c) => c.cmd === 'get_collection_options');
      expect(opts).toBeTruthy();
      expect(opts.args).toMatchObject({ id: 'conn-1', database: 'sales_db', collection: 'customers' });
    });
  });

  it('opens the Generate Data tab from a collection context menu and infers the template (#91)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'infer_generate_template') {
        return Promise.resolve('{\n  "name": "$name"\n}');
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-generate-coll-btn'));

    expect(await screen.findByTestId('generate-view')).toBeInTheDocument();
    // Tab-bar label (tabLabelFor) and the view's own header — both derived
    // from the same tab, different text.
    expect(screen.getByText('Generate: customers')).toBeInTheDocument();
    expect(screen.getByText('Generate Data: sales_db.customers')).toBeInTheDocument();
    await waitFor(() => {
      const infer = calls.find((c) => c.cmd === 'infer_generate_template');
      expect(infer).toBeTruthy();
      expect(infer.args).toMatchObject({ id: 'conn-1', database: 'sales_db', collection: 'customers' });
    });
    // Switch to the raw editor to confirm the inferred template content
    // (rather than the builder-decoded rows) made it into the view.
    fireEvent.click(screen.getByTestId('generate-mode-raw'));
    expect(await screen.findByTestId('generate-raw-editor')).toHaveValue('{\n  "name": "$name"\n}');
  });

  it('opens the Generate Data tab from a database context menu with a starter template, no inference call (#91)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      return Promise.resolve([]);
    });

    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-generate-db-btn'));

    expect(await screen.findByTestId('generate-view')).toBeInTheDocument();
    // No collection segment — both the tab label and the view header fall
    // back to the bare database name.
    expect(screen.getByText('Generate: sales_db')).toBeInTheDocument();
    expect(screen.getByText('Generate Data: sales_db')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('generate-mode-raw'));
    const editor = await screen.findByTestId('generate-raw-editor');
    expect((editor as HTMLTextAreaElement).value).toContain('$name');
    expect(calls.some((c) => c.cmd === 'infer_generate_template')).toBe(false);
  });

  it('dedupes the Generate Data tab (collection) on a second open — same tab focused, not duplicated (#91)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'infer_generate_template') return Promise.resolve('{}');
      return Promise.resolve([]);
    });

    const { fireEvent, within } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-generate-coll-btn'));
    expect(await screen.findByTestId('generate-view')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('open-generate-coll-btn'));

    const tabStrip = screen.getByTestId('workspace-tab-strip');
    expect(within(tabStrip).getAllByText('Generate: customers')).toHaveLength(1);
  });

  it('refreshes the source collection tab once its generate task completes (#91)', async () => {
    vi.useFakeTimers();
    try {
      const calls: any[] = [];
      const runningTask = {
        id: 'task-generate-refresh',
        kind: 'generate',
        label: 'Generate → sales_db.customers',
        status: 'running',
        processed: 0,
        total: 100,
        message: 'Queued',
        path: null,
        error: null,
        createdAtMs: 1,
        finishedAtMs: null,
      };
      let taskStatus = 'running';
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'execute_mql_query') {
          return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
        }
        if (cmd === 'load_collection_queries') {
          return Promise.resolve({ saved: [], history: [], default: null });
        }
        if (cmd === 'infer_generate_template') {
          return Promise.resolve('{"name": "$name"}');
        }
        if (cmd === 'preview_generated_documents') {
          return Promise.resolve([]);
        }
        if (cmd === 'count_documents') {
          return Promise.resolve(0);
        }
        if (cmd === 'start_generate_task') {
          return Promise.resolve(runningTask);
        }
        if (cmd === 'list_export_tasks') {
          return Promise.resolve([{ ...runningTask, status: taskStatus }]);
        }
        return Promise.resolve([]);
      });

      const { fireEvent } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await vi.waitFor(() => expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('select-collection-btn'));
      await vi.waitFor(() => expect(screen.getByText(/"John Doe"/)).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('open-generate-coll-btn'));
      await vi.waitFor(() => expect(screen.getByTestId('generate-view')).toBeInTheDocument());
      await vi.advanceTimersByTimeAsync(500); // let the inferred template + first preview settle

      fireEvent.click(screen.getByTestId('generate-run-btn'));
      await vi.waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('dialog-confirm'));

      await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'start_generate_task')).toBe(true));

      const execCallsBefore = calls.filter((c) => c.cmd === 'execute_mql_query').length;

      // The task completes; the next poll tick should notice and re-run the
      // source collection tab's query — same watcher as the import case,
      // generalized to `task.kind === 'generate'`.
      taskStatus = 'completed';
      await vi.advanceTimersByTimeAsync(1000);

      await vi.waitFor(() => {
        const execCallsAfter = calls.filter((c) => c.cmd === 'execute_mql_query').length;
        expect(execCallsAfter).toBeGreaterThan(execCallsBefore);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  const managedStatusesFixture = [
    { name: 'database-tools', version: '100.9.4', installed: false, path: null },
    { name: 'mongosh', version: '2.3.1', installed: true, path: '/data/tools/mongosh/bin/mongosh' },
  ];

  it('opens the guided tool-setup dialog from the Dump guidance card and loads managed tool status', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    expect(await screen.findByTestId('dump-view')).toBeInTheDocument();
    expect(await screen.findByTestId('dump-tools-missing')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));

    expect(await screen.findByTestId('toolsetup-dialog')).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.some((c) => c.cmd === 'managed_tools_status')).toBe(true);
    });
    expect(await screen.findByTestId('toolsetup-check-database-tools')).toBeInTheDocument();
  });

  it('runs a tool install (payload includes tools/force), tracks the task in the dialog, and cancels it', async () => {
    const calls: any[] = [];
    const installTask = {
      id: 'task-tool-1',
      kind: 'tool_install',
      label: 'Install MongoDB tools',
      status: 'running',
      processed: 0,
      total: null,
      message: 'Downloading database-tools…',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: null,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      if (cmd === 'start_tool_install_task') return Promise.resolve(installTask);
      if (cmd === 'list_export_tasks') return Promise.resolve([installTask]);
      if (cmd === 'cancel_task') return Promise.resolve();
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    await screen.findByTestId('dump-view');
    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));
    await screen.findByTestId('toolsetup-check-database-tools');

    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));

    await waitFor(() => {
      const started = calls.find((c) => c.cmd === 'start_tool_install_task');
      expect(started).toBeTruthy();
      expect(started.args).toMatchObject({ tools: ['database-tools'], force: false });
    });

    expect(await screen.findByTestId('toolsetup-cancel-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toolsetup-cancel-btn'));

    await waitFor(() => {
      const cancelled = calls.find((c) => c.cmd === 'cancel_task');
      expect(cancelled).toBeTruthy();
      expect(cancelled.args).toMatchObject({ id: 'task-tool-1' });
    });
  });

  it('completing the tool install and clicking Done re-detects mongo tools, refreshes managed status, and closes the dialog', async () => {
    const calls: any[] = [];
    const completedTask = {
      id: 'task-tool-2',
      kind: 'tool_install',
      label: 'Install MongoDB tools',
      status: 'completed',
      processed: 2,
      total: 2,
      message: 'Installed database-tools, mongosh',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: 2,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      if (cmd === 'start_tool_install_task') return Promise.resolve(completedTask);
      if (cmd === 'list_export_tasks') return Promise.resolve([completedTask]);
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    await screen.findByTestId('dump-view');
    const detectCallCount = () => calls.filter((c) => c.cmd === 'detect_mongo_tools').length;
    const detectBefore = detectCallCount();

    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));
    await screen.findByTestId('toolsetup-check-database-tools');
    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));

    expect(await screen.findByTestId('toolsetup-done-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toolsetup-done-btn'));

    await waitFor(() => {
      expect(detectCallCount()).toBeGreaterThan(detectBefore);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('toolsetup-dialog')).not.toBeInTheDocument();
    });
  });

  it('renders the cancelled state in the guided tool-setup dialog when the install task is cancelled', async () => {
    const calls: any[] = [];
    const cancelledTask = {
      id: 'task-tool-3',
      kind: 'tool_install',
      label: 'Install MongoDB tools',
      status: 'cancelled',
      processed: 1,
      total: 2,
      message: 'Install cancelled',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: 2,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      if (cmd === 'start_tool_install_task') return Promise.resolve(cancelledTask);
      if (cmd === 'list_export_tasks') return Promise.resolve([cancelledTask]);
      return Promise.resolve([]);
    });

    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    await screen.findByTestId('dump-view');
    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));
    await screen.findByTestId('toolsetup-check-database-tools');
    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));

    expect(await screen.findByTestId('toolsetup-cancelled-heading')).toBeInTheDocument();
  });

  it('surfaces the real failure reason (task.error) instead of the generic task.message when the install task fails', async () => {
    const calls: any[] = [];
    const failedTask = {
      id: 'task-tool-4',
      kind: 'tool_install',
      label: 'Install MongoDB tools',
      status: 'failed',
      processed: 0,
      total: 2,
      message: 'Task failed',
      path: null,
      error: 'checksum mismatch — download corrupted or tampered',
      createdAtMs: 1,
      finishedAtMs: 2,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      if (cmd === 'start_tool_install_task') return Promise.resolve(failedTask);
      if (cmd === 'list_export_tasks') return Promise.resolve([failedTask]);
      return Promise.resolve([]);
    });

    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    await screen.findByTestId('dump-view');
    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));
    await screen.findByTestId('toolsetup-check-database-tools');
    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));

    const errorEl = await screen.findByTestId('toolsetup-error');
    expect(errorEl).toHaveTextContent('checksum mismatch — download corrupted or tampered');
    expect(errorEl).not.toHaveTextContent('Task failed');
  });

  it('closing the completed tool-setup dialog without Done still finalizes, and reopening shows the checklist', async () => {
    const calls: any[] = [];
    const completedTask = {
      id: 'task-tool-5',
      kind: 'tool_install',
      label: 'Install MongoDB tools',
      status: 'completed',
      processed: 2,
      total: 2,
      message: 'Installed database-tools, mongosh',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: 2,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      if (cmd === 'start_tool_install_task') return Promise.resolve(completedTask);
      if (cmd === 'list_export_tasks') return Promise.resolve([completedTask]);
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    await screen.findByTestId('dump-view');
    const detectCallCount = () => calls.filter((c) => c.cmd === 'detect_mongo_tools').length;

    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));
    await screen.findByTestId('toolsetup-check-database-tools');
    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));
    expect(await screen.findByTestId('toolsetup-done-btn')).toBeInTheDocument();

    // Close via the dialog's X (Radix onOpenChange(false)) instead of Done —
    // the completion side effects must still run.
    const detectBefore = detectCallCount();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('toolsetup-dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(detectCallCount()).toBeGreaterThan(detectBefore);
    });

    // Reopening shows the fresh checklist, not the stale completed screen.
    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));
    expect(await screen.findByTestId('toolsetup-check-database-tools')).toBeInTheDocument();
    expect(screen.queryByTestId('toolsetup-done-btn')).not.toBeInTheDocument();
  });

  it('a stale list_export_tasks response cannot clobber an optimistically inserted install task', async () => {
    const installTask = {
      id: 'task-tool-6',
      kind: 'tool_install',
      label: 'Install MongoDB tools',
      status: 'running',
      processed: 0,
      total: null,
      message: 'Downloading database-tools…',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: null,
    };
    // The FIRST list_export_tasks request (mount poll) is held open and only
    // resolves — empty, as fetched before the task registered — after the
    // optimistic insert. It must be dropped, not applied.
    let resolveStaleList!: (tasks: any[]) => void;
    const staleList = new Promise<any[]>((resolve) => { resolveStaleList = resolve; });
    let listCalls = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      if (cmd === 'start_tool_install_task') return Promise.resolve(installTask);
      if (cmd === 'list_export_tasks') {
        listCalls += 1;
        return listCalls === 1 ? staleList : Promise.resolve([installTask]);
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor, act } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    await screen.findByTestId('dump-view');
    fireEvent.click(await screen.findByTestId('dump-install-tools-btn'));
    await screen.findByTestId('toolsetup-check-database-tools');
    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));

    // The dialog tracks the optimistically inserted running task.
    expect(await screen.findByTestId('toolsetup-cancel-btn')).toBeInTheDocument();

    // The pre-insert snapshot resolves late and empty.
    await act(async () => {
      resolveStaleList([]);
    });

    // The dialog must NOT flash back to the checklist.
    await waitFor(() => {
      expect(screen.getByTestId('toolsetup-cancel-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('toolsetup-install-btn')).not.toBeInTheDocument();
    });
  });

  it('the dump guidance card "Open Settings" opens Settings on the Tools section', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_databases') return Promise.resolve(['sales_db']);
      if (cmd === 'list_collections') return Promise.resolve([{ name: 'customers', type: 'collection' }]);
      if (cmd === 'detect_mongo_tools') return Promise.resolve({ mongodump: null, mongorestore: null });
      if (cmd === 'managed_tools_status') return Promise.resolve(managedStatusesFixture);
      if (cmd === 'load_app_settings') return Promise.resolve({});
      return Promise.resolve([]);
    });

    const { fireEvent, within } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('open-dump-db-btn'));
    const guidance = await screen.findByTestId('dump-tools-missing');

    fireEvent.click(within(guidance).getByRole('button', { name: /open settings/i }));

    expect(await screen.findByTestId('settings-view')).toBeInTheDocument();
    // The Tools section (mongosh/tools paths) is active, not Appearance.
    expect(await screen.findByTestId('mongosh-path-input')).toBeInTheDocument();
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
    fireEvent.click(screen.getByTestId('export-full-btn'));

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

  it('sends options and skip/limit with a filtered export', async () => {
    const calls: any[] = [];
    const task = {
      id: 'task-2',
      kind: 'filtered_export',
      label: 'Export sales_db.customers as CSV',
      status: 'running',
      processed: 0,
      total: null,
      message: 'Queued',
      path: '/tmp/customers.filtered.csv',
      error: null,
      createdAtMs: 1,
      finishedAtMs: null,
    };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'start_filtered_export') {
        return Promise.resolve(task);
      }
      if (cmd === 'list_export_tasks') {
        return Promise.resolve([task]);
      }
      return Promise.resolve([]);
    });
    saveMock.mockResolvedValue('/tmp/customers.filtered.csv');

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-btn'));
    expect(await screen.findByTestId('export-view')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-format-csv'));
    fireEvent.change(screen.getByTestId('export-options-csv-delimiter'), { target: { value: ';' } });
    fireEvent.change(screen.getByTestId('export-filtered-skip'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('export-filtered-limit'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('export-filtered-btn'));

    await waitFor(() => {
      const exp = calls.find((c) => c.cmd === 'start_filtered_export');
      expect(exp).toBeTruthy();
      expect(exp.args).toMatchObject({
        format: 'csv',
        skip: 10,
        limit: 50,
        options: expect.objectContaining({ csv: expect.objectContaining({ delimiter: ';' }) }),
      });
    });
  });

  it('exports current results through format_current_docs', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'format_current_docs') {
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });
    saveMock.mockResolvedValue('/tmp/customers.json');

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-btn'));
    expect(await screen.findByTestId('export-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('export-current-btn'));

    await waitFor(() => {
      const exp = calls.find((c) => c.cmd === 'format_current_docs');
      expect(exp).toBeTruthy();
      expect(exp.args).toMatchObject({ format: 'json', path: expect.any(String) });
    });
  });

  it('copies current results to the clipboard as text', async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'format_current_docs') {
        return Promise.resolve('name\nA\n');
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-btn'));
    expect(await screen.findByTestId('export-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('export-copy-current-btn'));

    await waitFor(() => {
      const exp = calls.find((c) => c.cmd === 'format_current_docs');
      expect(exp).toBeTruthy();
      expect(exp.args).toMatchObject({ path: null });
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('name\nA\n'));
  });

  it('routes a pane-scoped export handler to the rendered pane\'s tab, not the focused pane (#97 review Fix 1)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([JSON.stringify({ _id: '1', name: 'John Doe' })]);
      }
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      if (cmd === 'sample_export_fields') {
        return Promise.resolve(['_id', 'name']);
      }
      return Promise.resolve([]);
    });

    const { fireEvent, waitFor } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    // Pane A: open "customers", then its Export tab (becomes the active tab).
    fireEvent.click(screen.getByTestId('select-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('export-btn'));
    expect(await screen.findByTestId('export-view')).toBeInTheDocument();

    // Split the active "Export: customers" tab into a new pane B. split_pane
    // focuses the fresh pane, and leaves pane A re-activated on "customers".
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(await screen.findByTestId('command-palette-input'), { target: { value: 'Split Right' } });
    fireEvent.click(await screen.findByText('Split Right'));

    // Refocus pane A (mousedown on an unfocused pane dispatches focus_pane).
    // PaneView's own testid is `pane-${pane.id}` (e.g. "pane-pane-1"); react-resizable-panels
    // also auto-sets `data-testid={id}` (e.g. "pane-1") on its wrapping Panel, so the
    // "pane-pane-" prefix is needed to select only PaneView's own element.
    const panes = screen.getAllByTestId(/^pane-pane-/);
    expect(panes).toHaveLength(2);
    fireEvent.mouseDown(panes[0]);

    // With pane A focused, open a DIFFERENT collection there. Pre-fix, the export
    // handlers read `activeTab`/the focused pane's state, so this is exactly the
    // (wrong) state they would have leaked into pane B's still-visible export tab.
    fireEvent.click(screen.getByTestId('select-orders-collection-btn'));
    expect(await screen.findByText(/"John Doe"/)).toBeInTheDocument();

    // Trigger pane B's (unfocused) ExportView. It must act on ITS OWN rendered
    // tab ("customers"), not the focused pane's active tab ("orders").
    fireEvent.click(screen.getByTestId('export-scan-fields-btn'));

    await waitFor(() => {
      const scan = calls.find((c) => c.cmd === 'sample_export_fields');
      expect(scan).toBeTruthy();
      expect(scan.args).toMatchObject({ database: 'sales_db', collection: 'customers' });
    });
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

  describe('session restore + Reconnect banner (#97 phase 2 Task 6)', () => {
    // Two collection tabs, both on profile p1, split into a row of two panes —
    // matches persistence.ts's toDisconnectedSnapshot wire shape (camelCase,
    // `profile:<profileId>` connection ids already baked into the tab ids).
    const workspaceSnapshot = {
      revision: 1,
      windows: [
        {
          id: 'main',
          focusedPaneId: 'pane-1',
          splitTree: {
            kind: 'split',
            id: 'split-1',
            dir: 'row',
            ratio: 0.5,
            children: [
              {
                kind: 'pane',
                id: 'pane-1',
                tabIds: ['profile:p1.sales_db.customers'],
                activeTabId: 'profile:p1.sales_db.customers',
              },
              {
                kind: 'pane',
                id: 'pane-2',
                tabIds: ['profile:p1.sales_db.orders'],
                activeTabId: 'profile:p1.sales_db.orders',
              },
            ],
          },
        },
      ],
      tabs: [
        {
          id: 'profile:p1.sales_db.customers',
          type: 'collection',
          profileId: 'p1',
          profileName: 'Prod Cluster',
          db: 'sales_db',
          collection: 'customers',
        },
        {
          id: 'profile:p1.sales_db.orders',
          type: 'collection',
          profileId: 'p1',
          profileName: 'Prod Cluster',
          db: 'sales_db',
          collection: 'orders',
        },
      ],
    };

    it('(a) restores a disconnected snapshot as ReconnectBanners, with no query invokes', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        return Promise.resolve([]);
      });

      renderWithProviders(<App />);

      const banners = await screen.findAllByTestId('reconnect-banner');
      expect(banners).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: /Reconnect Prod Cluster/ })).toHaveLength(2);

      expect(mockInvoke).not.toHaveBeenCalledWith('execute_mql_query', expect.anything());
      expect(mockInvoke).not.toHaveBeenCalledWith('execute_aggregate', expect.anything());
    });

    it('(b) clicking Reconnect resolves profiles + connect_db, revives all of the profile\'s tabs, and eagerly re-runs their queries', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('new-conn-1');
        if (cmd === 'execute_mql_query') {
          return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        }
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);

      const banners = await screen.findAllByTestId('reconnect-banner');
      expect(banners).toHaveLength(2);

      const [firstBtn] = screen.getAllByRole('button', { name: /Reconnect Prod Cluster/ });
      fireEvent.click(firstBtn);

      // One click on either pane's banner revives ALL tabs of that profile —
      // both panes' banners disappear and both mount real content.
      await waitFor(() => {
        expect(screen.queryAllByTestId('reconnect-banner')).toHaveLength(0);
      });
      expect(await screen.findAllByText(/"Ada"/)).toHaveLength(2);

      await waitFor(() => {
        const execCalls = calls.filter((c) => c.cmd === 'execute_mql_query');
        expect(execCalls).toHaveLength(2);
        expect(execCalls.every((c) => c.args?.id === 'new-conn-1')).toBe(true);
      });

      const connectCalls = calls.filter((c) => c.cmd === 'connect_db');
      expect(connectCalls).toHaveLength(1); // one connect_db for the whole profile, not per-tab
    });

    it('(b1) clicking two banners for the same profile back-to-back only connects once — IMPORTANT fix regression guard', async () => {
      // Both panes' banners share profileId p1. A synchronous double-click
      // (or two banners firing before either's setReconnectState commits) used
      // to both pass the busy check — reconnectState is render-captured, so
      // neither call could see the other's in-flight state yet — and each
      // called connect_db, leaking a connection. reconnectBusyRef is checked
      // and set synchronously at the top of handleReconnectProfile, before
      // any state update or await, so the second call must bail out.
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('new-conn-1');
        if (cmd === 'execute_mql_query') {
          return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        }
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor, act } = await import('@testing-library/react');
      renderWithProviders(<App />);

      const banners = await screen.findAllByTestId('reconnect-banner');
      expect(banners).toHaveLength(2);
      const buttons = screen.getAllByRole('button', { name: /Reconnect Prod Cluster/ });
      expect(buttons).toHaveLength(2);

      // Both clicks inside ONE `act()` so React defers re-rendering (and
      // therefore re-committing `reconnectState`) until after BOTH
      // synchronous handler prefixes have already run — reproducing the
      // real race: two banner clicks that each observe the SAME
      // pre-click `reconnectState` snapshot. Two separate `fireEvent.click`
      // calls (each with its own implicit act()) would let the first
      // click's state update flush and re-render before the second
      // fires, masking the race this test exists to catch.
      act(() => {
        fireEvent.click(buttons[0]);
        fireEvent.click(buttons[1]);
      });

      await waitFor(() => {
        expect(screen.queryAllByTestId('reconnect-banner')).toHaveLength(0);
      });

      const connectCalls = calls.filter((c) => c.cmd === 'connect_db');
      expect(connectCalls).toHaveLength(1); // NOT 2 — the second click must have been dropped
    });

    it('(b2) a missing profile surfaces "no longer exists" as the banner error, without connecting', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        if (cmd === 'load_connection_profiles') return Promise.resolve([]); // p1 is gone
        return Promise.resolve([]);
      });

      const { fireEvent } = await import('@testing-library/react');
      renderWithProviders(<App />);

      const [firstBtn] = await screen.findAllByRole('button', { name: /Reconnect Prod Cluster/ });
      fireEvent.click(firstBtn);

      // Both panes share the same profileId's error state — the error surfaces
      // on every banner for that profile, not just the one that was clicked.
      expect(await screen.findAllByText('Connection profile no longer exists')).toHaveLength(2);
      expect(mockInvoke).not.toHaveBeenCalledWith('connect_db', expect.anything());
      // Still disconnected — both banners remain.
      expect(screen.getAllByTestId('reconnect-banner')).toHaveLength(2);
    });

    it('(c) a null snapshot keeps the default Quick Start tab', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'workspace_get') return Promise.resolve(null);
        return Promise.resolve([]);
      });

      renderWithProviders(<App />);
      expect(await screen.findByTestId('quickstart-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument();
    });

    it('(d) banner click while the profile is already connected reuses the live connection — quick-connecting a profile that still has a ReconnectBanner clears it without a second connect_db (#97 phase 2 final review Fix 1)', async () => {
      // One window, two panes: pane-1 shows the Quick Start tab (so its
      // ConnectionCard is available to drive a quick-connect), pane-2 shows a
      // restored-but-disconnected tab for the same profile p1.
      const quickConnectSnapshot = {
        revision: 1,
        windows: [
          {
            id: 'main',
            focusedPaneId: 'pane-1',
            splitTree: {
              kind: 'split',
              id: 'split-1',
              dir: 'row',
              ratio: 0.5,
              children: [
                { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' },
                {
                  kind: 'pane',
                  id: 'pane-2',
                  tabIds: ['profile:p1.sales_db.customers'],
                  activeTabId: 'profile:p1.sales_db.customers',
                },
              ],
            },
          },
        ],
        tabs: [
          { id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' },
          {
            id: 'profile:p1.sales_db.customers',
            type: 'collection',
            profileId: 'p1',
            profileName: 'Prod Cluster',
            db: 'sales_db',
            collection: 'customers',
          },
        ],
      };

      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(quickConnectSnapshot);
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('live-1');
        if (cmd === 'execute_mql_query') return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);

      expect(await screen.findByTestId('reconnect-banner')).toBeInTheDocument();

      // Quick-connect the SAME profile from the Quick Start pane, not the
      // banner itself — this is the path that used to leave the banner
      // showing (it only rebound tabs on an explicit banner click), so a
      // later banner click would mint a duplicate `connect_db` for a
      // profile that's already connected.
      const connectCard = await screen.findByTestId('conn-card-p1');
      fireEvent.click(connectCard);

      // The rebind fires as part of the quick-connect itself — the banner
      // must be gone WITHOUT ever needing a click on it.
      await waitFor(() => {
        expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument();
      });

      const connectCalls = calls.filter((c) => c.cmd === 'connect_db');
      expect(connectCalls).toHaveLength(1); // NOT 2 — no duplicate backend connection for p1
    });

    it('(e) builder state seeded under the profile-space tab id survives reconnect (#97 phase 2 final review Fix 2)', async () => {
      const seededBuilderState = {
        queryMode: 'find',
        filterQuery: '{"seeded":true}',
        sortQuery: '{}',
        projectionQuery: '{}',
        limit: '50',
        skip: '0',
        stages: [{ id: 'stage-1', operator: '$match', content: '{\n  \n}' }],
      };
      const snapshotWithBuilderState = {
        revision: 1,
        windows: [
          {
            id: 'main',
            focusedPaneId: 'pane-1',
            splitTree: {
              kind: 'pane',
              id: 'pane-1',
              tabIds: ['profile:p1.sales_db.customers'],
              activeTabId: 'profile:p1.sales_db.customers',
            },
          },
        ],
        tabs: [
          {
            id: 'profile:p1.sales_db.customers',
            type: 'collection',
            profileId: 'p1',
            profileName: 'Prod Cluster',
            db: 'sales_db',
            collection: 'customers',
            builderState: seededBuilderState,
          },
        ],
      };

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'workspace_get') return Promise.resolve(snapshotWithBuilderState);
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('new-conn-1');
        if (cmd === 'execute_mql_query') return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);

      const [firstBtn] = await screen.findAllByRole('button', { name: /Reconnect Prod Cluster/ });
      fireEvent.click(firstBtn);

      await waitFor(() => {
        expect(screen.queryAllByTestId('reconnect-banner')).toHaveLength(0);
      });

      // The tab's id (and the builder-state cache entry seeded under its old
      // profile-space id) must both have been rebound onto the live
      // connection id — DocumentViewer's `initialBuilderState` reads the
      // cache under the tab's CURRENT id, so a filter of "{}" here would
      // mean the seeded state was dropped (leaked under the dead old id)
      // instead of re-keyed.
      const filterInput = await screen.findByTestId('query-filter-input');
      expect((filterInput as HTMLInputElement).value).toBe('{"seeded":true}');
    });
  });

  describe('dispatchWorkspace no-op mirror gate (#97 phase 2 final review Fix 3)', () => {
    it('does not mirror split_pane when it moves a pane\'s only tab (a frontend reducer no-op)', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      const { TAB_DRAG_MIME } = await import('../../workspace/PaneView');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // Open one collection tab, then close Quick Start — pane-1 now holds
      // exactly one tab ("customers"), which is also its active tab. (The
      // command palette's own "Split Right"/"Split Down" entries only ever
      // appear when a pane has MORE than one tab, so this exact reproduction
      // — a self-drop drag of a pane's only tab onto its own edge — is the
      // one the UI actually lets through to `dispatchWorkspace`.)
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      await screen.findByTestId('mock-sidebar');
      fireEvent.click(screen.getByRole('button', { name: 'Close Quick Start' }));
      await waitFor(() => {
        expect(screen.queryByTestId('quickstart-tab')).not.toBeInTheDocument();
      });
      expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);

      calls.length = 0; // only care about ops mirrored from the drop below

      // Drag the pane's own (only) tab and drop it on the pane's own right
      // edge — model.ts's split_pane case returns the SAME layout reference
      // for this ("would empty the source pane — pointless split"), so
      // dispatchWorkspace must skip the mirror.
      const pane = screen.getByTestId(/^pane-pane-/);
      const data: Record<string, string> = { [TAB_DRAG_MIME]: 'conn-1.sales_db.customers' };
      const dt = { getData: (k: string) => data[k] ?? '', setData: () => {}, types: [TAB_DRAG_MIME] };
      Object.defineProperty(pane, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }),
      });
      fireEvent.dragOver(pane, { dataTransfer: dt, clientX: 950, clientY: 250 });
      fireEvent.drop(pane, { dataTransfer: dt, clientX: 950, clientY: 250 });

      // No second pane ever appears (the frontend reducer itself no-opped).
      expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);
      const splitCalls = calls.filter((c) => c.cmd === 'workspace_apply' && (c.args?.op as any)?.type === 'split_pane');
      expect(splitCalls).toHaveLength(0);
    });

    it('does mirror a normal split_pane (pane has more than one tab)', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'execute_mql_query') return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // pane-1 now holds two tabs: Quick Start and "customers" (active).
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      expect(await screen.findAllByText(/"Ada"/)).toBeTruthy();

      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      fireEvent.change(await screen.findByTestId('command-palette-input'), { target: { value: 'Split Right' } });
      fireEvent.click(await screen.findByText('Split Right'));

      await waitFor(() => {
        expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(2);
      });
      const splitCalls = calls.filter((c) => c.cmd === 'workspace_apply' && (c.args?.op as any)?.type === 'split_pane');
      expect(splitCalls).toHaveLength(1);
    });

    it('mirrors both rename_tab dispatches from a single-tick rename storm', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'execute_mql_query') return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        return Promise.resolve([]);
      });

      const { fireEvent } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // Two collection tabs under the same connection+db — renaming the
      // database renames BOTH tabs, dispatched back-to-back in one
      // synchronous `forEach` (App.tsx's `handleDatabaseRenamed`).
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      expect(await screen.findAllByText(/"Ada"/)).toBeTruthy();
      fireEvent.click(screen.getByTestId('select-orders-collection-btn'));
      expect(await screen.findAllByText(/"Ada"/)).toBeTruthy();

      calls.length = 0; // only care about ops mirrored from the rename storm below

      fireEvent.click(screen.getByTestId('rename-db-btn'));

      const renameCalls = calls.filter((c) => c.cmd === 'workspace_apply' && (c.args?.op as any)?.type === 'rename_tab');
      expect(renameCalls).toHaveLength(2);
      const newIds = renameCalls.map((c) => (c.args.op as any).new_id).sort();
      expect(newIds).toEqual(['conn-1.sales_db2.customers', 'conn-1.sales_db2.orders']);
    });
  });

  describe('dispatchWorkspace trial-run id-counter parity (closing review amendment)', () => {
    it('a real split_pane commits pane-pane-2, not pane-pane-3 — the no-op mirror gate\'s trial reducer call must not itself consume a pane id', async () => {
      // The gate's trial run (see the previous describe block) calls
      // `workspaceReducer` purely for reference-identity comparison and
      // discards its result. Minting is a stateless scan of the layout being
      // reduced (model.ts's `nextPaneId`/`nextSplitId`, #197), so this test
      // needs no reset between runs: every App render starts from the same
      // fresh `pane-1` root regardless of what earlier tests in this file
      // minted, and the trial call above cannot leave any residue behind for
      // this test to inherit.
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_mql_query') return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // pane-1 (root) now holds two tabs: Quick Start and "customers" (active).
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      expect(await screen.findAllByText(/"Ada"/)).toBeTruthy();

      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      fireEvent.change(await screen.findByTestId('command-palette-input'), { target: { value: 'Split Right' } });
      fireEvent.click(await screen.findByText('Split Right'));

      await waitFor(() => {
        expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(2);
      });

      // Pre-fix: the discarded trial minted pane-2/split-1 for nothing, and
      // the real (render-time) application then minted pane-3/split-2 —
      // THAT is what got committed, one generation ahead of what the
      // mirrored op causes the backend to mint from its own, separately-
      // counted id space. Post-fix, the trial's mint is undone before the
      // real application runs, so the real one mints pane-2 — the same id a
      // single reducer application (matching the backend) would produce.
      expect(screen.getByTestId('pane-pane-2')).toBeInTheDocument();
      expect(screen.queryByTestId('pane-pane-3')).not.toBeInTheDocument();
    });
  });

  describe('foreign-event reconciliation (Phase 3 Task 4)', () => {
    it('(a) a foreign NON-crossWindow event is bystander-only: lastWorkspaceRef updates, layout/tabs untouched', async () => {
      const { fireEvent, waitFor, act, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // pane-1 now holds two already-known tabs: Quick Start + customers.
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      await within(screen.getByTestId('workspace-tab-strip')).findByText('customers');
      expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);

      // A DIFFERENT window's (win-1) LOCAL, non-crossWindow op — per the
      // backend's own guarantee (op_is_cross_window), this could only have
      // touched win-1's own tree, never main's. main's entry below is
      // deliberately a DIFFERENT shape (a 2-pane split) than what's
      // actually committed here, standing in for a stale/pre-mirror
      // snapshot — reconciling against it would be wrong, so it must be
      // ignored outright (CRITICAL fix, review round 1). win-1's own entry
      // claims 'conn-1.sales_db.orders' — reachable via the mock sidebar's
      // "select orders" button, used below to prove the ref DID update.
      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 1,
          origin: 'win-1',
          crossWindow: false,
          workspace: {
            revision: 1,
            windows: [
              {
                id: 'main',
                focusedPaneId: 'pane-1',
                splitTree: {
                  kind: 'split',
                  id: 'split-1',
                  dir: 'row',
                  ratio: 0.5,
                  children: [
                    { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' },
                    { kind: 'pane', id: 'pane-2', tabIds: [], activeTabId: null },
                  ],
                },
              },
              {
                id: 'win-1',
                focusedPaneId: 'pane-1',
                splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['conn-1.sales_db.orders'], activeTabId: 'conn-1.sales_db.orders' },
              },
            ],
            tabs: [
              { id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' },
              { id: 'conn-1.sales_db.orders', type: 'collection', profileId: '', profileName: '', db: 'sales_db', collection: 'orders' },
            ],
          },
        });
      });

      // Layout/tabs untouched — still exactly one pane, still "customers".
      await waitFor(() => {
        expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);
      });
      expect(within(screen.getByTestId('workspace-tab-strip')).getByText('customers')).toBeInTheDocument();

      // lastWorkspaceRef DID update, though (proven indirectly via the
      // cross-window open dedupe, the other consumer of that ref): opening
      // the tab this event said win-1 holds must be deduped/focus-routed,
      // not added locally — which is only possible if the bystander path
      // still updated lastWorkspaceRef even though it skipped hydrate/diff.
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        return Promise.resolve([]);
      });
      fireEvent.click(screen.getByTestId('select-orders-collection-btn'));
      await waitFor(() => {
        const focusCalls = calls.filter((c) => c.cmd === 'focus_window');
        expect(focusCalls).toHaveLength(1);
        expect(focusCalls[0].args).toEqual({ label: 'win-1' });
      });
      expect(within(screen.getByTestId('workspace-tab-strip')).queryByText('orders')).not.toBeInTheDocument();
    });

    it('(a2) a crossWindow event re-hydrates this window\'s layout', async () => {
      const { fireEvent, waitFor, act, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // pane-1 now holds two already-known tabs: Quick Start + customers.
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      await within(screen.getByTestId('workspace-tab-strip')).findByText('customers');
      expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);

      // A crossWindow op (move_tab_to_window/detach_tab/window_closed) —
      // the one class of event that CAN touch this window's tree even when
      // it didn't originate here. The broadcast carries the FULL workspace;
      // main's entry now shows a split with the two tabs this window
      // already knows about (no arriving/leaving).
      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 1,
          origin: 'win-1',
          crossWindow: true,
          workspace: {
            revision: 1,
            windows: [
              {
                id: 'main',
                focusedPaneId: 'pane-1',
                splitTree: {
                  kind: 'split',
                  id: 'split-1',
                  dir: 'row',
                  ratio: 0.5,
                  children: [
                    { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' },
                    {
                      kind: 'pane',
                      id: 'pane-2',
                      tabIds: ['conn-1.sales_db.customers'],
                      activeTabId: 'conn-1.sales_db.customers',
                    },
                  ],
                },
              },
              { id: 'win-1', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null } },
            ],
            tabs: [
              { id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' },
              { id: 'conn-1.sales_db.customers', type: 'collection', profileId: '', profileName: '', db: 'sales_db', collection: 'customers' },
            ],
          },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(2);
      });
    });

    it('(i) an unmirrored (export/import) tab survives a crossWindow reconcile — never in any snapshot, must not be dropped', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'execute_mql_query') return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        return Promise.resolve([]);
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { fireEvent, act, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      fireEvent.click(screen.getByTestId('select-collection-btn'));
      expect(await screen.findAllByText(/"Ada"/)).toBeTruthy();

      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      fireEvent.change(await screen.findByTestId('command-palette-input'), { target: { value: 'Export Collection' } });
      fireEvent.click(await screen.findByText('Export Collection…'));

      const tabStrip = screen.getByTestId('workspace-tab-strip');
      await within(tabStrip).findByText('Export: customers');

      calls.length = 0;

      // A crossWindow event affecting THIS window — main's backend tree
      // only ever lists quickstart + the collection tab (export tabs are
      // NEVER mirrored, toPersistedTab returns null for them), regardless
      // of what unrelated activity elsewhere triggered this event.
      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 1,
          origin: 'win-1',
          crossWindow: true,
          workspace: {
            revision: 1,
            windows: [
              {
                id: 'main',
                focusedPaneId: 'pane-1',
                splitTree: {
                  kind: 'pane',
                  id: 'pane-1',
                  tabIds: ['quickstart', 'conn-1.sales_db.customers'],
                  activeTabId: 'conn-1.sales_db.customers',
                },
              },
            ],
            tabs: [
              { id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' },
              { id: 'conn-1.sales_db.customers', type: 'collection', profileId: '', profileName: '', db: 'sales_db', collection: 'customers' },
            ],
          },
        });
      });

      // Still there — never treated as "leaving" (IMPORTANT fix, review
      // round 1: the leaving-set now excludes unmirroredTabIdsRef ids).
      expect(within(tabStrip).getByText('Export: customers')).toBeInTheDocument();
      // Grafted back into the LAYOUT tree too, not just left dangling in
      // tabs[] — no dev-mode layout/tabs[] desync warning.
      const desyncWarnings = consoleErrorSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          (c[0].includes('workspace layout references unknown tab') || c[0].includes('tabs[] contains ids missing'))
      );
      expect(desyncWarnings).toHaveLength(0);
      consoleErrorSpy.mockRestore();
    });

    it('(ii) an optimistic local open survives a foreign non-crossWindow event carrying an older (pre-mirror) snapshot', async () => {
      const { fireEvent, act, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // Local optimistic open — in a real app its mirror (workspace_apply)
      // is still in flight; nothing here waits for it.
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      const tabStrip = screen.getByTestId('workspace-tab-strip');
      await within(tabStrip).findByText('customers');

      // A foreign, non-crossWindow event from another window's UNRELATED
      // activity — its snapshot of main's tree predates this window's
      // local open (the backend hasn't processed that mirror yet), so it
      // still shows only Quick Start. Pre-fix, this would have hydrated
      // and wiped the just-opened tab (CRITICAL — review round 1). Post-fix:
      // bystander semantics mean this window is untouched by definition —
      // the race is trivially safe.
      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 1,
          origin: 'win-1',
          crossWindow: false,
          workspace: {
            revision: 1,
            windows: [
              { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' } },
              { id: 'win-1', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null } },
            ],
            tabs: [{ id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' }],
          },
        });
      });

      // Survives — this window was never touched by that event.
      expect(within(tabStrip).getByText('customers')).toBeInTheDocument();
    });

    it('(b) an arriving tab materializes and refreshes when its connection is already live locally', async () => {
      const workspaceSnapshot = {
        revision: 1,
        windows: [
          { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.sales_db.customers'], activeTabId: 'profile:p1.sales_db.customers' } },
        ],
        tabs: [
          { id: 'profile:p1.sales_db.customers', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'customers' },
        ],
      };
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('new-conn-1');
        if (cmd === 'execute_mql_query') return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor, act, within } = await import('@testing-library/react');
      renderWithProviders(<App />);

      // Reconnect p1 — establishes activeConnections=[{id:'new-conn-1',profileId:'p1',...}]
      // and rebinds the existing customers tab onto the live id.
      const [firstBtn] = await screen.findAllByRole('button', { name: /Reconnect Prod Cluster/ });
      fireEvent.click(firstBtn);
      await waitFor(() => {
        expect(screen.queryAllByTestId('reconnect-banner')).toHaveLength(0);
      });

      calls.length = 0; // only care about what the arriving event triggers below

      // A crossWindow event: main's tree now ALSO holds an `orders` tab for
      // the same profile p1 — arriving, and live (p1 is already connected
      // here). Reconciliation only ever runs for crossWindow events now
      // (bystander fix, review round 1) — a non-crossWindow event wouldn't
      // reach this diff at all.
      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 2,
          origin: 'win-1',
          crossWindow: true,
          workspace: {
            revision: 2,
            windows: [
              {
                id: 'main',
                focusedPaneId: 'pane-1',
                splitTree: {
                  kind: 'pane',
                  id: 'pane-1',
                  tabIds: ['profile:p1.sales_db.customers', 'profile:p1.sales_db.orders'],
                  activeTabId: 'profile:p1.sales_db.orders',
                },
              },
            ],
            tabs: [
              { id: 'profile:p1.sales_db.customers', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'customers' },
              { id: 'profile:p1.sales_db.orders', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'orders' },
            ],
          },
        });
      });

      // Materialized: shows up in the tab strip.
      expect(await within(screen.getByTestId('workspace-tab-strip')).findByText('orders')).toBeInTheDocument();
      // Live: refreshed automatically (re-ran the default query against the
      // now-live connection) without any user interaction.
      await waitFor(() => {
        const orderCalls = calls.filter((c) => c.cmd === 'execute_mql_query' && c.args?.collection === 'orders');
        expect(orderCalls.length).toBeGreaterThan(0);
        expect(orderCalls[0].args.id).toBe('new-conn-1');
      });
    });

    it('(c) a leaving tab is removed locally without mirroring a close', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'execute_mql_query') return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor, act, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      fireEvent.click(screen.getByTestId('select-collection-btn'));
      expect(await screen.findAllByText(/"Ada"/)).toBeTruthy();
      const tabStrip = screen.getByTestId('workspace-tab-strip');
      expect(within(tabStrip).getByText('customers')).toBeInTheDocument();

      calls.length = 0; // only care about what firing the event below does

      // A foreign event: main's tree now holds ONLY Quick Start — customers
      // left (moved/closed elsewhere).
      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 1,
          origin: 'win-1',
          crossWindow: true,
          workspace: {
            revision: 1,
            windows: [
              { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' } },
            ],
            tabs: [{ id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' }],
          },
        });
      });

      await waitFor(() => {
        expect(within(tabStrip).queryByText('customers')).not.toBeInTheDocument();
      });
      // Never mirrored — the window that moved/closed it already did.
      const mirrored = calls.filter((c) => c.cmd === 'workspace_apply');
      expect(mirrored).toHaveLength(0);
    });

    it('(d) a self-origin, non-cross-window event is ignored entirely', async () => {
      const { waitFor, act } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('quickstart-tab');
      expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);

      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 1,
          origin: 'main', // this window's own label
          crossWindow: false,
          workspace: {
            revision: 1,
            windows: [
              {
                id: 'main',
                focusedPaneId: 'pane-1',
                splitTree: {
                  kind: 'split',
                  id: 'split-1',
                  dir: 'row',
                  ratio: 0.5,
                  children: [
                    { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' },
                    { kind: 'pane', id: 'pane-2', tabIds: [], activeTabId: null },
                  ],
                },
              },
            ],
            tabs: [{ id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' }],
          },
        });
      });

      // Give any (incorrect) reconciliation a chance to run, then assert
      // nothing changed — still exactly one pane.
      await waitFor(() => {
        expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);
      });
    });

    it('(e) an out-of-order/replayed event (revision <= last seen) is dropped', async () => {
      const { act } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // crossWindow: true throughout — reconciliation (and therefore this
      // revision-replay guard) is only ever reached for crossWindow events
      // now (bystander fix, review round 1).
      const eventAt = (revision: number) => ({
        revision,
        origin: 'win-1',
        crossWindow: true,
        workspace: {
          revision,
          windows: [
            { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.sales_db.customers'], activeTabId: 'profile:p1.sales_db.customers' } },
          ],
          tabs: [
            { id: 'profile:p1.sales_db.customers', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'customers' },
          ],
        },
      });

      // revision 2 lands first — customers arrives.
      await act(async () => {
        fireMockEvent('workspace-changed', eventAt(2));
      });
      expect(await screen.findByText('customers')).toBeInTheDocument();

      // A STALE revision 1 replay tries to wipe main's tree back to empty —
      // it must be dropped entirely (by the revision check, before the
      // crossWindow gate is even reached), leaving revision 2's state intact.
      const staleEmpty = {
        revision: 1,
        origin: 'win-1',
        crossWindow: true,
        workspace: {
          revision: 1,
          windows: [{ id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null } }],
          tabs: [],
        },
      };
      await act(async () => {
        fireMockEvent('workspace-changed', staleEmpty);
      });

      // Still there — the stale event never applied.
      expect(screen.getByText('customers')).toBeInTheDocument();
    });

    it('(f) opening a tab already present in another window\'s tree does not add it locally (MANDATE)', async () => {
      const quickConnectWorkspace = {
        revision: 1,
        windows: [
          { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' } },
          { id: 'win-1', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['conn-1.sales_db.customers'], activeTabId: 'conn-1.sales_db.customers' } },
        ],
        tabs: [
          { id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' },
          { id: 'conn-1.sales_db.customers', type: 'collection', profileId: '', profileName: '', db: 'sales_db', collection: 'customers' },
        ],
      };
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(quickConnectWorkspace);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('quickstart-tab');

      // 'customers' (conn-1.sales_db.customers) is already open in win-1's
      // tree per the boot snapshot above (lastWorkspaceRef is seeded at
      // boot). Selecting it here (running as main) must not add it locally.
      fireEvent.click(screen.getByTestId('select-collection-btn'));

      await waitFor(() => {
        const focusCalls = calls.filter((c) => c.cmd === 'focus_window');
        expect(focusCalls).toHaveLength(1);
        expect(focusCalls[0].args).toEqual({ label: 'win-1' });
      });
      // Never added to this window's tab strip/pane.
      expect(screen.queryByText('customers')).not.toBeInTheDocument();
      expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);
    });

    it('(g) a connections-changed addition rebinds a restored profile\'s banner tabs without this window ever connecting itself', async () => {
      const workspaceSnapshot = {
        revision: 1,
        windows: [
          { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.sales_db.customers'], activeTabId: 'profile:p1.sales_db.customers' } },
        ],
        tabs: [
          { id: 'profile:p1.sales_db.customers', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'customers' },
        ],
      };
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        return Promise.resolve([]);
      });

      const { waitFor, act } = await import('@testing-library/react');
      renderWithProviders(<App />);

      expect(await screen.findByTestId('reconnect-banner')).toBeInTheDocument();

      // Another window connected p1 — this window never called connect_db.
      await act(async () => {
        fireMockEvent('connections-changed', {
          connections: [{ id: 'live-99', profileId: 'p1', name: 'Prod Cluster' }],
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument();
      });
      expect(calls.some((c) => c.cmd === 'connect_db')).toBe(false);
    });

    it('(h) the boot-time connection_list seed rebinds a restored profile\'s banner tab without any connect_db call (final whole-branch review Fix 2)', async () => {
      const workspaceSnapshot = {
        revision: 1,
        windows: [
          { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.sales_db.customers'], activeTabId: 'profile:p1.sales_db.customers' } },
        ],
        tabs: [
          { id: 'profile:p1.sales_db.customers', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'customers' },
        ],
      };
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        // Simulates a window spawned into an already-live session — another
        // window connected p1 before this one ever booted.
        if (cmd === 'connection_list') {
          return Promise.resolve([{ id: 'live-99', profileId: 'p1', name: 'Prod Cluster' }]);
        }
        return Promise.resolve([]);
      });

      const { waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);

      // Never even flashes a ReconnectBanner — the seed lands before the
      // hydrated tab renders as "disconnected".
      await waitFor(() => {
        expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument();
      });
      expect(await screen.findByTestId('sidebar-conn-live-99')).toHaveTextContent('Prod Cluster');
      expect(calls.some((c) => c.cmd === 'connect_db')).toBe(false);
    });
  });

  describe('cross-window connection + pref coherence (Phase 3 Task 6)', () => {
    it('(a1) a quick-connect from the Quick Start pane calls set_connection_meta for the fresh id', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('live-1');
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);

      const connectCard = await screen.findByTestId('conn-card-p1');
      fireEvent.click(connectCard);

      await waitFor(() => {
        expect(
          calls.some(
            (c) =>
              c.cmd === 'set_connection_meta' &&
              c.args?.id === 'live-1' &&
              c.args?.profileId === 'p1' &&
              c.args?.name === 'Prod Cluster',
          ),
        ).toBe(true);
      });
    });

    it('(a2) connecting via the ConnectionManager dialog calls set_connection_meta for the fresh id', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('quickstart-tab');

      fireEvent.click(screen.getAllByText('New connection')[0]);
      const connectBtn = await screen.findByTestId('mock-cm-connect-btn');
      fireEvent.click(connectBtn);

      await waitFor(() => {
        expect(
          calls.some(
            (c) =>
              c.cmd === 'set_connection_meta' &&
              c.args?.id === 'cm-live-1' &&
              c.args?.profileId === 'p-cm' &&
              c.args?.name === 'Staging Cluster',
          ),
        ).toBe(true);
      });
    });

    it('(a3) the fresh-connect branch of a ReconnectBanner click calls set_connection_meta for the new id', async () => {
      const workspaceSnapshot = {
        revision: 1,
        windows: [
          { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.sales_db.customers'], activeTabId: 'profile:p1.sales_db.customers' } },
        ],
        tabs: [
          { id: 'profile:p1.sales_db.customers', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'customers' },
        ],
      };
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('live-1');
        if (cmd === 'execute_mql_query') return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);

      expect(await screen.findByTestId('reconnect-banner')).toBeInTheDocument();
      fireEvent.click(screen.getByText(/Reconnect Prod Cluster/));

      await waitFor(() => {
        expect(
          calls.some(
            (c) =>
              c.cmd === 'set_connection_meta' &&
              c.args?.id === 'live-1' &&
              c.args?.profileId === 'p1' &&
              c.args?.name === 'Prod Cluster',
          ),
        ).toBe(true);
      });
      // The reuse branch (an id already in `activeConnections`) never calls
      // `connect_db`/`set_connection_meta` a second time — see App.tsx's
      // `handleReconnectProfile` comment. Nothing else exercises that branch
      // here, so this just confirms `set_connection_meta` fired exactly once.
      expect(calls.filter((c) => c.cmd === 'set_connection_meta')).toHaveLength(1);
    });

    it('(b) a connections-changed addition renders in this window\'s sidebar even though it never connected anything itself', async () => {
      const { act } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      expect(screen.queryByTestId('sidebar-conn-live-99')).not.toBeInTheDocument();

      await act(async () => {
        fireMockEvent('connections-changed', {
          connections: [{ id: 'live-99', profileId: 'p1', name: 'Prod Cluster' }],
        });
      });

      expect(await screen.findByTestId('sidebar-conn-live-99')).toHaveTextContent('Prod Cluster');
    });

    it('(b2) a connections-changed viaMcp addition for an ALREADY-connected profileId still renders its own sidebar row, badged "via MCP" (final fix wave, agent-connection visibility)', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('live-1');
        return Promise.resolve([]);
      });

      const { fireEvent, act } = await import('@testing-library/react');
      renderWithProviders(<App />);

      // This window connects p1 itself first (a human connection).
      const connectCard = await screen.findByTestId('conn-card-p1');
      fireEvent.click(connectCard);
      expect(await screen.findByTestId('sidebar-conn-live-1')).toHaveTextContent('Prod Cluster');

      // An MCP agent now also connects to the SAME profile (its own
      // `connect` tool call, backend-side, broadcast as `viaMcp: true`) —
      // previously `addActiveConnection`'s profileId dedupe silently
      // dropped this: a live backend connection no window ever displayed.
      await act(async () => {
        fireMockEvent('connections-changed', {
          connections: [
            { id: 'live-1', profileId: 'p1', name: 'Prod Cluster', viaMcp: false },
            { id: 'mcp-live-2', profileId: 'p1', name: 'Prod Cluster', viaMcp: true },
          ],
        });
      });

      // Both rows now render — the pre-existing human connection AND the
      // agent's own, distinct row for the same profile.
      expect(screen.getByTestId('sidebar-conn-live-1')).toBeInTheDocument();
      expect(await screen.findByTestId('sidebar-conn-mcp-live-2')).toHaveTextContent('Prod Cluster');
    });

    it('(d) a stale connection_meta entry for a profile already live locally under a different id is left alone (no disconnect_db)', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('live-1');
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor, act } = await import('@testing-library/react');
      renderWithProviders(<App />);

      const connectCard = await screen.findByTestId('conn-card-p1');
      fireEvent.click(connectCard);
      await waitFor(() => expect(calls.some((c) => c.cmd === 'connect_db')).toBe(true));

      calls.length = 0; // only the event handler's own reaction matters below

      // The backend broadcast still carries an id for p1 this window did NOT
      // mint (`live-old`) alongside the one it did (`live-1`) — the shape a
      // genuinely-orphaned meta entry AND a same-profile race with another
      // window are both indistinguishable in. Per App.tsx's comment, this is
      // deliberately left alone rather than risk killing a live connection.
      await act(async () => {
        fireMockEvent('connections-changed', {
          connections: [
            { id: 'live-1', profileId: 'p1', name: 'Prod Cluster' },
            { id: 'live-old', profileId: 'p1', name: 'Prod Cluster' },
          ],
        });
      });

      expect(calls.some((c) => c.cmd === 'disconnect_db')).toBe(false);
    });

    it('(e) a connections-changed removal tears down local tabs without double-mirroring the close', async () => {
      const workspaceSnapshot = {
        revision: 1,
        windows: [
          { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['profile:p1.sales_db.customers'], activeTabId: 'profile:p1.sales_db.customers' } },
        ],
        tabs: [
          { id: 'profile:p1.sales_db.customers', type: 'collection', profileId: 'p1', profileName: 'Prod Cluster', db: 'sales_db', collection: 'customers' },
        ],
      };
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'workspace_get') return Promise.resolve(workspaceSnapshot);
        if (cmd === 'execute_mql_query') return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const { waitFor, act, within } = await import('@testing-library/react');
      renderWithProviders(<App />);

      expect(await screen.findByTestId('reconnect-banner')).toBeInTheDocument();

      // Another window connected p1 first — rebinds this window's banner tab.
      await act(async () => {
        fireMockEvent('connections-changed', {
          connections: [{ id: 'live-99', profileId: 'p1', name: 'Prod Cluster' }],
        });
      });
      await waitFor(() => expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument());
      expect(within(screen.getByTestId('workspace-tab-strip')).getByText('customers')).toBeInTheDocument();

      calls.length = 0; // only what the REMOVAL itself triggers matters below

      // That connection is now gone from the broadcast — another window
      // disconnected it (or this one would have via Sidebar's onDisconnect,
      // which calls disconnect_db itself and is not exercised here).
      await act(async () => {
        fireMockEvent('connections-changed', { connections: [] });
      });

      await waitFor(() => {
        expect(within(screen.getByTestId('workspace-tab-strip')).queryByText('customers')).not.toBeInTheDocument();
      });
      // The close is a raw local `dispatchLayout`, never re-mirrored to the
      // backend workspace store — mirroring it again would double-apply the
      // same close backend-side (see App.tsx's "Removals" comment). The
      // tabs-empty effect firing afterward (main window resurrects Quick
      // Start) DOES call workspace_apply for an `open_tab` — this only
      // asserts no `close_many` op was ever mirrored.
      const closeManyMirrors = calls.filter((c) => c.cmd === 'workspace_apply' && c.args?.op?.type === 'close_many');
      expect(closeManyMirrors).toHaveLength(0);
      expect(calls.some((c) => c.cmd === 'disconnect_db')).toBe(false);
    });

    it('(f) a fresh local connect survives an unrelated connections-changed broadcast that never mentions it, and re-fires set_connection_meta (final whole-branch review Fix 3)', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('live-1');
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor, act } = await import('@testing-library/react');
      renderWithProviders(<App />);

      const connectCard = await screen.findByTestId('conn-card-p1');
      fireEvent.click(connectCard);
      await waitFor(() => expect(screen.getByTestId('sidebar-conn-live-1')).toBeInTheDocument());

      calls.length = 0; // only the broadcast handler's own reaction matters below

      // An unrelated broadcast lands — this window's own `set_connection_meta`
      // for p1 hasn't registered backend-side yet (a race), so the very
      // first connections-changed payload it ever sees doesn't mention p1
      // at all. p1's own connection id ('live-1') was never SEEN in any
      // prior broadcast (seenConnectionIdsRef is empty for it), so this
      // must NOT be treated as a removal.
      await act(async () => {
        fireMockEvent('connections-changed', {
          connections: [{ id: 'live-other', profileId: 'p-other', name: 'Other Cluster' }],
        });
      });

      // Still there — not torn down by a broadcast that has nothing to do
      // with it.
      expect(screen.getByTestId('sidebar-conn-live-1')).toBeInTheDocument();
      expect(calls.some((c) => c.cmd === 'disconnect_db')).toBe(false);
      // Self-healing re-registration: re-announces this window's own live
      // connection so the backend's connection_meta map (and hence the next
      // broadcast) catches up.
      await waitFor(() => {
        expect(
          calls.some(
            (c) => c.cmd === 'set_connection_meta' && c.args?.id === 'live-1' && c.args?.profileId === 'p1',
          ),
        ).toBe(true);
      });
    });

    it('(g) a broadcast carrying a DIFFERENT connection for the SAME profile does not tear down this window\'s own not-yet-announced connection (closing review residual fix)', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'load_connection_profiles') {
          return Promise.resolve([{ id: 'p1', name: 'Prod Cluster', uri: 'mongodb://prod', ssh: null }]);
        }
        if (cmd === 'connect_db') return Promise.resolve('live-1');
        return Promise.resolve([]);
      });

      const { fireEvent, waitFor, act } = await import('@testing-library/react');
      renderWithProviders(<App />);

      // This window connects p1 itself (a human connect_db) — 'live-1' is
      // added to activeConnections synchronously, but this window's own
      // `set_connection_meta` for it hasn't registered backend-side yet.
      const connectCard = await screen.findByTestId('conn-card-p1');
      fireEvent.click(connectCard);
      await waitFor(() => expect(screen.getByTestId('sidebar-conn-live-1')).toBeInTheDocument());

      calls.length = 0; // only the broadcast handler's own reaction matters below

      // A broadcast lands carrying a DIFFERENT connection id for the SAME
      // profile (an MCP agent's own `connect`, or a second window racing
      // this one) — NOT the local 'live-1' id, which this window's own
      // `set_connection_meta` hasn't announced backend-side yet. A
      // profileId-keyed seen-gate would mark p1 "seen" off this row alone
      // and tear down 'live-1' as if it had been genuinely removed; the
      // connection-id-keyed gate must not, since 'live-1' itself was never
      // mentioned in any broadcast.
      await act(async () => {
        fireMockEvent('connections-changed', {
          connections: [{ id: 'mcp-live-2', profileId: 'p1', name: 'Prod Cluster', viaMcp: true }],
        });
      });

      // This window's own connection (and its tabs) survive — not torn
      // down by a same-profile broadcast that isn't actually about it.
      expect(screen.getByTestId('sidebar-conn-live-1')).toBeInTheDocument();
      expect(calls.some((c) => c.cmd === 'disconnect_db')).toBe(false);
      expect(calls.some((c) => c.cmd === 'workspace_apply' && c.args?.op?.type === 'close_many')).toBe(false);
      // The agent's own row still renders (Fix 2's two-rows behavior is
      // unaffected by this fix).
      expect(await screen.findByTestId('sidebar-conn-mcp-live-2')).toBeInTheDocument();
      // Self-healing re-registration, not teardown: re-announces this
      // window's own live connection so the backend's connection_meta map
      // (and hence the next broadcast) catches up.
      await waitFor(() => {
        expect(
          calls.some(
            (c) => c.cmd === 'set_connection_meta' && c.args?.id === 'live-1' && c.args?.profileId === 'p1',
          ),
        ).toBe(true);
      });
    });
  });

  describe('tab context menu — detach/move (Phase 3 Task 5)', () => {
    // Seeds lastWorkspaceRef with a second open window (win-1, active tab
    // "orders") via a workspace-changed event — the same seeding technique
    // Task 4's reconciliation tests use. `crossWindow: false` is deliberate:
    // per the bystander fix, a non-crossWindow event still updates
    // lastWorkspaceRef (only the hydrate/diff is skipped), and updating the
    // ref is all this describe block's context-menu items read from.
    async function seedForeignWindow() {
      const { act } = await import('@testing-library/react');
      await act(async () => {
        fireMockEvent('workspace-changed', {
          revision: 1,
          origin: 'win-1',
          crossWindow: false,
          workspace: {
            revision: 1,
            windows: [
              { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['quickstart'], activeTabId: 'quickstart' } },
              { id: 'win-1', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['conn-1.sales_db.orders'], activeTabId: 'conn-1.sales_db.orders' } },
            ],
            tabs: [
              { id: 'quickstart', type: 'quickstart', profileId: '', profileName: '', db: '', collection: '' },
              { id: 'conn-1.sales_db.orders', type: 'collection', profileId: '', profileName: '', db: 'sales_db', collection: 'orders' },
            ],
          },
        });
      });
    }

    it('shows "Detach to New Window" and "Move to <window>" for a tab once this window has more than one tab open', async () => {
      const { fireEvent, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');
      await seedForeignWindow();

      // pane-1 now holds two tabs: Quick Start + customers.
      fireEvent.click(screen.getByTestId('select-collection-btn'));
      const tabStrip = screen.getByTestId('workspace-tab-strip');
      const customersTab = await within(tabStrip).findByText('customers');

      fireEvent.contextMenu(customersTab.closest('div')!);

      expect(await screen.findByTestId('context-menu')).toBeInTheDocument();
      expect(screen.getByText('Detach to New Window')).toBeInTheDocument();
      expect(screen.getByText('Move to win-1 (orders)')).toBeInTheDocument();
    });

    it('hides "Detach to New Window" when this window holds only one tab, but still offers "Move to <window>"', async () => {
      const { fireEvent, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');
      await seedForeignWindow();

      // Only the default Quick Start tab is open in this window.
      const tabStrip = screen.getByTestId('workspace-tab-strip');
      const quickstartTab = await within(tabStrip).findByText('Quick Start');
      fireEvent.contextMenu(quickstartTab.closest('div')!);

      expect(await screen.findByTestId('context-menu')).toBeInTheDocument();
      expect(screen.queryByText('Detach to New Window')).not.toBeInTheDocument();
      expect(screen.getByText('Move to win-1 (orders)')).toBeInTheDocument();
    });

    it('detaching calls workspace_detach_tab with this tab\'s id', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        return Promise.resolve([]);
      });
      const { fireEvent, within, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      fireEvent.click(screen.getByTestId('select-collection-btn'));
      const tabStrip = screen.getByTestId('workspace-tab-strip');
      const customersTab = await within(tabStrip).findByText('customers');
      calls.length = 0; // drop the open_tab mirror from selecting the collection above
      fireEvent.contextMenu(customersTab.closest('div')!);

      fireEvent.click(await screen.findByText('Detach to New Window'));

      await waitFor(() => {
        const detachCalls = calls.filter((c) => c.cmd === 'workspace_detach_tab');
        expect(detachCalls).toHaveLength(1);
        expect(detachCalls[0].args).toEqual({ tabId: 'conn-1.sales_db.customers', origin: 'main' });
      });
      // Never applied through the local layout reducer/dispatchWorkspace —
      // this window's own tree is untouched by the detach click itself,
      // only the crossWindow echo (not fired in this test) ever would be.
      expect(calls.some((c) => c.cmd === 'workspace_apply')).toBe(false);
    });

    it('moving to another window calls workspace_apply with move_tab_to_window and never touches this window\'s local layout', async () => {
      const calls: any[] = [];
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        calls.push({ cmd, args });
        return Promise.resolve([]);
      });
      const { fireEvent, within, waitFor } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');
      await seedForeignWindow();

      fireEvent.click(screen.getByTestId('select-collection-btn'));
      const tabStrip = screen.getByTestId('workspace-tab-strip');
      const customersTab = await within(tabStrip).findByText('customers');
      calls.length = 0;
      fireEvent.contextMenu(customersTab.closest('div')!);

      fireEvent.click(await screen.findByText('Move to win-1 (orders)'));

      await waitFor(() => {
        const moveCalls = calls.filter((c) => c.cmd === 'workspace_apply' && (c.args?.op as any)?.type === 'move_tab_to_window');
        expect(moveCalls).toHaveLength(1);
        expect(moveCalls[0].args).toEqual({
          op: { type: 'move_tab_to_window', tab_id: 'conn-1.sales_db.customers', target_window_id: 'win-1' },
          origin: 'main',
        });
      });
      // Final whole-branch review, Fix 4(b): also fires `focus_window` for
      // the target — the backend widens its contract to spawn `win-1` if
      // the store still lists it but no OS window is currently open (a
      // dead move target), so this self-heals instead of stranding the tab.
      await waitFor(() => {
        const focusCalls = calls.filter((c) => c.cmd === 'focus_window');
        expect(focusCalls).toHaveLength(1);
        expect(focusCalls[0].args).toEqual({ label: 'win-1' });
      });
      // CRITICAL: this window's own tab strip/pane is untouched by the
      // click itself — dispatchLayout was never called for this op, only
      // the crossWindow echo (not fired in this test) would ever remove it.
      expect(within(tabStrip).getByText('customers')).toBeInTheDocument();
      expect(screen.getAllByTestId(/^pane-pane-/)).toHaveLength(1);
    });

    it('hides both cross-window items for an unmirrored (export/import) tab, showing a disabled explanatory entry instead', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_mql_query') return Promise.resolve([JSON.stringify({ _id: '1', name: 'Ada' })]);
        return Promise.resolve([]);
      });
      const { fireEvent, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');
      await seedForeignWindow();

      fireEvent.click(screen.getByTestId('select-collection-btn'));
      expect(await screen.findAllByText(/"Ada"/)).toBeTruthy();
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      fireEvent.change(await screen.findByTestId('command-palette-input'), { target: { value: 'Export Collection' } });
      fireEvent.click(await screen.findByText('Export Collection…'));

      const tabStrip = screen.getByTestId('workspace-tab-strip');
      const exportTab = await within(tabStrip).findByText('Export: customers');
      fireEvent.contextMenu(exportTab.closest('div')!);

      expect(await screen.findByTestId('context-menu')).toBeInTheDocument();
      expect(screen.queryByText('Detach to New Window')).not.toBeInTheDocument();
      expect(screen.queryByText(/^Move to /)).not.toBeInTheDocument();
      const placeholder = screen.getByText('Export/import tabs stay in their window');
      expect(placeholder.closest('button')).toBeDisabled();
      expect(placeholder.closest('button')).toHaveAttribute('title', 'Export/import tabs stay in their window');
    });

    it('does not open an empty context menu for the sole tab when no other windows exist', async () => {
      const { fireEvent, within } = await import('@testing-library/react');
      renderWithProviders(<App />);
      await screen.findByTestId('mock-sidebar');

      // Only Quick Start is open, and no other windows were seeded — both
      // "Detach to New Window" and any "Move to" entries are absent, so
      // buildTabContextMenuItems returns [] and the menu must not open.
      const tabStrip = screen.getByTestId('workspace-tab-strip');
      const quickstartTab = await within(tabStrip).findByText('Quick Start');
      fireEvent.contextMenu(quickstartTab.closest('div')!);

      expect(screen.queryByTestId('context-menu')).not.toBeInTheDocument();
    });
  });
});

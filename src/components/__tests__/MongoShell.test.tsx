import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MongoShell } from '../MongoShell';
import { readShellSession, resetShellSessions, writeShellSession } from '../../lib/mongoshSession';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const mockOpenDialog = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: any[]) => mockOpenDialog(...args),
}));
const mockOpenUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: any[]) => mockOpenUrl(...args),
}));

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      aria-label="mongosh editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

describe('MongoShell Component', () => {
  beforeEach(() => {
    resetShellSessions();
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'get_mongodb_version') {
        return Promise.resolve('7.0.5');
      }
      if (cmd === 'load_app_settings') {
        return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
      }
      if (cmd === 'test_mongosh_path') {
        return Promise.resolve('2.1.1');
      }
      if (cmd === 'start_mongosh_session') {
        return Promise.resolve({ session_id: 'shell-session-1', stdout: [], stderr: [] });
      }
      if (cmd === 'run_mongosh_command') {
        return Promise.resolve({ stdout: ['mongosh result'], stderr: [] });
      }
      if (cmd === 'stop_mongosh_session') {
        return Promise.resolve();
      }
      // The backend returns Option<Value>; unknown tabs are null, not [].
      if (cmd === 'get_shell_tab_state') {
        return Promise.resolve(null);
      }
      if (cmd === 'set_shell_tab_state' || cmd === 'clear_shell_tab_state') {
        return Promise.resolve();
      }
      if (cmd === 'execute_mql_query') {
        return Promise.resolve([
          JSON.stringify({ _id: '1', name: 'Alice Smith', event_type: 'page_view' }),
        ]);
      }
      return Promise.resolve([]);
    });
  });

  it('auto-runs initial find command and shows documents in Data Viewer', async () => {
    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
        initialCommand="db.events.find({}).limit(50)"
      />
    );

    expect(await screen.findByText('Data Viewer')).toBeInTheDocument();
    expect(await screen.findByText(/"Alice Smith"/)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('start_mongosh_session', expect.objectContaining({
      connectionId: 'conn-1',
      uri: 'mongodb://prod-replica-set',
      database: 'user_analytics',
      mongoshPath: '/usr/local/bin/mongosh',
    }));
    expect(mockInvoke).toHaveBeenCalledWith('run_mongosh_command', expect.objectContaining({
      sessionId: 'shell-session-1',
      command: 'db.events.find({}).limit(50)',
    }));
    fireEvent.click(screen.getByRole('tab', { name: /console/i }));
    expect(await screen.findByText(/Current Mongosh Log ID:/)).toBeInTheDocument();
    expect(screen.getByText(/Connecting to: mock/)).toBeInTheDocument();
    expect(screen.queryByText(/mongodb:\/\/prod-replica-set/)).not.toBeInTheDocument();
    expect(screen.getByText(/Using MongoDB: 7.0.5\s+Using Mongosh: 2.1.1/)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('execute_mql_query', expect.objectContaining({
      id: 'conn-1',
      database: 'user_analytics',
      collection: 'events',
      filter: '{}',
      limit: 50,
      skip: 0,
    }));
  });

  it('runs edited shell command and renders returned documents', async () => {
    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="sales_db"
        collectionName="customers"
      />
    );

    // The shell is gated until the mongosh session attaches.
    await screen.findByText(/mongosh session attached/);

    fireEvent.change(screen.getByLabelText('mongosh editor'), {
      target: { value: 'db.customers.find({ name: "Alice Smith" }).limit(10)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

    await waitFor(() => {
      expect(screen.getByText('Data Viewer')).toBeInTheDocument();
    });
    // Exact match: the editor textarea also contains the substring "Alice Smith",
    // but only the result document renders it as a standalone JSON string token.
    expect(await screen.findByText('"Alice Smith"')).toBeInTheDocument();
  });

  it('opens the AI panel; Insert fills the command box without running', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
      if (cmd === 'test_mongosh_path') return Promise.resolve('2.1.1');
      if (cmd === 'start_mongosh_session')
        return Promise.resolve({ session_id: 'shell-session-1', stdout: [], stderr: [] });
      if (cmd === 'run_mongosh_command') return Promise.resolve({ stdout: ['ok'], stderr: [] });
      if (cmd === 'stop_mongosh_session') return Promise.resolve();
      if (cmd === 'generate_mql_query') {
        return Promise.resolve(
          JSON.stringify({ explanation: 'Counts users.', queryType: 'aggregate', pipeline: [{ $count: 'n' }] })
        );
      }
      return Promise.resolve([]);
    });

    render(
      <MongoShell
        connectionId="c1"
        connectionName="local"
        connectionUri="mongodb://x"
        databaseName="test-db"
        collectionName="users"
      />
    );

    // Wait for the session to attach so the shell (and AI toggle) render.
    await screen.findByText(/mongosh session attached/);

    fireEvent.click(screen.getByTestId('shell-ai-toggle'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'count users' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-insert-btn')).toBeInTheDocument());

    const runCalls = () => mockInvoke.mock.calls.filter((c) => c[0] === 'run_mongosh_command').length;
    const before = runCalls();
    fireEvent.click(screen.getByTestId('chat-insert-btn'));
    expect(runCalls()).toBe(before); // Insert does not execute.

    // The runnable aggregate command is dropped into the editor.
    expect((screen.getByLabelText('mongosh editor') as HTMLTextAreaElement).value).toContain(
      'db.users.aggregate('
    );
  });

  // Regression test: shell:mongoShell.toolbar.aiToggleLabel previously shipped
  // "KI" (the German abbreviation) in the *English* catalog, so English users
  // saw a toggle labelled "KI" instead of "AI". Locked down here under the
  // English locale that src/test/setup.ts initialises i18next with.
  it('renders the AI toggle button labelled "AI" under the English locale', async () => {
    render(
      <MongoShell
        connectionId="c1"
        connectionName="local"
        connectionUri="mongodb://x"
        databaseName="test-db"
        collectionName="users"
      />
    );

    await screen.findByText(/mongosh session attached/);

    const toggle = screen.getByTestId('shell-ai-toggle');
    expect(toggle).toHaveTextContent('AI');
    expect(toggle).not.toHaveTextContent('KI');
  });

  it('runs a multi-statement JS script through the mongosh session', async () => {
    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
      />
    );

    // Wait for the mongosh session to attach before running a script.
    await screen.findByText(/mongosh session attached/);

    fireEvent.change(screen.getByLabelText('mongosh editor'), {
      target: { value: 'const n = 2;\nprintjson(n);' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'run_mongosh_command',
        // runCommand strips a single trailing semicolon.
        expect.objectContaining({ command: 'const n = 2;\nprintjson(n)' })
      );
    });
    // A script does NOT go through the typed find path.
    const findCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'execute_mql_query');
    expect(findCalls.length).toBe(0);
  });

  it('treats input that only starts with db.coll.find() as a script, not a bare find', async () => {
    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
      />
    );
    await screen.findByText(/mongosh session attached/);

    fireEvent.change(screen.getByLabelText('mongosh editor'), {
      target: { value: 'db.events.find({}); var n = 2;' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'run_mongosh_command',
        expect.objectContaining({ command: 'db.events.find({}); var n = 2' })
      );
    });
    // It must not be reduced to a typed find().
    const findCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'execute_mql_query');
    expect(findCalls.length).toBe(0);
  });

  it('runs a $group aggregate through execute_aggregate (not a collapsed find)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
      if (cmd === 'test_mongosh_path') return Promise.resolve('2.1.1');
      if (cmd === 'start_mongosh_session')
        return Promise.resolve({ session_id: 'shell-session-1', stdout: [], stderr: [] });
      if (cmd === 'run_mongosh_command') return Promise.resolve({ stdout: ['ok'], stderr: [] });
      if (cmd === 'stop_mongosh_session') return Promise.resolve();
      if (cmd === 'execute_aggregate') {
        return Promise.resolve([JSON.stringify({ serviceName: 'billing' })]);
      }
      return Promise.resolve([]);
    });

    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="cfg"
        collectionName="services"
      />
    );

    await screen.findByText(/mongosh session attached/);

    fireEvent.change(screen.getByLabelText('mongosh editor'), {
      target: {
        value: 'db.services.aggregate([{ "$group": { "_id": "$serviceName" } }, { "$project": { "_id": 0, "serviceName": "$_id" } }])',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

    // The full pipeline goes to execute_aggregate, not a collapsed find.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'execute_aggregate',
        expect.objectContaining({
          id: 'conn-1',
          database: 'cfg',
          collection: 'services',
          pipeline: JSON.stringify([
            { $group: { _id: '$serviceName' } },
            { $project: { _id: 0, serviceName: '$_id' } },
          ]),
        })
      );
    });
    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'execute_mql_query').length).toBe(0);
    // The returned aggregate docs render in the Data Viewer.
    expect(await screen.findByText('"billing"')).toBeInTheDocument();
  });

  it('gates the shell with a setup screen when no mongosh session can start', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
      if (cmd === 'test_mongosh_path') return Promise.reject('not found');
      if (cmd === 'start_mongosh_session') return Promise.reject('mongosh not found');
      return Promise.resolve([]);
    });

    const onOpenSettings = vi.fn();
    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
        onOpenSettings={onOpenSettings}
      />
    );

    // Setup gate appears (failed state, after the session attempt resolves);
    // no editor is rendered.
    expect(await screen.findByTestId('gate-open-settings')).toBeInTheDocument();
    expect(screen.getByTestId('shell-session-gate')).toBeInTheDocument();
    expect(screen.queryByLabelText('mongosh editor')).toBeNull();

    // Open Settings is wired.
    fireEvent.click(screen.getByTestId('gate-open-settings'));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('retry re-attempts the mongosh session from the gate', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
      if (cmd === 'test_mongosh_path') return Promise.reject('not found');
      if (cmd === 'start_mongosh_session') return Promise.reject('mongosh not found');
      return Promise.resolve([]);
    });

    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
      />
    );

    await screen.findByTestId('gate-retry');
    const before = mockInvoke.mock.calls.filter((c) => c[0] === 'start_mongosh_session').length;
    fireEvent.click(screen.getByTestId('gate-retry'));
    await waitFor(() => {
      const after = mockInvoke.mock.calls.filter((c) => c[0] === 'start_mongosh_session').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('shows an Install tools button on the gate that opens the guided setup dialog', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
      if (cmd === 'test_mongosh_path') return Promise.reject('not found');
      if (cmd === 'start_mongosh_session') return Promise.reject('mongosh not found');
      return Promise.resolve([]);
    });

    const onInstallTools = vi.fn();
    render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
        onInstallTools={onInstallTools}
      />
    );

    fireEvent.click(await screen.findByTestId('shell-install-tools-btn'));
    expect(onInstallTools).toHaveBeenCalled();
  });

  it('re-attempts the mongosh session when reconnectSignal changes (tool-install Done)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
      if (cmd === 'test_mongosh_path') return Promise.reject('not found');
      if (cmd === 'start_mongosh_session') return Promise.reject('mongosh not found');
      return Promise.resolve([]);
    });

    const { rerender } = render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
        reconnectSignal={0}
      />
    );

    await screen.findByTestId('shell-session-gate');
    const before = mockInvoke.mock.calls.filter((c) => c[0] === 'start_mongosh_session').length;

    rerender(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
        reconnectSignal={1}
      />
    );

    await waitFor(() => {
      const after = mockInvoke.mock.calls.filter((c) => c[0] === 'start_mongosh_session').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('does not restart a healthy attached session when reconnectSignal changes', async () => {
    const { rerender } = render(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
        reconnectSignal={0}
      />
    );

    // Default mocks: the session attaches successfully.
    await screen.findByText(/mongosh session attached/);
    const sessionStarts = () =>
      mockInvoke.mock.calls.filter((c) => c[0] === 'start_mongosh_session').length;
    const before = sessionStarts();

    // A tool install completing bumps the signal for EVERY open shell tab —
    // a healthy session must not be torn down and restarted.
    rerender(
      <MongoShell
        connectionId="conn-1"
        connectionName="mock"
        connectionUri="mongodb://prod-replica-set"
        databaseName="user_analytics"
        collectionName="events"
        reconnectSignal={1}
      />
    );

    await waitFor(() => expect(sessionStarts()).toBe(before));
    expect(mockInvoke).not.toHaveBeenCalledWith('stop_mongosh_session', expect.anything());
    expect(screen.queryByTestId('shell-session-gate')).not.toBeInTheDocument();
  });

  it('gates a destructive AI script behind a confirm modal', async () => {
    const script = 'db.users.deleteMany({ active: false })';
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case 'get_mongodb_version':
          return Promise.resolve('7.0.0');
        case 'load_app_settings':
          return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
        case 'test_mongosh_path':
          return Promise.resolve('mongosh 2.0.0');
        case 'start_mongosh_session':
          return Promise.resolve({ session_id: 's1', stdout: [], stderr: [] });
        case 'run_mongosh_command':
          return Promise.resolve({ stdout: ['ok'], stderr: [] });
        case 'generate_mql_query':
          return Promise.resolve(
            JSON.stringify({ explanation: 'Removes inactive users.', queryType: 'script', script })
          );
        default:
          return Promise.resolve(null);
      }
    });

    render(
      <MongoShell
        connectionId="c1"
        connectionName="local"
        connectionUri="mongodb://localhost:27017"
        databaseName="test"
        collectionName="users"
      />
    );

    // Wait for the mongosh session to attach (the session gate clears).
    await screen.findByTestId('mongo-shell');

    // Open the AI panel, ask for a destructive script, generate it.
    fireEvent.click(screen.getByTestId('shell-ai-toggle'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'delete inactive users' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await screen.findByTestId('chat-query-card');

    // Insert & run -> the guard shows the modal instead of running.
    fireEvent.click(screen.getByTestId('chat-insert-run-btn'));
    const confirmDialog = await screen.findByTestId('destructive-confirm');
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'run_mongosh_command',
      expect.objectContaining({ command: script })
    );

    // Trans (shell:mongoShell.destructiveDialog.body) matches its JSX children
    // to the catalog's <strong> by tag/index and substitutes {{operation}} in
    // as the interpolated value — verify the emitted <strong> still carries
    // the className from the source JSX rather than losing it in that swap.
    const operationEl = within(confirmDialog).getByText('deleteMany');
    expect(operationEl.tagName).toBe('STRONG');
    expect(operationEl).toHaveClass('text-foreground');

    // Run anyway -> the script actually executes.
    fireEvent.click(screen.getByTestId('destructive-run'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'run_mongosh_command',
        expect.objectContaining({ command: script })
      )
    );
  });

  it('cancelling a destructive AI script does not run it', async () => {
    const script = 'db.users.drop()';
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case 'get_mongodb_version':
          return Promise.resolve('7.0.0');
        case 'load_app_settings':
          return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
        case 'test_mongosh_path':
          return Promise.resolve('mongosh 2.0.0');
        case 'start_mongosh_session':
          return Promise.resolve({ session_id: 's1', stdout: [], stderr: [] });
        case 'run_mongosh_command':
          return Promise.resolve({ stdout: [], stderr: [] });
        case 'generate_mql_query':
          return Promise.resolve(
            JSON.stringify({ explanation: 'Drops the collection.', queryType: 'script', script })
          );
        default:
          return Promise.resolve(null);
      }
    });

    render(
      <MongoShell
        connectionId="c1"
        connectionName="local"
        connectionUri="mongodb://localhost:27017"
        databaseName="test"
        collectionName="users"
      />
    );
    await screen.findByTestId('mongo-shell');

    fireEvent.click(screen.getByTestId('shell-ai-toggle'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'drop users' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await screen.findByTestId('chat-query-card');

    fireEvent.click(screen.getByTestId('chat-insert-run-btn'));
    fireEvent.click(await screen.findByTestId('destructive-cancel'));

    // Modal dismissed and the script never ran.
    await waitFor(() => expect(screen.queryByTestId('destructive-confirm')).not.toBeInTheDocument());
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'run_mongosh_command',
      expect.objectContaining({ command: script })
    );
  });

  describe('guided mongosh setup on session failure', () => {
    const renderFailedShell = (overrides: Record<string, (args: any) => any> = {}) => {
      mockInvoke.mockImplementation((cmd: string, args: any) => {
        if (overrides[cmd]) return overrides[cmd](args);
        if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
        if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
        if (cmd === 'test_mongosh_path') return Promise.reject(new Error('Failed to run mongosh'));
        if (cmd === 'start_mongosh_session')
          return Promise.reject(new Error('Failed to start mongosh'));
        if (cmd === 'detect_mongosh_binary') return Promise.resolve(null);
        if (cmd === 'save_app_settings') return Promise.resolve();
        return Promise.resolve([]);
      });
      render(
        <MongoShell
          connectionId="conn-1"
          connectionName="mock"
          connectionUri="mongodb://prod-replica-set"
          databaseName="sales_db"
        />
      );
    };

    it('offers a detected mongosh and saves it on confirmation', async () => {
      renderFailedShell({
        detect_mongosh_binary: () =>
          Promise.resolve({ path: '/opt/homebrew/bin/mongosh', version: '2.9.9', source: 'path' }),
      });

      expect(await screen.findByTestId('shell-detected-mongosh')).toHaveTextContent(
        /2\.9\.9.*\/opt\/homebrew\/bin\/mongosh|\/opt\/homebrew\/bin\/mongosh.*2\.9\.9/
      );
      fireEvent.click(screen.getByTestId('shell-use-detected-btn'));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          'save_app_settings',
          expect.objectContaining({
            settings: expect.objectContaining({ mongosh_path: '/opt/homebrew/bin/mongosh' }),
          })
        );
      });
      // Saving retries the session.
      const sessionAttempts = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'start_mongosh_session');
      await waitFor(() => {
        expect(
          mockInvoke.mock.calls.filter(([cmd]) => cmd === 'start_mongosh_session').length
        ).toBeGreaterThan(sessionAttempts.length - 1);
      });
    });

    it('lets the user browse for a binary and saves the pick', async () => {
      mockOpenDialog.mockResolvedValue('/custom/tools/mongosh');
      renderFailedShell();

      fireEvent.click(await screen.findByTestId('shell-browse-mongosh-btn'));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          'save_app_settings',
          expect.objectContaining({
            settings: expect.objectContaining({ mongosh_path: '/custom/tools/mongosh' }),
          })
        );
      });
    });

    it('re-attempts the session even when the picked binary equals the configured path', async () => {
      // Same path as already configured: without an explicit retry, the state
      // update is a no-op and the session would never be re-attempted.
      mockOpenDialog.mockResolvedValue('/already/configured/mongosh');
      renderFailedShell({
        load_app_settings: () => Promise.resolve({ mongosh_path: '/already/configured/mongosh' }),
      });

      const browseBtn = await screen.findByTestId('shell-browse-mongosh-btn');
      const attemptsBefore = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'start_mongosh_session'
      ).length;
      fireEvent.click(browseBtn);

      await waitFor(() => {
        expect(
          mockInvoke.mock.calls.filter(([cmd]) => cmd === 'start_mongosh_session').length
        ).toBeGreaterThan(attemptsBefore);
      });
    });

    it('shows install instructions and a MongoDB docs link when nothing is found', async () => {
      renderFailedShell();

      expect(await screen.findByTestId('shell-install-hint')).toBeInTheDocument();
      const docsLink = screen.getByTestId('shell-mongosh-docs-link');
      fireEvent.click(docsLink);
      await waitFor(() => {
        expect(mockOpenUrl).toHaveBeenCalledWith(
          expect.stringContaining('mongodb.com/docs/mongodb-shell')
        );
      });
    });
  });

  describe('session survives a tab switch (#240)', () => {
    const shellProps = {
      connectionId: 'conn-1',
      connectionName: 'mock',
      connectionUri: 'mongodb://prod-replica-set',
      databaseName: 'user_analytics',
    };
    const startCalls = () =>
      mockInvoke.mock.calls.filter((c) => c[0] === 'start_mongosh_session').length;
    const stopCalls = () =>
      mockInvoke.mock.calls.filter((c) => c[0] === 'stop_mongosh_session').length;

    it('does not kill the mongosh process when the tab is switched away', async () => {
      const { unmount } = render(<MongoShell {...shellProps} sessionKey="tab-shell-1" />);
      await waitFor(() => expect(startCalls()).toBe(1));

      unmount(); // user switches to another tab

      expect(stopCalls()).toBe(0);
    });

    it('reattaches to the running session instead of spawning a second one', async () => {
      const first = render(<MongoShell {...shellProps} sessionKey="tab-shell-1" />);
      await waitFor(() => expect(startCalls()).toBe(1));
      first.unmount();

      render(<MongoShell {...shellProps} sessionKey="tab-shell-1" />); // switched back

      await waitFor(() => expect(startCalls()).toBe(1));
      expect(stopCalls()).toBe(0);
    });

    it('does not re-run the opening command on every tab switch', async () => {
      // The auto-run guard was a component ref, so it reset on each mount.
      // Invisible while the transcript was wiped on every switch — once the
      // transcript survived, the same command re-executed and piled up.
      const runs = () =>
        mockInvoke.mock.calls.filter((c) => c[0] === 'run_mongosh_command').length;

      const first = render(
        <MongoShell {...shellProps} sessionKey="tab-shell-2" initialCommand="show collections" />
      );
      await waitFor(() => expect(runs()).toBe(1));
      first.unmount();

      render(
        <MongoShell {...shellProps} sessionKey="tab-shell-2" initialCommand="show collections" />
      );
      await waitFor(() => expect(startCalls()).toBe(1));

      expect(runs()).toBe(1);
    });

    it('keeps a session that finished starting after the tab was switched away', async () => {
      // Switching tabs mid-startup used to stop the session the moment it
      // arrived, because the cancellation branch could not tell "the user left
      // this tab" from "there is nobody to own this process".
      let resolveStart: (v: unknown) => void = () => {};
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
        if (cmd === 'test_mongosh_path') return Promise.resolve('2.1.1');
        if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
        if (cmd === 'start_mongosh_session') return new Promise((res) => { resolveStart = res; });
        return Promise.resolve([]);
      });

      const { unmount } = render(<MongoShell {...shellProps} sessionKey="tab-shell-3" />);
      await waitFor(() => expect(startCalls()).toBe(1));
      unmount();
      resolveStart({ session_id: 'late-session', stdout: [], stderr: [] });
      await new Promise((r) => setTimeout(r, 0));

      expect(stopCalls()).toBe(0);
      expect(readShellSession('tab-shell-3')?.sessionId).toBe('late-session');
    });

    it('keeps the AI helper open with its transcript across a tab switch', async () => {
      const first = render(<MongoShell {...shellProps} sessionKey="tab-shell-ai" />);
      await waitFor(() => expect(startCalls()).toBe(1));
      fireEvent.click(screen.getByTestId('shell-ai-toggle'));
      await screen.findByTestId('ai-helper-panel');
      first.unmount();

      render(<MongoShell {...shellProps} sessionKey="tab-shell-ai" />); // switched back

      expect(await screen.findByTestId('ai-helper-panel')).toBeInTheDocument();
    });

    it('restarts the session on demand without losing the scrollback', async () => {
      render(<MongoShell {...shellProps} sessionKey="tab-shell-restart" />);
      await waitFor(() => expect(startCalls()).toBe(1));

      fireEvent.click(screen.getByTestId('shell-restart-session'));

      // Old process stopped, a new session started, banner still on screen.
      await waitFor(() => expect(stopCalls()).toBe(1));
      await waitFor(() => expect(startCalls()).toBe(2));
      expect(screen.getByText(/Current Mongosh Log ID/)).toBeInTheDocument();
    });

    it('does not clobber output another instance appended off-screen', async () => {
      // Two instances exist whenever a command is still running as the user
      // switches away and back. The mounted one used to append against its own
      // React `prev`, so its next write — and the mirror effect behind it —
      // erased whatever the other instance had finished off-screen. Driven
      // through the registry rather than a second mount, because the registry
      // IS the shared transcript the two instances race over.
      render(<MongoShell {...shellProps} sessionKey="tab-shell-merge" />);
      await screen.findByText(/mongosh session attached/);

      // What the other instance's completion does.
      const stored = readShellSession('tab-shell-merge');
      writeShellSession('tab-shell-merge', {
        entries: [...(stored?.entries ?? []), { kind: 'text', lines: ['off-screen result'] }],
      });

      // Now this instance appends.
      fireEvent.change(screen.getByLabelText('mongosh editor'), {
        target: { value: 'db.events.countDocuments({})' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

      await waitFor(() => {
        const entries = readShellSession('tab-shell-merge')?.entries ?? [];
        // The other instance's output is still there...
        expect(
          entries.some((e) => e.kind === 'text' && e.lines.includes('off-screen result'))
        ).toBe(true);
        // ...and this instance's own input landed after it.
        expect(entries.some((e) => e.kind === 'input')).toBe(true);
      });
    });

    it('shows output that another instance finished off-screen, without waiting for a local append', async () => {
      // The old instance's completion writes to the registry and has no way to
      // reach this one. Before the subscription the output simply sat there,
      // invisible until this instance appended something of its own.
      render(<MongoShell {...shellProps} sessionKey="tab-shell-live" />);
      await screen.findByText(/mongosh session attached/);

      const stored = readShellSession('tab-shell-live');
      writeShellSession('tab-shell-live', {
        entries: [...(stored?.entries ?? []), { kind: 'text', lines: ['late arrival'] }],
      });

      expect(await screen.findByText('late arrival')).toBeInTheDocument();
    });

    it('a remount around a pending start ends up attached to exactly one child', async () => {
      // A start records nothing until it returns, so a remount partway through
      // saw an unattached tab and issued its own; the two ids then overwrote
      // each other and one child was left with nothing pointing at it.
      //
      // Which of the two guards this exercises depends on where the remount
      // lands relative to the start settling — before it, the shared pending
      // start dedupes; after it, the reattach check has to read the registry
      // live rather than the mount-time snapshot. The dedupe itself is pinned
      // deterministically in the registry suite; this covers the invariant the
      // user actually sees.
      let resolveStart: (v: unknown) => void = () => {};
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
        if (cmd === 'test_mongosh_path') return Promise.resolve('2.1.1');
        if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
        if (cmd === 'start_mongosh_session') return new Promise((res) => { resolveStart = res; });
        if (cmd === 'get_shell_tab_state') return Promise.resolve(null);
        return Promise.resolve([]);
      });

      const first = render(<MongoShell {...shellProps} sessionKey="tab-shell-join" />);
      await waitFor(() => expect(startCalls()).toBe(1));
      first.unmount();                                    // switched away
      render(<MongoShell {...shellProps} sessionKey="tab-shell-join" />); // and back

      // Still one start, and both instances are served by it.
      await waitFor(() => expect(startCalls()).toBe(1));
      resolveStart({ session_id: 'the-only-child', stdout: [], stderr: [] });

      await waitFor(() =>
        expect(readShellSession('tab-shell-join')?.sessionId).toBe('the-only-child')
      );
      expect(startCalls()).toBe(1);
    });

    it('stops a start that a retry has already superseded', async () => {
      // Retry tears the effect down and starts another attempt immediately.
      // Treating that like an unmount retained the first child, whose id the
      // second attempt then overwrote — leaving one mongosh process untracked.
      const starts: ((v: unknown) => void)[] = [];
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
        if (cmd === 'test_mongosh_path') return Promise.resolve('2.1.1');
        if (cmd === 'get_mongodb_version') return Promise.resolve('7.0.5');
        if (cmd === 'start_mongosh_session') return new Promise((res) => { starts.push(res); });
        return Promise.resolve([]);
      });

      const { rerender } = render(
        <MongoShell {...shellProps} sessionKey="tab-shell-retry" reconnectSignal={0} />
      );
      await waitFor(() => expect(starts).toHaveLength(1));

      // What a finished tool install does: bump the signal while the first
      // start is still pending.
      rerender(<MongoShell {...shellProps} sessionKey="tab-shell-retry" reconnectSignal={1} />);
      await waitFor(() => expect(starts).toHaveLength(2));

      // The first attempt only now returns — it has been replaced.
      starts[0]({ session_id: 'superseded', stdout: [], stderr: [] });
      await waitFor(() =>
        expect(
          mockInvoke.mock.calls.some(
            (c) => c[0] === 'stop_mongosh_session' && c[1]?.sessionId === 'superseded'
          )
        ).toBe(true)
      );
      // ...and it must not be the id the tab remembers.
      expect(readShellSession('tab-shell-retry')?.sessionId).not.toBe('superseded');
    });

    it('still tears the session down on unmount when it has no tab identity', async () => {
      // Callers that pass no sessionKey keep the old per-mount lifetime, so a
      // shell rendered outside the tab system cannot leak a process.
      const { unmount } = render(<MongoShell {...shellProps} />);
      await waitFor(() => expect(startCalls()).toBe(1));

      unmount();

      await waitFor(() => expect(stopCalls()).toBe(1));
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MongoShell } from '../MongoShell';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
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
    fireEvent.click(screen.getByRole('button', { name: /console/i }));
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
    await screen.findByTestId('destructive-confirm');
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'run_mongosh_command',
      expect.objectContaining({ command: script })
    );

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
});

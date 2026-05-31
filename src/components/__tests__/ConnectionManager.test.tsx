import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionManager, buildUri, buildSshConfig } from '../ConnectionManager';
import { DialogProvider } from '../dialogs/DialogProvider';

// ConnectionManager now uses the in-app dialog system, so it must render inside a provider.
const render = (ui: ReactElement) => rtlRender(<DialogProvider>{ui}</DialogProvider>);

// Mock Tauri invoke function
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  // Minimal Channel stub: the producer side calls `.onmessage(update)`.
  Channel: class {
    onmessage: ((m: any) => void) | null = null;
    send(m: any) {
      this.onmessage?.(m);
    }
  },
}));

const baseConn = {
  topology: 'standalone',
  hosts: [{ host: 'db.example.com', port: '27017' }],
  replicaSetName: '',
  directConnection: true,
  uri: 'mongodb://localhost:27017',
  authMethod: 'none',
  authUser: '',
  authPass: '',
  authDb: 'admin',
  tlsMode: 'off',
  tlsCa: '',
  tlsClientCert: '',
  tlsClientKey: '',
  tlsAllowInvalidHosts: false,
  tlsAllowInvalidCerts: false,
  readPreference: 'primary',
  compression: 'none',
  appName: '',
  defaultDb: '',
} as any;

describe('buildUri TLS handling (C8)', () => {
  it('adds tlsCAFile when TLS mode is "file" and a CA path is set', () => {
    const uri = buildUri({ ...baseConn, tlsMode: 'file', tlsCa: '/etc/ssl/ca.pem' });
    expect(uri).toContain('tls=true');
    expect(uri).toContain('tlsCAFile=%2Fetc%2Fssl%2Fca.pem');
  });

  it('emits tls=true without a CA file for system mode', () => {
    const uri = buildUri({ ...baseConn, tlsMode: 'system' });
    expect(uri).toContain('tls=true');
    expect(uri).not.toContain('tlsCAFile');
  });

  it('omits TLS params entirely when TLS is off', () => {
    const uri = buildUri({ ...baseConn, tlsMode: 'off', tlsCa: '/etc/ssl/ca.pem' });
    expect(uri).not.toContain('tls=true');
    expect(uri).not.toContain('tlsCAFile');
  });

  it('only disables validation when the explicit toggles are set (H8)', () => {
    const off = buildUri({ ...baseConn, tlsMode: 'system' });
    expect(off).not.toContain('tlsAllowInvalidCertificates');
    expect(off).not.toContain('tlsAllowInvalidHostnames');

    const on = buildUri({
      ...baseConn,
      tlsMode: 'system',
      tlsAllowInvalidCerts: true,
      tlsAllowInvalidHosts: true,
    });
    expect(on).toContain('tlsAllowInvalidCertificates=true');
    expect(on).toContain('tlsAllowInvalidHostnames=true');
  });
});

describe('buildUri timeouts + proxy (M2)', () => {
  it('emits connectTimeoutMS and serverSelectionTimeoutMS from the fields', () => {
    const uri = buildUri({ ...baseConn, connectTimeout: 8000, serverSelectionTimeout: 12000 });
    expect(uri).toContain('connectTimeoutMS=8000');
    expect(uri).toContain('serverSelectionTimeoutMS=12000');
  });

  it('emits SOCKS5 proxy params (host/port/user/pass) when proxy is enabled', () => {
    const uri = buildUri({
      ...baseConn,
      proxyEnabled: true,
      proxyType: 'socks5',
      proxyHost: 'proxy.internal',
      proxyPort: '1085',
      proxyUser: 'pu',
      proxyPass: 'p@ss',
    });
    expect(uri).toContain('proxyHost=proxy.internal');
    expect(uri).toContain('proxyPort=1085');
    expect(uri).toContain('proxyUsername=pu');
    expect(uri).toContain('proxyPassword=p%40ss');
  });

  it('defaults the proxy port to 1080 when blank', () => {
    const uri = buildUri({
      ...baseConn,
      proxyEnabled: true,
      proxyHost: 'proxy.internal',
      proxyPort: '',
    });
    expect(uri).toContain('proxyPort=1080');
  });

  it('omits proxy params when proxy is disabled or host missing', () => {
    const disabled = buildUri({ ...baseConn, proxyEnabled: false, proxyHost: 'proxy.internal' });
    expect(disabled).not.toContain('proxyHost');
    const noHost = buildUri({ ...baseConn, proxyEnabled: true, proxyHost: '' });
    expect(noHost).not.toContain('proxyHost');
  });
});

describe('buildUri external auth mechanisms (M5)', () => {
  it('x509: MONGODB-X509 + authSource=$external, username optional', () => {
    const withUser = buildUri({ ...baseConn, authMethod: 'x509', authUser: 'CN=client' });
    expect(withUser).toContain('authMechanism=MONGODB-X509');
    expect(withUser).toContain('authSource=$external');
    expect(withUser).toContain('@'); // username present in authority

    const noUser = buildUri({ ...baseConn, authMethod: 'x509', authUser: '' });
    expect(noUser).toContain('authMechanism=MONGODB-X509');
    expect(noUser).toContain('authSource=$external');
    expect(noUser).not.toContain('@'); // username derived from cert
  });

  it('aws: MONGODB-AWS + $external + creds; session token only when set', () => {
    const base = { ...baseConn, authMethod: 'aws', authUser: 'AKIA', authPass: 'secret' };
    const noToken = buildUri(base);
    expect(noToken).toContain('authMechanism=MONGODB-AWS');
    expect(noToken).toContain('authSource=$external');
    expect(noToken).toContain('AKIA:secret@');
    expect(noToken).not.toContain('AWS_SESSION_TOKEN');

    const withToken = buildUri({ ...base, awsSessionToken: 'tok/123' });
    expect(withToken).toContain('authMechanismProperties=AWS_SESSION_TOKEN:tok%2F123');
  });

  it('kerberos: GSSAPI + $external; service name only when set; no password', () => {
    const base = { ...baseConn, authMethod: 'kerberos', authUser: 'user@REALM', authPass: 'ignored' };
    const noSvc = buildUri(base);
    expect(noSvc).toContain('authMechanism=GSSAPI');
    expect(noSvc).toContain('authSource=$external');
    expect(noSvc).not.toContain(':ignored'); // GSSAPI uses a ticket, not a password
    expect(noSvc).not.toContain('SERVICE_NAME');

    const withSvc = buildUri({ ...base, kerberosServiceName: 'mongo-svc' });
    expect(withSvc).toContain('authMechanismProperties=SERVICE_NAME:mongo-svc');
  });

  it('ldap: PLAIN + $external + username/password', () => {
    const uri = buildUri({ ...baseConn, authMethod: 'ldap', authUser: 'lu', authPass: 'lp' });
    expect(uri).toContain('authMechanism=PLAIN');
    expect(uri).toContain('authSource=$external');
    expect(uri).toContain('lu:lp@');
  });

  it('scram still uses authSource=<authDb>, never $external (regression)', () => {
    const uri = buildUri({
      ...baseConn,
      authMethod: 'scram-256',
      authUser: 'admin',
      authPass: 'pw',
      authDb: 'myauthdb',
    });
    expect(uri).toContain('authSource=myauthdb');
    expect(uri).not.toContain('$external');
  });
});

describe('buildSshConfig (C7)', () => {
  const sshBase = {
    ...baseConn,
    sshEnabled: false,
    sshHost: '',
    sshPort: '22',
    sshUser: '',
    sshAuth: 'key',
    sshKey: '',
    sshPass: '',
  } as any;

  it('returns null when SSH is disabled', () => {
    expect(buildSshConfig({ ...sshBase, sshEnabled: false })).toBeNull();
  });

  it('builds a key-auth config with passphrase', () => {
    const cfg = buildSshConfig({
      ...sshBase,
      sshEnabled: true,
      sshHost: 'bastion.example.com',
      sshPort: '2222',
      sshUser: 'deploy',
      sshAuth: 'key',
      sshKey: '~/.ssh/id_ed25519',
      sshPass: 'secret',
    });
    expect(cfg).toEqual({
      enabled: true,
      host: 'bastion.example.com',
      port: 2222,
      user: 'deploy',
      auth: { type: 'key', path: '~/.ssh/id_ed25519', passphrase: 'secret' },
    });
  });

  it('builds a password-auth config', () => {
    const cfg = buildSshConfig({
      ...sshBase,
      sshEnabled: true,
      sshHost: 'h',
      sshUser: 'u',
      sshAuth: 'password',
      sshPass: 'pw',
    });
    expect(cfg?.auth).toEqual({ type: 'password', password: 'pw' });
  });
});

describe('ConnectionManager Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders connection manager list when opened', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([
          { id: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
          { id: 'profile-2', name: 'Prod Cluster', uri: 'mongodb://localhost:27017' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={() => {}}
      />
    );

    // Wait for profiles to render in the table/list tree
    await waitFor(() => {
      expect(screen.getAllByText('Mock DB 1')[0]).toBeInTheDocument();
      expect(screen.getAllByText('Prod Cluster')[0]).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /new\.\.\./i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
  });

  it('opens nested Connection Edit Dialog and allows saving new profile', async () => {
    let savedProfile: any = null;
    let profilesList = [
      { id: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
    ];

    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve(profilesList);
      }
      if (cmd === 'save_connection_profile') {
        savedProfile = args.profile;
        profilesList.push(args.profile);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={() => {}}
      />
    );

    // Click "New..."
    const newBtn = await screen.findByRole('button', { name: /new\.\.\./i });
    fireEvent.click(newBtn);

    // Verify Connection Edit Dialog nested modal is visible
    expect(screen.getByText('New Connection')).toBeInTheDocument();

    const nameInput = screen.getByLabelText(/display name/i);
    const uriInput = screen.getByLabelText(/connection uri/i);

    fireEvent.change(nameInput, { target: { value: 'Staging DB' } });
    fireEvent.change(uriInput, { target: { value: 'mongodb://staging:27017' } });

    // Click Save
    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    // Verify it called save command and closed the edit dialog
    await waitFor(() => {
      expect(savedProfile).toEqual({
        id: expect.any(String),
        name: 'Staging DB',
        uri: 'mongodb://staging:27017',
        ssh: null,
      });
      // The nested modal should be closed
      expect(screen.queryByText('New Connection')).not.toBeInTheDocument();
      // The new profile should be added to the list
      expect(screen.getAllByText('Staging DB')[0]).toBeInTheDocument();
    });
  });

  it('creates a new folder from the connection manager toolbar', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={() => {}}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /new folder/i }));

    const folderNameInput = screen.getByTestId('new-folder-name-input');
    fireEvent.change(folderNameInput, { target: { value: 'Production' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(screen.getAllByText('Production').length).toBeGreaterThan(0);
    });

    expect(screen.getByRole('option', { name: 'Production' })).toBeInTheDocument();
    expect(screen.queryByTestId('new-folder-name-input')).not.toBeInTheDocument();

    const storedFolders = JSON.parse(localStorage.getItem('mqlens_folders') || '[]');
    expect(storedFolders).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Production', parentId: null, shared: false }),
    ]));
  });

  it('runs step-by-step validation checklist during connection test', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([]);
      }
      if (cmd === 'test_connection_uri') {
        expect(args.uri).toBe('mongodb://mock');
        // Simulate the backend streaming each real phase through the channel.
        const emit = (phase: string, status: string) => args.onPhase.onmessage({ phase, status });
        for (const p of ['parse', 'resolve', 'connect', 'ping']) {
          emit(p, 'start');
          emit(p, 'ok');
        }
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={() => {}}
      />
    );

    // Open edit dialog
    const newBtn = await screen.findByRole('button', { name: /new\.\.\./i });
    fireEvent.click(newBtn);

    const uriInput = screen.getByLabelText(/connection uri/i);
    fireEvent.change(uriInput, { target: { value: 'mongodb://mock' } });

    // Click Test Connection
    const testBtn = screen.getByRole('button', { name: /test connection/i });
    fireEvent.click(testBtn);

    // Verify validation steps appear and eventually succeed
    await waitFor(() => {
      expect(screen.getByText('Parse Connection URI')).toBeInTheDocument();
      expect(screen.getByText('Resolve Host & Port')).toBeInTheDocument();
      expect(screen.getByText('Initialize Driver Client')).toBeInTheDocument();
      expect(screen.getByText('Verify Connection (Ping)')).toBeInTheDocument();
    });

    // Steps painted from real phase updates; overall test reports success.
    await waitFor(() => {
      expect(screen.getByText('Connection test successful')).toBeInTheDocument();
    });
  });

  it('displays error message if test connection step fails', async () => {
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([]);
      }
      if (cmd === 'test_connection_uri') {
        // Parse + resolve pass, then the connect phase fails.
        const emit = (phase: string, status: string, message?: string) =>
          args.onPhase.onmessage({ phase, status, message });
        emit('parse', 'start');
        emit('parse', 'ok');
        emit('resolve', 'start');
        emit('resolve', 'ok');
        emit('connect', 'start');
        emit('connect', 'fail', 'Connection timed out');
        return Promise.reject('Connection timed out');
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={() => {}}
      />
    );

    // Open edit dialog
    const newBtn = await screen.findByRole('button', { name: /new\.\.\./i });
    fireEvent.click(newBtn);

    const uriInput = screen.getByLabelText(/connection uri/i);
    fireEvent.change(uriInput, { target: { value: 'mongodb://invalid' } });

    // Click Test Connection
    const testBtn = screen.getByRole('button', { name: /test connection/i });
    fireEvent.click(testBtn);

    // Verify error feedback is displayed
    await waitFor(() => {
      expect(screen.getByText('Connection timed out')).toBeInTheDocument();
    }, { timeout: 4000 });
  });

  it('calls connect_db and triggers onConnect callback when Connect is clicked', async () => {
    const handleConnect = vi.fn();
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([
          { id: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
        ]);
      }
      if (cmd === 'connect_db') {
        expect(args.uri).toBe('mongodb://mock');
        return Promise.resolve('conn-abc-123');
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={handleConnect}
      />
    );

    // Wait for profile to load
    let profileNode: HTMLElement | null = null;
    await waitFor(() => {
      const nodes = screen.getAllByText('Mock DB 1');
      expect(nodes.length).toBeGreaterThan(0);
      profileNode = nodes[0];
    });
    if (profileNode) {
      fireEvent.click(profileNode);
    }

    // Click Connect button
    const connectBtn = screen.getByRole('button', { name: /^connect$/i });
    fireEvent.click(connectBtn);

    // Verify it called connect_db and passed connection ID to callback
    await waitFor(() => {
      expect(handleConnect).toHaveBeenCalledWith('conn-abc-123', 'Mock DB 1', 'mongodb://mock', 'profile-1');
    });
  });

  it('displays green connection status dot for active connections', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([
          { id: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
          { id: 'profile-2', name: 'Prod DB', uri: 'mongodb://localhost:27017' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const activeConnections = [
      { id: 'conn-1', profileId: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' }
    ];

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={() => {}}
        activeConnections={activeConnections}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText('Mock DB 1')[0]).toBeInTheDocument();
    });

    const connectedDot = screen.getByTitle('Connected');
    expect(connectedDot).toBeInTheDocument();
  });

  it('prevents connecting to duplicate connections', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([
          { id: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
        ]);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const activeConnections = [
      { id: 'conn-1', profileId: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' }
    ];

    render(
      <ConnectionManager
        isOpen={true}
        onClose={() => {}}
        onConnect={() => {}}
        activeConnections={activeConnections}
      />
    );

    let profileNode: HTMLElement | null = null;
    await waitFor(() => {
      const nodes = screen.getAllByText('Mock DB 1');
      expect(nodes.length).toBeGreaterThan(0);
      profileNode = nodes[0];
    });
    if (profileNode) {
      fireEvent.click(profileNode);
    }

    const connectBtn = screen.getByRole('button', { name: /already connected/i });
    expect(connectBtn).toBeInTheDocument();
    expect(connectBtn).toBeDisabled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionManager, buildUri, buildSshConfig, parseUriIntoFields, summarizeConnectionError } from '../ConnectionManager';
import { DialogProvider } from '../dialogs/DialogProvider';

// ConnectionManager now uses the in-app dialog system, so it must render inside a provider.
const render = (ui: ReactElement) => rtlRender(<DialogProvider>{ui}</DialogProvider>);

async function pickSelectOption(testId: string, optionName: RegExp | string) {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

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

// File dialogs and text-file IO used by URI import/export.
const mockOpenDialog = vi.fn();
const mockSaveDialog = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: any[]) => mockOpenDialog(...args),
  save: (...args: any[]) => mockSaveDialog(...args),
}));
const mockReadTextFile = vi.fn();
const mockWriteTextFile = vi.fn();
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: (...args: any[]) => mockReadTextFile(...args),
  writeTextFile: (...args: any[]) => mockWriteTextFile(...args),
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

describe('summarizeConnectionError', () => {
  it('reports a TLS trust problem buried inside a server-selection timeout', () => {
    const raw = 'Kind: Server selection timeout: No available servers. Topology: { Servers: [ { Address: 1.2.3.4:27017, Type: Unknown, Error: Kind: I/O error: invalid peer certificate: UnknownIssuer } ] }';
    const { summary, hint } = summarizeConnectionError(raw);
    expect(summary).toMatch(/certificate not trusted/i);
    expect(hint).toMatch(/CA file|invalid certificates/i);
  });

  it('detects authentication failures', () => {
    expect(summarizeConnectionError('Authentication failed. (18)').summary).toMatch(/authentication failed/i);
  });

  it('detects connection refused', () => {
    expect(summarizeConnectionError('Kind: I/O error: Connection refused (os error 61)').summary).toMatch(/refused/i);
  });

  it('falls back to a trimmed first line for unknown errors', () => {
    const { summary, hint } = summarizeConnectionError('Kind: some weird failure\nwith more lines');
    expect(summary).toBe('some weird failure');
    expect(hint).toBeUndefined();
  });

  it('summarizes a bare server-selection timeout when no deeper cause is present', () => {
    expect(summarizeConnectionError('Server selection timeout: No available servers').summary).toMatch(/selection timed out/i);
  });
});

describe('parseUriIntoFields (import → form)', () => {
  it('extracts credentials, host/port, and default db into editable fields', () => {
    const f = parseUriIntoFields('mongodb://alice:s3cr3t@db.example.com:27018/shop?tls=true');
    expect(f.authUser).toBe('alice');
    expect(f.authPass).toBe('s3cr3t');
    expect(f.authMethod).toBe('scram-256');
    expect(f.tlsMode).toBe('system');
    expect(f.defaultDb).toBe('shop');
    expect(f.hosts).toEqual([{ host: 'db.example.com', port: '27018' }]);
    expect(f.topology).toBe('standalone');
  });

  it('splits multiple hosts and detects a replica set (with its name)', () => {
    const f = parseUriIntoFields('mongodb://h1:27017,h2:27017,h3:27017/?replicaSet=rs0');
    expect(f.hosts).toEqual([
      { host: 'h1', port: '27017' },
      { host: 'h2', port: '27017' },
      { host: 'h3', port: '27017' },
    ]);
    expect(f.topology).toBe('replicaSet');
    expect(f.replicaSetName).toBe('rs0');
    expect(f.protocol).toBe('mongodb');
  });

  it('detects a sharded cluster from multiple hosts without a replicaSet', () => {
    const f = parseUriIntoFields('mongodb://m1:27017,m2:27017/admin');
    expect(f.topology).toBe('sharded');
  });

  it('detects a direct/standalone connection from directConnection=true', () => {
    const f = parseUriIntoFields('mongodb://h1:27017,h2:27017/?directConnection=true');
    expect(f.topology).toBe('standalone');
    expect(f.directConnection).toBe(true);
  });

  it('maps TLS options (CA file, tlsInsecure) into the form', () => {
    const f = parseUriIntoFields('mongodb://h:27017/?tls=true&tlsCAFile=%2Fetc%2Fca.pem&tlsInsecure=true');
    expect(f.tlsMode).toBe('file');
    expect(f.tlsCa).toBe('/etc/ca.pem');
    expect(f.tlsAllowInvalidCerts).toBe(true);
    expect(f.tlsAllowInvalidHosts).toBe(true);
  });

  it('maps individual allow-invalid TLS flags', () => {
    const f = parseUriIntoFields('mongodb://h:27017/?tls=true&tlsAllowInvalidCertificates=true');
    expect(f.tlsMode).toBe('system');
    expect(f.tlsAllowInvalidCerts).toBe(true);
    expect(f.tlsAllowInvalidHosts).toBe(false);
  });

  it('detects mongodb+srv: protocol, port-less host, sharded topology', () => {
    const f = parseUriIntoFields('mongodb+srv://user:pw@cluster0.abcd.mongodb.net/app');
    expect(f.protocol).toBe('mongodb+srv');
    expect(f.hosts).toEqual([{ host: 'cluster0.abcd.mongodb.net', port: '' }]);
    expect(f.topology).toBe('sharded');
    expect(f.defaultDb).toBe('app');
  });

  it('handles a bare host with no credentials', () => {
    const f = parseUriIntoFields('mongodb://localhost:27017');
    expect(f.authUser).toBe('');
    expect(f.authMethod).toBe('none');
    expect(f.hosts).toEqual([{ host: 'localhost', port: '27017' }]);
  });

  it('decodes percent-encoded credentials', () => {
    const f = parseUriIntoFields('mongodb://user%40corp:p%40ss@localhost:27017/');
    expect(f.authUser).toBe('user@corp');
    expect(f.authPass).toBe('p@ss');
  });

  it('round-trips with buildUri back to a standalone form', () => {
    const f = parseUriIntoFields('mongodb://alice:s3cr3t@db.example.com:27018/shop');
    const uri = buildUri({ ...baseConn, ...f, authPass: f.authPass });
    expect(uri).toContain('db.example.com:27018');
    expect(uri).toContain('alice');
  });
});

describe('buildUri protocol + topology', () => {
  it('emits a mongodb+srv:// scheme with port-less hosts', () => {
    const uri = buildUri({ ...baseConn, protocol: 'mongodb+srv', topology: 'sharded', hosts: [{ host: 'cluster0.abcd.mongodb.net', port: '' }] });
    expect(uri.startsWith('mongodb+srv://')).toBe(true);
    expect(uri).toContain('cluster0.abcd.mongodb.net');
    expect(uri).not.toContain(':27017');
    expect(uri).not.toContain('directConnection');
  });

  it('sharded topology joins the host list without a replicaSet param', () => {
    const uri = buildUri({ ...baseConn, topology: 'sharded', hosts: [{ host: 'm1', port: '27017' }, { host: 'm2', port: '27017' }] });
    expect(uri).toContain('m1:27017,m2:27017');
    expect(uri).not.toContain('replicaSet');
    expect(uri).not.toContain('directConnection');
  });

  it('only emits directConnection for a single-host standalone', () => {
    const single = buildUri({ ...baseConn, topology: 'standalone', directConnection: true, hosts: [{ host: 'h1', port: '27017' }] });
    expect(single).toContain('directConnection=true');
    const multi = buildUri({ ...baseConn, topology: 'standalone', directConnection: true, hosts: [{ host: 'h1', port: '27017' }, { host: 'h2', port: '27017' }] });
    expect(multi).not.toContain('directConnection');
  });
});

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

  it('builds an agent-auth config without any secret material', () => {
    const cfg = buildSshConfig({
      ...sshBase,
      sshEnabled: true,
      sshHost: 'h',
      sshUser: 'u',
      sshAuth: 'agent',
      sshKey: '~/.ssh/id_ed25519', // stale form state must not leak into the config
      sshPass: 'leftover',
    });
    expect(cfg?.auth).toEqual({ type: 'agent' });
  });
});

describe('SSH agent auth in the editor (issue #130)', () => {
  const agentProfile = {
    id: 'p-agent',
    name: 'Bastion',
    uri: 'mongodb://db.internal:27017',
    ssh: { enabled: true, host: 'jump.example.com', port: 22, user: 'ops', auth: { type: 'agent' } },
    color_tag: null,
  };

  const renderWithProfiles = (profiles: any[], onSave: (p: any) => void = () => {}) => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(profiles);
      if (cmd === 'save_connection_profile') {
        onSave(args.profile);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });
    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
  };

  const openSshTab = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    fireEvent.click(screen.getByRole('button', { name: /ssh tunnel/i }));
    fireEvent.click(screen.getByLabelText(/enable ssh tunnel/i));
  };

  it('selecting "SSH agent" hides key/password inputs, shows the security note, and saves auth {type: agent}', async () => {
    let savedProfile: any = null;
    renderWithProfiles([], (p) => { savedProfile = p; });

    await openSshTab();
    fireEvent.change(screen.getByPlaceholderText('ssh.server.com'), { target: { value: 'jump.example.com' } });
    fireEvent.change(screen.getByPlaceholderText('deploy'), { target: { value: 'ops' } });

    await pickSelectOption('ssh-auth-select', /ssh agent/i);

    // Key/password inputs are hidden; the security note is shown instead.
    expect(screen.queryByPlaceholderText('~/.ssh/id_ed25519')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('••••••••')).not.toBeInTheDocument();
    const note = screen.getByTestId('ssh-agent-note');
    expect(note).toHaveTextContent(/SSH_AUTH_SOCK/);
    expect(note).toHaveTextContent(/never/i);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(savedProfile?.ssh).toEqual({
        enabled: true,
        host: 'jump.example.com',
        port: 22,
        user: 'ops',
        auth: { type: 'agent' },
      });
    });
  });

  it('switching back from agent to key/password restores those inputs', async () => {
    renderWithProfiles([]);
    await openSshTab();

    await pickSelectOption('ssh-auth-select', /ssh agent/i);
    expect(screen.getByTestId('ssh-agent-note')).toBeInTheDocument();

    await pickSelectOption('ssh-auth-select', /private key/i);
    expect(screen.queryByTestId('ssh-agent-note')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('~/.ssh/id_ed25519')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/leave blank if the key is unencrypted/i)).toBeInTheDocument();

    await pickSelectOption('ssh-auth-select', /^password$/i);
    expect(screen.queryByTestId('ssh-agent-note')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
  });

  it('round-trips a saved profile with agent auth through edit and save', async () => {
    let savedProfile: any = null;
    renderWithProfiles([agentProfile], (p) => { savedProfile = p; });

    fireEvent.click((await screen.findAllByText('Bastion'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    // The SSH tab reflects the persisted agent auth without touching anything.
    fireEvent.click(screen.getByRole('button', { name: /ssh tunnel/i }));
    expect(screen.getByTestId('ssh-agent-note')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('~/.ssh/id_ed25519')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(savedProfile?.ssh).toEqual(agentProfile.ssh);
    });
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
    await pickSelectOption('topology-select', /full uri string only/i);
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
        color_tag: null,
        mcp_enabled: false,
        connection_mode: 'normal',
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

    fireEvent.click(screen.getByTestId('folder-filter-select'));
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

    await pickSelectOption('topology-select', /full uri string only/i);
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

    await pickSelectOption('topology-select', /full uri string only/i);
    const uriInput = screen.getByLabelText(/connection uri/i);
    fireEvent.change(uriInput, { target: { value: 'mongodb://invalid' } });

    // Click Test Connection
    const testBtn = screen.getByRole('button', { name: /test connection/i });
    fireEvent.click(testBtn);

    // Verify summarized error feedback is displayed (raw error lives behind "Show details").
    await waitFor(() => {
      expect(screen.getByTestId('test-result-summary')).toHaveTextContent(/timed out/i);
    }, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('test-error-details-toggle'));
    expect(screen.getByTestId('test-error-detail')).toHaveTextContent('Connection timed out');

    // The result can be dismissed.
    fireEvent.click(screen.getByTestId('test-dismiss'));
    expect(screen.queryByTestId('test-result-summary')).toBeNull();
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
      expect(handleConnect).toHaveBeenCalledWith('conn-abc-123', 'Mock DB 1', 'mongodb://mock', 'profile-1', undefined, 'normal');
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

  it('saves a color tag from the preset palette', async () => {
    let savedProfile: any = null;
    let profilesList: any[] = [];

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(profilesList);
      if (cmd === 'save_connection_profile') {
        savedProfile = args.profile;
        profilesList = [args.profile];
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

    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Prod' } });
    await pickSelectOption('topology-select', /full uri string only/i);
    fireEvent.change(screen.getByLabelText(/connection uri/i), { target: { value: 'mongodb://prod' } });
    fireEvent.click(screen.getByTestId('color-swatch-blue'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(savedProfile).toMatchObject({
        name: 'Prod',
        uri: 'mongodb://prod',
        color_tag: '#3b82f6',
      });
    });
  });

  it('saves a custom color from the color picker', async () => {
    let savedProfile: any = null;
    let profilesList: any[] = [];

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(profilesList);
      if (cmd === 'save_connection_profile') {
        savedProfile = args.profile;
        profilesList = [args.profile];
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

    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Custom' } });
    await pickSelectOption('topology-select', /full uri string only/i);
    fireEvent.change(screen.getByLabelText(/connection uri/i), { target: { value: 'mongodb://custom' } });
    expect(screen.getByLabelText('Pick a custom color')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('color-picker-custom'), { target: { value: '#a1b2c3' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(savedProfile).toMatchObject({
        name: 'Custom',
        uri: 'mongodb://custom',
        color_tag: '#a1b2c3',
      });
    });
  });

  it('shows color dots in the profile list for tagged connections', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') {
        return Promise.resolve([
          { id: 'p1', name: 'Staging', uri: 'mongodb://staging', color_tag: '#22c55e' },
          { id: 'p2', name: 'Prod', uri: 'mongodb://prod' },
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

    await waitFor(() => expect(screen.getAllByText('Staging')[0]).toBeInTheDocument());
    const dots = screen.getAllByTestId('connection-color-dot');
    expect(dots.length).toBeGreaterThanOrEqual(1);
    dots.forEach((dot) => {
      expect(dot).toHaveStyle({ backgroundColor: 'rgb(34, 197, 94)' });
    });
  });

  it('clears a saved color tag when none is selected', async () => {
    let savedProfile: any = null;
    const profilesList = [
      { id: 'p1', name: 'Staging', uri: 'mongodb://staging', color_tag: '#22c55e' },
    ];

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(profilesList);
      if (cmd === 'save_connection_profile') {
        savedProfile = args.profile;
        profilesList[0] = args.profile;
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

    await waitFor(() => expect(screen.getAllByText('Staging')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Staging')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.click(screen.getByTestId('color-swatch-none'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(savedProfile).toMatchObject({
        id: 'p1',
        color_tag: null,
      });
    });
  });
});

describe('MCP opt-in flag (#98)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('saving with "Expose to MCP agents" checked round-trips mcp_enabled: true', async () => {
    let savedProfile: any = null;
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'save_connection_profile') {
        savedProfile = args.profile;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Agent DB' } });
    await pickSelectOption('topology-select', /full uri string only/i);
    fireEvent.change(screen.getByLabelText(/connection uri/i), { target: { value: 'mongodb://agent' } });

    fireEvent.click(screen.getByLabelText(/expose to mcp agents/i));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(savedProfile).toMatchObject({
        name: 'Agent DB',
        uri: 'mongodb://agent',
        mcp_enabled: true,
      });
    });
  });

  it('editing a profile without mcp_enabled renders the checkbox unchecked', async () => {
    const legacyProfile = { id: 'p-legacy', name: 'Legacy', uri: 'mongodb://legacy:27017' };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([legacyProfile]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);

    await waitFor(() => expect(screen.getAllByText('Legacy')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Legacy')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    expect(screen.getByLabelText(/expose to mcp agents/i)).not.toBeChecked();
  });

  it('toggling the checkbox on and saving an old profile adds mcp_enabled: true', async () => {
    let savedProfile: any = null;
    const legacyProfile = { id: 'p-legacy', name: 'Legacy', uri: 'mongodb://legacy:27017' };
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([legacyProfile]);
      if (cmd === 'save_connection_profile') {
        savedProfile = args.profile;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);

    await waitFor(() => expect(screen.getAllByText('Legacy')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Legacy')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const checkbox = screen.getByLabelText(/expose to mcp agents/i);
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(savedProfile).toMatchObject({
        id: 'p-legacy',
        mcp_enabled: true,
      });
    });
  });

  it('duplicating an MCP-exposed profile resets "Expose to MCP agents" to unchecked, while editing it keeps it checked (final fix wave)', async () => {
    const mcpProfile = { id: 'p-mcp', name: 'Agent DB', uri: 'mongodb://agent:27017', mcp_enabled: true };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([mcpProfile]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);

    await waitFor(() => expect(screen.getAllByText('Agent DB')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Agent DB')[0]);

    // Edit path: unaffected, keeps mapping the original's flag.
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByLabelText(/expose to mcp agents/i)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    // Duplicate path: the new profile starts unexposed regardless.
    fireEvent.click(screen.getAllByText('Agent DB')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^duplicate$/i }));
    expect(screen.getByLabelText(/expose to mcp agents/i)).not.toBeChecked();
  });
});

describe('Connection mode segmented control (#188 Task 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders the three connection mode options, defaulting a new profile to Normal', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));

    expect(screen.getByTestId('connection-mode-normal')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('connection-mode-read_only')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('connection-mode-confirm_destructive')).toHaveAttribute('aria-pressed', 'false');
  });

  it('selecting a mode updates the segmented control selection', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));

    fireEvent.click(screen.getByTestId('connection-mode-read_only'));

    expect(screen.getByTestId('connection-mode-read_only')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('connection-mode-normal')).toHaveAttribute('aria-pressed', 'false');
  });

  it('saving with "Confirm destructive" selected persists connection_mode', async () => {
    let savedProfile: any = null;
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'save_connection_profile') {
        savedProfile = args.profile;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Prod' } });
    await pickSelectOption('topology-select', /full uri string only/i);
    fireEvent.change(screen.getByLabelText(/connection uri/i), { target: { value: 'mongodb://prod' } });

    fireEvent.click(screen.getByTestId('connection-mode-confirm_destructive'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(savedProfile).toMatchObject({
        name: 'Prod',
        uri: 'mongodb://prod',
        connection_mode: 'confirm_destructive',
      });
    });
  });

  it('editing a profile with a mode shows it selected in the segmented control', async () => {
    const roProfile = { id: 'p-ro', name: 'Read Only DB', uri: 'mongodb://ro:27017', connection_mode: 'read_only' };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([roProfile]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('Read Only DB')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Read Only DB')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    expect(screen.getByTestId('connection-mode-read_only')).toHaveAttribute('aria-pressed', 'true');
  });

  it('editing a legacy profile without connection_mode defaults the segmented control to Normal', async () => {
    const legacyProfile = { id: 'p-legacy', name: 'Legacy', uri: 'mongodb://legacy:27017' };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([legacyProfile]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('Legacy')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Legacy')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    expect(screen.getByTestId('connection-mode-normal')).toHaveAttribute('aria-pressed', 'true');
  });

  it('duplicating a read-only profile inherits its connection mode (opposite of mcpEnabled)', async () => {
    const roProfile = { id: 'p-ro', name: 'Prod', uri: 'mongodb://prod:27017', connection_mode: 'read_only' };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([roProfile]);
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('Prod')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Prod')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^duplicate$/i }));

    expect(screen.getByTestId('connection-mode-read_only')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('URI import and export', () => {
  const prodProfile = {
    id: 'p1',
    name: 'Prod',
    uri: 'mongodb://alice:pw@db1:27017/sales?tls=true&proxyHost=p&proxyPassword=ppw',
    ssh: { enabled: true, host: 'jump', port: 22, user: 'ops', auth: { type: 'password', password: 'sp' } },
    color_tag: null,
  };
  const redacted = 'mongodb://alice@db1:27017/sales?tls=true&proxyHost=p';

  const setupClipboard = () => {
    const readText = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText, writeText },
      configurable: true,
    });
    return { readText, writeText };
  };

  const renderManager = (profiles: any[] = []) => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(profiles);
      return Promise.resolve([]);
    });
    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);
  };

  const openImportMenu = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    fireEvent.pointerDown(screen.getByTestId('import-uri-btn'), { button: 0, ctrlKey: false });
  };

  beforeEach(() => {
    mockOpenDialog.mockReset();
    mockSaveDialog.mockReset();
    mockReadTextFile.mockReset();
    mockWriteTextFile.mockReset();
  });

  it('imports a URI from the clipboard into the editor form', async () => {
    const { readText } = setupClipboard();
    readText.mockResolvedValue('MONGO_URL="mongodb://u:p@db.imported.example:27017/app"');
    renderManager();

    await openImportMenu();
    fireEvent.click(await screen.findByTestId('import-from-clipboard'));

    await waitFor(() => {
      expect(screen.getByText(/db\.imported\.example/)).toBeInTheDocument();
    });
  });

  it('shows an inline error when the clipboard has no mongodb URI', async () => {
    const { readText } = setupClipboard();
    readText.mockResolvedValue('postgres://u:p@host/db');
    renderManager();

    await openImportMenu();
    fireEvent.click(await screen.findByTestId('import-from-clipboard'));

    expect(await screen.findByTestId('import-uri-error')).toHaveTextContent(/no mongodb/i);
  });

  it('imports the first URI found in a picked file', async () => {
    setupClipboard();
    mockOpenDialog.mockResolvedValue('/tmp/creds.env');
    mockReadTextFile.mockResolvedValue('A=1\nURL=mongodb+srv://u@cluster.file.example/app\n');
    renderManager();

    await openImportMenu();
    fireEvent.click(await screen.findByTestId('import-from-file'));

    await waitFor(() => {
      expect(screen.getByText(/cluster\.file\.example/)).toBeInTheDocument();
    });
  });

  it('exports a redacted URI by default, notes the SSH tunnel, and includes the password on demand', async () => {
    const { writeText } = setupClipboard();
    renderManager([prodProfile]);

    fireEvent.click((await screen.findAllByText('Prod'))[0]);
    fireEvent.click(screen.getByTestId('export-uri-btn'));

    const preview = await screen.findByTestId('export-uri-preview');
    expect(preview).toHaveTextContent(redacted);
    expect(preview).not.toHaveTextContent('pw');
    expect(screen.getByTestId('export-ssh-note')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('export-copy-btn'));
    expect(writeText).toHaveBeenCalledWith(redacted);

    fireEvent.click(screen.getByTestId('export-include-password'));
    await waitFor(() => expect(preview).toHaveTextContent('alice:pw@'));

    fireEvent.click(screen.getByTestId('export-copy-btn'));
    expect(writeText).toHaveBeenLastCalledWith(prodProfile.uri);
  });

  it('drops the query string when connection settings are excluded', async () => {
    setupClipboard();
    renderManager([prodProfile]);

    fireEvent.click((await screen.findAllByText('Prod'))[0]);
    fireEvent.click(screen.getByTestId('export-uri-btn'));

    const preview = await screen.findByTestId('export-uri-preview');
    fireEvent.click(screen.getByTestId('export-include-settings'));
    await waitFor(() => expect(preview).toHaveTextContent(/^mongodb:\/\/alice@db1:27017\/sales$/));
  });

  it('saves the export to a file via the save dialog', async () => {
    setupClipboard();
    mockSaveDialog.mockResolvedValue('/tmp/conn.txt');
    mockWriteTextFile.mockResolvedValue(undefined);
    renderManager([prodProfile]);

    fireEvent.click((await screen.findAllByText('Prod'))[0]);
    fireEvent.click(screen.getByTestId('export-uri-btn'));
    await screen.findByTestId('export-uri-preview');
    fireEvent.click(screen.getByTestId('export-save-btn'));

    await waitFor(() => {
      expect(mockWriteTextFile).toHaveBeenCalledWith('/tmp/conn.txt', `${redacted}\n`);
    });
  });
});

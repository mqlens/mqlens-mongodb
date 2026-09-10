import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  ConnectionManager,
  buildUri,
  buildSshConfig,
  parseUriIntoFields,
  summarizeConnectionError,
  suggestConnectionName,
} from '../ConnectionManager';
import { DialogProvider } from '../dialogs/DialogProvider';
import enErrors from '../../locales/en/errors.json';

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

// ConnectionErrorSummary is a discriminated union (summaryKey+hintKey for
// known causes, bare summaryText for the untranslated raw-error fallback) so
// the untranslatable branch stays honest at the type level. These narrow it
// for assertions without weakening that guarantee in the production code.
const summaryKeyOf = (info: ReturnType<typeof summarizeConnectionError>) =>
  'summaryKey' in info ? info.summaryKey : undefined;
const hintKeyOf = (info: ReturnType<typeof summarizeConnectionError>) =>
  'hintKey' in info ? info.hintKey : undefined;
const summaryTextOf = (info: ReturnType<typeof summarizeConnectionError>) =>
  'summaryText' in info ? info.summaryText : undefined;

describe('summarizeConnectionError', () => {
  it('reports a TLS trust problem buried inside a server-selection timeout', () => {
    const raw = 'Kind: Server selection timeout: No available servers. Topology: { Servers: [ { Address: 1.2.3.4:27017, Type: Unknown, Error: Kind: I/O error: invalid peer certificate: UnknownIssuer } ] }';
    const info = summarizeConnectionError(raw);
    expect(summaryKeyOf(info)).toBe('errors:conn.tlsNotTrusted');
    expect(hintKeyOf(info)).toBe('errors:conn.tlsNotTrustedHint');
  });

  it('detects authentication failures', () => {
    expect(summaryKeyOf(summarizeConnectionError('Authentication failed. (18)'))).toBe('errors:conn.authFailed');
  });

  it('detects connection refused', () => {
    expect(summaryKeyOf(summarizeConnectionError('Kind: I/O error: Connection refused (os error 61)'))).toBe('errors:conn.refused');
  });

  it('falls back to a trimmed first line for unknown errors', () => {
    const info = summarizeConnectionError('Kind: some weird failure\nwith more lines');
    expect(summaryTextOf(info)).toBe('some weird failure');
    expect(summaryKeyOf(info)).toBeUndefined();
  });

  it('summarizes a bare server-selection timeout when no deeper cause is present', () => {
    expect(summaryKeyOf(summarizeConnectionError('Server selection timeout: No available servers')))
      .toBe('errors:conn.selectionTimeout');
    // #230: a pre-3.6 server drops the connection instead of reporting its
    // version, so the raw error is an I/O EOF nested in a selection timeout.
    // That must be named, not swallowed by the generic timeout message.
    const legacy = summarizeConnectionError(
      'Kind: Server selection timeout: No available servers. Topology: { Type: Single, Servers: [ { Address: localhost:12220, Type: Unknown, Error: Kind: I/O error: unexpected end of file, Labels: {"SystemOverloadedError"} } ] }',
    );
    expect(summaryKeyOf(legacy)).toBe('errors:conn.handshakeClosed');
    expect(hintKeyOf(legacy)).toBe('errors:conn.handshakeClosedHint');
    // And the English catalog must still carry the same wording users saw before.
    expect(enErrors.conn.handshakeClosed).toMatch(/closed the connection during handshake/i);
    expect(enErrors.conn.handshakeClosedHint).toMatch(/4\.2/);
    expect(enErrors.conn.handshakeClosedHint).toMatch(/TLS/i);
    // A plain selection timeout with no EOF still gets the generic message.
    expect(
      summaryKeyOf(summarizeConnectionError('Server selection timeout: No available servers')),
    ).toBe('errors:conn.selectionTimeout');
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

  it('keeps a non-admin auth database instead of resetting it to admin (#349)', () => {
    // Reported bug: a SCRAM connection saved with its own authSource came back
    // showing `admin`, silently changing the authSource the connection used.
    const f = parseUriIntoFields(
      'mongodb://appuser:pw@db.example.com:27017/?authSource=reporting&authMechanism=SCRAM-SHA-256'
    );
    expect(f.authDb).toBe('reporting');
    expect(f.authUser).toBe('appuser');
    expect(f.authMethod).toBe('scram-256');
  });

  it('reads the auth database from the path when no authSource is given', () => {
    // MongoDB authenticates against the path database when authSource is
    // absent, so reporting `admin` would name a database this connection
    // does not use. The backend applies the same rule in strip_path_database.
    const f = parseUriIntoFields('mongodb://alice:pw@h:27017/shop');
    expect(f.authDb).toBe('shop');
  });

  it('prefers an explicit authSource over the path database', () => {
    const f = parseUriIntoFields('mongodb://alice:pw@h:27017/shop?authSource=reporting');
    expect(f.authDb).toBe('reporting');
  });

  it('falls back to admin when there is no authSource and no path database', () => {
    expect(parseUriIntoFields('mongodb://alice:pw@h:27017').authDb).toBe('admin');
    expect(parseUriIntoFields('mongodb://alice:pw@h:27017/').authDb).toBe('admin');
  });

  it('decodes a percent-encoded path database before using it as the auth source', () => {
    const f = parseUriIntoFields('mongodb://alice:pw@h:27017/my%20db');
    expect(f.authDb).toBe('my db');
  });

  it('does not put $external in the auth database field', () => {
    // buildUri writes $external from the mechanism, not from this field, so
    // showing it as the auth database would be wrong on the way back.
    const f = parseUriIntoFields('mongodb://h:27017/?authMechanism=MONGODB-X509&authSource=$external');
    expect(f.authDb).toBe('admin');
    expect(f.authMethod).toBe('x509');
  });

  it('restores the saved auth mechanism rather than assuming SCRAM-SHA-256', () => {
    expect(parseUriIntoFields('mongodb://u:p@h/?authMechanism=SCRAM-SHA-1').authMethod).toBe('scram-1');
    expect(parseUriIntoFields('mongodb://u:p@h/?authMechanism=PLAIN').authMethod).toBe('ldap');
    expect(parseUriIntoFields('mongodb://u:p@h/?authMechanism=GSSAPI').authMethod).toBe('kerberos');
    expect(parseUriIntoFields('mongodb://u:p@h/?authMechanism=MONGODB-AWS').authMethod).toBe('aws');
  });

  it('restores the mechanism properties that go with AWS and Kerberos', () => {
    const aws = parseUriIntoFields(
      'mongodb://k:s@h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN%3Atok%3An'
    );
    expect(aws.awsSessionToken).toBe('tok:n');
    const krb = parseUriIntoFields(
      'mongodb://u@h/?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME%3Amongodb'
    );
    expect(krb.kerberosServiceName).toBe('mongodb');
  });

  it('reads username-only credentials for a passwordless mechanism', () => {
    // buildUri emits `user@host` for X.509 and Kerberos; a credentials group
    // requiring a colon swallowed the principal into the hostname instead.
    const f = parseUriIntoFields('mongodb://user%40REALM@kdc.example.com:27017/?authMechanism=GSSAPI');
    expect(f.authUser).toBe('user@REALM');
    expect(f.authPass).toBe('');
    expect(f.authMethod).toBe('kerberos');
    expect(f.hosts).toEqual([{ host: 'kdc.example.com', port: '27017' }]);
  });

  it('does not mistake an @ in the query string for credentials', () => {
    const f = parseUriIntoFields('mongodb://h:27017/db?appName=a@b');
    expect(f.authUser).toBe('');
    expect(f.hosts).toEqual([{ host: 'h', port: '27017' }]);
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

describe('saving a connection and reopening it keeps its auth settings (#349)', () => {
  // The editor rebuilds its fields from the saved URI, so the round trip is
  // the behaviour that matters: what the user typed has to survive save →
  // reopen. It did not — a non-admin auth database came back as `admin`.
  const roundTrip = (state: Record<string, unknown>) =>
    parseUriIntoFields(buildUri({ ...baseConn, ...state }));

  it('keeps the auth database the user typed', () => {
    const reopened = roundTrip({
      authMethod: 'scram-256',
      authUser: 'adtimabox_cshub_ab_internal_stg',
      authPass: 'pw',
      authDb: 'adtimabox_cshub_ab_internal_stg',
    });
    expect(reopened.authDb).toBe('adtimabox_cshub_ab_internal_stg');
    expect(reopened.authUser).toBe('adtimabox_cshub_ab_internal_stg');
  });

  it('keeps a non-default auth mechanism', () => {
    const reopened = roundTrip({
      authMethod: 'scram-1',
      authUser: 'alice',
      authPass: 'pw',
      authDb: 'reporting',
    });
    expect(reopened.authMethod).toBe('scram-1');
    expect(reopened.authDb).toBe('reporting');
  });

  it('keeps an explicit admin auth source when the default database differs', () => {
    // Omitting it here would hand authentication to the path database on the
    // next save, while the form still showed admin.
    const uri = buildUri({
      ...baseConn,
      authMethod: 'scram-256',
      authUser: 'alice',
      authPass: 'pw',
      authDb: 'admin',
      defaultDb: 'shop',
    });
    expect(uri).toContain('authSource=admin');
    expect(parseUriIntoFields(uri).authDb).toBe('admin');
  });

  it('omits authSource when it would only repeat the path database', () => {
    const uri = buildUri({
      ...baseConn,
      authMethod: 'scram-256',
      authUser: 'alice',
      authPass: 'pw',
      authDb: 'shop',
      defaultDb: 'shop',
    });
    expect(uri).not.toContain('authSource');
    expect(parseUriIntoFields(uri).authDb).toBe('shop');
  });

  it('keeps a Kerberos principal and its service name', () => {
    const uri = buildUri({
      ...baseConn,
      authMethod: 'kerberos',
      authUser: 'user@REALM',
      kerberosServiceName: 'mongodb',
    });
    const reopened = parseUriIntoFields(uri);
    expect(reopened.authUser).toBe('user@REALM');
    expect(reopened.authMethod).toBe('kerberos');
    expect(reopened.kerberosServiceName).toBe('mongodb');
  });

  it('treats an encoded path database and its decoded auth source as one database', () => {
    // The path keeps its escapes while the auth database is held decoded, so
    // comparing them raw called the same database different and emitted a raw
    // `&` that started another query option.
    const parsed = parseUriIntoFields('mongodb://u:p@h:27017/sales%26ops');
    expect(parsed.authDb).toBe('sales&ops');
    const uri = buildUri({ ...baseConn, ...parsed });
    expect(uri).not.toContain('authSource');
    expect(uri).toContain('/sales%26ops');
    expect(parseUriIntoFields(uri).authDb).toBe('sales&ops');
  });

  it('percent-encodes an auth source that needs it', () => {
    const uri = buildUri({
      ...baseConn,
      authMethod: 'scram-256',
      authUser: 'alice',
      authPass: 'pw',
      authDb: 'sales&ops',
      defaultDb: 'shop',
    });
    expect(uri).toContain('authSource=sales%26ops');
    expect(parseUriIntoFields(uri).authDb).toBe('sales&ops');
  });

  it('leaves an admin auth database as admin', () => {
    const reopened = roundTrip({
      authMethod: 'scram-256',
      authUser: 'alice',
      authPass: 'pw',
      authDb: 'admin',
    });
    expect(reopened.authDb).toBe('admin');
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

describe('connecting before saving (#364)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  /** Open the editor on a blank connection and point it at `uri`. */
  const openEditorWith = async (uri: string) => {
    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    await pickSelectOption('topology-select', /full uri string only/i);
    fireEvent.change(screen.getByLabelText(/connection uri/i), { target: { value: uri } });
  };

  it('opens the connection from the editor without writing a profile', async () => {
    const handleConnect = vi.fn();
    const calls: string[] = [];
    mockInvoke.mockImplementation((cmd, args) => {
      calls.push(cmd);
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') {
        expect(args.uri).toBe('mongodb://trial:27017');
        return Promise.resolve('conn-trial-1');
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));

    // The connection is live and the user is asked — not told — about saving.
    await screen.findByTestId('connect-save-offer');
    expect(calls).toContain('connect_db');
    expect(calls).not.toContain('save_connection_profile');
    // Nothing reaches the app until that question is answered, because
    // accepting a connection closes this manager.
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('declining the offer still opens the connection, under no profile', async () => {
    const handleConnect = vi.fn();
    const calls: string[] = [];
    mockInvoke.mockImplementation((cmd) => {
      calls.push(cmd);
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-trial-2');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    fireEvent.click(await screen.findByTestId('connect-skip-save-btn'));

    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    const [connId, , uri, profileId] = handleConnect.mock.calls[0];
    expect(connId).toBe('conn-trial-2');
    expect(uri).toBe('mongodb://trial:27017');
    // An id of its own, so a second trial connection is not mistaken for this
    // one by the app's dedupe-on-profileId.
    expect(profileId).toMatch(/^ephemeral:/);
    expect(calls).not.toContain('save_connection_profile');
  });

  it('accepting the offer saves it and opens it under the new profile', async () => {
    const handleConnect = vi.fn();
    let saved: any = null;
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(saved ? [saved] : []);
      if (cmd === 'connect_db') return Promise.resolve('conn-trial-3');
      if (cmd === 'save_connection_profile') {
        saved = args.profile;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    fireEvent.click(await screen.findByTestId('connect-save-btn'));

    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    expect(saved).toMatchObject({ uri: 'mongodb://trial:27017' });
    // The live connection carries the identity it just acquired, not the
    // throwaway one — otherwise its tabs could never be reconnected to it.
    const [connId, , , profileId] = handleConnect.mock.calls[0];
    expect(connId).toBe('conn-trial-3');
    expect(profileId).toBe(saved.id);
    expect(profileId).not.toMatch(/^ephemeral:/);
  });

  it('keeps the editor open on failure, with the cause and the raw text', async () => {
    const handleConnect = vi.fn();
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.reject('Authentication failed.');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));

    // The diagnosis, not the driver's dump — and the editor is still there to
    // act on it, which is the whole point of not having saved first.
    await waitFor(() => {
      expect(screen.getByTestId('connect-error-summary')).toHaveTextContent(/authentication/i);
    });
    expect(screen.getByLabelText(/connection uri/i)).toBeInTheDocument();
    expect(handleConnect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connect-save-offer')).toBeNull();

    fireEvent.click(screen.getByTestId('connect-error-details-toggle'));
    expect(screen.getByTestId('connect-error-detail')).toHaveTextContent('Authentication failed.');
  });

  it('does not strand a live connection when the editor is dismissed', async () => {
    const handleConnect = vi.fn();
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-trial-4');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // The offer replaces Cancel with an explicit choice, so Escape is the
    // way out that could actually strand the connection. It answers 'no
    // profile', not 'no connection': the connection is already open in the
    // backend, and abandoning it here would leak it.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(handleConnect).toHaveBeenCalledWith(
      'conn-trial-4',
      expect.any(String),
      'mongodb://trial:27017',
      expect.stringMatching(/^ephemeral:/),
      undefined,
      'normal',
    ));
  });

  it('offers a name taken from the host rather than "New Connection"', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-trial-5');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={() => {}} />);
    await openEditorWith('mongodb+srv://cluster0.ab12c.mongodb.net');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));

    await screen.findByTestId('connect-save-offer');
    expect(screen.getByLabelText(/display name/i)).toHaveValue('cluster0');
  });

  it('leaves a name the user typed alone', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-trial-6');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={() => {}} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Payments prod' } });
    fireEvent.click(screen.getByTestId('editor-connect-btn'));

    await screen.findByTestId('connect-save-offer');
    expect(screen.getByLabelText(/display name/i)).toHaveValue('Payments prod');
  });

  it('connects an unchanged saved profile as itself, with nothing to save', async () => {
    const handleConnect = vi.fn();
    const calls: string[] = [];
    const profile = {
      id: 'profile-1',
      name: 'Mock DB 1',
      uri: 'mongodb://mock',
      ssh: null,
      color_tag: null,
      connection_mode: 'normal',
    };
    mockInvoke.mockImplementation((cmd) => {
      calls.push(cmd);
      if (cmd === 'load_connection_profiles') return Promise.resolve([profile]);
      if (cmd === 'connect_db') return Promise.resolve('conn-existing');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    fireEvent.click((await screen.findAllByText('Mock DB 1'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.click(await screen.findByTestId('editor-connect-btn'));

    // Already saved, so it keeps its own identity and is not offered back to
    // the user as something new to file.
    await waitFor(() => expect(handleConnect).toHaveBeenCalledWith(
      'conn-existing',
      'Mock DB 1',
      'mongodb://mock',
      'profile-1',
      undefined,
      'normal',
    ));
    expect(screen.queryByTestId('connect-save-offer')).toBeNull();
    expect(calls).not.toContain('save_connection_profile');
  });
});

describe('the save offer cannot strand or misdescribe a connection (#369 review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  const openEditorWith = async (uri: string) => {
    fireEvent.click(await screen.findByRole('button', { name: /new\.\.\./i }));
    await pickSelectOption('topology-select', /full uri string only/i);
    fireEvent.change(screen.getByLabelText(/connection uri/i), { target: { value: uri } });
  };

  it('adopts the connection when the editor is closed from its header button', async () => {
    const handleConnect = vi.fn();
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-header-close');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // The header's X is a plain button, not a Radix close primitive, so it
    // never reaches the dialog's onOpenChange. Left to itself it would drop
    // the reference to a session still open in the backend.
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i });
    fireEvent.click(closeButtons[closeButtons.length - 1]);

    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    expect(handleConnect.mock.calls[0][0]).toBe('conn-header-close');
  });

  it('takes the connection fields off screen once the offer is up', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-frozen');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={() => {}} />);
    await openEditorWith('mongodb://trial:27017');
    expect(screen.getByLabelText(/connection uri/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // Answering the offer closes the dialog, so a field edited here could only
    // ever describe something other than the connection already open. The name
    // stays, because naming the thing is the question being asked.
    expect(screen.queryByLabelText(/connection uri/i)).toBeNull();
    expect(screen.queryByTestId('topology-select')).toBeNull();
    expect(screen.queryByRole('button', { name: /test connection/i })).toBeNull();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  });

  it('saves the configuration the connection was opened on', async () => {
    let saved: any = null;
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(saved ? [saved] : []);
      if (cmd === 'connect_db') return Promise.resolve('conn-tested');
      if (cmd === 'save_connection_profile') {
        saved = args.profile;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={() => {}} />);
    await openEditorWith('mongodb://tested-host:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');
    fireEvent.click(screen.getByTestId('connect-save-btn'));

    // The profile and the live connection handed over beside it have to
    // describe the same server, or every later reconnect targets the wrong one.
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved.uri).toBe('mongodb://tested-host:27017');
  });

  it('refuses to connect a profile that is already active, edited or not', async () => {
    const handleConnect = vi.fn();
    const calls: string[] = [];
    const profile = {
      id: 'profile-1',
      name: 'Mock DB 1',
      uri: 'mongodb://mock',
      ssh: null,
      color_tag: null,
      connection_mode: 'normal',
    };
    mockInvoke.mockImplementation((cmd) => {
      calls.push(cmd);
      if (cmd === 'load_connection_profiles') return Promise.resolve([profile]);
      if (cmd === 'connect_db') return Promise.resolve('conn-duplicate');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(
      <ConnectionManager
        isOpen
        onClose={() => {}}
        onConnect={handleConnect}
        activeConnections={[
          { id: 'live-1', profileId: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
        ]}
      />,
    );
    fireEvent.click((await screen.findAllByText('Mock DB 1'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    // Edited, so it is no longer "unchanged" — but saving still writes back
    // onto this same profile id, which the app already has a session for.
    fireEvent.change(await screen.findByLabelText(/display name/i), {
      target: { value: 'Mock DB 1 (tweaked)' },
    });
    fireEvent.click(screen.getByTestId('editor-connect-btn'));

    await screen.findByTestId('editor-error');
    expect(screen.getByTestId('editor-error')).toHaveTextContent(/already active/i);
    expect(calls).not.toContain('connect_db');
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('hands the connection over once when Escape reaches both listeners', async () => {
    const handleConnect = vi.fn();
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-once');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // One Escape, from inside the dialog where a real one comes from. It
    // bubbles to document, where Radix dismisses the layer, and on to window,
    // where useEscapeClose is listening — two handlers for one event, both
    // reading the same pendingSave because neither has re-rendered yet.
    fireEvent.keyDown(screen.getByTestId('connect-save-offer'), {
      key: 'Escape',
      bubbles: true,
    });

    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    // Twice would re-broadcast metadata, rebind tabs and refresh, all again.
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it('never hands over a nameless connection', async () => {
    const handleConnect = vi.fn();
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-nameless');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://someone:hunter2@named-host:27017/app');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // Declining to save is not declining to be identifiable: an empty name
    // reaches the sidebar as a blank row. Clearing it here rather than before
    // Connect is what actually reaches the fallback — before Connect, the
    // offer's own prefill would fill it in and the fallback would never run.
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('connect-skip-save-btn'));

    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    const name = handleConnect.mock.calls[0][1];
    expect(name).toBe('named-host');
    // And never the connection string. The name reaches pinned and favourite
    // state, which writes it to localStorage in clear text — CodeQL flagged
    // js/clear-text-storage-of-sensitive-data when this fell back to the URI.
    // Masking the password is not enough: `user@host` is still a credential
    // and an infrastructure detail. Only the host may be borrowed.
    expect(name).not.toContain('@');
    expect(name).not.toContain('someone');
    expect(name).not.toContain('hunter2');
  });

  it('does not let the editor be dismissed out from under a save', async () => {
    const handleConnect = vi.fn();
    let finishSave: (() => void) | null = null;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-slow-save');
      if (cmd === 'save_connection_profile') {
        return new Promise<void>((resolve) => { finishSave = () => resolve(); });
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');
    fireEvent.click(screen.getByTestId('connect-save-btn'));
    await waitFor(() => expect(finishSave).not.toBeNull());

    // Escaping here would adopt under the throwaway id while the write is still
    // going, and the write would then hand the same session over again under
    // the saved profile's id — two identities for one connection.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handleConnect).not.toHaveBeenCalled();
    expect(screen.getByTestId('connect-save-offer')).toBeInTheDocument();

    finishSave!();
    await waitFor(() => expect(handleConnect).toHaveBeenCalledTimes(1));
    expect(handleConnect.mock.calls[0][3]).not.toMatch(/^ephemeral:/);
  });

  it('ignores edits made while the connection was still opening', async () => {
    const handleConnect = vi.fn();
    let saved: any = null;
    let settle: ((id: string) => void) | null = null;
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve(saved ? [saved] : []);
      if (cmd === 'connect_db') {
        expect(args.uri).toBe('mongodb://tested-host:27017');
        return new Promise<string>((resolve) => { settle = resolve; });
      }
      if (cmd === 'save_connection_profile') {
        saved = args.profile;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://tested-host:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await waitFor(() => expect(settle).not.toBeNull());

    // The fields only go off screen once the offer is up. Until then they are
    // live, and server selection can take half a minute.
    fireEvent.change(screen.getByLabelText(/connection uri/i), {
      target: { value: 'mongodb://typed-later:27017' },
    });
    settle!('conn-tested');
    await screen.findByTestId('connect-save-offer');

    // Everything the offer says has to describe what was connected to. A name
    // suggested from a host nobody connected to is the visible half of the
    // same mistake as saving one.
    expect(screen.getByLabelText(/display name/i)).toHaveValue('tested-host');

    fireEvent.click(screen.getByTestId('connect-save-btn'));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved.uri).toBe('mongodb://tested-host:27017');
    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    expect(handleConnect.mock.calls[0][2]).toBe('mongodb://tested-host:27017');
  });

  it('adopts an unsaved connection under the host it actually reached', async () => {
    const handleConnect = vi.fn();
    let settle: ((id: string) => void) | null = null;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return new Promise<string>((resolve) => { settle = resolve; });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://tested-host:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await waitFor(() => expect(settle).not.toBeNull());
    fireEvent.change(screen.getByLabelText(/connection uri/i), {
      target: { value: 'mongodb://typed-later:27017' },
    });
    settle!('conn-adopted');
    await screen.findByTestId('connect-save-offer');

    // Clearing the name sends adoption to its fallback, which must derive from
    // the snapshot too — not from a form that has moved on.
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('connect-skip-save-btn'));

    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    expect(handleConnect.mock.calls[0][1]).toBe('tested-host');
    expect(handleConnect.mock.calls[0][2]).toBe('mongodb://tested-host:27017');
  });

  it('carries the safeguard the connection was opened under, not a later one', async () => {
    const handleConnect = vi.fn();
    let settle: ((id: string) => void) | null = null;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return new Promise<string>((resolve) => { settle = resolve; });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://tested-host:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await waitFor(() => expect(settle).not.toBeNull());

    // The mode control is still reachable while the connection is opening.
    // Everything the offer hands over describes the attempt that was made, so
    // a mode chosen after it was dispatched belongs to a connection that was
    // never opened. (If read-only should instead win here on safety grounds,
    // that is a deliberate exception to the rule, not an accident of it.)
    fireEvent.click(screen.getByTestId('connection-mode-read_only'));
    settle!('conn-mode');
    await screen.findByTestId('connect-save-offer');
    fireEvent.click(screen.getByTestId('connect-skip-save-btn'));

    await waitFor(() => expect(handleConnect).toHaveBeenCalled());
    expect(handleConnect.mock.calls[0][5]).toBe('normal');
  });
  it('shows the URI it connected to, not the one left in the form', async () => {
    let settle: ((id: string) => void) | null = null;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return new Promise<string>((resolve) => { settle = resolve; });
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={() => {}} />);
    await openEditorWith('mongodb://tested-host:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await waitFor(() => expect(settle).not.toBeNull());
    fireEvent.change(screen.getByLabelText(/connection uri/i), {
      target: { value: 'mongodb://typed-later:27017' },
    });
    settle!('conn-preview');
    await screen.findByTestId('connect-save-offer');

    // The URI preview and its Export button sit beside the name, above the
    // fields the offer hides — so they stay on screen under a banner that says
    // "Connected". Showing a host nobody connected to there, or exporting it as
    // the working configuration, is the visible half of saving the wrong one.
    const shown = screen.getByText(/^mongodb:\/\//);
    expect(shown).toHaveTextContent('tested-host');
    expect(shown).not.toHaveTextContent('typed-later');
  });

  it('does not answer the save offer when Escape was meant for the export dialog', async () => {
    const handleConnect = vi.fn();
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-export-escape');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    fireEvent.click(screen.getByTestId('editor-export-uri-btn'));
    await screen.findByTestId('export-uri-dialog');

    // The export dialog is its own Radix layer and dismisses itself. This
    // listener is on window, so the same keypress reached it too — and now that
    // the editor's Escape answers the save offer, it would have silently
    // chosen "Don't save" and closed the manager underneath.
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(handleConnect).not.toHaveBeenCalled();
    expect(screen.getByTestId('connect-save-offer')).toBeInTheDocument();
  });

  it('gives every trial connection an identity of its own', async () => {
    const handleConnect = vi.fn();
    let n = 0;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') {
        n += 1;
        return Promise.resolve(`conn-${n}`);
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);

    for (const host of ['first-host', 'second-host']) {
      await openEditorWith(`mongodb://${host}:27017`);
      fireEvent.click(screen.getByTestId('editor-connect-btn'));
      await screen.findByTestId('connect-save-offer');
      fireEvent.click(screen.getByTestId('connect-skip-save-btn'));
      await waitFor(() => expect(handleConnect).toHaveBeenCalledTimes(host === 'first-host' ? 1 : 2));
    }

    // The app dedupes active connections on profileId, so two trial sessions
    // sharing one would mean the second silently never arrives. Uniqueness is
    // the whole job of this id — it is a namespace, not a secret.
    const [firstId, secondId] = handleConnect.mock.calls.map((c) => c[3]);
    expect(firstId).toMatch(/^ephemeral:/);
    expect(secondId).toMatch(/^ephemeral:/);
    expect(firstId).not.toBe(secondId);
  });

  it('does not let an abandoned attempt re-enable Connect for a live one', async () => {
    const handleConnect = vi.fn();
    const disconnected: string[] = [];
    const settlers: Array<(id: string) => void> = [];
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') {
        return new Promise<string>((resolve) => { settlers.push(resolve); });
      }
      if (cmd === 'disconnect_db') {
        disconnected.push(args.id);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);

    // First attempt, then walk away from it while it is still going.
    await openEditorWith('mongodb://slow-one:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await waitFor(() => expect(settlers).toHaveLength(1));
    fireEvent.keyDown(window, { key: 'Escape' });

    // Second attempt, in a fresh editor, also still going.
    await openEditorWith('mongodb://slow-two:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await waitFor(() => expect(settlers).toHaveLength(2));
    expect(screen.getByTestId('editor-connect-btn')).toBeDisabled();

    // The abandoned one lands. It must release its own connection and nothing
    // else: clearing the button here would let a third click run two requests
    // under one generation, and the later to land would overwrite the earlier
    // pendingSave and strand its connection.
    settlers[0]('conn-abandoned');
    await waitFor(() => expect(disconnected).toEqual(['conn-abandoned']));
    expect(screen.getByTestId('editor-connect-btn')).toBeDisabled();
    expect(screen.queryByTestId('connect-save-offer')).toBeNull();

    // The live one still finishes normally.
    settlers[1]('conn-live');
    await screen.findByTestId('connect-save-offer');
  });

  it('will not save onto a profile another window connected while the offer waited', async () => {
    const handleConnect = vi.fn();
    const calls: string[] = [];
    const profile = {
      id: 'profile-1',
      name: 'Mock DB 1',
      uri: 'mongodb://mock',
      ssh: null,
      color_tag: null,
      connection_mode: 'normal',
    };
    mockInvoke.mockImplementation((cmd) => {
      calls.push(cmd);
      if (cmd === 'load_connection_profiles') return Promise.resolve([profile]);
      if (cmd === 'connect_db') return Promise.resolve('conn-ours');
      if (cmd === 'save_connection_profile') return Promise.resolve();
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const { rerender } = render(
      <ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} activeConnections={[]} />,
    );
    fireEvent.click((await screen.findAllByText('Mock DB 1'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    // Edited, so this is an offer rather than a plain reconnect.
    fireEvent.change(await screen.findByLabelText(/display name/i), {
      target: { value: 'Mock DB 1 (edited)' },
    });
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // Another window connects the same profile while the offer sits there.
    // Nothing stopped it: this connection has not been announced yet.
    // Wrapped again: rerender replaces the whole tree, and this suite's render
    // helper is what supplies the DialogProvider.
    rerender(
      <DialogProvider>
        <ConnectionManager
          isOpen
          onClose={() => {}}
          onConnect={handleConnect}
          activeConnections={[
            { id: 'live-elsewhere', profileId: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
          ]}
        />
      </DialogProvider>,
    );

    calls.length = 0;
    fireEvent.click(screen.getByTestId('connect-save-btn'));

    // Saving would overwrite the profile and hand over a second live id that
    // App drops as a duplicate, leaving this session unreachable under a
    // profile that now describes a different server.
    expect(await screen.findByTestId('editor-error')).toHaveTextContent(/already active/i);
    expect(calls).not.toContain('save_connection_profile');
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('sees a profile claimed while the save was in flight, not just before it', async () => {
    const handleConnect = vi.fn();
    const disconnected: string[] = [];
    let finishSave: (() => void) | null = null;
    const profile = {
      id: 'profile-1',
      name: 'Mock DB 1',
      uri: 'mongodb://mock',
      ssh: null,
      color_tag: null,
      connection_mode: 'normal',
    };
    const taken = [
      { id: 'live-elsewhere', profileId: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
    ];
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([profile]);
      if (cmd === 'connect_db') return Promise.resolve('conn-ours');
      if (cmd === 'save_connection_profile') {
        return new Promise<void>((resolve) => { finishSave = () => resolve(); });
      }
      if (cmd === 'disconnect_db') {
        disconnected.push(args.id);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const { rerender } = render(
      <ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} activeConnections={[]} />,
    );
    fireEvent.click((await screen.findAllByText('Mock DB 1'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(await screen.findByLabelText(/display name/i), {
      target: { value: 'Mock DB 1 (edited)' },
    });
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // Save starts while the profile is free.
    fireEvent.click(screen.getByTestId('connect-save-btn'));
    await waitFor(() => expect(finishSave).not.toBeNull());

    // The other window claims it DURING the write. React re-renders with the
    // new prop, but the suspended handler still closes over the old array — so
    // a post-await check against the prop cannot see this at all.
    rerender(
      <DialogProvider>
        <ConnectionManager
          isOpen
          onClose={() => {}}
          onConnect={handleConnect}
          activeConnections={taken}
        />
      </DialogProvider>,
    );

    finishSave!();

    await waitFor(() => expect(disconnected).toEqual(['conn-ours']));
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it('sees a profile claimed while an untouched reconnect was in flight', async () => {
    const handleConnect = vi.fn();
    const disconnected: string[] = [];
    let settle: ((id: string) => void) | null = null;
    const profile = {
      id: 'profile-1',
      name: 'Mock DB 1',
      uri: 'mongodb://mock',
      ssh: null,
      color_tag: null,
      connection_mode: 'normal',
    };
    const taken = [
      { id: 'live-elsewhere', profileId: 'profile-1', name: 'Mock DB 1', uri: 'mongodb://mock' },
    ];
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([profile]);
      if (cmd === 'connect_db') return new Promise<string>((resolve) => { settle = resolve; });
      if (cmd === 'disconnect_db') {
        disconnected.push(args.id);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    const { rerender } = render(
      <ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} activeConnections={[]} />,
    );
    fireEvent.click((await screen.findAllByText('Mock DB 1'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    // Untouched, so this is a plain reconnect rather than an offer — the branch
    // that hands the connection straight over.
    fireEvent.click(await screen.findByTestId('editor-connect-btn'));
    await waitFor(() => expect(settle).not.toBeNull());

    rerender(
      <DialogProvider>
        <ConnectionManager
          isOpen
          onClose={() => {}}
          onConnect={handleConnect}
          activeConnections={taken}
        />
      </DialogProvider>,
    );

    settle!('conn-ours');

    // Handing it over would give App a row it drops as a duplicate while the
    // backend session stays open with nothing pointing at it.
    await waitFor(() => expect(disconnected).toEqual(['conn-ours']));
    expect(handleConnect).not.toHaveBeenCalled();
    expect(await screen.findByTestId('editor-error')).toHaveTextContent(/already active/i);
  });

  it('does not rename a saved profile that happens to be called New Connection', async () => {
    const handleConnect = vi.fn();
    let saved: any = null;
    const profile = {
      id: 'profile-1',
      name: 'New Connection',
      uri: 'mongodb://mock',
      ssh: null,
      color_tag: null,
      connection_mode: 'normal',
    };
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([profile]);
      if (cmd === 'connect_db') return Promise.resolve('conn-named');
      if (cmd === 'save_connection_profile') {
        saved = args.profile;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    fireEvent.click((await screen.findAllByText('New Connection'))[0]);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    // Touch a connection setting, never the name — that is what routes this
    // through the offer rather than a plain reconnect.
    fireEvent.click(await screen.findByTestId('connection-mode-read_only'));
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    // "New Connection" is a placeholder only where the app puts it. Here it is
    // a name somebody chose, and matching it by string alone renamed their
    // profile on save without them touching the field.
    expect(screen.getByLabelText(/display name/i)).toHaveValue('New Connection');

    fireEvent.click(screen.getByTestId('connect-save-btn'));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved.name).toBe('New Connection');
  });

  it('releases a connection that arrives after the editor was dismissed', async () => {
    const handleConnect = vi.fn();
    const disconnected: string[] = [];
    let settle: ((id: string) => void) | null = null;
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return new Promise<string>((resolve) => { settle = resolve; });
      if (cmd === 'disconnect_db') {
        disconnected.push(args.id);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://slow-host:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));

    // Server selection can take half a minute, and the user is entitled to
    // walk away from it. Nothing is pending yet, so the editor just closes.
    await waitFor(() => expect(settle).not.toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('connect-save-offer')).toBeNull();

    // The answer arrives with nobody waiting for it. Held as `pendingSave` it
    // would be an invisible handle the next editor silently discards, leaving
    // the session open and unreachable — so it has to be given back.
    settle!('conn-abandoned');
    await waitFor(() => expect(disconnected).toEqual(['conn-abandoned']));
    expect(handleConnect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connect-save-offer')).toBeNull();
  });

  it('still offers a connection that arrives while the editor is open', async () => {
    const handleConnect = vi.fn();
    const disconnected: string[] = [];
    let settle: ((id: string) => void) | null = null;
    mockInvoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return new Promise<string>((resolve) => { settle = resolve; });
      if (cmd === 'disconnect_db') {
        disconnected.push(args.id);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={handleConnect} />);
    await openEditorWith('mongodb://slow-host:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));

    // The generation guard must not fire for the ordinary slow connection.
    await waitFor(() => expect(settle).not.toBeNull());
    settle!('conn-patient');
    await screen.findByTestId('connect-save-offer');
    expect(disconnected).toEqual([]);
  });

  it('says why Save did nothing when the name has been cleared', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'connect_db') return Promise.resolve('conn-unnamed');
      return Promise.reject(new Error(`Unhandled mock: ${cmd}`));
    });

    render(<ConnectionManager isOpen onClose={() => {}} onConnect={() => {}} />);
    await openEditorWith('mongodb://trial:27017');
    fireEvent.click(screen.getByTestId('editor-connect-btn'));
    await screen.findByTestId('connect-save-offer');

    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('connect-save-btn'));

    // Without an outlet inside the dialog this reason rendered behind the
    // modal, and Save just appeared to do nothing.
    expect(await screen.findByTestId('editor-error')).toHaveTextContent(/display name/i);
    expect(screen.getByTestId('connect-save-offer')).toBeInTheDocument();
  });
});

describe('suggestConnectionName', () => {
  const withHost = (host: string, port = '27017') =>
    ({ ...baseConn, topology: 'standalone', hosts: [{ host, port }], name: 'New Connection' }) as any;

  it('names an Atlas cluster after the cluster, not the whole SRV record', () => {
    expect(suggestConnectionName(withHost('cluster0.ab12c.mongodb.net'))).toBe('cluster0');
  });

  it('keeps an ordinary hostname whole', () => {
    expect(suggestConnectionName(withHost('db.internal.example.com'))).toBe('db.internal.example.com');
  });

  it('reads the host out of a URI-only connection', () => {
    expect(
      suggestConnectionName({
        ...baseConn,
        topology: 'uri',
        uri: 'mongodb://user:pw@shard.example.com:27017/app',
        name: 'New Connection',
      } as any),
    ).toBe('shard.example.com');
  });

  it('falls back to the existing name when there is no host to go on', () => {
    expect(suggestConnectionName({ ...baseConn, topology: 'standalone', hosts: [], name: 'Untitled' } as any)).toBe(
      'Untitled',
    );
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
    localStorage.clear();
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

  it('exports all saved profile URIs to clipboard as JSON without passwords by default', async () => {
    const { writeText } = setupClipboard();
    renderManager([
      { id: 'p1', name: 'Local', uri: 'mongodb://user:secret@localhost:27017/local', ssh: null, color_tag: null },
      { id: 'p2', name: 'Prod', uri: 'mongodb://admin:pw@prod.example.com:27017/prod?replicaSet=rs0', ssh: null, color_tag: null },
    ]);

    fireEvent.click((await screen.findAllByText('Local'))[0]);
    fireEvent.click(screen.getByTestId('export-all-uris-btn'));
    await screen.findByTestId('export-uri-preview');
    fireEvent.click(screen.getByTestId('export-copy-btn'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        JSON.stringify(
          {
            folders: [
              { name: 'Local resources', connections: [] },
            ],
            connections: [
              { name: 'Local', uri: 'mongodb://user@localhost:27017/local' },
              { name: 'Prod', uri: 'mongodb://admin@prod.example.com:27017/prod?replicaSet=rs0' },
            ],
          },
          null,
          2,
        ),
      );
    });
  });

  it('imports multiple connections from MQLens JSON including folders', async () => {
    const saved: Array<{ name: string; uri: string }> = [];
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'save_connection_profile') {
        saved.push({ name: args.profile.name, uri: args.profile.uri });
        return Promise.resolve();
      }
      return Promise.resolve([]);
    });
    setupClipboard();
    mockOpenDialog.mockResolvedValue('/tmp/connections.json');
    mockReadTextFile.mockResolvedValue(JSON.stringify({
      folders: [
        {
          name: 'Team',
          connections: [
            { name: 'Atlas', uri: 'mongodb+srv://user:pw@cluster0.example.net/app' },
          ],
        },
      ],
      connections: [
        { name: 'Local', uri: 'mongodb://localhost:27017' },
      ],
    }));

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);

    await openImportMenu();
    fireEvent.click(await screen.findByTestId('import-from-file'));
    fireEvent.click(await screen.findByRole('button', { name: /import all/i }));

    await waitFor(() => {
      expect(saved).toEqual([
        { name: 'Atlas', uri: 'mongodb+srv://user:pw@cluster0.example.net/app' },
        { name: 'Local', uri: 'mongodb://localhost:27017' },
      ]);
    });

    const storedFolders = JSON.parse(localStorage.getItem('mqlens_folders') || '[]') as Array<{ name: string }>;
    expect(storedFolders.some((folder) => folder.name === 'Team')).toBe(true);
    const profileMap = JSON.parse(localStorage.getItem('mqlens_profile_folders') || '{}') as Record<string, string>;
    expect(Object.keys(profileMap).length).toBeGreaterThanOrEqual(1);
  });

  it('imports multiple URIs from a Studio 3T-style export file', async () => {
    const saved: Array<{ name: string; uri: string }> = [];
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      if (cmd === 'save_connection_profile') {
        saved.push({ name: args.profile.name, uri: args.profile.uri });
        return Promise.resolve();
      }
      return Promise.resolve([]);
    });
    setupClipboard();
    mockOpenDialog.mockResolvedValue('/tmp/studio3t.uri');
    mockReadTextFile.mockResolvedValue([
      '# Local',
      'mongodb://localhost:27017',
      '',
      '# Production',
      'mongodb://user:pw@prod.example.com:27017/app',
    ].join('\n'));

    render(<ConnectionManager isOpen={true} onClose={() => {}} onConnect={() => {}} />);

    await openImportMenu();
    fireEvent.click(await screen.findByTestId('import-from-file'));
    fireEvent.click(await screen.findByRole('button', { name: /import all/i }));

    await waitFor(() => {
      expect(saved).toEqual([
        { name: 'Local', uri: 'mongodb://localhost:27017' },
        { name: 'Production', uri: 'mongodb://user:pw@prod.example.com:27017/app' },
      ]);
      expect(screen.queryByTestId('import-uri-success')).not.toBeInTheDocument();
    });
  });
});

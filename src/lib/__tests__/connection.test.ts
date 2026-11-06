import { describe, it, expect } from 'vitest';
import {
  buildExportUri,
  buildExportAllUris,
  extractMongoUriFromText,
  findMongoUriInText,
  maskUriPassword,
  parseConnectionImportFile,
  resolveImportUri,
  stripUriSecrets,
  validateMongoUri,
  needsPasswordPrompt,
  connectionSummary,
  readLastConnected,
  recordLastConnected,
  withPassword,
} from '../connection';

describe('stripUriSecrets', () => {
  it('removes the auth password but keeps the username', () => {
    expect(stripUriSecrets('mongodb://alice:s3cr%40t@db1:27017,db2:27017/sales?tls=true')).toBe(
      'mongodb://alice@db1:27017,db2:27017/sales?tls=true'
    );
  });

  it('leaves URIs without credentials untouched', () => {
    expect(stripUriSecrets('mongodb://db:27017/app?replicaSet=rs0')).toBe(
      'mongodb://db:27017/app?replicaSet=rs0'
    );
    expect(stripUriSecrets('mongodb+srv://cluster.example.com/app')).toBe(
      'mongodb+srv://cluster.example.com/app'
    );
  });

  it('keeps a username-only userinfo (no password) intact', () => {
    expect(stripUriSecrets('mongodb://alice@db:27017/?authMechanism=MONGODB-X509')).toBe(
      'mongodb://alice@db:27017/?authMechanism=MONGODB-X509'
    );
  });

  it('removes the SOCKS5 proxy password but keeps the proxy username', () => {
    expect(
      stripUriSecrets('mongodb://db:27017/?proxyHost=p&proxyPort=1080&proxyUsername=u&proxyPassword=pw&tls=true')
    ).toBe('mongodb://db:27017/?proxyHost=p&proxyPort=1080&proxyUsername=u&tls=true');
  });

  it('removes an AWS session token but keeps other mechanism properties', () => {
    expect(
      stripUriSecrets(
        'mongodb://u:p@db/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:tok123&appName=x'
      )
    ).toBe('mongodb://u@db/?authMechanism=MONGODB-AWS&appName=x');
  });

  it('removes a client-key password and cleans a now-empty query', () => {
    expect(stripUriSecrets('mongodb://db:27017/app?tlsCertificateKeyFilePassword=kp')).toBe(
      'mongodb://db:27017/app'
    );
  });

  it('does not touch password-shaped text inside query values', () => {
    expect(stripUriSecrets('mongodb://db/?appName=user:pass%40host')).toBe(
      'mongodb://db/?appName=user:pass%40host'
    );
  });
});

describe('buildExportUri', () => {
  const uri =
    'mongodb://alice:pw@db1:27017,db2:27017/sales?replicaSet=rs0&tls=true&proxyHost=p&proxyPassword=ppw&appName=MQLens';

  it('defaults are applied by the caller — full round trip keeps everything', () => {
    expect(buildExportUri(uri, { includePassword: true, includeSettings: true })).toBe(uri);
  });

  it('strips all secrets when the password is excluded', () => {
    expect(buildExportUri(uri, { includePassword: false, includeSettings: true })).toBe(
      'mongodb://alice@db1:27017,db2:27017/sales?replicaSet=rs0&tls=true&proxyHost=p&appName=MQLens'
    );
  });

  it('drops the query string but keeps hosts and default db when settings are excluded', () => {
    expect(buildExportUri(uri, { includePassword: true, includeSettings: false })).toBe(
      'mongodb://alice:pw@db1:27017,db2:27017/sales'
    );
    expect(buildExportUri(uri, { includePassword: false, includeSettings: false })).toBe(
      'mongodb://alice@db1:27017,db2:27017/sales'
    );
  });
});

describe('findMongoUriInText', () => {
  it('finds the first mongodb URI in .env-style content', () => {
    const env = '# config\nAPP_ENV=prod\nMONGO_URL="mongodb+srv://u:p@cluster.example.com/app?retryWrites=true"\nOTHER=1\n';
    expect(findMongoUriInText(env)).toBe('mongodb+srv://u:p@cluster.example.com/app?retryWrites=true');
  });

  it('accepts a bare URI with surrounding whitespace', () => {
    expect(findMongoUriInText('  mongodb://localhost:27017/test \n')).toBe('mongodb://localhost:27017/test');
  });

  it('returns null when no mongodb URI is present', () => {
    expect(findMongoUriInText('postgres://u:p@host/db')).toBeNull();
    expect(findMongoUriInText('')).toBeNull();
  });
});

describe('validateMongoUri', () => {
  // The real catalog rather than a stub `t`, so a missing or renamed key fails
  // here instead of silently rendering the raw key in the UI.
  const tFor = async (lng: 'en' | 'de') => {
    const { i18next } = await import('@/lib/i18n');
    return i18next.getFixedT(lng, 'connections');
  };

  it('accepts mongodb and mongodb+srv URIs', async () => {
    const t = await tFor('en');
    expect(validateMongoUri('mongodb://localhost:27017', t)).toBeNull();
    expect(validateMongoUri('mongodb+srv://cluster.example.net', t)).toBeNull();
  });

  it('rejects empty and non-mongodb strings', async () => {
    const t = await tFor('en');
    expect(validateMongoUri('', t)).toMatch(/enter a mongodb/i);
    expect(validateMongoUri('postgres://localhost', t)).toMatch(/enter a mongodb/i);
  });

  it('returns the German message under a German locale', async () => {
    const t = await tFor('de');
    expect(validateMongoUri('postgres://localhost', t)).toBe(
      'Gib eine mongodb:// oder mongodb+srv:// URI ein',
    );
  });
});

describe('extractMongoUriFromText', () => {
  it('finds a URI in plain text', () => {
    expect(extractMongoUriFromText('Use mongodb://user:pw@host/db for dev')).toBe(
      'mongodb://user:pw@host/db',
    );
  });

  it('finds a URI in .env-style content', () => {
    expect(extractMongoUriFromText('MONGO_URI="mongodb+srv://cluster0.example.net/app"\n')).toBe(
      'mongodb+srv://cluster0.example.net/app',
    );
  });

  it('finds a URI in export-prefixed .env lines', () => {
    expect(extractMongoUriFromText('export DATABASE_URL=mongodb://user:pw@host:27017/db')).toBe(
      'mongodb://user:pw@host:27017/db',
    );
  });

  it('skips commented .env lines', () => {
    expect(extractMongoUriFromText('# MONGO_URI=mongodb://old\nMONGO_URI=mongodb://new:27017')).toBe(
      'mongodb://new:27017',
    );
  });

  it('returns null when no URI is present', () => {
    expect(extractMongoUriFromText('HOST=localhost\nPORT=27017')).toBeNull();
  });
});

describe('resolveImportUri', () => {
  it('accepts a plain mongodb URI', () => {
    expect(resolveImportUri('mongodb://alice:secret@host:27017/app')).toEqual({
      ok: true,
      uri: 'mongodb://alice:secret@host:27017/app',
    });
  });

  it('extracts a URI embedded in .env text', () => {
    expect(resolveImportUri('MONGO_URI=mongodb://host:27017')).toEqual({
      ok: true,
      uri: 'mongodb://host:27017',
    });
  });

  it('rejects non-mongodb input', () => {
    // `error` is a code (translated at the call site in ConnectionManager.tsx,
    // see connections:errors.importNoUriFound), not display text.
    expect(resolveImportUri('postgres://localhost')).toEqual({
      ok: false,
      error: 'noUriFound',
    });
  });

  it('rejects empty input', () => {
    expect(resolveImportUri('   ')).toEqual({
      ok: false,
      error: 'empty',
    });
  });
});

describe('parseConnectionImportFile', () => {
  it('parses a Studio 3T single-connection .uri file', () => {
    const text = 'mongodb://alice:secret@studio3t.example.com:27017/admin?authSource=admin&readPreference=primary';
    expect(parseConnectionImportFile(text)).toEqual({
      ok: true,
      connections: [{
        name: 'studio3t.example.com',
        uri: text,
        folder: null,
      }],
    });
  });

  it('parses multiple labeled URIs like MQLens / NoSQLBooster exports', () => {
    const text = [
      '# Local',
      'mongodb://localhost:27017',
      '',
      '# Production',
      'mongodb://user:pw@prod.example.com:27017/app?replicaSet=rs0',
    ].join('\n');
    expect(parseConnectionImportFile(text)).toEqual({
      ok: true,
      connections: [
        { name: 'Local', uri: 'mongodb://localhost:27017', folder: null },
        { name: 'Production', uri: 'mongodb://user:pw@prod.example.com:27017/app?replicaSet=rs0', folder: null },
      ],
    });
  });

  it('parses folder labels in text exports', () => {
    const text = [
      '# folder: Team',
      '# Atlas',
      'mongodb+srv://user:pw@cluster0.example.net/app',
      '# folder: Local',
      '# Dev',
      'mongodb://localhost:27017',
    ].join('\n');
    expect(parseConnectionImportFile(text)).toEqual({
      ok: true,
      connections: [
        { name: 'Atlas', uri: 'mongodb+srv://user:pw@cluster0.example.net/app', folder: 'Team' },
        { name: 'Dev', uri: 'mongodb://localhost:27017', folder: 'Local' },
      ],
    });
  });

  it('parses Studio 3T-style JSON connection exports with folders', () => {
    const text = JSON.stringify({
      folders: [{
        name: 'Team',
        connections: [
          { name: 'Atlas', uri: 'mongodb+srv://user:pw@cluster0.example.net/app' },
        ],
      }],
      connections: [
        { connectionName: 'Dev', connectionString: 'mongodb://dev.local:27017' },
      ],
    });
    expect(parseConnectionImportFile(text)).toEqual({
      ok: true,
      connections: expect.arrayContaining([
        { name: 'Atlas', uri: 'mongodb+srv://user:pw@cluster0.example.net/app', folder: 'Team' },
        { name: 'Dev', uri: 'mongodb://dev.local:27017', folder: null },
      ]),
    });
  });

  it('parses MQLens export JSON with nested folders', () => {
    const text = JSON.stringify({
      folders: [
        {
          name: 'Local resources',
          connections: [
            { name: 'Local', uri: 'mongodb://localhost:27017' },
          ],
        },
      ],
      connections: [
        { name: 'Orphan', uri: 'mongodb://orphan:27017' },
      ],
    });
    expect(parseConnectionImportFile(text)).toEqual({
      ok: true,
      connections: [
        { name: 'Local', uri: 'mongodb://localhost:27017', folder: 'Local resources' },
        { name: 'Orphan', uri: 'mongodb://orphan:27017', folder: null },
      ],
    });
  });

  it('parses multiple plain URIs on separate lines', () => {
    const text = [
      'mongodb://localhost:27017',
      'mongodb://prod.example.com:27017/app',
    ].join('\n');
    expect(parseConnectionImportFile(text)).toEqual({
      ok: true,
      connections: [
        { name: 'localhost', uri: 'mongodb://localhost:27017', folder: null },
        { name: 'prod.example.com', uri: 'mongodb://prod.example.com:27017/app', folder: null },
      ],
    });
  });

  it('deduplicates repeated URIs', () => {
    const text = [
      '# One',
      'mongodb://host:27017/db',
      '# Two',
      'mongodb://host:27017/db',
    ].join('\n');
    const result = parseConnectionImportFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.connections).toHaveLength(1);
  });
});

describe('maskUriPassword', () => {
  it('masks the auth password for display', () => {
    expect(maskUriPassword('mongodb://alice:secret@host/db')).toBe(
      'mongodb://alice:••••••@host/db',
    );
  });
});

describe('buildExportAllUris', () => {
  const profiles = [
    { id: 'p1', name: 'Local', uri: 'mongodb://user:secret@localhost:27017/local?appName=MQLens' },
    { id: 'p2', name: 'Prod', uri: 'mongodb://admin:pw@prod.example.com:27017/prod?replicaSet=rs0' },
  ];

  it('formats each connection as JSON', () => {
    const text = buildExportAllUris(profiles, {
      includePassword: true,
      includeSettings: true,
    });
    expect(JSON.parse(text)).toEqual({
      connections: [
        { name: 'Local', uri: 'mongodb://user:secret@localhost:27017/local?appName=MQLens' },
        { name: 'Prod', uri: 'mongodb://admin:pw@prod.example.com:27017/prod?replicaSet=rs0' },
      ],
    });
  });

  it('strips secrets from every exported URI by default', () => {
    const text = buildExportAllUris(profiles, {
      includePassword: false,
      includeSettings: true,
    });
    const parsed = JSON.parse(text);
    expect(parsed.connections).toEqual([
      { name: 'Local', uri: 'mongodb://user@localhost:27017/local?appName=MQLens' },
      { name: 'Prod', uri: 'mongodb://admin@prod.example.com:27017/prod?replicaSet=rs0' },
    ]);
    expect(text).not.toContain('secret');
    expect(text).not.toContain(':pw@');
  });

  it('preserves folder structure for transfer between MQLens instances', () => {
    const text = buildExportAllUris(
      profiles,
      { includePassword: false, includeSettings: true },
      {
        folders: [
          { id: 'f1', name: 'Local resources' },
          { id: 'f2', name: 'Production' },
        ],
        profileFolderMap: { p1: 'f1', p2: 'f2' },
      },
    );
    expect(JSON.parse(text)).toEqual({
      folders: [
        {
          name: 'Local resources',
          connections: [
            { name: 'Local', uri: 'mongodb://user@localhost:27017/local?appName=MQLens' },
          ],
        },
        {
          name: 'Production',
          connections: [
            { name: 'Prod', uri: 'mongodb://admin@prod.example.com:27017/prod?replicaSet=rs0' },
          ],
        },
      ],
      connections: [],
    });
  });
});

describe('asking for a password that was not saved', () => {
  it('asks when a password mechanism has a user and no password', () => {
    expect(needsPasswordPrompt('mongodb://alice@db:27017/')).toBe(true);
    expect(needsPasswordPrompt('mongodb://alice@db:27017/?authMechanism=SCRAM-SHA-1')).toBe(true);
    expect(needsPasswordPrompt('mongodb://alice@db:27017/?authMechanism=PLAIN&authSource=$external')).toBe(true);
    expect(needsPasswordPrompt('mongodb+srv://AKIA@cluster.example.net/?authMechanism=MONGODB-AWS')).toBe(true);
  });

  it('does not ask when there is a password, no user, or a passwordless mechanism', () => {
    expect(needsPasswordPrompt('mongodb://alice:pw@db:27017/')).toBe(false);
    expect(needsPasswordPrompt('mongodb://alice:@db:27017/')).toBe(false);
    expect(needsPasswordPrompt('mongodb://db:27017/')).toBe(false);
    expect(needsPasswordPrompt('mongodb://CN=me@db:27017/?authMechanism=MONGODB-X509')).toBe(false);
    expect(needsPasswordPrompt('mongodb://svc%40REALM@db:27017/?authMechanism=GSSAPI')).toBe(false);
    expect(needsPasswordPrompt('mongodb://me@db:27017/?authMechanism=MONGODB-OIDC')).toBe(false);
    expect(needsPasswordPrompt('mongodb://db:27017/?note=a@b')).toBe(false);
  });

  it('puts the typed password into the userinfo, encoded', () => {
    expect(withPassword('mongodb://alice@db:27017/shop?tls=true', 'p@ss:/w')).toBe(
      'mongodb://alice:p%40ss%3A%2Fw@db:27017/shop?tls=true',
    );
    expect(withPassword('mongodb+srv://alice@cluster.example.net', 'x')).toBe('mongodb+srv://alice:x@cluster.example.net');
  });
});

describe('what the connection table shows', () => {
  it('summarises a URI without its password', () => {
    expect(connectionSummary('mongodb://alice:s3cret@h1:27017,h2:27018/app?tls=true&authMechanism=SCRAM-SHA-1')).toEqual({
      server: 'h1:27017, h2:27018',
      user: 'alice',
      mechanism: 'SCRAM-SHA-1',
      tls: true,
    });
    expect(connectionSummary('mongodb+srv://cluster0.example.net/')).toEqual({
      server: 'cluster0.example.net (SRV)',
      user: '',
      mechanism: '',
      tls: true,
    });
    expect(connectionSummary('mongodb://localhost')).toEqual({ server: 'localhost', user: '', mechanism: '', tls: false });
  });

  it('remembers when each profile last connected', () => {
    localStorage.clear();
    recordLastConnected('p1', 1000);
    recordLastConnected('p2', 2000);
    recordLastConnected('p1', 3000);
    expect(readLastConnected()).toEqual({ p1: 3000, p2: 2000 });
  });

  it('reads damaged storage as nothing recorded', () => {
    localStorage.setItem('mqlens.lastConnected', '{not json');
    expect(readLastConnected()).toEqual({});
  });
});

describe('maskUriPassword hides secret options too', () => {
  it('masks the sslCertificateKeyFilePassword spelling as well', () => {
    expect(maskUriPassword('mongodb://h/?sslCertificateKeyFilePassword=kp')).toBe('mongodb://h/?sslCertificateKeyFilePassword=••••••');
  });

  it('masks the proxy password and every client-key passphrase spelling', () => {
    const masked = maskUriPassword(
      'mongodb://h:27017/?tls=true&tlsCertificateKeyFilePassword=kp1&proxyPassword=pp&sslClientCertificateKeyPassword=kp2&sslPEMKeyPassword=kp3&appName=x',
    );
    expect(masked).toBe(
      'mongodb://h:27017/?tls=true&tlsCertificateKeyFilePassword=••••••&proxyPassword=••••••&sslClientCertificateKeyPassword=••••••&sslPEMKeyPassword=••••••&appName=x',
    );
  });
});

describe('importing from other MongoDB tools', () => {
  it('reads a Compass export, named by its favourite', () => {
    const compass = JSON.stringify({
      type: 'Compass Connections',
      version: { $numberInt: '1' },
      connections: [
        {
          id: 'c1',
          connectionOptions: { connectionString: 'mongodb://ann@reports.db:27017/?authSource=admin' },
          favorite: { name: 'Reports', color: 'color3' },
        },
        { id: 'c2', connectionOptions: { connectionString: 'mongodb+srv://cluster0.example.net/' } },
      ],
    });
    expect(parseConnectionImportFile(compass)).toEqual({ ok: true, connections: [
      { name: 'Reports', uri: 'mongodb://ann@reports.db:27017/?authSource=admin', folder: null },
      { name: 'cluster0.example.net', uri: 'mongodb+srv://cluster0.example.net/', folder: null },
    ] });
  });

  it('builds URIs from a robo3t.json, which stores fields rather than a URI', () => {
    const robo = JSON.stringify({
      connections: [
        {
          connectionName: 'Local',
          serverHost: 'localhost',
          serverPort: 27017,
          credentials: [],
          ssl: { enabled: false },
        },
        {
          connectionName: 'Billing',
          serverHost: 'billing.db',
          serverPort: 27018,
          credentials: [{ enabled: true, userName: 'bob', userPassword: 'p@ss', databaseName: 'admin', mechanism: 'SCRAM-SHA-256' }],
          ssl: { enabled: true },
        },
        {
          connectionName: 'Cluster',
          serverHost: 'm1.db',
          serverPort: 27017,
          credentials: [{ enabled: false, userName: 'unused', userPassword: 'x', databaseName: 'admin' }],
          replicaSet: { setName: 'rs0', members: ['m1.db:27017', 'm2.db:27017'] },
        },
      ],
    });
    expect(parseConnectionImportFile(robo)).toEqual({ ok: true, connections: [
      { name: 'Local', uri: 'mongodb://localhost:27017/', folder: null },
      {
        name: 'Billing',
        uri: 'mongodb://bob:p%40ss@billing.db:27018/?authSource=admin&authMechanism=SCRAM-SHA-256&tls=true',
        folder: null,
      },
      { name: 'Cluster', uri: 'mongodb://m1.db:27017,m2.db:27017/?replicaSet=rs0', folder: null },
    ] });
  });
});

describe('exporting and importing SSH tunnel settings', () => {
  const tunnelled = {
    id: 'p-ssh',
    name: 'Behind bastion',
    uri: 'mongodb://app:pw@10.0.0.5:27017/',
    ssh: { enabled: true, host: 'bastion.example', port: 2222, user: 'ops', auth: { type: 'key' as const, path: '/keys/id_ed25519', passphrase: 'kp' } },
  };

  it('writes the tunnel into the JSON export, without its secrets by default', () => {
    const out = JSON.parse(buildExportAllUris([tunnelled], { includePassword: false, includeSettings: true }));
    expect(out.connections[0].ssh).toEqual({ host: 'bastion.example', port: 2222, user: 'ops', auth: { type: 'key', path: '/keys/id_ed25519' } });
    const withSecrets = JSON.parse(buildExportAllUris([tunnelled], { includePassword: true, includeSettings: true }));
    expect(withSecrets.connections[0].ssh.auth).toEqual({ type: 'key', path: '/keys/id_ed25519', passphrase: 'kp' });
  });

  it('leaves out a tunnel that is switched off', () => {
    const off = { ...tunnelled, ssh: { ...tunnelled.ssh, enabled: false } };
    expect(JSON.parse(buildExportAllUris([off], { includePassword: false, includeSettings: true })).connections[0].ssh).toBeUndefined();
  });

  it('reads the tunnel back on import', () => {
    const text = buildExportAllUris([tunnelled], { includePassword: false, includeSettings: true });
    expect(parseConnectionImportFile(text)).toEqual({
      ok: true,
      connections: [{
        name: 'Behind bastion',
        uri: 'mongodb://app@10.0.0.5:27017/',
        folder: null,
        ssh: { enabled: true, host: 'bastion.example', port: 2222, user: 'ops', auth: { type: 'key', path: '/keys/id_ed25519' } },
      }],
    });
  });

  it('ignores an ssh entry it cannot use', () => {
    const text = JSON.stringify({ connections: [{ name: 'x', uri: 'mongodb://h', ssh: { host: 'b', auth: { type: 'telnet' } } }] });
    expect(parseConnectionImportFile(text)).toEqual({ ok: true, connections: [{ name: 'x', uri: 'mongodb://h', folder: null }] });
  });
});

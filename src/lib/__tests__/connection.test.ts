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
  it('accepts mongodb and mongodb+srv URIs', () => {
    expect(validateMongoUri('mongodb://localhost:27017')).toBeNull();
    expect(validateMongoUri('mongodb+srv://cluster.example.net')).toBeNull();
  });

  it('rejects empty and non-mongodb strings', () => {
    expect(validateMongoUri('')).toMatch(/enter a mongodb/i);
    expect(validateMongoUri('postgres://localhost')).toMatch(/enter a mongodb/i);
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
    expect(resolveImportUri('postgres://localhost')).toEqual({
      ok: false,
      error: 'No mongodb:// or mongodb+srv:// URI found in file',
    });
  });

  it('rejects empty input', () => {
    expect(resolveImportUri('   ')).toEqual({
      ok: false,
      error: 'File is empty',
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

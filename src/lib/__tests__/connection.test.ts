import { describe, it, expect } from 'vitest';
import { buildExportUri, findMongoUriInText, stripUriSecrets } from '../connection';

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

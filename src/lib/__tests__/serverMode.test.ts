import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  connectToServer,
  deleteServerAccount,
  isCommandBlocked,
  isServerConnection,
  listServerAccounts,
  listServerConnections,
  parseServerProfileId,
  saveServerAccount,
  serverProfileId,
  signInToServer,
  signOutOfServer,
} from '../serverMode';
import type { ConnectionEntry } from '../../workspace/workspaceStore';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const local: ConnectionEntry = { id: 'l1', profileId: 'p1', name: 'Local', viaMcp: false };
const remote: ConnectionEntry = {
  id: 'r1',
  profileId: 'server:acc-1:c-9',
  name: 'Orders',
  viaMcp: false,
  server: {
    accountId: 'acc-1',
    accountName: 'Acme',
    serverUrl: 'https://mqlens.acme.test',
    remoteId: 'c-9',
    opClasses: ['read'],
    blockedCommands: ['count_documents', 'insert_document'],
    roleBlockedCommands: ['insert_document'],
  },
};

describe('server profile ids', () => {
  it('round-trips the account and the server connection', () => {
    expect(parseServerProfileId(serverProfileId('acc-1', 'c-9'))).toEqual({
      accountId: 'acc-1',
      remoteId: 'c-9',
    });
  });

  it('keeps a remote id that contains a colon whole', () => {
    expect(parseServerProfileId(serverProfileId('acc-1', 'a:b'))).toEqual({
      accountId: 'acc-1',
      remoteId: 'a:b',
    });
  });

  it('reads a local profile id, or a malformed one, as not a server one', () => {
    for (const id of ['3f2c-uuid', 'server:', 'server:acc-1', 'server::c-9', 'server:acc-1:']) {
      expect(parseServerProfileId(id), id).toBeNull();
    }
  });
});

describe('blocked commands', () => {
  it('blocks nothing on a local connection', () => {
    expect(isServerConnection(local)).toBe(false);
    expect(isCommandBlocked(local, 'count_documents')).toBe(false);
  });

  it('blocks what the server connection says it cannot run', () => {
    expect(isServerConnection(remote)).toBe(true);
    expect(isCommandBlocked(remote, 'count_documents')).toBe(true);
    expect(isCommandBlocked(remote, 'execute_mql_query')).toBe(false);
  });

  it('treats a missing connection as blocking nothing', () => {
    expect(isCommandBlocked(undefined, 'count_documents')).toBe(false);
  });
});

describe('server commands', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('calls each backend command with its arguments', async () => {
    const input = {
      name: 'Acme',
      url: 'https://mqlens.acme.test',
      tenant: 'acme',
      email: 'ops@acme.test',
      allowInsecureHttp: false,
    };
    await listServerAccounts();
    await saveServerAccount(input);
    await deleteServerAccount('acc-1');
    await signInToServer('acc-1', 'pw');
    await signOutOfServer('acc-1');
    await listServerConnections('acc-1');
    await connectToServer('acc-1', 'c-9');

    expect(invokeMock.mock.calls).toEqual([
      ['server_account_list'],
      ['server_account_save', { account: input }],
      ['server_account_delete', { id: 'acc-1' }],
      ['server_sign_in', { accountId: 'acc-1', password: 'pw' }],
      ['server_sign_out', { accountId: 'acc-1' }],
      ['server_list_connections', { accountId: 'acc-1' }],
      ['server_connect', { accountId: 'acc-1', remoteId: 'c-9' }],
    ]);
  });
});

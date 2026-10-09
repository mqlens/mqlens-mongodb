// Server mode: MQLens Server accounts, sign-in, and connections made through a
// server rather than straight to MongoDB.
import { invoke } from '@tauri-apps/api/core';
import type { ConnectionEntry } from '../workspace/workspaceStore';

/** An MQLens Server account as the backend shows it: never a token. */
export interface ServerAccountView {
  id: string;
  name: string;
  url: string;
  tenant: string;
  email: string;
  allowInsecureHttp: boolean;
  extraCaPem?: string | null;
  signedIn: boolean;
  /** Set when an action half-succeeded, e.g. a session could not be ended on its server. */
  warning?: string;
}

export interface ServerAccountInput {
  /** Omitted for a new account. */
  id?: string;
  name: string;
  url: string;
  tenant: string;
  email: string;
  allowInsecureHttp: boolean;
  extraCaPem?: string | null;
}

export interface AccountDeleteResult {
  deleted: boolean;
  /** Whether the server confirmed the session ended; absent when there was none. */
  sessionRevoked?: boolean | null;
}

export interface SignOutResult {
  endedOnServer: boolean;
}

/** One of a server's connections: a reference and what the user may do there. */
export interface RemoteConnectionView {
  id: string;
  name: string;
  tags: string[];
  deploymentKind: string;
  opClasses: string[];
}

export interface ServerConnectResult {
  /** The desktop connection id the server connection now has. */
  id: string;
  mongoVersion: string;
  opClasses: string[];
}

/** What a connection-list entry carries for a connection made through a server. */
export interface RemoteConnectionInfo {
  accountId: string;
  accountName: string;
  serverUrl: string;
  remoteId: string;
  opClasses: string[];
  /** Commands the connection cannot run; the UI disables them. */
  blockedCommands: string[];
  /** Those of them that only the user's role rules out. */
  roleBlockedCommands: string[];
}

export const listServerAccounts = () => invoke<ServerAccountView[]>('server_account_list');
export const saveServerAccount = (account: ServerAccountInput) =>
  invoke<ServerAccountView>('server_account_save', { account });
export const deleteServerAccount = (id: string) =>
  invoke<AccountDeleteResult>('server_account_delete', { id });
export const signInToServer = (accountId: string, password: string) =>
  invoke<ServerAccountView>('server_sign_in', { accountId, password });
export const signOutOfServer = (accountId: string) =>
  invoke<SignOutResult>('server_sign_out', { accountId });
export const listServerConnections = (accountId: string) =>
  invoke<RemoteConnectionView[]>('server_list_connections', { accountId });
export const connectToServer = (accountId: string, remoteId: string) =>
  invoke<ServerConnectResult>('server_connect', { accountId, remoteId });

const PREFIX = 'server:';

/** The profile id a server connection is remembered by, for reconnecting. */
export const serverProfileId = (accountId: string, remoteId: string) =>
  `${PREFIX}${accountId}:${remoteId}`;

/** The account and server connection behind a profile id, or null for a local one. */
export function parseServerProfileId(
  profileId: string
): { accountId: string; remoteId: string } | null {
  if (!profileId.startsWith(PREFIX)) return null;
  const rest = profileId.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1) return null;
  return { accountId: rest.slice(0, colon), remoteId: rest.slice(colon + 1) };
}

export const isServerConnection = (entry: ConnectionEntry | undefined) => !!entry?.server;

/** Whether `command` cannot run on this connection. Local connections block nothing. */
export const isCommandBlocked = (entry: ConnectionEntry | undefined, command: string) =>
  entry?.server?.blockedCommands.includes(command) ?? false;

/** The monitoring view's reads: it is worth opening while any of them can run. */
export const MONITORING_READS = ['server_status', 'repl_set_status', 'get_profiling_status'];

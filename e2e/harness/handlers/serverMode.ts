// MQLens Server accounts, and the connections made through them (#396).
//
// A server connection reads one of the seeded servers, so the data handlers
// answer for it as for any other connection. It is listed with the server
// details and the commands it cannot run, as the backend lists it.
import type { Backend } from '../backend';
import type { ServerAccountSeed } from '../seed';
import type { E2EState } from '../state';

const view = (account: ServerAccountSeed) => ({
  id: account.id,
  name: account.name,
  url: account.url,
  tenant: account.tenant,
  email: account.email,
  allowInsecureHttp: account.allowInsecureHttp ?? false,
  extraCaPem: account.extraCaPem ?? null,
  signedIn: account.signedIn ?? false,
});

export function registerServerModeHandlers(backend: Backend, state: E2EState): void {
  let nextAccount = 1;
  const account = (id: unknown) => {
    const found = state.serverAccounts.find((a) => a.id === String(id));
    if (!found) throw `MQLens Server account not found: ${String(id)}`;
    return found;
  };
  const signedIn = (found: ServerAccountSeed) => {
    if (!found.signedIn) throw `Sign in to the MQLens Server account "${found.name}" first`;
  };

  backend.register({
    server_account_list: () => state.serverAccounts.map(view),
    server_account_save: ({ account: input }) => {
      const fields = input as Omit<ServerAccountSeed, 'connections' | 'signedIn'>;
      const existing = fields.id ? account(fields.id) : undefined;
      const saved: ServerAccountSeed = existing
        ? Object.assign(existing, fields)
        : { ...fields, id: `acct-${nextAccount++}`, signedIn: false, connections: [] };
      if (!existing) state.serverAccounts.push(saved);
      return { ...view(saved), warning: saved.saveWarning };
    },
    server_account_delete: ({ id }) => {
      const found = account(id);
      state.serverAccounts = state.serverAccounts.filter((a) => a !== found);
      return { deleted: true, sessionRevoked: found.signedIn ? !found.signOutUnconfirmed : null };
    },
    server_sign_in: ({ accountId, password }) => {
      const found = account(accountId);
      if (found.password !== undefined && password !== found.password) throw 'Wrong email or password';
      found.signedIn = true;
      return view(found);
    },
    server_sign_out: ({ accountId }) => {
      const found = account(accountId);
      found.signedIn = false;
      return { endedOnServer: !found.signOutUnconfirmed };
    },
    server_list_connections: ({ accountId }) => {
      const found = account(accountId);
      signedIn(found);
      return (found.connections ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        tags: c.tags ?? [],
        deploymentKind: c.deploymentKind ?? 'replica_set',
        opClasses: c.opClasses ?? ['read'],
      }));
    },
    server_connect: ({ accountId, remoteId }) => {
      const found = account(accountId);
      signedIn(found);
      const remote = (found.connections ?? []).find((c) => c.id === String(remoteId));
      if (!remote) throw `This connection is not available to you on the MQLens Server account "${found.name}"`;
      const id = `conn-${state.nextConnectionId++}`;
      const opClasses = remote.opClasses ?? ['read'];
      state.connections[id] = {
        uri: remote.server,
        profileId: null,
        name: remote.name,
        mode: 'readWrite',
        server: {
          accountId: found.id,
          accountName: found.name,
          serverUrl: found.url,
          remoteId: remote.id,
          opClasses,
          blockedCommands: remote.blockedCommands ?? [],
        },
      };
      return { id, mongoVersion: state.servers[remote.server]?.version ?? '8.0.0', opClasses };
    },
  });
}

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

const isLoopback = (host: string) => {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  // An address, as IpAddr::is_loopback takes it; a name that only starts like one is not.
  const ipv4 = bare.split('.');
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    (ipv4.length === 4 && ipv4[0] === '127' && ipv4.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255))
  );
};

/** The URL's authority as written, which normalize_url keeps (an explicit default port included). */
const authorityOf = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];

/** The server URL as channel::normalize_url accepts and stores it, with its messages. */
function normalizeUrl(input: string, allowInsecureHttp: boolean): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw 'Enter the MQLens Server URL';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw 'MQLens Server URL must start with https://';
  }
  if (url.username || url.password) throw 'MQLens Server URL must not include a user name or password';
  if (url.pathname !== '/' || url.search) throw 'MQLens Server URL must not include a path';
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'http' && !allowInsecureHttp && !isLoopback(url.hostname)) {
    throw 'MQLens Server URL must use https:// unless the server runs on this computer';
  }
  if (scheme !== 'https' && scheme !== 'http') throw 'MQLens Server URL must start with https://';
  return `${scheme}://${authorityOf(trimmed).toLowerCase()}`;
}

/** The form as ServerAccountInput::into_account validates and stores it, with its messages. */
function normalize(a: Pick<ServerAccountSeed, 'id' | 'name' | 'url' | 'tenant' | 'email' | 'allowInsecureHttp' | 'extraCaPem'>) {
  const name = a.name.trim();
  if (!name) throw 'Enter a name for this MQLens Server account';
  const allowInsecureHttp = a.allowInsecureHttp ?? false;
  const url = normalizeUrl(a.url, allowInsecureHttp);
  const tenant = a.tenant.trim();
  if (!tenant) throw 'Enter the MQLens Server tenant';
  const email = a.email.trim();
  const [local, domain, extra] = email.split('@');
  if (!local || !domain || extra !== undefined || /\s/.test(email)) {
    throw 'Enter the email address you sign in to MQLens Server with';
  }
  const extraCaPem = a.extraCaPem?.trim() || null;
  if (extraCaPem && !extraCaPem.includes('-----BEGIN CERTIFICATE-----')) {
    throw 'The extra CA certificate must be PEM text starting with -----BEGIN CERTIFICATE-----';
  }
  return { id: a.id, name, url, tenant, email, allowInsecureHttp, extraCaPem };
}

/** Whether two accounts sign in to the same place as the same user, as ServerAccount::same_identity decides. */
const sameIdentity = (a: ServerAccountSeed, b: ReturnType<typeof normalize>) =>
  a.url === b.url &&
  a.tenant === b.tenant &&
  a.email.toLowerCase() === b.email.toLowerCase() &&
  (a.allowInsecureHttp ?? false) === b.allowInsecureHttp &&
  (a.extraCaPem ?? null) === b.extraCaPem;

export function registerServerModeHandlers(backend: Backend, state: E2EState): void {
  let nextAccount = 1;
  const newId = () => {
    let id = `acct-${nextAccount++}`;
    while (state.serverAccounts.some((a) => a.id === id)) id = `acct-${nextAccount++}`;
    return id;
  };
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
      // Only what the backend's ServerAccountInput carries; the view's signedIn and warning are not input.
      const { id, name, url, tenant, email, allowInsecureHttp, extraCaPem } = input as ServerAccountSeed;
      const fields = normalize({ id, name, url, tenant, email, allowInsecureHttp, extraCaPem });
      const existing = fields.id ? account(fields.id) : undefined;
      // A new identity ends the session; only then is there one to revoke, and a warning when that fails.
      const displaced = !!existing?.signedIn && !sameIdentity(existing, fields);
      if (displaced) existing!.signedIn = false;
      const saved: ServerAccountSeed = existing
        ? Object.assign(existing, fields)
        : { ...fields, id: newId(), signedIn: false, connections: [] };
      if (!existing) state.serverAccounts.push(saved);
      return { ...view(saved), warning: displaced ? saved.saveWarning : undefined };
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
      // The server reports no op classes for a connection the user cannot reach.
      if (opClasses.length === 0) throw `This connection is not available to you on the MQLens Server account "${found.name}"`;
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

# OIDC (browser login)

MQLens supports **MONGODB-OIDC** for MongoDB deployments that use workforce
OIDC — a browser-based sign-in, instead of a stored username and password.
Under the hood it's OAuth 2.0 Authorization Code with PKCE (S256), run in
your **system browser**. You never paste or store a token.

## Setting it up in MQLens

1. Open the connection editor and go to the **Authentication** tab.
2. Choose **OIDC (browser login)**.
3. **Username** is optional — a principal hint for your identity provider,
   not a credential. There's no password field.
4. **Allowed hosts** is needed only for self-managed deployments (see below).

The driver already allows these hosts by default: `*.mongodb.net`,
`*.mongodb-qa.net`, `*.mongodb-dev.net`, `*.mongodbgov.net`, `localhost`,
`127.0.0.1`, `::1`, and `*.mongo.com` — which covers MongoDB Atlas. A custom
**Allowed hosts** list **replaces** those defaults rather than adding to
them, so a self-managed deployment needs its own host listed explicitly.

Allowed hosts are stored on the connection profile, never in the connection
URI — the MongoDB driver rejects an `authMechanismProperties=ALLOWED_HOSTS`
option inside a connection string. That also means a URI you copy out of
MQLens stays valid for `mongosh` and other tools.

## What the MongoDB deployment must have

- OIDC configured with human sign-in flows enabled: MongoDB Atlas workforce
  identity federation, or a self-managed server whose `oidcIdentityProviders`
  configuration includes `issuer`, `audience`, `clientId`, and
  `supportsHumanFlows: true`.
- **MQLens takes the issuer, client ID and scopes from MongoDB itself during
  the handshake. You don't enter them in MQLens.** If the deployment supplies
  no client ID, the login can't start.

## Registering MQLens with your identity provider

- Register a **public client** (native, desktop or SPA type): no client
  secret, PKCE enabled.
- **Redirect URI: `http://127.0.0.1/callback` on any port.** MQLens picks a
  free port each time it logs in, so there's no fixed port to configure.
- The access token's **audience** must match the `audience` your MongoDB
  deployment checks. This is the most common reason a login succeeds in the
  browser but the token is then rejected by MongoDB.

## Requirements on the identity provider

- Its endpoints must be **HTTPS**. MQLens refuses a plain-HTTP identity
  provider.
- **Its TLS certificate must chain to a publicly trusted certificate
  authority.** MQLens currently trusts the standard public root set, not
  your operating system's certificate store. An identity provider behind an
  internal or enterprise certificate authority won't connect yet — this is a
  current limitation, not something you can configure around.
- MQLens never relaxes identity-provider certificate checks, even if the
  MongoDB connection itself allows invalid certificates.

## What happens when you connect or test

- The system browser opens. The redirect lands on a local listener bound to
  `127.0.0.1` only, on a temporary port. The browser page shown afterwards
  displays no token.
- In **Test Connection**, an OIDC profile shows an extra row:
  **Authenticate — waiting for browser login**.
- While a login is pending in the connection editor (from **Test** or
  **Connect**), you get **Cancel login** and **Open browser again**.
  **Open browser again** reopens the same pending login — it doesn't start
  a new one.
- A login started from the **sidebar** or a **reconnect** has **no cancel
  button**. MQLens abandons it on its own after the driver's **5-minute**
  limit.
- A slow sign-in is fine — logins taking well over a minute were tested and
  work.

## Staying signed in

Tokens are kept **in memory only**. Reauthenticating normally uses a refresh
token, without reopening the browser. If the identity provider rejects the
refresh token, MQLens opens a new browser login mid-session. That login
can't be cancelled from the app, and MQLens abandons it after 5 minutes if
you don't complete it.

## Privacy

- **Stored:** the connection URI and the optional allowed-hosts list.
  Nothing else.
- **Never stored:** access tokens, refresh tokens, authorization codes, or
  PKCE material.
- Tokens are released when you disconnect or close MQLens. Nothing
  OIDC-related is written to logs, exported URIs, or the clipboard.

## Proxies

A SOCKS5 proxy set in the connection URI applies to **MongoDB traffic
only**. MQLens reaches your identity provider directly over your system's
network, not through that proxy. If a corporate proxy blocks direct access
to the identity provider, you'll see a token-exchange error.

## SSH tunnels

OIDC works over an SSH tunnel with the default allowed hosts, because
through a tunnel the driver sees the connection as coming from `127.0.0.1`.
If you set a custom **Allowed hosts** list, **include `127.0.0.1`**, or the
tunnelled connection will be rejected. This is a current limitation.

## The embedded shell (mongosh)

The embedded shell runs **its own separate browser login** — it can't share
MQLens's session — so expect a second login prompt when you open the shell
on an OIDC connection. Any shell login error appears in the shell's own
output.

## Export and import (mongodump / mongorestore)

The bundled MongoDB Database Tools support OIDC only for automated
(workload) environments, not browser login. Exporting or importing on an
OIDC profile **fails immediately**, without contacting the server, and shows
an explanatory message. Use a SCRAM user for exports and imports instead.

## AI agents (MCP)

An agent can't start an OIDC login on its own — it gets an "interactive
login required in MQLens" error. It **can** use an OIDC connection you've
already opened yourself, if that profile is opted in to MCP access.

## Troubleshooting

Each entry below matches a message you may see in MQLens, followed by what
it means and what to do.

**"MQLens could not open your system browser. Open the login link manually, or set a default browser."**
MQLens couldn't hand off to a browser. Open the login link it shows
manually, or set a default browser on your system and try again.

**"The login was cancelled."**
You (or MQLens, on timeout) cancelled the login before it finished. Start
the login again when you're ready.

**"The login was denied. Approve the request in your browser to continue."**
You declined the consent screen in the browser, or your identity provider
denied the request. Start the login again and approve it.

**"MQLens could not read your identity provider's configuration. Check network access to the provider."**
MQLens couldn't fetch the identity provider's OIDC discovery document.
Check that your network can reach the identity provider (and that it's
actually reachable, not just MongoDB).

**"This MongoDB host is not in the allowed hosts for OIDC. Add it under Allowed hosts if you trust this deployment."**
Your custom **Allowed hosts** list doesn't include this deployment's host.
Add it under **Allowed hosts** in the Authentication tab if you trust this
deployment — remember a custom list replaces the built-in defaults rather
than extending them.

**"Your identity provider rejected the login request. Check the application registration for this deployment."**
The identity provider itself rejected the request — commonly a
misconfigured client registration. Check the application registration
(redirect URI, client type, allowed scopes) for this deployment.

**"The identity provider endpoint is not HTTPS. MQLens will not send a login over an unencrypted connection."**
MQLens refuses to talk to a plain-HTTP identity provider. This isn't
configurable; the identity provider needs an HTTPS endpoint.

**"Login succeeded, but the database did not respond. Check the host, TLS and network settings."**
The browser login itself worked, but MongoDB didn't respond to the
resulting connection. Check the host, TLS configuration, and network
settings on the connection itself.

**"This deployment did not supply an OIDC client id, so a browser login cannot start. Ask your administrator to configure one."**
MongoDB's OIDC handshake didn't return a client ID, so MQLens has nothing to
register a login against. This is a deployment-side configuration gap — ask
your administrator to configure `clientId` for this deployment's identity
provider.

**"MQLens could not open a local port to receive the login. Close other applications using loopback ports and try again."**
MQLens couldn't bind a local listener for the OAuth redirect. Close other
applications that might be holding loopback ports and try again.

**"The login response did not match this request and was rejected. Start the login again."**
The OAuth state returned by the identity provider didn't match what MQLens
sent — MQLens rejects it as a safety measure. Start the login again.

**"The browser login expired. Start the login again."**
You didn't finish the browser login within the time limit. Start the login
again.

**"MQLens could not exchange the login for a token. If your network uses a proxy, note that the identity provider is reached directly, not through the connection's SOCKS5 proxy."**
The final token exchange with the identity provider failed. If your network
requires a proxy to reach external hosts, remember MQLens reaches the
identity provider directly — a SOCKS5 proxy configured on the connection
only applies to MongoDB traffic (see **Proxies** above).

**"MongoDB rejected the login token. Confirm your account has access to this deployment."**
The browser login succeeded and MQLens got a token, but MongoDB rejected it
— commonly a token whose audience doesn't match what MongoDB expects, or an
account without access to this deployment. Confirm your account has access,
and check the client registration's audience (see **Registering MQLens with
your identity provider** above).

## Limitations in this release

- No workload/machine OIDC (Azure, GCP managed identities).
- No token persistence across restarts — every app restart requires a fresh
  browser login.
- No device-code flow.
- Export and import (mongodump / mongorestore) aren't supported on OIDC
  profiles.
- The identity provider must use a publicly trusted certificate authority;
  MQLens doesn't yet consult your OS certificate store.
- No cancel button for a login started from the sidebar or from a
  reconnect — MQLens abandons it on its own after 5 minutes.
- SSH tunnels need `127.0.0.1` in a custom allowed-hosts list (see **SSH
  tunnels** above).

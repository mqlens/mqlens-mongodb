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
5. **Use ID token instead of access token** is off by default. Turn it on
   only if MongoDB rejects your identity provider's access tokens (see
   **When MongoDB rejects your identity provider's access tokens** below).

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
- **Redirect URI: `http://localhost:27097/redirect`.** It is the one mongosh
  and Compass use, so an app registration made for them works for MQLens
  unchanged. Identity providers that match redirect URIs exactly (Entra ID,
  and OAuth 2.1 in general) need exactly this value, port included.
- **Response mode.** MQLens sends no `response_mode`, so the default
  applies: a redirect with the code in the query string. If your identity
  provider is set to post the response instead (`response_mode=form_post`),
  MQLens accepts that too. Prefer the redirect where you can choose: some
  browsers restrict or ask about a web page that posts a form to a local
  address, which a redirect avoids.
- The access token's **audience** must match the `audience` your MongoDB
  deployment checks. This is the most common reason a login succeeds in the
  browser but the token is then rejected by MongoDB. (With **Use ID token
  instead of access token** on, MongoDB checks the ID token, whose audience
  is the client ID; see the next section.)

## When MongoDB rejects your identity provider's access tokens

MongoDB accepts a token only if its JWT header has no `typ`, or has
`typ: "JWT"`. Some identity providers, cidaas among them, issue access
tokens typed `at+jwt` (the RFC 9068 access-token format), and MongoDB
refuses those, whatever else the token carries. The browser login succeeds,
and then MongoDB rejects the token. MQLens recognises this case and tells you
to turn on the option below. Turning it on is always needed for such tokens,
but it may not be all that's needed: if the issuer or audience is also wrong,
MongoDB will still reject the login.

Turn on **Use ID token instead of access token** in the OIDC section of the
Authentication tab. MQLens then gives MongoDB the **ID token** from the same
login, which such identity providers type as plain `JWT`. This is the same
escape hatch as mongosh's `--oidcIdTokenAsAccessToken`.

- **The deployment's `audience` must be your client ID.** An ID token's
  audience is always the client ID it was issued to. On a self-managed
  server, set `audience` in `oidcIdentityProviders` to the same value as
  `clientId`.
- MongoDB takes the user name, and any groups claim it uses for
  authorization, from the ID token. Make sure your identity provider puts
  those claims in the ID token and not only in the access token.
- MQLens checks that the ID token belongs to this login: its `nonce` must
  match the one MQLens sent. MongoDB checks the signature, issuer and
  audience.
- When the identity provider's refresh response includes a new ID token,
  MQLens uses it. When it doesn't, MQLens starts a new browser login instead
  of resending the old ID token. MQLens also stops using an ID token when
  it expires, even if the access token from the same login is still valid.
- MongoDB receives the ID token itself, including the profile claims your
  identity provider puts in it (for example your name and email address).
  If other people run the deployment, bear that in mind before turning the
  option on. **Allowed hosts** still limit which servers a token can be
  sent to (see **Privacy** below).

## Requirements on the identity provider

- Its endpoints must be **HTTPS**. MQLens refuses a plain-HTTP identity
  provider.
- **Its TLS certificate must chain to a certificate authority MQLens
  trusts.** MQLens trusts both the standard public root set and your
  operating system's certificate store — broadly what most browsers trust,
  though not identical: Firefox keeps its own store by default, and if
  `SSL_CERT_FILE` or `SSL_CERT_DIR` is set in MQLens's environment, the
  certificates they name replace the OS store. An identity provider behind
  an internal or enterprise certificate authority works once that
  authority's root is in the OS certificate store, and so does a network
  that inspects TLS traffic (Zscaler, Netskope and similar) and re-signs it
  with a corporate root.
- MQLens never relaxes identity-provider certificate checks, even if the
  MongoDB connection itself allows invalid certificates.

The requests MQLens's AI features send to an AI provider trust the same
certificates. That lets them work behind TLS inspection and internal-CA
gateways, and it also means a company proxy that inspects TLS can read those
requests, your AI provider's API key and your prompts included, just as it
can read your browser's traffic. (An AI command-line tool that MQLens runs
for you makes its own connections, with its own certificate settings.)

## What happens when you connect or test

- The system browser opens. The redirect lands on a local listener on port
  27097, bound to the loopback addresses only (`127.0.0.1`, and `::1` where
  the computer has IPv6), for as long as the login waits. The browser page
  shown afterwards displays no token.
- In **Test Connection**, an OIDC profile shows an extra row:
  **Authenticate — waiting for browser login**.
- While a login is pending in the connection editor (from **Test** or
  **Connect**), you get **Cancel login** and **Open browser again**.
  **Open browser again** reopens the same pending login — it doesn't start
  a new one.
- A login started from the **sidebar**, from a **recent connection on the
  start page**, or from a **reconnect** has **no cancel button**. MQLens
  abandons it on its own after the driver's **5-minute** limit.
- Closing the connection dialog cancels any login it started that is still
  waiting.
- A slow sign-in is fine: it isn't cut off by the connection's own timeouts.
  Logins lasting up to about 45 seconds have been tested. The hard limit is
  the driver's 5 minutes, and it covers the whole login — including every
  request MQLens makes to your identity provider — so an identity provider
  that stops responding can't hold a login open past it.
- **Test Connection** and **Connect** each run their own login. Testing a
  profile and then connecting it means two browser logins.
- The **Authenticate** row also turns red when the login is refused outside
  the browser: when MongoDB rejects the token (even though the browser part
  succeeded), or when the host isn't in the allowed hosts (before any
  browser opens).

## Staying signed in

Tokens are kept **in memory only**. Reauthenticating normally uses a refresh
token, without reopening the browser. If the identity provider rejects the
refresh token, or never issued one, MQLens opens a new browser login
mid-session. Whatever needed the new token starts it, and that can be an
MCP agent's query (see **AI agents** below). That login can't be cancelled
from the app, and MQLens abandons it after 5 minutes if you don't complete
it.

## Privacy

- **Stored:** the connection URI, the optional allowed-hosts list, and
  whether **Use ID token instead of access token** is on. Nothing else.
- **Never stored:** access tokens, ID tokens, refresh tokens, authorization
  codes, or PKCE material.
- Tokens are released when you disconnect or close MQLens. Nothing
  OIDC-related is written to logs, exported URIs, or the clipboard.
- With **Use ID token instead of access token** on, MongoDB receives your
  **ID token**, profile claims such as name and email included, instead of
  the access token. Keep that in mind on a deployment others administer.
  Allowed hosts still decide which servers can receive it.

## Proxies

A SOCKS5 proxy set in the connection URI applies to **MongoDB traffic
only**. MQLens reaches your identity provider directly over your system's
network, not through that proxy. If a corporate proxy blocks direct access
to the identity provider, the login fails at its first request, reading the
identity provider's configuration: you'll see "MQLens could not read your
identity provider's configuration", before any browser opens.

## SSH tunnels

OIDC works over an SSH tunnel, and allowed hosts protect a tunnelled
connection the same as a direct one. Through a tunnel the MongoDB driver
only ever sees `127.0.0.1`, so MQLens checks your deployment's **real** host,
the one the tunnel forwards to, against the allowed hosts **before it opens
the tunnel**: your custom **Allowed hosts** list, or the built-in defaults
without one. If the host isn't allowed, the connection fails with the
allowed-hosts error, and no tunnel or browser opens.

So a self-managed deployment's host must be in your **Allowed hosts** list
whether or not you tunnel. The built-in defaults cover MongoDB Atlas and
localhost only, so with no custom list a tunnelled self-managed deployment
is refused, exactly as a direct connection to it would be. List your
deployment's own host name, as it appears in the connection URI. You don't
need to add `127.0.0.1`.

## The embedded shell (mongosh)

The embedded shell runs **its own separate browser login** — it can't share
MQLens's session — so expect a second login prompt when you open the shell
on an OIDC connection. Any shell login error appears in the shell's own
output.

With **Use ID token instead of access token** on, MQLens starts the shell
with mongosh's `--oidcIdTokenAsAccessToken`, so its login sends the ID
token too. The profile's **Allowed hosts** don't reach the shell; mongosh
applies its own rules for which hosts it will log in to.

## Export and import (mongodump / mongorestore)

The bundled MongoDB Database Tools support OIDC only for automated
(workload) environments, not browser login. Exporting or importing on an
OIDC profile **fails immediately**, without contacting the server, and shows
an explanatory message. Use a SCRAM user for exports and imports instead.
Browser-login support for export and import is tracked in
[issue #432](https://github.com/mqlens/mqlens-mongodb/issues/432).

## AI agents (MCP)

An agent **can't open** an OIDC connection: connecting an OIDC profile over
MCP fails with an "interactive login required in MQLens" error, without
opening a browser.

It **can** use an OIDC connection you've already opened yourself, if that
profile is opted in to MCP access — and that has one consequence to know
about. When the connection's access token expires, MQLens renews it with the
refresh token, without a browser. If your identity provider rejects the
refresh token, or never issued one, the connection signs in again with a
**browser login**, started by whichever operation needed the new token. If
that operation is an agent's query, the agent's query opens a browser login
on your desktop. Like any mid-session login, it can't be cancelled from
MQLens, and MQLens abandons it after the driver's 5-minute limit if you
don't complete it.

If you don't want an agent to be able to do that, don't opt OIDC profiles in
to MCP access, or disconnect them when you step away.

## Troubleshooting

Each entry below matches a message you may see in MQLens, followed by what
it means and what to do.

**"MQLens could not open your system browser. Set a default browser, then try again."**
MQLens couldn't hand off to a browser, so the login never started. Set a
default browser on your system, then test or connect again. MQLens does
not show the login link itself, because it carries this login's one-time
values.

**"The login was cancelled."**
The login was cancelled before it finished — with **Cancel login**, or by
closing the connection dialog while it was still waiting. (A login that runs
out of time reports that it expired instead; see below.) Start the login
again when you're ready.

**"The login was denied. Approve the request in your browser to continue."**
You declined the consent screen in the browser, or your identity provider
denied the request. Start the login again and approve it.

**"MQLens could not read your identity provider's configuration. Check network access to the provider."**
MQLens couldn't fetch the identity provider's OIDC discovery document — the
first thing a login asks the identity provider for, so a network or proxy
that blocks the identity provider (see **Proxies** above), or one that
doesn't answer in time, fails here, before any browser opens. Check that
your network can reach the identity provider directly (and that it's
actually reachable, not just MongoDB). A certificate MQLens doesn't trust
fails here too (see **Requirements on the identity provider** above).

MQLens also follows **no redirects** when talking to the identity provider,
and that includes this first request. If your identity provider answers its
`/.well-known/openid-configuration` address with a redirect, even to a valid
document, the login fails here. MQLens deliberately never follows an
identity provider's redirect, so this can't be configured. The discovery
address (the issuer MongoDB reports, plus `/.well-known/openid-configuration`)
must return the document directly.

**"This MongoDB host is not in the allowed hosts for OIDC. Add it under Allowed hosts if you trust this deployment."**
This deployment's host isn't in the allowed hosts — your custom **Allowed
hosts** list, or, without one, the built-in defaults (which cover MongoDB
Atlas and localhost, not a self-managed deployment's own host name). The
host is checked before any browser opens. Add the host under **Allowed
hosts** in the Authentication tab if you trust this deployment — remember a
custom list replaces the built-in defaults rather than extending them. The
same applies over an SSH tunnel: the host to allow is still the
deployment's own host from the connection URI, not `127.0.0.1`, and MQLens
checks it before opening the tunnel (see **SSH tunnels** above).

**"Your identity provider rejected the login request. Check the application registration for this deployment."**
The identity provider itself rejected the request — commonly a
misconfigured client registration. Check the application registration
(redirect URI, client type, allowed scopes) for this deployment.

**"The identity provider endpoint is not HTTPS. MQLens will not send a login over an unencrypted connection."**
MQLens refuses to talk to a plain-HTTP identity provider. This isn't
configurable; the identity provider needs an HTTPS endpoint.

**"Login succeeded, but the database did not respond. Check the host, TLS and network settings."**
The login with your identity provider completed, and then the connection
check failed with an error that isn't about authentication. That doesn't
mean MongoDB accepted the login: the failure may come before MongoDB ever
checks the token, for example a timeout or a dropped connection, or be an
unrelated command error. Check the host, TLS configuration, and network
settings on the connection itself. (If MongoDB had refused the token, you'd
see "MongoDB rejected the login token" instead.)

**"This deployment did not supply an OIDC client id, so a browser login cannot start. Ask your administrator to configure one."**
MongoDB's OIDC handshake didn't return a client ID, so MQLens has nothing to
register a login against. This is a deployment-side configuration gap — ask
your administrator to configure `clientId` for this deployment's identity
provider.

**"MQLens could not open port 27097 to receive the login. Another login may be using it, in MQLens, mongosh or Compass. Finish or cancel that login, then try again."**
Every login waits for the browser on port 27097, the redirect registered with
your identity provider, so only one can wait at a time, across MQLens,
mongosh and Compass. MQLens never falls back to another port, which the
identity provider would refuse. Finish or cancel the other login, or close
whatever else holds the port, then try again.

**"The login response did not match this request and was rejected. Start the login again."**
The OAuth state returned by the identity provider didn't match what MQLens
sent — MQLens rejects it as a safety measure. With **Use ID token instead of
access token** on, the same message means the ID token's `nonce` was
missing or didn't match this login's, so MQLens didn't send it to MongoDB.
Start the login again.

**"The browser login expired. Start the login again."**
The login didn't finish within the driver's 5-minute limit — almost always
because the browser login wasn't completed in time. Start the login again.

**"MQLens could not exchange the login for a token. If your network uses a proxy, note that the identity provider is reached directly, not through the connection's SOCKS5 proxy."**
The final token exchange with the identity provider failed, after the
browser part of the login. The identity provider refused or didn't answer
the exchange, or the browser came back without an authorization code.
MQLens also refuses a token endpoint that redirects it elsewhere, rather
than resend the login there. If your network requires a proxy to reach
external hosts, remember MQLens reaches the identity provider directly — a
SOCKS5 proxy configured on the connection only applies to MongoDB traffic
(see **Proxies** above).

**"MongoDB rejected the login token. Confirm your account has access to this deployment."**
The browser login succeeded and MQLens got a token, but MongoDB rejected it
— commonly a token whose audience doesn't match what MongoDB expects, or an
account without access to this deployment. In **Test Connection** the
**Authenticate** row turns red, even though the browser part had already
completed. Confirm your account has access,
and check the client registration's audience (see **Registering MQLens with
your identity provider** above). With **Use ID token instead of access
token** on, check that the deployment's `audience` is your client ID and
that the ID token carries the claims MongoDB needs (see **When MongoDB
rejects your identity provider's access tokens** above).

**"MongoDB rejected your identity provider's access token type. Turn on “Use ID token instead of access token” for this connection."**
The browser login succeeded, but the access token your identity provider
issued has a JWT type MongoDB refuses, typically `at+jwt`, as cidaas
issues. MongoDB accepts only untyped tokens or `typ: "JWT"`. In **Test
Connection** the **Authenticate** row turns red. Turn on **Use ID token
instead of access token** in the Authentication tab, and make sure the
deployment's `audience` is your client ID (see **When MongoDB rejects your
identity provider's access tokens** above).

## Limitations in this release

- No workload/machine OIDC (Azure, GCP managed identities).
- No token persistence across restarts — every app restart requires a fresh
  browser login.
- No device-code flow.
- Export and import (mongodump / mongorestore) aren't supported on OIDC
  profiles.
- No cancel button for a login started from the sidebar, from a recent
  connection on the start page, or from a reconnect — MQLens abandons it on
  its own after 5 minutes.
- An MCP agent using an OIDC connection you opened can trigger a browser
  login mid-session if your refresh token is rejected (see **AI agents**
  above).

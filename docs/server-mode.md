# Server mode: connecting through MQLens Server

MQLens can work with a MongoDB deployment directly, or through an
[MQLens Server](https://github.com/mqlens/mqlens-server) that your team runs.
Through a server, the app never sees the deployment's URI or credentials.
Your server account decides which connections you can open and what you may
do on them, and the server records what you do.

The data UI is the same as in local mode: browse, query, aggregate, edit,
manage indexes and users, monitor, export, GridFS and the shell. Each of
these runs on the server instead of from your machine.

## Adding an account

1. Open the connection manager and choose **MQLens Server**.
2. Choose **Add account** and fill in a name for it, then:
   - **Server URL**: `https://` is required. Plain `http://` is accepted only
     for a server on this machine (`localhost`, `127.0.0.1`, `::1`), unless
     you allow it for the account.
   - **Tenant** and **Email**: your server account.
   - **Extra CA certificate**: only needed for a server whose certificate your
     system does not trust.
3. Sign in with your password.

Your password is used to sign in and is never stored. The app keeps a refresh
token in its encrypted vault, so you stay signed in across restarts.

- **Locking the vault** signs this app out of every server and closes its
  server connections. Unlocking it resumes them without asking for your
  password again.
- **Signing out**, or changing an account's URL, tenant or email, ends that
  account's session on the server.

## Connecting

An account lists only the connections an administrator has granted you. Choose
**Connect** on one. It opens like any other connection and carries a
**Server** badge.

What you may do depends on your role on that connection:

| Role | You can |
| --- | --- |
| `viewer` | Browse, query, aggregate, explain, read schemas and statistics, see server status and the profiling level, export, download GridFS files |
| `operator` | All of the above, plus edit documents and upload or delete GridFS files |
| `admin`, `owner` | All of the above, plus collections, views, databases, indexes and validation; current operations and killing them; the profiler; deployment users and roles; and the shell |

Actions your role does not allow are disabled or hidden. A disabled one says
why: *Your role on this MQLens Server connection does not allow this* when a
different role would allow it (ask your server administrator), or *Not
available on MQLens Server yet* when no role would.

Server connections always open in the normal connection mode. The read-only
and confirm-destructive modes cannot be chosen for them yet, so your role on
the server is what limits you.

## Not available through a server yet

These are disabled on server connections:

- Copying collections or databases, import, and generating test data.
- `mongodump`/`mongorestore` (the MongoDB Database Tools).
- Watching change streams.
- Running a multi-line script as a one-shot `mongosh --file` program. The shell
  itself works, and multi-line input goes to its live session instead.
- AI agents over MCP: server connections are never offered to them.

## How it differs from local mode

Results are meant to match local mode exactly. Exports write the same bytes,
counts and explain plans use the same settings, and documents arrive as BSON,
not as JSON. The known differences:

- **The shell runs the server's mongosh.** Its startup banner says
  `Using Mongosh: on MQLens Server`, because the server does not report its
  mongosh version. Multi-line input runs in the live session, so a script that
  calls `quit()` ends the shell. If the server ends the shell with an error,
  the error is shown.
- **Ids that are themselves type-wrapper-shaped documents.** An inserted,
  upserted or GridFS file `_id` comes back as Extended JSON. So an `_id` that
  is itself a document like `{"$oid": …}` cannot be told apart from the type
  it imitates.
- **Stored documents with type-wrapper-shaped keys.** A sub-document such as
  `{"$numberLong": "7", "other": 1}` reads back exactly as stored through a
  server. Local mode currently reads it as the number 7, which is being fixed.
- **Auditing happens twice.** Your app's activity log records the operation,
  and so does the server's audit log.

## Versions

The app and the server agree on an API version when you connect. If they have
none in common, connecting fails and tells you which side to update:
**Update MQLens Server** or **Update this app**.

## When something fails

Errors from the server end with `(MQLens Server correlation id: …)`. Give that
id to your server administrator: it finds the request in the server's logs.

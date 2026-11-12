# Remembering native OIDC logins

The Authentication tab offers **Remember login in encrypted vault**, off by
default. Save the profile before connecting to remember its login. Only native
connections use this option; mongosh, Compass, and MCP keep their existing behavior.

Only refresh tokens are persisted. Access and ID tokens remain in memory. The
cache lives inside `connections.enc`, separate from the profiles returned over
IPC or exported to JSON. Existing vault locking, atomic writes, password rotation,
and reset apply to it without introducing another vault file.

A cached token belongs to one saved profile and its URI, SSH and OIDC settings.
The server's issuer, client ID and requested scopes must also match before reuse.
Changing these settings, disabling remembering, or deleting the profile discards
its cached token. A rejected refresh clears the token before browser login starts.
Successful refreshes save rotated tokens, including providers that keep the old
refresh token. Concurrent stale responses cannot overwrite a newer token.

**Forget saved login** deletes the stored token. Existing connections remain
signed in, but their old cache generation cannot write it back. A subsequent
connection may save a new login if remembering remains enabled. Locking the vault
prevents cache reads and writes.

The implementation follows the official
[@mongodb-js/oidc-plugin](https://github.com/mongodb-js/oidc-plugin/blob/76571c7c119db28f0dd3606522ba0c63b13028ce/src/plugin.ts):
versioned restored state, cache identity based on server metadata, and updates
when token sets rotate. MQLens saves only the refresh token in its own encrypted
vault rather than persisting the plugin's complete token-set serialization.

Old encrypted profile arrays still load. The encrypted payload becomes an
envelope only when a cache exists; old app versions cannot read that envelope.
Disabling remembering for all profiles and saving them removes the cache and
returns the payload to the old array format. Plain profile JSON stays unchanged
apart from the optional `remember_login` preference.

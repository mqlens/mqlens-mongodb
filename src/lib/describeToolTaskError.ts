/**
 * A dump/restore task's `error`, either raw (redacted) mongodump/mongorestore
 * stderr, or a bare locale key such as `tools.errors.oidcUnsupportedByDatabaseTools`
 * (#430 Task 16) — the backend maps the one Database Tools OIDC failure it can
 * actually recognize to a key instead of echoing the tool's own text, since
 * that text has no locale context of its own.
 *
 * Mirrors {@link describeConnectError}'s shape: `null`/`undefined` (no error)
 * pass through, and only a value starting with the known prefix is run
 * through `t()` — everything else, including raw stderr that happens to
 * contain a colon, is shown verbatim rather than risking a bogus namespace
 * lookup. The key always names the `shell` namespace explicitly, so this
 * works the same regardless of the caller's own default namespace.
 */
const TOOL_ERROR_PREFIX = 'tools.errors.';

export const describeToolTaskError = (
  error: string | null | undefined,
  t: (key: string) => string
): string | null | undefined => {
  if (!error) return error;
  return error.startsWith(TOOL_ERROR_PREFIX) ? t(`shell:${error}`) : error;
};

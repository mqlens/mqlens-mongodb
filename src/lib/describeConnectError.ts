/**
 * A connect/test failure the backend can hand the frontend, either a raw
 * (English) driver error string, or a bare OIDC locale key such as
 * `auth.oidc.errors.cancelled` (#430) — the backend never sends English for
 * an OIDC failure, since it has no locale context of its own.
 *
 * One helper, used at every site that shows a connect or test error (the
 * ConnectionManager test checklist and its connect banners, the sidebar
 * quick-connect toast, and the reconnect banner in App.tsx), so a bare key
 * is never rendered verbatim. The key always names the `connections`
 * namespace explicitly — callers may default to a different namespace (the
 * App.tsx sites default to `common`) — so this works the same regardless of
 * the caller's own `t()`.
 */
const OIDC_ERROR_PREFIX = 'auth.oidc.errors.';

export const describeConnectError = (error: unknown, t: (key: string) => string): string => {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return raw.startsWith(OIDC_ERROR_PREFIX) ? t(`connections:${raw}`) : raw;
};

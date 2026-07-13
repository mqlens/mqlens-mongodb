export const lagText = (lagSecs: number | null | undefined): string =>
  lagSecs == null ? 'n/a' : `${lagSecs < 10 ? lagSecs.toFixed(1) : Math.round(lagSecs)}s`;

export const lagClass = (lagSecs: number | null | undefined): string => {
  if (lagSecs == null) return 'text-muted-foreground';
  if (lagSecs >= 60) return 'font-semibold text-red-500';
  if (lagSecs >= 10) return 'font-semibold text-amber-500';
  return 'text-muted-foreground';
};

export const memberUnhealthy = (m: { health: number; stateStr: string }): boolean =>
  m.health !== 1 || /not reachable|DOWN|UNKNOWN/i.test(m.stateStr);

export const memberDotClass = (m: { health: number; stateStr: string }): string => {
  if (memberUnhealthy(m)) return 'bg-red-500';
  if (m.stateStr === 'PRIMARY') return 'bg-emerald-500';
  if (m.stateStr === 'SECONDARY') return 'bg-sky-500';
  return 'bg-amber-500';
};

export const fmtMemberUptime = (secs: number): string => {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((secs % 3_600) / 60)}m`;
};

/** Username from a mongodb:// or mongodb+srv:// URI, or null when auth-less.
 *  Multi-host URIs (mongodb://u:p@h1:27017,h2:27017/db) break `new URL`, so
 *  this is regex-based rather than parsed via the URL API. */
export const uriUser = (uri: string): string | null => {
  const m = /^mongodb(?:\+srv)?:\/\/([^:@/]+)(?::[^@/]*)?@/.exec(uri);
  return m ? decodeURIComponent(m[1]) : null;
};

/** readPreference from the URI query string; MongoDB's default is "primary". */
export const uriReadPreference = (uri: string): string => {
  const m = /[?&]readPreference=([^&]+)/i.exec(uri);
  return m ? decodeURIComponent(m[1]) : 'primary';
};

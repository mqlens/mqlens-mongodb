import type { TFunction } from 'i18next';

/** Avatar background colors (hex), chosen to read on the dark theme. */
export const AVATAR_PALETTE = [
  '#1f7a4d', // green
  '#9a6a13', // amber
  '#2b5fb0', // blue
  '#6d3bb0', // violet
  '#a23b5e', // rose
  '#1f6f7a', // teal
] as const;

export { primaryShortcutModifier } from './shortcuts';

/** Host[:port] parsed from a mongodb URI, credentials stripped. '' if unparseable. */
export function hostFromUri(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    const m = uri.match(/mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i);
    return m ? m[1] : '';
  }
}

/** First alphanumeric character of a name, uppercased; '?' when none. */
export function initial(name: string): string {
  const m = name.match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : '?';
}

/** Short topology label derived from a mongodb URI: SRV cluster, replica set, or
 *  standalone. Rendered on the connection card, so all three branches are
 *  user-facing copy; `t` is injected to keep this module pure (same pattern as
 *  `tabLabelFor` in App.tsx). */
export function topology(uri: string, t: TFunction): string {
  if (/^mongodb\+srv:\/\//i.test(uri)) return t('shell:connectionCard.topology.srvCluster');
  const m = uri.match(/mongodb:\/\/(?:[^@/]*@)?([^/?]+)/i);
  if (!m) return '';
  const hosts = m[1].split(',').filter(Boolean);
  return hosts.length > 1
    ? t('shell:connectionCard.topology.replicaSet', { count: hosts.length })
    : t('shell:connectionCard.topology.standalone');
}

/** Deterministic palette color from a name (FNV-1a hash). */
export function avatarColor(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

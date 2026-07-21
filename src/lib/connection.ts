import type { SshConfig } from '../components/ConnectionManager';

/** Mirrors backend `connections::ConnectionMode` (#188). */
export type ConnectionMode = 'normal' | 'read_only' | 'confirm_destructive';

/** A saved connection profile, mirroring the backend `ConnectionProfile`. */
export interface ConnectionProfile {
  id: string;
  name: string;
  uri: string;
  color_tag?: string | null;
  ssh?: SshConfig | null;
  /** Expose this profile to MCP agents. Mirrors backend `ConnectionProfile::mcp_enabled`. */
  mcp_enabled?: boolean;
  /** Read-only / confirm-destructive production safeguard. Mirrors backend `ConnectionProfile::connection_mode`. */
  connection_mode?: ConnectionMode;
}

/** Options for exporting a connection URI for sharing. */
export interface ExportUriOptions {
  /** Keep the auth password and other secret-bearing params. Default callers to false. */
  includePassword: boolean;
  /** Keep the query string (TLS files, replicaSet, appName, proxy, timeouts…). */
  includeSettings: boolean;
}

// Query params whose values are secrets in their own right.
const SECRET_PARAM_KEYS = /^(proxyPassword|tlsCertificateKeyFilePassword|sslClientCertificateKeyPassword)$/i;

const isSecretParam = (param: string): boolean => {
  const key = param.split('=')[0];
  if (SECRET_PARAM_KEYS.test(key)) return true;
  // AWS session tokens travel inside authMechanismProperties.
  return /^authMechanismProperties$/i.test(key) && /AWS_SESSION_TOKEN/i.test(param);
};

/**
 * Remove every secret a mongodb:// URI can carry: the userinfo password (the
 * username is kept), the SOCKS5 proxy password, client-key passwords, and AWS
 * session tokens. Unlike `maskUriPassword` (a display mask), the result is a
 * valid, shareable URI. SSH tunnel secrets never live in the URI itself.
 */
export const stripUriSecrets = (uri: string): string => {
  // Userinfo password: anchored to the scheme so query values can't match.
  let out = uri.replace(/^(mongodb(?:\+srv)?:\/\/[^:/@?#]+):[^@/?#]*@/i, '$1@');

  const qIdx = out.indexOf('?');
  if (qIdx === -1) return out;
  const kept = out
    .slice(qIdx + 1)
    .split('&')
    .filter((p) => p !== '' && !isSecretParam(p));
  return kept.length ? `${out.slice(0, qIdx)}?${kept.join('&')}` : out.slice(0, qIdx);
};

/**
 * Build the URI string an Export action writes to the clipboard or a file.
 * Excluding settings drops the whole query string (hosts and the default db
 * stay — they are the address, not settings); excluding the password strips
 * all secrets via `stripUriSecrets`.
 */
export const buildExportUri = (uri: string, opts: ExportUriOptions): string => {
  let out = opts.includeSettings ? uri : uri.split(/[?#]/)[0];
  if (!opts.includePassword) out = stripUriSecrets(out);
  return out;
};

/**
 * Find the first mongodb:// / mongodb+srv:// connection string in free-form
 * text (a .env file, a note, a pasted config). Quotes and whitespace end the
 * match so `MONGO_URL="mongodb://…"` yields just the URI.
 */
export const findMongoUriInText = (text: string): string | null =>
  text.match(/mongodb(?:\+srv)?:\/\/[^\s"'`;]+/i)?.[0] ?? null;

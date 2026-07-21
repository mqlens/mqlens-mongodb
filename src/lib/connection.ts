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

export const MONGO_URI_RE = /^mongodb(\+srv)?:\/\//i;
export const MONGO_URI_IN_TEXT_RE = /mongodb(\+srv)?:\/\/[^\s'"<>\r\n]+/i;

export type ImportUriResult =
  | { ok: true; uri: string }
  | { ok: false; error: string };

export type ImportedConnection = {
  name: string;
  uri: string;
  /** Folder name to place the connection in; omitted/null means root. */
  folder?: string | null;
};

export type ParseConnectionsResult =
  | { ok: true; connections: ImportedConnection[] }
  | { ok: false; error: string };

export type ExportFolderInfo = {
  folders: Array<{ id: string; name: string }>;
  profileFolderMap: Record<string, string>;
};

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

/** Validation message for import flows; `null` when the string is a MongoDB URI. */
export function validateMongoUri(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return 'Enter a mongodb:// or mongodb+srv:// URI';
  if (!MONGO_URI_RE.test(trimmed)) return 'Enter a mongodb:// or mongodb+srv:// URI';
  return null;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function deriveNameFromUri(uri: string): string {
  const match = uri.match(/mongodb(\+srv)?:\/\/(?:[^/@]+@)?([^/?,@]+)/i);
  const host = match?.[2]?.split(':')[0];
  return host || 'Imported Connection';
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeUriCandidate(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  return MONGO_URI_RE.test(trimmed) ? trimmed : null;
}

function extractUriFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const envMatch = trimmed.match(/^(?:export\s+)?[\w.-]+\s*=\s*(.+)$/i);
  const candidate = envMatch ? envMatch[1].trim() : trimmed;
  const unquoted = candidate.replace(/^["']|["']$/g, '');

  const direct = unquoted.match(MONGO_URI_IN_TEXT_RE);
  return direct ? normalizeUriCandidate(direct[0]) : null;
}

function parseLabelFromComment(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^(?:#|\/\/|;)\s*(.+)$/);
  if (!match) return null;
  const label = match[1].trim();
  if (MONGO_URI_RE.test(label)) return null;
  return label || null;
}

function parseTextConnections(text: string, out: ImportedConnection[]): void {
  let pendingName: string | null = null;
  let pendingFolder: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      if (/^#\s*(?:export\s+)?[\w.-]+\s*=\s*.+$/i.test(trimmed)) continue;

      const folderMatch = trimmed.match(/^#\s*(?:folder|group)\s*[:=]\s*(.+)$/i);
      if (folderMatch) {
        pendingFolder = folderMatch[1].trim() || null;
        pendingName = null;
        continue;
      }

      const label = parseLabelFromComment(trimmed);
      if (label) pendingName = label;
      continue;
    }

    const label = parseLabelFromComment(trimmed);
    if (label && !extractUriFromLine(trimmed)) {
      pendingName = label;
      continue;
    }

    const uri = extractUriFromLine(trimmed);
    if (!uri) continue;

    const name = pendingName || deriveNameFromUri(uri);
    pendingName = null;
    out.push({ name, uri, folder: pendingFolder });
  }
}

function collectConnectionsFromJson(value: unknown, out: ImportedConnection[], inheritedFolder?: string): void {
  if (typeof value === 'string') {
    const uri = normalizeUriCandidate(value);
    if (uri) {
      out.push({ name: deriveNameFromUri(uri), uri, folder: inheritedFolder ?? null });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectConnectionsFromJson(item, out, inheritedFolder));
    return;
  }

  if (!value || typeof value !== 'object') return;

  const obj = value as Record<string, unknown>;
  const name = pickString(obj, ['connectionName', 'name', 'title', 'label']);
  const folder =
    pickString(obj, ['folder', 'folderName', 'connectionFolder', 'group', 'groupName'])
    || inheritedFolder
    || null;
  const uri = pickString(obj, ['uri', 'connectionString', 'connectionUri', 'url', 'connection_url']);

  if (uri) {
    const normalized = normalizeUriCandidate(uri);
    if (normalized) {
      out.push({
        name: name || deriveNameFromUri(normalized),
        uri: normalized,
        folder,
      });
      return;
    }
  }

  // Nested folder node: { name, connections[], folders[] }
  const isFolderNode =
    Array.isArray(obj.connections) || Array.isArray(obj.folders) || Array.isArray(obj.items);
  const folderName = isFolderNode && name && !uri ? name : inheritedFolder;

  if (Array.isArray(obj.folders)) {
    obj.folders.forEach((nestedFolder) => {
      collectConnectionsFromJson(nestedFolder, out, folderName || undefined);
    });
  }

  for (const key of ['connections', 'items', 'profiles']) {
    const nested = obj[key];
    if (Array.isArray(nested)) {
      nested.forEach((item) => collectConnectionsFromJson(item, out, folderName || undefined));
    }
  }

  for (const nested of Object.values(obj)) {
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const record = nested as Record<string, unknown>;
      if ('connections' in record || 'folders' in record || 'uri' in record || 'connectionString' in record) {
        collectConnectionsFromJson(nested, out, folderName || undefined);
      }
    }
  }
}

/** Parse Studio 3T .uri files, multi-URI lists, .env files, and JSON connection exports. */
export function parseConnectionImportFile(text: string): ParseConnectionsResult {
  const normalized = stripBom(text).trim();
  if (!normalized) {
    return { ok: false, error: 'File is empty' };
  }

  const connections: ImportedConnection[] = [];

  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    try {
      collectConnectionsFromJson(JSON.parse(normalized), connections);
    } catch {
      // Fall back to plain-text parsing below.
    }
  }

  if (connections.length === 0) {
    parseTextConnections(normalized, connections);
  }

  if (connections.length === 0) {
    const globalMatches = normalized.matchAll(/mongodb(\+srv)?:\/\/[^\s'"<>\r\n]+/gi);
    for (const match of globalMatches) {
      const uri = normalizeUriCandidate(match[0]);
      if (uri) connections.push({ name: deriveNameFromUri(uri), uri });
    }
  }

  const seen = new Set<string>();
  const unique = connections.filter((connection) => {
    if (seen.has(connection.uri)) return false;
    seen.add(connection.uri);
    return true;
  });

  if (unique.length === 0) {
    return { ok: false, error: 'No mongodb:// or mongodb+srv:// URI found in file' };
  }

  return { ok: true, connections: unique };
}

/** Find the first mongodb URI in clipboard text or a file (.env, plain text, etc.). */
export function extractMongoUriFromText(text: string): string | null {
  const result = parseConnectionImportFile(text);
  return result.ok ? result.connections[0].uri : null;
}

/**
 * Find the first mongodb:// / mongodb+srv:// connection string in free-form
 * text (a .env file, a note, a pasted config). Quotes and whitespace end the
 * match so `MONGO_URL="mongodb://…"` yields just the URI.
 */
export const findMongoUriInText = (text: string): string | null => extractMongoUriFromText(text);

/** Validate and normalize raw clipboard/file/paste input into a MongoDB URI. */
export function resolveImportUri(raw: string): ImportUriResult {
  const result = parseConnectionImportFile(raw);
  if (!result.ok) return result;
  return { ok: true, uri: result.connections[0].uri };
}

/** Display mask: replace the auth password with bullets without changing the URI. */
export function maskUriPassword(uri: string): string {
  return uri.replace(/(\/\/[^/:@\s]+:)([^@/\s]+)(@)/, (_m, a, _p, c) => `${a}••••••${c}`);
}

/** Format every saved connection as JSON, preserving folder structure for MQLens / Studio 3T transfer. */
export function buildExportAllUris(
  profiles: Array<Pick<ConnectionProfile, 'id' | 'name' | 'uri'> | Pick<ConnectionProfile, 'name' | 'uri'>>,
  options: ExportUriOptions,
  folderInfo?: ExportFolderInfo,
): string {
  type ExportConnection = { name: string; uri: string };
  type ExportFolder = { name: string; connections: ExportConnection[] };

  const toExportConnection = (
    profile: Pick<ConnectionProfile, 'name' | 'uri'>,
  ): ExportConnection => ({
    name: profile.name,
    uri: buildExportUri(profile.uri, options),
  });

  if (!folderInfo || folderInfo.folders.length === 0) {
    return JSON.stringify(
      {
        connections: profiles.map(toExportConnection),
      },
      null,
      2,
    );
  }

  const folderById = new Map(folderInfo.folders.map((folder) => [folder.id, folder.name]));
  const foldersOut: ExportFolder[] = folderInfo.folders.map((folder) => ({
    name: folder.name,
    connections: [],
  }));
  const folderIndex = new Map(foldersOut.map((folder, index) => [folder.name, index]));
  const rootConnections: ExportConnection[] = [];

  for (const profile of profiles) {
    const exported = toExportConnection(profile);
    const profileId = 'id' in profile ? profile.id : undefined;
    const folderId = profileId ? folderInfo.profileFolderMap[profileId] : undefined;
    const folderName = folderId ? folderById.get(folderId) : undefined;
    if (folderName && folderIndex.has(folderName)) {
      foldersOut[folderIndex.get(folderName)!].connections.push(exported);
    } else {
      rootConnections.push(exported);
    }
  }

  return JSON.stringify(
    {
      folders: foldersOut,
      connections: rootConnections,
    },
    null,
    2,
  );
}

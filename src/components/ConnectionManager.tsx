import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { invoke, Channel } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  buildExportAllUris,
  buildExportUri,
  parseConnectionImportFile,
  resolveImportUri,
  type ImportedConnection,
  type ImportParseErrorCode,
} from '@/lib/connection';
import { useDialogs } from './dialogs/DialogProvider';
import { PasswordInput } from './PasswordInput';
import { useEscapeClose } from '../lib/useEscapeClose';
import { EPHEMERAL_PROFILE_PREFIX } from '../workspace/persistence';
import { formatShortcut, shortcutById } from '@/lib/shortcuts';
import {
  Plus, X, Server, Play, Edit3, Trash2, Check, AlertCircle, RefreshCw,
  Folder, FolderPlus, FolderOpen, Search, ChevronRight,
  Copy, ExternalLink, ShieldAlert, Eye, EyeOff, LayoutGrid, ClipboardPaste, Pipette
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogPortal,
  DialogOverlay,
} from '@/components/ui/dialog';
import { DraggableDialogContent } from '@/components/ui/draggable-dialog-content';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  type FolderNode,
  loadConnectionFolders,
  saveConnectionFolders,
} from '@/lib/connectionFolders';
import { CONNECTION_COLOR_PALETTE, colorInputValue, isPresetConnectionColor, normalizeHexColor } from '@/lib/connectionColors';

// Mirrors the backend ssh_tunnel::SshConfig (auth is internally tagged).
export type SshConfig = {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth:
    | { type: 'password'; password: string }
    | { type: 'key'; path: string; passphrase?: string }
    | { type: 'agent' };
};

/** Mirrors backend `connections::ConnectionMode` (#188). */
export type ConnectionMode = 'normal' | 'read_only' | 'confirm_destructive';

interface ConnectionProfile {
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

interface ConnectionManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (id: string, name: string, uri: string, profileId: string, colorTag?: string | null, connectionMode?: ConnectionMode) => void;
  activeConnections?: { id: string; profileId: string; name: string; uri: string }[];
}

interface TestStep {
  nameKey: string;
  status: 'pending' | 'running' | 'success' | 'failed';
}

/** Last resort only: enough to stay unique within a session, see below. */
let idSequence = 0;

/**
 * An id for a saved profile, and for the identity an unsaved connection
 * travels under.
 *
 * What these need is uniqueness, not unpredictability — nothing authorises on
 * them. But an ephemeral id is now also the namespace a trial session's saved
 * queries and history live under, and CodeQL objects to `Math.random()`
 * reaching a storage key (js/insecure-randomness). It is right to: weak
 * randomness given a new job is worth two lines to fix rather than to argue
 * about, so the randomness comes from `crypto` wherever there is any.
 *
 * The counter tail covers an environment with no `crypto` at all. It is still
 * unique within a session, and unlike the old fallback it does not pretend to
 * be random.
 */
const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  }
  idSequence += 1;
  return `${Date.now().toString(36)}-${idSequence.toString(36)}`;
};

const BLANK_CONN = {
  topology: 'standalone',
  protocol: 'mongodb',
  hosts: [{ host: 'localhost', port: '27017' }],
  replicaSetName: '',
  directConnection: true,
  uri: 'mongodb://localhost:27017',
  authMethod: 'none',
  authUser: '',
  authPass: '',
  authDb: 'admin',
  awsSessionToken: '',
  kerberosServiceName: '',
  tlsMode: 'off',
  tlsCa: '',
  tlsClientCert: '',
  tlsClientKey: '',
  tlsAllowInvalidHosts: false,
  tlsAllowInvalidCerts: false,
  sshEnabled: false,
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  sshAuth: 'key',
  sshKey: '',
  sshPass: '',
  proxyEnabled: false,
  proxyType: 'socks5',
  proxyHost: '',
  proxyPort: '1080',
  proxyUser: '',
  proxyPass: '',
  defaultDb: '',
  readPreference: 'primary',
  appName: 'MQLens',
  connectTimeout: 10000,
  serverSelectionTimeout: 30000,
  compression: 'none',
  // Stored profile data, not UI copy — intentionally English in every locale (i18n out of scope).
  name: 'New Connection',
  folder: '',
  colorTag: '',
  mcpEnabled: false,
  connectionMode: 'normal' as ConnectionMode,
};

/** Connection mode editor options (#188 Task 1) — segmented control in the server panel. */
const CONNECTION_MODE_OPTIONS: { value: ConnectionMode; labelKey: string; descriptionKey: string }[] = [
  { value: 'normal', labelKey: 'connectionMode.normal.label', descriptionKey: 'connectionMode.normal.description' },
  { value: 'read_only', labelKey: 'connectionMode.readOnly.label', descriptionKey: 'connectionMode.readOnly.description' },
  { value: 'confirm_destructive', labelKey: 'connectionMode.confirmDestructive.label', descriptionKey: 'connectionMode.confirmDestructive.description' },
];

const sidebarPanelClass =
  'flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar/40 text-sidebar-foreground';

/** Stacking above the connection-manager shell (z-50) and its nested editor (z-100). */
const NESTED_DIALOG_Z = 'z-[100]';
const NESTED_SELECT_Z = 'z-[110]';

const sidebarNavButtonClass = (active: boolean) =>
  cn(
    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ui-xs transition-colors cursor-pointer',
    active
      ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
  );

const treeRowClass = (active?: boolean) =>
  cn(
    'flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-xs transition-colors',
    active
      ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
      : 'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground',
  );

const ConnectionColorDot = ({ color, className }: { color?: string | null; className?: string }) => {
  const { t } = useTranslation('connections');
  return color ? (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
      title={t('list.colorDotTitle')}
      data-testid="connection-color-dot"
    />
  ) : null;
};

const TABS = [
  { id: 'server', labelKey: 'tabs.server', icon: Server },
  { id: 'auth', labelKey: 'tabs.auth', icon: ShieldAlert },
  { id: 'tls', labelKey: 'tabs.tls', icon: ShieldAlert },
  { id: 'ssh', labelKey: 'tabs.ssh', icon: ExternalLink },
  { id: 'proxy', labelKey: 'tabs.proxy', icon: RefreshCw },
  { id: 'adv', labelKey: 'tabs.advanced', icon: LayoutGrid },
];

// Replace the password in a mongodb URI (//user:PASSWORD@host) with dots, so the
// connection string can be shown without exposing the credential.
export const maskUriPassword = (uri: string): string =>
  uri.replace(/(\/\/[^/:@\s]+:)([^@/\s]+)(@)/, (_m, a, _p, c) => `${a}••••••${c}`);

// Turn a raw mongodb driver error (often a huge "server selection timeout" with
// the full topology dump) into a concise root-cause headline + actionable hint.
// TLS/auth/refused/DNS are checked first because those causes are usually buried
// inside the topology of a wrapping "server selection timeout".
export type ConnectionErrorSummary =
  | { summaryKey: string; hintKey?: string }
  | { summaryText: string };

export const summarizeConnectionError = (raw: string): ConnectionErrorSummary => {
  const e = (raw || '').toLowerCase();
  if (/invalid peer certificate|unknownissuer|certnotvalidfor|certificate verify failed|self.?signed/.test(e))
    return { summaryKey: 'errors:conn.tlsNotTrusted', hintKey: 'errors:conn.tlsNotTrustedHint' };
  if (/authentication failed|\(18\)|bad auth|authenticationfailed/.test(e))
    return { summaryKey: 'errors:conn.authFailed', hintKey: 'errors:conn.authFailedHint' };
  if (/connection refused|os error 61|os error 111|actively refused/.test(e))
    return { summaryKey: 'errors:conn.refused', hintKey: 'errors:conn.refusedHint' };
  if (/failed to lookup|name or service not known|no such host|nodename nor servname|dns error/.test(e))
    return { summaryKey: 'errors:conn.dnsFailed', hintKey: 'errors:conn.dnsFailedHint' };
  // The server accepted the socket then hung up mid-handshake. Two causes look
  // identical here, so name both rather than guess: a server older than the
  // driver supports (pre-3.6 servers don't speak OP_MSG, so they drop the
  // connection before reporting a version — see #230), or a server that requires
  // TLS while TLS is off. Must precede the generic server-selection check, since
  // the driver nests this I/O error inside that timeout.
  if (/unexpected end of file|end of stream/.test(e))
    return { summaryKey: 'errors:conn.handshakeClosed', hintKey: 'errors:conn.handshakeClosedHint' };
  if (/server selection timeout|no available servers|no suitable servers/.test(e))
    return { summaryKey: 'errors:conn.selectionTimeout', hintKey: 'errors:conn.selectionTimeoutHint' };
  if (/timed out|timeout/.test(e)) return { summaryKey: 'errors:conn.timedOut' };
  // Fallback for raw driver text, not UI copy — intentionally English in every locale (i18n out of scope).
  const firstLine = (raw || 'Connection failed').replace(/^kind:\s*/i, '').split(/\n|\. /)[0].trim();
  return { summaryText: firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine };
};

// Parse a mongodb URI into structured editor fields so the form (protocol / hosts
// / auth / TLS) can be edited interactively, auto-detecting the deployment type.
// Used both when editing a saved profile and when importing a pasted URI.
/**
 * The user-facing summary and hint for a raw driver error.
 *
 * Both the connection test and a failed Connect show the same diagnosis, so the
 * classification lives in one place; only the surrounding banner differs.
 */
export const describeConnectionError = (
  raw: string,
  t: (key: string) => string,
): { summary: string; hint?: string } => {
  const info = summarizeConnectionError(raw);
  // Pulled out rather than inlined below: the i18n coverage scanner reads a
  // string literal sitting directly after `hint:` as untranslated UI copy,
  // which the key name in the `in` check would otherwise look exactly like.
  const hintKey = 'hintKey' in info ? info.hintKey : undefined;
  return {
    summary: 'summaryKey' in info ? t(info.summaryKey) : info.summaryText,
    hint: hintKey ? t(hintKey) : undefined,
  };
};

export const parseUriIntoFields = (uri: string) => {
  const isSrv = /^mongodb\+srv:\/\//i.test(uri);
  // The password is optional: X.509 and Kerberos authenticate without one and
  // buildUri emits username-only userinfo for them, which a credentials group
  // requiring a colon read as part of the hostname. Excluding `/` and `?` from
  // the username keeps a query string containing `@` from being mistaken for
  // credentials now that the colon is no longer required (#349 review).
  const m = uri.match(/mongodb(?:\+srv)?:\/\/(?:([^:@/?]+)(?::([^@/?]*))?@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?/i);
  let authUser = '';
  let authPass = '';
  let hostStr = isSrv ? 'localhost' : 'localhost:27017';
  let defaultDb = '';
  let tlsMode = 'off';
  let tlsCa = '';
  let tlsClientCert = '';
  let tlsAllowInvalidCerts = false;
  let tlsAllowInvalidHosts = false;
  let authMethod = 'none';
  // Auth settings default to what a blank form would hold. Everything the
  // editor rebuilds from a saved URI has to be read back here: a field left
  // unparsed silently reverts to the blank default when a saved connection is
  // reopened, which is how a non-admin auth database came back as `admin` and
  // quietly changed the authSource the connection used (#349).
  let authDb = 'admin';
  let awsSessionToken = '';
  let kerberosServiceName = '';
  let query = '';
  if (m) {
    authUser = m[1] ? decodeURIComponent(m[1]) : '';
    authPass = m[2] ? decodeURIComponent(m[2]) : '';
    hostStr = m[3] || hostStr;
    defaultDb = m[4] || '';
    query = m[5] || '';
    const param = (name: string): string | null => {
      const mm = query.match(new RegExp(`(?:^|&)${name}=([^&]*)`, 'i'));
      return mm ? decodeURIComponent(mm[1]) : null;
    };
    const caFile = param('tlsCAFile') || param('sslCertificateAuthorityFile');
    if (caFile) {
      tlsMode = 'file';
      tlsCa = caFile;
    } else if (/(?:^|&)(?:tls|ssl)=true/i.test(query)) {
      tlsMode = 'system';
    }
    tlsClientCert = param('tlsCertificateKeyFile') || param('sslClientCertificateKeyFile') || '';
    // tlsInsecure implies both allow-invalid relaxations.
    const insecure = /(?:^|&)tlsInsecure=true/i.test(query);
    tlsAllowInvalidCerts = insecure || /(?:^|&)tlsAllowInvalidCertificates=true/i.test(query);
    tlsAllowInvalidHosts = insecure || /(?:^|&)tlsAllowInvalidHostnames=true/i.test(query);
    // The inverse of the mechanism buildUri writes. Without this a saved
    // SCRAM-SHA-1 or X.509 connection reopened as SCRAM-SHA-256.
    const mechanisms: Record<string, string> = {
      'SCRAM-SHA-1': 'scram-1',
      'SCRAM-SHA-256': 'scram-256',
      'MONGODB-X509': 'x509',
      'MONGODB-AWS': 'aws',
      GSSAPI: 'kerberos',
      PLAIN: 'ldap',
    };
    const mechanism = mechanisms[(param('authMechanism') || '').toUpperCase()];
    // A URI with credentials and no mechanism is SCRAM, the server default.
    // X.509 carries no username, so the mechanism alone decides there.
    if (mechanism) authMethod = mechanism;
    else if (authUser) authMethod = 'scram-256';
    // `$external` is not a database the user picks; it is what the external
    // mechanisms authenticate against, and buildUri writes it from the
    // mechanism rather than from this field.
    const authSource = param('authSource');
    if (authSource && authSource !== '$external') {
      authDb = authSource;
    } else if (!authSource && (authMethod === 'scram-1' || authMethod === 'scram-256')) {
      // With no authSource, MongoDB authenticates against the path database
      // and only falls back to admin when the path is empty — the same rule
      // the backend applies in `strip_path_database`. Reporting admin here
      // named a database the connection was not using, and left editing the
      // default database silently moving where authentication happens.
      let pathDb = defaultDb;
      try {
        pathDb = decodeURIComponent(defaultDb);
      } catch {
        // A malformed escape is left as written rather than failing the parse.
      }
      if (pathDb) authDb = pathDb;
    }
    // Split on the first colon only: the key never contains one, the value may.
    for (const entry of (param('authMechanismProperties') || '').split(',')) {
      const at = entry.indexOf(':');
      if (at < 0) continue;
      const key = entry.slice(0, at).trim().toUpperCase();
      const value = entry.slice(at + 1);
      if (key === 'AWS_SESSION_TOKEN') awsSessionToken = value;
      else if (key === 'SERVICE_NAME') kerberosServiceName = value;
    }
  }
  const hosts = hostStr.split(',').map((h) => {
    const [host, port] = h.split(':');
    return { host: host || 'localhost', port: port || (isSrv ? '' : '27017') };
  });
  const rsMatch = query.match(/(?:^|&)replicaSet=([^&]+)/i);
  const directConnection = /directConnection=true/i.test(query);
  // Auto-detect the deployment type from the URI shape:
  //  replicaSet= → replica set · directConnection=true → single direct node ·
  //  +srv or multiple hosts → cluster (sharded/mongos) · otherwise standalone.
  let topology: string;
  if (rsMatch) topology = 'replicaSet';
  else if (directConnection) topology = 'standalone';
  else if (isSrv || hosts.length > 1) topology = 'sharded';
  else topology = 'standalone';
  return {
    protocol: isSrv ? 'mongodb+srv' : 'mongodb',
    authUser,
    authPass,
    authMethod,
    authDb,
    awsSessionToken,
    kerberosServiceName,
    tlsMode,
    tlsCa,
    tlsClientCert,
    tlsAllowInvalidCerts,
    tlsAllowInvalidHosts,
    defaultDb,
    hosts: hosts.length > 0 ? hosts : [{ host: 'localhost', port: isSrv ? '' : '27017' }],
    topology,
    replicaSetName: rsMatch ? decodeURIComponent(rsMatch[1]) : '',
    directConnection,
  };
};

// Host list <-> "host:port, host:port" text for the editable Host List field.
export const hostsToText = (hosts: { host: string; port: string }[], isSrv: boolean): string =>
  hosts.filter((h) => h.host).map((h) => (isSrv || !h.port ? h.host : `${h.host}:${h.port}`)).join(', ');

export const textToHosts = (text: string): { host: string; port: string }[] => {
  const list = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((h) => {
      const [host, port] = h.split(':');
      return { host: host || '', port: port || '' };
    });
  return list.length ? list : [{ host: '', port: '' }];
};

export const buildUri = (s: typeof BLANK_CONN) => {
  if (s.topology === 'uri') return s.uri;
  const isSrv = s.protocol === 'mongodb+srv';
  // SRV records resolve the port set, so a +srv URI carries hostnames only.
  const hosts = isSrv
    ? s.hosts.filter(h => h.host).map(h => h.host).join(',')
    : s.hosts.filter(h => h.host).map(h => `${h.host}:${h.port || 27017}`).join(',');
  let creds = '';
  if (s.authMethod !== 'none' && s.authUser) {
    const u = encodeURIComponent(s.authUser);
    // X509 derives the user from the cert; GSSAPI uses a Kerberos ticket — neither sends a password.
    const usesPassword = s.authPass && s.authMethod !== 'x509' && s.authMethod !== 'kerberos';
    const p = usesPassword ? `:${encodeURIComponent(s.authPass)}` : '';
    creds = `${u}${p}@`;
  }
  const params = [];
  if (s.topology === 'replicaSet' && s.replicaSetName) params.push(`replicaSet=${s.replicaSetName}`);
  // directConnection only makes sense for a single-host, non-SRV standalone.
  if (s.topology === 'standalone' && s.directConnection && !isSrv && s.hosts.filter(h => h.host).length <= 1)
    params.push('directConnection=true');
  if (s.tlsMode !== 'off') params.push('tls=true');
  // Custom CA file (and optional client cert/key file) must be passed to the driver.
  if (s.tlsMode === 'file' && s.tlsCa) params.push(`tlsCAFile=${encodeURIComponent(s.tlsCa)}`);
  if (s.tlsMode !== 'off' && s.tlsClientCert) params.push(`tlsCertificateKeyFile=${encodeURIComponent(s.tlsClientCert)}`);
  if (s.tlsAllowInvalidHosts) params.push('tlsAllowInvalidHostnames=true');
  if (s.tlsAllowInvalidCerts) params.push('tlsAllowInvalidCertificates=true');
  if (s.authMethod === 'scram-1') params.push('authMechanism=SCRAM-SHA-1');
  if (s.authMethod === 'scram-256') params.push('authMechanism=SCRAM-SHA-256');
  if (s.authMethod === 'x509') params.push('authMechanism=MONGODB-X509');
  if (s.authMethod === 'aws') params.push('authMechanism=MONGODB-AWS');
  if (s.authMethod === 'kerberos') params.push('authMechanism=GSSAPI');
  if (s.authMethod === 'ldap') params.push('authMechanism=PLAIN');
  // External mechanisms (M5) authenticate against $external; SCRAM uses the chosen auth DB.
  const isExternalAuth = ['x509', 'aws', 'kerberos', 'ldap'].includes(s.authMethod);
  if (isExternalAuth) {
    params.push('authSource=$external');
  } else if (s.authMethod !== 'none' && s.authDb) {
    // With authSource omitted MongoDB authenticates against the path database,
    // or admin when there is no path. So the parameter is redundant only when
    // it already matches that: dropping an explicit `admin` beside a path
    // database moved authentication onto that database on the next save
    // (#349 review).
    // The path is compared decoded, because that is the form the auth database
    // is held in, and the value is written back encoded: an unescaped `&` in a
    // database name would start another query option and change what the URI
    // means (#349 review).
    let pathDb = s.defaultDb;
    try {
      pathDb = decodeURIComponent(s.defaultDb);
    } catch {
      // A malformed escape compares as written.
    }
    const implied = pathDb || 'admin';
    if (s.authDb !== implied) params.push(`authSource=${encodeURIComponent(s.authDb)}`);
  }
  // Mechanism-specific properties (M5).
  if (s.authMethod === 'aws' && s.awsSessionToken) {
    params.push(`authMechanismProperties=AWS_SESSION_TOKEN:${encodeURIComponent(s.awsSessionToken)}`);
  }
  if (s.authMethod === 'kerberos' && s.kerberosServiceName) {
    params.push(`authMechanismProperties=SERVICE_NAME:${encodeURIComponent(s.kerberosServiceName)}`);
  }
  if (s.readPreference !== 'primary') params.push(`readPreference=${s.readPreference}`);
  if (s.compression !== 'none') params.push(`compressors=${s.compression}`);
  if (s.appName) params.push(`appName=${encodeURIComponent(s.appName)}`);
  // Timeouts (M2): honor the user's configured connect/server-selection windows.
  if (s.connectTimeout) params.push(`connectTimeoutMS=${s.connectTimeout}`);
  if (s.serverSelectionTimeout) params.push(`serverSelectionTimeoutMS=${s.serverSelectionTimeout}`);
  // SOCKS5 proxy (M2): the MongoDB driver only supports SOCKS5 proxy URI options.
  if (s.proxyEnabled && s.proxyHost) {
    params.push(`proxyHost=${encodeURIComponent(s.proxyHost)}`);
    params.push(`proxyPort=${s.proxyPort || 1080}`);
    if (s.proxyUser) params.push(`proxyUsername=${encodeURIComponent(s.proxyUser)}`);
    if (s.proxyPass) params.push(`proxyPassword=${encodeURIComponent(s.proxyPass)}`);
  }
  const dbPath = s.defaultDb ? `/${s.defaultDb}` : '';
  const scheme = isSrv ? 'mongodb+srv' : 'mongodb';
  return `${scheme}://${creds}${hosts}${dbPath}${params.length ? '?' + params.join('&') : ''}`;
};

// Build the structured SSH tunnel config the backend expects, or null when disabled.
/**
 * A name worth offering for a connection the user has just proved works (#364).
 *
 * The host carries the identity people recognise: an Atlas cluster reached at
 * `cluster0.ab12c.mongodb.net` is "cluster0" to whoever provisioned it, and a
 * local server is just "localhost". Anything else keeps its full hostname,
 * which still beats offering to save something called "New Connection".
 */
export const suggestConnectionName = (s: typeof BLANK_CONN): string => {
  const host =
    s.topology === 'uri'
      ? (parseUriIntoFields(s.uri).hosts ?? [])[0]?.host
      : s.hosts.find((h: { host: string }) => h.host)?.host;
  if (!host) return s.name;
  return (host.endsWith('.mongodb.net') ? host.split('.')[0] : host) || host;
};

export const buildSshConfig = (s: typeof BLANK_CONN): SshConfig | null => {
  if (!s.sshEnabled || !s.sshHost) return null;
  const auth =
    s.sshAuth === 'password'
      ? { type: 'password' as const, password: s.sshPass }
      : s.sshAuth === 'agent'
        ? { type: 'agent' as const }
        : { type: 'key' as const, path: s.sshKey, passphrase: s.sshPass || undefined };
  return {
    enabled: true,
    host: s.sshHost,
    port: parseInt(s.sshPort, 10) || 22,
    user: s.sshUser,
    auth,
  };
};

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({
  isOpen,
  onClose,
  onConnect,
  activeConnections = [],
}) => {
  const { confirm, prompt } = useDialogs();
  const { t } = useTranslation('connections');
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [folderFilter, setFolderFilter] = useState<string>('all');
  
  // Folder tree management states
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [profileFolderMap, setProfileFolderMap] = useState<Record<string, string>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [showFolderDialog, setShowFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);

  // Editor Dialog nested modal states
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editMode, setEditMode] = useState<'new' | 'edit' | 'duplicate'>('new');

  // URI import (clipboard/file) error — shown inline next to the Import menu,
  // since those sources fail without a dialog of their own to host a message.
  const [importError, setImportError] = useState<string | null>(null);
  // Export dialog: a single profile URI, or all profiles as JSON with folders.
  const [exportDialog, setExportDialog] = useState<
    | { mode: 'single'; uri: string; hasSsh: boolean }
    | { mode: 'all' }
    | null
  >(null);
  const [exportIncludePassword, setExportIncludePassword] = useState(false);
  const [exportIncludeSettings, setExportIncludeSettings] = useState(true);
  const [editorState, setEditorState] = useState<typeof BLANK_CONN>(BLANK_CONN);
  const [activeEditorTab, setActiveEditorTab] = useState('server');
  const [showPassword, setShowPassword] = useState(false);
  const [revealUri, setRevealUri] = useState(false);
  const [revealDetailUri, setRevealDetailUri] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test Connection States
  const [testing, setTesting] = useState(false);
  const [testProgress, setTestProgress] = useState(0);
  const [testSteps, setTestSteps] = useState<TestStep[]>([
    { nameKey: 'test.stageParse', status: 'running' },
    { nameKey: 'test.stageResolve', status: 'pending' },
    { nameKey: 'test.stageConnect', status: 'pending' },
    { nameKey: 'test.stagePing', status: 'pending' },
  ]);
  // `message` carries raw (English) driver text for the failure path only; the
  // success path has no driver text to preserve, so its label is rendered from
  // `success` at display time (see t('test.successMessage') below) rather than
  // being frozen into state, so it doesn't go stale on a mid-session language switch.
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [showErrDetail, setShowErrDetail] = useState(false);

  // A connection opened straight from the editor, before it has been saved
  // (#364). Held here rather than handed straight to the app, because the app
  // closes this manager the moment it accepts one — and the offer to save has
  // to outlive that. Every path out of the editor adopts it (see
  // `closeEditor`), so a trial connection can never be orphaned in the backend.
  const [pendingSave, setPendingSave] = useState<
    {
      connId: string;
      uri: string;
      ssh: SshConfig | null;
      profileId: string;
      // The editor exactly as it stood when Connect was pressed. The fields go
      // off screen once the offer is up, but they are live for as long as
      // `connect_db` takes — which can be a server-selection timeout's worth of
      // seconds — so anything the offer says about the connection has to come
      // from here rather than from the form (#369 review). Only the name,
      // folder and colour still on screen are read live.
      state: typeof BLANK_CONN;
    } | null
  >(null);
  const [connecting, setConnecting] = useState(false);
  // Raw driver text from a failed editor Connect, kept apart from `testResult`
  // so the failure reads as what it was — the connection itself refusing —
  // rather than borrowing the four-stage checklist of a test that never ran.
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showConnectErrDetail, setShowConnectErrDetail] = useState(false);
  // The editor's own rendering of the profile it opened, serialized, or null
  // when the editor is not sitting on a saved profile. Connect compares against
  // this to tell a saved connection from a new one.
  //
  // It cannot compare rebuilt URIs instead: the structured form does not
  // round-trip one byte for byte — a profile stored as `mongodb://mock` comes
  // back as `mongodb://mock:27017/?directConnection=true` — so every profile
  // would look modified the instant it was opened.
  const pristineEditorRef = useRef<string | null>(null);
  // Bumped every time the editor closes. A `connect_db` still in flight
  // compares against it to find out whether anyone is still waiting for the
  // answer, since a server-selection timeout can leave the user looking at a
  // dialog for half a minute and they are entitled to walk away from it.
  const connectAttemptRef = useRef(0);
  // Every check that runs AFTER an await must read this, not the prop.
  //
  // A handler suspended on `connect_db` or `save_connection_profile` resumes
  // inside the render that started it, so `activeConnections` there is the array
  // as it was when the click happened — even though React has since re-rendered
  // this component with another window's connection in it. A post-await check
  // against the prop therefore cannot see the very thing it exists to catch
  // (#369 review).
  const activeConnectionsRef = useRef(activeConnections);
  activeConnectionsRef.current = activeConnections;
  // A single Escape reaches us twice: Radix dismisses the dialog through
  // `onOpenChange` and the window-level listener fires for the same event, and
  // both read the same `pendingSave` from this render. Handing a connection to
  // the app is not idempotent over there — it broadcasts metadata, rebinds
  // tabs and refreshes the profile list — so the guard has to be a ref, which
  // settles synchronously, rather than state, which would not (#369 review).
  const handedOverRef = useRef<string | null>(null);

  // Initialize folders and load connection profiles
  useEffect(() => {
    if (isOpen) {
      loadProfiles();
      loadFoldersFromStorage();
    }
  }, [isOpen]);

  // Escape closes the topmost layer: the nested editor dialog when it is
  // open, otherwise the manager itself.
  //
  // Both stand down while the export or new-folder dialog is up. Those are
  // Radix layers of their own and dismiss themselves on Escape; this listener
  // sits on window, so the same keypress reached it too and closed what was
  // underneath. Harmless when that only dropped a dialog — but the editor's
  // Escape now answers the save offer, so dismissing an export preview would
  // have silently chosen 'Don't save' and taken the manager with it
  // (#369 review).
  const nestedLayerOpen = !!exportDialog || showFolderDialog;
  useEscapeClose(isOpen && showEditDialog && !nestedLayerOpen, () => closeEditor());

  useEffect(() => {
    if (!showEditDialog) connectAttemptRef.current += 1;
  }, [showEditDialog]);
  useEscapeClose(isOpen && !showEditDialog && !nestedLayerOpen, onClose);

  const loadFoldersFromStorage = () => {
    const { folders: currentFolders, profileFolderMap: map } = loadConnectionFolders();
    setFolders(currentFolders);
    setExpandedFolders((prev) => ({ 'local-resources': true, ...prev }));
    setProfileFolderMap(map);
  };

  const saveFoldersToStorage = (updatedFolders: FolderNode[], updatedMap: Record<string, string>) => {
    saveConnectionFolders(updatedFolders, updatedMap);
    setFolders(updatedFolders);
    setProfileFolderMap(updatedMap);
  };

  const loadProfiles = async () => {
    try {
      const list = await invoke<ConnectionProfile[]>('load_connection_profiles');
      setProfiles(list || []);
      if (list && list.length > 0 && !selectedId) {
        setSelectedId(list[0].id);
      }
    } catch (err) {
      console.error('Failed to load profiles', err);
    }
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setRevealDetailUri(false);
    setError(null);
    setTestResult(null);
  };

  const handleNewClick = () => {
    setEditMode('new');
    const defaultFolder = folders.length > 0 ? folders[0].id : '';
    setEditorState({
      ...BLANK_CONN,
      name: 'New Connection',
      hosts: [{ host: 'localhost', port: '27017' }],
      folder: defaultFolder,
    });
    setError(null);
    setTestResult(null);
    setPendingSave(null);
    setConnectError(null);
    // A previous attempt may still be in flight and will no longer clear this,
    // by design — so the fresh editor starts its own.
    setConnecting(false);
    pristineEditorRef.current = null;
    setTesting(false);
    setActiveEditorTab('server');
    setShowEditDialog(true);
  };

  const handleEditClick = (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    
    setEditMode('edit');

    // Extract structured fields so the form is editable for standalone/replicaSet.
    const parsed = parseUriIntoFields(profile.uri);

    // Restore structured SSH config persisted with the profile.
    const ssh = profile.ssh || null;
    const sshFields = ssh
      ? {
          sshEnabled: ssh.enabled,
          sshHost: ssh.host,
          sshPort: String(ssh.port),
          sshUser: ssh.user,
          sshAuth: ssh.auth.type,
          sshKey: ssh.auth.type === 'key' ? ssh.auth.path : '',
          sshPass:
            ssh.auth.type === 'password'
              ? ssh.auth.password
              : ssh.auth.type === 'key'
                ? ssh.auth.passphrase || ''
                : '',
        }
      : {};

    const opened = {
      ...BLANK_CONN,
      name: profile.name,
      uri: profile.uri,
      ...parsed,
      folder: profileFolderMap[profile.id] || '',
      colorTag: profile.color_tag || '',
      mcpEnabled: profile.mcp_enabled ?? false,
      connectionMode: profile.connection_mode ?? 'normal',
      ...sshFields,
    };
    setEditorState(opened);

    setError(null);
    setTestResult(null);
    setPendingSave(null);
    setConnectError(null);
    // A previous attempt may still be in flight and will no longer clear this,
    // by design — so the fresh editor starts its own.
    setConnecting(false);
    pristineEditorRef.current = null;
    setTesting(false);
    setActiveEditorTab('server');
    pristineEditorRef.current = JSON.stringify(opened);
    setShowEditDialog(true);
  };

  const handleDuplicateClick = (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    
    setEditMode('duplicate');
    setEditorState({
      ...BLANK_CONN,
      name: `${profile.name} (Copy)`,
      uri: profile.uri,
      topology: profile.uri.includes('replicaSet=') ? 'replicaSet' : 'standalone',
      hosts: [{ host: 'localhost', port: '27017' }],
      folder: profileFolderMap[profile.id] || '',
      colorTag: profile.color_tag || '',
      // Adjudicated product call (final fix wave): a duplicated profile
      // never inherits "Expose to MCP agents" from the profile it was
      // copied from, even when the original has it on — the new profile is
      // a distinct connection an agent hasn't been vetted for yet, and
      // silently exposing it would be surprising. `handleEditClick` above
      // is unaffected and keeps mapping `profile.mcp_enabled` as-is; this
      // reset is specific to the duplicate-populate path.
      mcpEnabled: false,
      // Opposite call from `mcpEnabled` above (#188 Task 1, adjudicated):
      // a read-only/confirm-destructive safeguard is exactly the kind of
      // thing that should survive duplication rather than reset — the new
      // profile is presumably still pointed at the same sensitive
      // environment (e.g. "prod (copy for testing a filter)"), and
      // silently dropping the safeguard back to unguarded `normal` would
      // be the surprising outcome here, not the safe one.
      connectionMode: profile.connection_mode ?? 'normal',
    });
    setError(null);
    setTestResult(null);
    setPendingSave(null);
    setConnectError(null);
    // A previous attempt may still be in flight and will no longer clear this,
    // by design — so the fresh editor starts its own.
    setConnecting(false);
    pristineEditorRef.current = null;
    setTesting(false);
    setActiveEditorTab('server');
    setShowEditDialog(true);
  };

  const handleNewFolderClick = () => {
    setNewFolderName('');
    setFolderError(null);
    setShowFolderDialog(true);
  };

  const handleCreateFolder = () => {
    const folderName = newFolderName.trim();
    if (!folderName) {
      setFolderError(t('errors.folderNameRequired'));
      return;
    }
    const folderExists = folders.some((folder) => folder.name.toLowerCase() === folderName.toLowerCase());
    if (folderExists) {
      setFolderError(t('errors.folderNameExists'));
      return;
    }

    const newFolder: FolderNode = {
      id: `folder-${generateUUID()}`,
      name: folderName,
      parentId: null,
      shared: false
    };

    const updatedFolders = [...folders, newFolder];
    saveFoldersToStorage(updatedFolders, profileFolderMap);
    setExpandedFolders(prev => ({ ...prev, [newFolder.id]: true }));
    setFolderFilter('all');
    setShowFolderDialog(false);
    setNewFolderName('');
    setFolderError(null);
  };

  /**
   * Write the editor's current fields out as a profile.
   *
   * Returns the saved profile so a caller can go on to use it — the
   * connect-then-save path needs its id to hand the live connection over under
   * the identity it has just acquired. Returns null when validation or the
   * write failed, with the reason already on screen, so the caller knows to
   * leave the editor open.
   */
  const persistEditorProfile = async (
    tested?: { uri: string; ssh: SshConfig | null; state: typeof BLANK_CONN },
  ): Promise<ConnectionProfile | null> => {
    if (!editorState.name.trim()) {
      setError(t('errors.displayNameRequired'));
      return null;
    }

    // `tested` is the configuration a connection was actually opened on. Saving
    // a rebuilt one instead would let the profile and the live connection it is
    // about to be handed describe different servers, so every later reconnect
    // and every restored tab would target the wrong one.
    const uriToSave = tested ? tested.uri : buildUri(editorState);
    const id = editMode === 'edit' && selectedId ? selectedId : generateUUID();
    const profile: ConnectionProfile = {
      id,
      name: editorState.name,
      uri: uriToSave,
      ssh: tested ? tested.ssh : buildSshConfig(editorState),
      color_tag: editorState.colorTag
        ? normalizeHexColor(editorState.colorTag) ?? editorState.colorTag
        : null,
      mcp_enabled: tested ? tested.state.mcpEnabled : editorState.mcpEnabled,
      connection_mode: tested ? tested.state.connectionMode : editorState.connectionMode,
    };

    setLoading(true);
    try {
      await invoke('save_connection_profile', { profile });

      // Update profile folder mapping
      const updatedMap = { ...profileFolderMap, [id]: editorState.folder };
      saveFoldersToStorage(folders, updatedMap);

      await loadProfiles();
      setSelectedId(id);
      return profile;
    } catch (err: any) {
      setError(String(err));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (await persistEditorProfile()) setShowEditDialog(false);
  };

  /**
   * Connect with the fields as they stand, saving nothing (#364).
   *
   * Saving is what engages the vault, so requiring it first meant the very
   * first thing a trial user did was write an encrypted credential to disk for
   * a connection nobody had shown to work yet. This asks the server instead,
   * and only then asks the user whether it is worth keeping.
   */
  const handleEditorConnect = async () => {
    // An untouched existing profile is not an anonymous connection: connect it
    // as itself so the duplicate guard and tab rebinding still recognise it,
    // and so nobody is offered a chance to save what is already saved. Edited
    // fields do get the offer, since Save in edit mode updates that same
    // profile rather than filing a second copy of it.
    const saved =
      editMode === 'edit' && selectedId ? profiles.find((p) => p.id === selectedId) : undefined;
    const existing =
      saved && pristineEditorRef.current === JSON.stringify(editorState) ? saved : undefined;

    // Untouched means untouched: connect on the exact string that was saved,
    // the way the profile list's own Connect does. Rebuilding it from the form
    // would quietly normalise it — `mongodb://mock` becomes
    // `mongodb://mock:27017` — and connect to something the user never wrote.
    const uri = existing ? existing.uri : buildUri(editorState);
    const ssh = existing ? existing.ssh ?? null : buildSshConfig(editorState);
    // Keyed on the saved profile, not on `existing`: an edited profile still
    // saves back onto its own id, and `addActiveConnection` dedupes by
    // profileId — so connecting a second time would leave the user on the old
    // session while the new one leaked, with the profile overwritten under it.
    if (saved && activeConnections.some((c) => c.profileId === saved.id)) {
      setError(t('errors.alreadyActive'));
      return;
    }

    // Held by reference, which is a true snapshot: editorState is only ever
    // replaced with a fresh object, never mutated in place.
    const tested = editorState;
    const attempt = connectAttemptRef.current;
    setConnecting(true);
    setConnectError(null);
    setShowConnectErrDetail(false);
    setTestResult(null);
    setError(null);
    try {
      const connId = await invoke<string>('connect_db', { uri, ssh });
      handedOverRef.current = null;
      // The editor was dismissed while this was in flight. There is no longer a
      // surface to offer the connection on, and `pendingSave` set now would be
      // an invisible handle that the next editor silently discards — so release
      // it instead. Walking away from an attempt is a way of cancelling it.
      if (attempt !== connectAttemptRef.current) {
        try {
          await invoke('disconnect_db', { id: connId });
        } catch {
          /* best effort: the session is already unreachable either way */
        }
        return;
      }
      if (existing) {
        // Rechecked, because `connect_db` is an await and another window can
        // claim this profile during it. Handing the id over anyway would give
        // App a row it drops as a duplicate while `set_connection_meta` still
        // publishes it — a live backend session with nothing local pointing at
        // it (#369 review).
        if (activeConnectionsRef.current.some((c) => c.profileId === existing.id)) {
          try {
            await invoke('disconnect_db', { id: connId });
          } catch {
            /* best effort: the session is unreachable either way */
          }
          setError(t('errors.alreadyActive'));
          return;
        }
        setShowEditDialog(false);
        handOverConnection(
          connId,
          existing.name,
          uri,
          existing.id,
          existing.color_tag ?? undefined,
          existing.connection_mode ?? 'normal',
        );
        return;
      }
      // The identity an unsaved connection travels under. `addActiveConnection`
      // dedupes on it, so it has to be unique per connection rather than one
      // shared sentinel — otherwise a second trial connection would be dropped
      // on the floor as a duplicate of the first.
      setPendingSave({
        connId,
        uri,
        ssh,
        profileId: `${EPHEMERAL_PROFILE_PREFIX}${generateUUID()}`,
        state: tested,
      });
      // The editor goes back to describing what was actually connected to. Its
      // connection fields are off screen from here on, but the URI preview and
      // the Export URI button beside the name are NOT — left on the live form
      // they would show, and export, a URI nobody connected to, directly under a
      // banner saying "Connected" (#369 review).
      //
      // Name, folder and colour are kept from the live form instead: those are
      // the three things still on screen, and the only ones the offer is asking
      // about. A name typed while the connection was opening is still a name the
      // user chose for it, so it stands.
      setEditorState((prev) => {
        // "New Connection" is only a placeholder where WE put it — opening a
        // blank editor. On a saved profile it is a name somebody chose, and
        // matching it by string alone silently renamed their profile on save
        // (#369 review). An empty name still takes the suggestion whatever the
        // mode, since the alternative is handing the app a nameless connection.
        const ourPlaceholder = editMode === 'new' && prev.name === BLANK_CONN.name;
        return {
          ...tested,
          name: !prev.name.trim() || ourPlaceholder ? suggestConnectionName(tested) : prev.name,
          folder: prev.folder,
          colorTag: prev.colorTag,
        };
      });
    } catch (err: any) {
      if (attempt === connectAttemptRef.current) setConnectError(String(err));
    } finally {
      // Only the attempt that is still current may release the button. An
      // abandoned one clearing it would re-enable Connect while the NEW attempt
      // is still in flight, and a further click would then run two requests
      // under one generation — both would pass the guard above, and the second
      // to land would overwrite the first pendingSave and strand its connection
      // (#369 review).
      if (attempt === connectAttemptRef.current) setConnecting(false);
    }
  };

  /** Give the app a connection, once, however many callers ask. */
  const handOverConnection = (
    connId: string,
    name: string,
    uri: string,
    profileId: string,
    colorTag: string | undefined,
    mode: ConnectionMode,
  ) => {
    if (handedOverRef.current === connId) return;
    handedOverRef.current = connId;
    onConnect(connId, name, uri, profileId, colorTag, mode);
  };

  /** Hand a connection the user chose not to save to the app as it stands. */
  const adoptPendingConnection = (pending: NonNullable<typeof pendingSave>) => {
    setPendingSave(null);
    setShowEditDialog(false);
    handOverConnection(
      pending.connId,
      // Never nameless: the display name is still editable while the offer is
      // up, and an empty one reaches the sidebar as a blank row that pinned and
      // favourite lookups cannot resolve by name (#369 review).
      //
      // The last resort is a literal, deliberately. Falling back to the URI —
      // even with the password masked — puts `user@host` into a name that
      // pinned and favourite state writes to localStorage in clear text, which
      // is what CodeQL flagged js/clear-text-storage-of-sensitive-data on. It
      // would also be a poor label: this branch is only reached when the URI
      // has no host to take a name from, so there is nothing recognisable in
      // it to show anyway.
      // Stored profile data, not UI copy — intentionally English in every locale (i18n out of scope).
      editorState.name.trim() || suggestConnectionName(pending.state).trim() || 'Untitled Connection',
      pending.uri,
      pending.profileId,
      editorState.colorTag
        ? normalizeHexColor(editorState.colorTag) ?? editorState.colorTag
        : undefined,
      pending.state.connectionMode,
    );
  };

  /**
   * Leave the editor. A connection opened but not yet saved goes to the app
   * rather than being abandoned: it is already live in the backend, and
   * declining the save offer is a decision about the profile, not the session.
   */
  const closeEditor = () => {
    // A save is a local encrypted write and takes milliseconds, but leaving
    // during one would adopt the connection under its throwaway id while the
    // write finishes and hands the same connection over under the saved
    // profile's id — two identities for one session, with the backend's
    // metadata left describing whichever landed last (#369 review).
    if (loading) return;

    // Advanced here, synchronously, and not left to the effect that watches
    // `showEditDialog`. That effect is passive: it runs after the commit, while
    // a `connect_db` promise resolves on a microtask — so a connection landing
    // in between would still read the old generation, pass the abandonment
    // check, and be stored in `pendingSave` on an editor that no longer exists.
    // The next editor would then clear that handle without disconnecting it
    // (#369 review). The effect stays for the close paths that do not come
    // through here; advancing twice is harmless, since only equality matters.
    connectAttemptRef.current += 1;

    if (pendingSave) {
      adoptPendingConnection(pendingSave);
      return;
    }
    setShowEditDialog(false);
  };

  /** Keep the connection that just worked, then open it under its new profile. */
  const handleSaveAndOpen = async () => {
    if (!pendingSave) return;
    // Checked again here, not only before connecting. The offer can sit on
    // screen for as long as the user likes, and another window can connect this
    // same profile in the meantime — this connection has not been announced
    // yet, so nothing stops it. Saving then would overwrite the profile and
    // hand over a second live id, which App drops as a duplicate by profileId
    // while still publishing its metadata: the visible session would point at
    // the old server under a profile now describing the new one, and this
    // connection would be unreachable (#369 review).
    const target = editMode === 'edit' && selectedId ? selectedId : null;
    if (target && activeConnections.some((c) => c.profileId === target)) {
      setError(t('errors.alreadyActive'));
      return;
    }
    const profile = await persistEditorProfile({
      uri: pendingSave.uri,
      ssh: pendingSave.ssh,
      state: pendingSave.state,
    });
    if (!profile) return;

    // Checked once more, because the write above is asynchronous and another
    // window can take the profile during it. This does NOT close the race — the
    // profile has already been overwritten by the time we get here, and only
    // the backend could hold it for the whole operation. What it prevents is
    // the worse half: handing over a connection that `addActiveConnection`
    // drops as a duplicate, which would leave this session live, unreachable
    // and invisible. Releasing it instead keeps the backend honest (#369
    // review; the reservation itself is filed separately).
    if (activeConnectionsRef.current.some((c) => c.profileId === profile.id)) {
      void invoke('disconnect_db', { id: pendingSave.connId }).catch(() => {});
      setPendingSave(null);
      setShowEditDialog(false);
      setError(t('errors.alreadyActive'));
      return;
    }

    const pending = pendingSave;
    setPendingSave(null);
    setShowEditDialog(false);
    handOverConnection(
      pending.connId,
      profile.name,
      pending.uri,
      profile.id,
      profile.color_tag ?? undefined,
      profile.connection_mode ?? 'normal',
    );
  };

  const handleDelete = async (profileId: string) => {
    if (
      !(await confirm({
        title: t('dialogs.deleteProfile.title'),
        message: t('dialogs.deleteProfile.message'),
        confirmLabel: t('actions.delete'),
        destructive: true,
      }))
    )
      return;
    try {
      await invoke('delete_connection_profile', { id: profileId });
      setProfiles((prev) => prev.filter((p) => p.id !== profileId));
      
      const updatedMap = { ...profileFolderMap };
      delete updatedMap[profileId];
      saveFoldersToStorage(folders, updatedMap);

      if (selectedId === profileId) {
        setSelectedId(null);
      }
      await loadProfiles();
    } catch (err) {
      console.error(err);
    }
  };

  const handleConnectClick = async () => {
    if (!selectedId) return;
    const profile = profiles.find((p) => p.id === selectedId);
    if (!profile) return;

    const isAlreadyConnected = activeConnections.some((c) => c.profileId === profile.id);
    if (isAlreadyConnected) {
      setError(t('errors.alreadyActive'));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const connId = await invoke<string>('connect_db', { uri: profile.uri, ssh: profile.ssh ?? null });
      onConnect(connId, profile.name, profile.uri, profile.id, profile.color_tag ?? undefined, profile.connection_mode ?? 'normal');
    } catch (err: any) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  // Native file picker for TLS certificate paths.
  const pickTlsFile = async (field: 'tlsCa' | 'tlsClientCert') => {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title: t('filePicker.selectCertificateTitle'),
        filters: [
          { name: t('filePicker.certificatesFilter'), extensions: ['pem', 'crt', 'cer', 'key', 'p12', 'pfx'] },
          { name: t('filePicker.allFilesFilter'), extensions: ['*'] },
        ],
      });
      if (typeof path === 'string') setEditorState(prev => ({ ...prev, [field]: path }));
    } catch {
      /* user cancelled */
    }
  };

  const openEditorForImport = () => {
    if (showEditDialog) return;
    setEditMode('new');
    const defaultFolder = folders.length > 0 ? folders[0].id : '';
    setEditorState({
      ...BLANK_CONN,
      name: 'New Connection',
      hosts: [{ host: 'localhost', port: '27017' }],
      folder: defaultFolder,
    });
    setError(null);
    setTestResult(null);
    setPendingSave(null);
    setConnectError(null);
    // A previous attempt may still be in flight and will no longer clear this,
    // by design — so the fresh editor starts its own.
    setConnecting(false);
    pristineEditorRef.current = null;
    setImportError(null);
    setTesting(false);
    setActiveEditorTab('server');
    setShowEditDialog(true);
  };

  // `parseConnectionImportFile`/`resolveImportUri` return an error CODE, not
  // display text (see `ImportParseErrorCode`'s doc comment) — translate it
  // here, at the render/state boundary.
  const importErrorMessage = (code: ImportParseErrorCode): string =>
    code === 'empty' ? t('errors.importFileEmpty') : t('errors.importNoUriFound');

  const applyImportedUri = (raw: string, name?: string) => {
    const result = resolveImportUri(raw);
    if (!result.ok) {
      setImportError(importErrorMessage(result.error));
      return;
    }
    setImportError(null);
    setEditorState((prev) => ({
      ...prev,
      name: name || prev.name,
      uri: result.uri,
      ...parseUriIntoFields(result.uri),
    }));
    setActiveEditorTab('server');
  };

  const uniqueImportName = (baseName: string, taken: Set<string>): string => {
    // Stored profile data, not UI copy — intentionally English in every locale (i18n out of scope).
    let name = baseName.trim() || 'Imported Connection';
    if (!taken.has(name.toLowerCase())) {
      taken.add(name.toLowerCase());
      return name;
    }
    let suffix = 2;
    while (taken.has(`${name} (${suffix})`.toLowerCase())) suffix += 1;
    const unique = `${name} (${suffix})`;
    taken.add(unique.toLowerCase());
    return unique;
  };

  const ensureImportFolder = (
    folderName: string | null | undefined,
    currentFolders: FolderNode[],
    folderIdsByName: Map<string, string>,
  ): { folderId: string | null; folders: FolderNode[] } => {
    const trimmed = folderName?.trim();
    if (!trimmed) return { folderId: null, folders: currentFolders };

    const existingId = folderIdsByName.get(trimmed.toLowerCase());
    if (existingId) return { folderId: existingId, folders: currentFolders };

    const newFolder: FolderNode = {
      id: `folder-${generateUUID()}`,
      name: trimmed,
      parentId: null,
      shared: false,
    };
    folderIdsByName.set(trimmed.toLowerCase(), newFolder.id);
    return { folderId: newFolder.id, folders: [...currentFolders, newFolder] };
  };

  const importParsedConnections = async (connections: ImportedConnection[]) => {
    setImportError(null);
    if (connections.length === 1 && !connections[0].folder) {
      openEditorForImport();
      applyImportedUri(connections[0].uri, connections[0].name);
      return;
    }

    const proceed = await confirm({
      title: t('dialogs.importConnections.title'),
      message: t('dialogs.importConnections.message', { count: connections.length }),
      confirmLabel: t('actions.importAll'),
    });
    if (!proceed) return;

    setLoading(true);
    try {
      const taken = new Set(profiles.map((profile) => profile.name.toLowerCase()));
      let nextFolders = [...folders];
      const folderIdsByName = new Map(
        nextFolders.map((folder) => [folder.name.toLowerCase(), folder.id]),
      );
      const nextMap = { ...profileFolderMap };
      let lastId: string | null = null;

      for (const connection of connections) {
        const name = uniqueImportName(connection.name, taken);
        const profile: ConnectionProfile = {
          id: generateUUID(),
          name,
          uri: connection.uri,
          ssh: null,
          color_tag: null,
          mcp_enabled: false,
        };
        await invoke('save_connection_profile', { profile });

        const ensured = ensureImportFolder(connection.folder, nextFolders, folderIdsByName);
        nextFolders = ensured.folders;
        if (ensured.folderId) nextMap[profile.id] = ensured.folderId;

        lastId = profile.id;
      }

      saveFoldersToStorage(nextFolders, nextMap);
      setExpandedFolders((prev) => {
        const next = { ...prev };
        for (const folder of nextFolders) next[folder.id] = true;
        return next;
      });
      setShowEditDialog(false);
      await loadProfiles();
      if (lastId) setSelectedId(lastId);
    } catch (err: unknown) {
      setImportError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleImportFromClipboard = async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (!text?.trim()) {
        setImportError(t('errors.clipboardEmpty'));
        return;
      }
      const result = parseConnectionImportFile(text);
      if (!result.ok) {
        setImportError(importErrorMessage(result.error));
        return;
      }
      await importParsedConnections(result.connections);
    } catch {
      setImportError(t('errors.clipboardReadFailed'));
    }
  };

  const handleImportFromFile = async () => {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title: t('filePicker.importFileTitle'),
        filters: [
          { name: t('filePicker.jsonStudio3tFilter'), extensions: ['json', 'uri', 'txt', 'env'] },
          { name: t('filePicker.allFilesFilter'), extensions: ['*'] },
        ],
      });
      if (typeof path !== 'string') return;
      const text = await readTextFile(path);
      const result = parseConnectionImportFile(text);
      if (!result.ok) {
        setImportError(importErrorMessage(result.error));
        return;
      }
      await importParsedConnections(result.connections);
    } catch {
      setImportError(t('errors.fileReadFailed'));
    }
  };

  // Manual paste — supports one or more URIs (with optional # labels / folders).
  const handleImportUri = async () => {
    const text = await prompt({
      title: t('dialogs.importUri.title'),
      message: t('dialogs.importUri.message', { shortcut: formatShortcut(shortcutById('submit-dialog')!) }),
      placeholder: t('dialogs.importUri.placeholder'),
      confirmLabel: t('actions.import'),
      multiline: true,
      validate: (v) => {
        const result = parseConnectionImportFile(v);
        return result.ok ? null : importErrorMessage(result.error);
      },
    });
    if (!text || !text.trim()) return;
    const result = parseConnectionImportFile(text);
    if (!result.ok) {
      setImportError(importErrorMessage(result.error));
      return;
    }
    await importParsedConnections(result.connections);
  };

  const importUriMenu = (testId = 'import-uri-btn', className?: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn(className)} data-testid={testId}>
          <ClipboardPaste size={testId === 'import-uri-btn' ? 11 : 12} />
          <span>{t('actions.importUri')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={NESTED_SELECT_Z}>
        <DropdownMenuItem onClick={() => void handleImportFromClipboard()} data-testid="import-from-clipboard">
          {t('import.fromClipboard')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handleImportFromFile()} data-testid="import-from-file">
          {t('import.fromFile')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handleImportUri()} data-testid="import-paste-manually">
          {t('import.pasteManually')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Export a URI with the password stripped by default (SSH/proxy secrets too);
  // the toggles opt back into secrets or drop the settings query entirely.
  const openExportDialog = (uri: string, hasSsh: boolean) => {
    setExportIncludePassword(false);
    setExportIncludeSettings(true);
    setExportDialog({ mode: 'single', uri, hasSsh });
  };

  const openExportAllDialog = () => {
    setExportIncludePassword(false);
    setExportIncludeSettings(true);
    setExportDialog({ mode: 'all' });
  };

  const exportOpts = {
    includePassword: exportIncludePassword,
    includeSettings: exportIncludeSettings,
  };

  const exportPreview = !exportDialog
    ? ''
    : exportDialog.mode === 'all'
      ? buildExportAllUris(profiles, exportOpts, { folders, profileFolderMap })
      : buildExportUri(exportDialog.uri, exportOpts);

  const handleExportSave = async () => {
    if (!exportDialog) return;
    try {
      const isAll = exportDialog.mode === 'all';
      const path = await save({
        defaultPath: isAll ? 'connections.json' : 'connection-uri.txt',
        title: isAll ? t('export.saveAllTitle') : t('export.saveTitle'),
        filters: isAll
          ? [
              { name: t('filePicker.jsonFilter'), extensions: ['json'] },
              { name: t('filePicker.allFilesFilter'), extensions: ['*'] },
            ]
          : [
              { name: t('filePicker.textFilter'), extensions: ['txt', 'env'] },
              { name: t('filePicker.allFilesFilter'), extensions: ['*'] },
            ],
      });
      if (!path) return;
      await writeTextFile(path, isAll ? exportPreview : `${exportPreview}\n`);
      setExportDialog(null);
    } catch {
      /* user cancelled or write failed — keep the dialog open */
    }
  };

  const runTestStepSequence = async () => {
    setTesting(true);
    setTestResult(null);
    setConnectError(null);
    setShowErrDetail(false);
    setTestProgress(0);

    const steps: TestStep[] = [
      { nameKey: 'test.stageParse', status: 'pending' },
      { nameKey: 'test.stageResolve', status: 'pending' },
      { nameKey: 'test.stageConnect', status: 'pending' },
      { nameKey: 'test.stagePing', status: 'pending' },
    ];
    setTestSteps([...steps]);

    const targetUri = buildUri(editorState);

    // Each real backend phase maps 1:1 to a checklist row.
    const phaseIndex: Record<string, number> = { parse: 0, resolve: 1, connect: 2, ping: 3 };

    // Live phase updates stream from the backend; paint each row from real results.
    const channel = new Channel<{ phase: string; status: string; message?: string }>();
    channel.onmessage = (update) => {
      const idx = phaseIndex[update.phase];
      if (idx === undefined) return;
      if (update.status === 'start') {
        steps[idx].status = 'running';
      } else if (update.status === 'ok') {
        steps[idx].status = 'success';
        setTestProgress((idx + 1) * 25);
      } else if (update.status === 'fail') {
        steps[idx].status = 'failed';
      }
      setTestSteps([...steps]);
    };

    try {
      await invoke('test_connection_uri', {
        uri: targetUri,
        ssh: buildSshConfig(editorState),
        onPhase: channel,
      });
      setTestProgress(100);
      setTestResult({ success: true });
    } catch (err: any) {
      // The failing row is already painted from its 'fail' update; as a fallback
      // (e.g. the call rejected before any update), mark the first unfinished row.
      if (!steps.some((s) => s.status === 'failed')) {
        const idx = steps.findIndex((s) => s.status === 'running' || s.status === 'pending');
        steps[idx === -1 ? 0 : idx].status = 'failed';
        setTestSteps([...steps]);
      }
      setTestResult({ success: false, message: String(err) });
    } finally {
      setTesting(false);
    }
  };

  // Filter profiles based on search and folder selection
  const filteredProfiles = useMemo(() => {
    return profiles.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.uri.toLowerCase().includes(searchQuery.toLowerCase());
      const mappedFolder = profileFolderMap[p.id] || '';
      
      if (folderFilter === 'all') return matchesSearch;
      if (folderFilter === 'root') return matchesSearch && !mappedFolder;
      return matchesSearch && mappedFolder === folderFilter;
    });
  }, [profiles, searchQuery, folderFilter, profileFolderMap]);

  const toggleFolderExpand = (folderId: string) => {
    setExpandedFolders(prev => ({ ...prev, [folderId]: !prev[folderId] }));
  };

  const selectedProfile = profiles.find(p => p.id === selectedId);

  return (
    <>
    {/* No click-outside close: dismiss only via the X button or Escape. */}
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DraggableDialogContent
        resetKey={isOpen}
        defaultWidth={900}
        defaultHeight={680}
        minWidth={640}
        minHeight={420}
        hideClose
        className="flex min-h-0 flex-col gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <header
          data-dialog-drag-handle
          className="flex shrink-0 cursor-grab items-center justify-between border-b border-border bg-muted/20 px-4 py-4 active:cursor-grabbing"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Server className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold leading-tight text-foreground">{t('title')}</h2>
              <p className="truncate text-ui-xs text-muted-foreground">{t('subtitle')}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label={t('common:close')}>
            <X size={14} />
          </Button>
        </header>

        {/* Toolbar */}
        <section className="flex shrink-0 flex-row flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={handleNewClick} aria-label={t('actions.new')}>
            <Plus size={12} className="text-primary" />
            <span>{t('actions.new')}</span>
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={handleNewFolderClick}>
            <FolderPlus size={12} className="text-warning" />
            <span>{t('actions.newFolder')}</span>
          </Button>
          {selectedId && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={() => handleEditClick(selectedId)}>
                <Edit3 size={12} className="text-primary" />
                <span>{t('actions.edit')}</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={() => handleDuplicateClick(selectedId)}>
                <Copy size={12} className="text-muted-foreground" />
                <span>{t('actions.duplicate')}</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs text-destructive hover:text-destructive" onClick={() => handleDelete(selectedId)}>
                <Trash2 size={12} />
                <span>{t('actions.delete')}</span>
              </Button>
              {importUriMenu('import-uri-toolbar-btn', 'h-8 gap-1.5 text-ui-xs')}
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" data-testid="export-uri-btn" onClick={() => {
                if (selectedProfile) openExportDialog(selectedProfile.uri, !!selectedProfile.ssh?.enabled);
              }}>
                <ExternalLink size={12} />
                <span>{t('actions.exportUri')}</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" data-testid="export-all-uris-btn" onClick={openExportAllDialog}>
                <ExternalLink size={12} />
                <span>{t('actions.exportAllUris')}</span>
              </Button>
            </>
          )}
        </section>

        {importError && !showEditDialog && (
          <div
            className="flex shrink-0 items-center gap-1.5 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[11px] text-destructive"
            data-testid="import-uri-error"
          >
            <AlertCircle size={12} />
            <span>{importError}</span>
          </div>
        )}

        {/* Content splits */}
        <div className="flex min-h-0 flex-1">
          {/* Left profile explorer tree */}
          <aside className={cn(sidebarPanelClass, 'w-[min(280px,34%)]')}>
            <div className="shrink-0 space-y-2 border-b border-sidebar-border px-3 py-3">
              <div className="relative flex items-center">
                <Search size={13} className="absolute left-2.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder={t('sidebar.searchPlaceholder')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="h-8 border-sidebar-border bg-background/80 pl-8 text-ui-xs"
                />
              </div>
              <Select value={folderFilter} onValueChange={setFolderFilter}>
                <SelectTrigger data-testid="folder-filter-select" className="h-8 w-full border-sidebar-border bg-background/80 text-ui-xs">
                  <SelectValue placeholder={t('sidebar.allFoldersPlaceholder')} />
                </SelectTrigger>
                <SelectContent className={NESTED_SELECT_Z}>
                  <SelectItem value="all">{t('sidebar.allFolders')}</SelectItem>
                  <SelectItem value="root">{t('folder.root')}</SelectItem>
                  {folders.map(f => (
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <ScrollArea className="min-h-0 flex-1">
            <div className="p-2">
              {folders.map(folder => {
                const isExpanded = expandedFolders[folder.id];
                const folderProfiles = filteredProfiles.filter(p => profileFolderMap[p.id] === folder.id);

                return (
                  <div key={folder.id}>
                    <div
                      className={treeRowClass()}
                      onClick={() => toggleFolderExpand(folder.id)}
                    >
                      <ChevronRight
                        size={12}
                        className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isExpanded && 'rotate-90')}
                      />
                      {isExpanded ? (
                        <FolderOpen size={12} className="shrink-0 text-warning" />
                      ) : (
                        <Folder size={12} className="shrink-0 text-warning" />
                      )}
                      <span className="min-w-0 truncate">{folder.name}</span>
                      <span className="shrink-0 text-ui-2xs tabular-nums text-muted-foreground">({folderProfiles.length})</span>
                    </div>

                    {isExpanded && (
                      <div className="ml-3 border-l border-sidebar-border pl-1.5">
                        {folderProfiles.map(p => {
                          const isSel = p.id === selectedId;
                          const isActive = activeConnections.some(c => c.profileId === p.id);
                          return (
                            <div
                              key={p.id}
                              className={treeRowClass(isSel)}
                              onClick={() => handleSelect(p.id)}
                              onDoubleClick={handleConnectClick}
                            >
                              <ConnectionColorDot color={p.color_tag} />
                              <Server size={12} className={cn('shrink-0', isSel ? 'text-primary' : 'text-muted-foreground')} />
                              <span className="min-w-0 truncate">{p.name || t('sidebar.unnamedConnection')}</span>
                              {isActive && (
                                <Badge variant="success" className="ml-auto h-4 px-1 text-ui-2xs" title={t('sidebar.connectedTitle')}>
                                  ●
                                </Badge>
                              )}
                            </div>
                          );
                        })}
                        {folderProfiles.length === 0 && (
                          <div className="pl-4 text-ui-2xs italic text-muted-foreground">{t('sidebar.emptyFolder')}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Uncategorized profiles at root */}
              {filteredProfiles.filter(p => !profileFolderMap[p.id]).map(p => {
                const isSel = p.id === selectedId;
                const isActive = activeConnections.some(c => c.profileId === p.id);
                return (
                  <div
                    key={p.id}
                    className={cn(treeRowClass(isSel), 'my-0.5')}
                    onClick={() => handleSelect(p.id)}
                    onDoubleClick={handleConnectClick}
                  >
                    <ConnectionColorDot color={p.color_tag} />
                    <Server size={12} className={cn('shrink-0', isSel ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="min-w-0 truncate">{p.name || t('sidebar.unnamedConnection')}</span>
                    {isActive && (
                      <Badge variant="success" className="ml-auto h-4 px-1 text-ui-2xs" title={t('sidebar.connectedTitle')}>
                        ●
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
            </ScrollArea>
          </aside>

          {/* Right connection preview panel */}
          <ScrollArea className="min-h-0 flex-1 bg-background">
            <div className="flex min-h-full flex-col p-6 lg:p-8">
            {selectedProfile ? (
              <div className="flex flex-1 flex-col">
                <div className="flex-1">
                  <div className="mb-4 flex items-center gap-3 border-b border-border pb-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                      <Server size={18} className="text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ConnectionColorDot color={selectedProfile.color_tag} className="h-2.5 w-2.5" />
                        <h3 className="truncate text-base font-semibold text-foreground">{selectedProfile.name}</h3>
                      </div>
                      <p className="text-ui-xs text-muted-foreground">{t('profile.subtitle')}</p>
                    </div>
                  </div>

                  <div className="mb-4 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-ui-2xs uppercase tracking-wide text-muted-foreground">{t('profile.connectionUri')}</Label>
                      {maskUriPassword(selectedProfile.uri) !== selectedProfile.uri && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => setRevealDetailUri(v => !v)}
                          title={revealDetailUri ? t('actions.hidePassword') : t('actions.showPassword')}
                          aria-label={revealDetailUri ? t('actions.hidePassword') : t('actions.showPassword')}
                        >
                          {revealDetailUri ? <EyeOff size={13} /> : <Eye size={13} />}
                        </Button>
                      )}
                    </div>
                    <div className="rounded-lg border border-border bg-muted/30 p-3 font-mono text-ui-xs break-all select-text">
                      {revealDetailUri ? selectedProfile.uri : maskUriPassword(selectedProfile.uri)}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label className="text-ui-2xs uppercase tracking-wide text-muted-foreground">{t('profile.metadata')}</Label>
                    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 text-ui-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('profile.status')}</span>
                        <span className="font-medium">
                          {activeConnections.some(c => c.profileId === selectedProfile.id) ? t('profile.connectedActive') : t('profile.disconnected')}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('profile.profileId')}</span>
                        <span className="font-mono text-ui-2xs">{selectedProfile.id}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mb-3 flex items-center gap-1.5 truncate rounded border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
                    <AlertCircle size={12} />
                    <span>{error}</span>
                  </div>
                )}

                <footer className="mt-auto flex justify-end gap-2 border-t border-border pt-3">
                  <Button
                    onClick={handleConnectClick}
                    disabled={loading || activeConnections.some(c => c.profileId === selectedProfile.id)}
                    size="sm"
                    aria-label={activeConnections.some(c => c.profileId === selectedProfile.id) ? t('actions.alreadyConnected') : loading ? t('actions.connecting') : t('actions.connect')}
                  >
                    <Play size={11} fill="currentColor" />
                    <span>{activeConnections.some(c => c.profileId === selectedProfile.id) ? t('actions.alreadyConnected') : loading ? t('actions.connecting') : t('actions.connect')}</span>
                  </Button>
                  <Button variant="outline" size="sm" onClick={onClose}>
                    {t('common:close')}
                  </Button>
                </footer>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                  <Server size={28} className="text-muted-foreground" />
                </div>
                <span className="max-w-sm text-ui-xs leading-relaxed">{t('empty.message')}</span>
              </div>
            )}
            </div>
          </ScrollArea>
        </div>
      </DraggableDialogContent>
    </Dialog>

      <Dialog open={showFolderDialog} onOpenChange={setShowFolderDialog}>
        <DialogPortal>
          <DialogOverlay className={NESTED_DIALOG_Z} />
          <DialogContent className={cn(NESTED_DIALOG_Z, 'w-[360px] max-w-[95vw] [&>button]:hidden')} onInteractOutside={(e) => e.preventDefault()}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleCreateFolder();
            }}
          >
            <DialogHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <FolderPlus size={14} className="text-warning" />
                <DialogTitle className="text-sm">{t('actions.newFolder')}</DialogTitle>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t('folder.closeDialogAria')} onClick={() => setShowFolderDialog(false)}>
                <X size={13} />
              </Button>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <Label htmlFor="new-folder-name">{t('folder.nameLabel')}</Label>
              <Input
                id="new-folder-name"
                data-testid="new-folder-name-input"
                value={newFolderName}
                onChange={(event) => {
                  setNewFolderName(event.target.value);
                  if (folderError) setFolderError(null);
                }}
                autoFocus
              />
              {folderError && (
                <div className="flex items-center gap-1.5 rounded border border-destructive/30 bg-destructive/10 p-1.5 text-[11px] text-destructive">
                  <AlertCircle size={12} />
                  <span>{folderError}</span>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowFolderDialog(false)}>{t('common:cancel')}</Button>
              <Button type="submit">
                <Check size={11} />
                <span>{t('actions.create')}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
        </DialogPortal>
      </Dialog>

      {/* Editor Dialog nested modal */}
      <Dialog open={showEditDialog} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DraggableDialogContent
          resetKey={showEditDialog}
          defaultWidth={780}
          defaultHeight={600}
          minWidth={560}
          minHeight={400}
          overlayClassName={NESTED_DIALOG_Z}
          hideClose
          className={cn(
            NESTED_DIALOG_Z,
            'flex min-h-0 flex-col gap-0 overflow-hidden p-0',
          )}
          onInteractOutside={(e) => e.preventDefault()}
        >
            <header
              data-dialog-drag-handle
              className="flex shrink-0 cursor-grab items-center justify-between border-b border-border bg-muted/20 px-4 py-4 active:cursor-grabbing"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                  <Server className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold leading-tight text-foreground">
                    {editMode === 'new' ? t('editor.newTitle') : editMode === 'duplicate' ? t('editor.duplicateTitle') : t('editor.editTitle')}
                  </h2>
                  <p className="truncate text-ui-xs text-muted-foreground">{t('editor.subtitle')}</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={closeEditor} aria-label={t('common:close')}>
                <X size={14} />
              </Button>
            </header>

            {/* Dialog Meta details */}
            <section className="shrink-0 space-y-2 border-b border-border bg-muted/20 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="connection-name" className="shrink-0 text-ui-xs">{t('form.displayName')}</Label>
                <Input
                  id="connection-name"
                  type="text"
                  value={editorState.name}
                  onChange={e => setEditorState(prev => ({ ...prev, name: e.target.value }))}
                  className="h-8 min-w-[160px] flex-1 text-ui-xs"
                />

                <Label htmlFor="folder-select" className="shrink-0 text-ui-xs">{t('form.folder')}</Label>
                <Select value={editorState.folder || '__root__'} onValueChange={(v) => setEditorState(prev => ({ ...prev, folder: v === '__root__' ? '' : v }))}>
                  <SelectTrigger id="folder-select" className="h-8 w-[140px] text-ui-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={NESTED_SELECT_Z}>
                    <SelectItem value="__root__">{t('folder.root')}</SelectItem>
                    {folders.map(f => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Label className="shrink-0 text-ui-xs">{t('form.colorTag')}</Label>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('form.colorTagGroupAria')}>
                  <button
                    type="button"
                    data-testid="color-swatch-none"
                    title={t('form.noColor')}
                    aria-label={t('form.noColor')}
                    aria-pressed={!editorState.colorTag}
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full border border-border text-ui-2xs text-muted-foreground transition-colors',
                      !editorState.colorTag && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                    )}
                    onClick={() => setEditorState((prev) => ({ ...prev, colorTag: '' }))}
                  >
                    ∅
                  </button>
                  {CONNECTION_COLOR_PALETTE.map((swatch) => (
                    <button
                      key={swatch.id}
                      type="button"
                      data-testid={`color-swatch-${swatch.id}`}
                      title={t(swatch.labelKey)}
                      aria-label={t(swatch.labelKey)}
                      aria-pressed={editorState.colorTag === swatch.value}
                      className={cn(
                        'h-5 w-5 rounded-full transition-[box-shadow]',
                        editorState.colorTag === swatch.value && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                      )}
                      style={{ backgroundColor: swatch.value }}
                      onClick={() => setEditorState((prev) => ({ ...prev, colorTag: swatch.value }))}
                    />
                  ))}
                  <label
                    className={cn(
                      'relative inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-ui-2xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground',
                      editorState.colorTag
                        && !isPresetConnectionColor(editorState.colorTag)
                        && 'border-solid ring-2 ring-primary ring-offset-1 ring-offset-background',
                    )}
                    title={t('form.pickCustomColor')}
                  >
                    <Pipette size={11} className="pointer-events-none shrink-0" aria-hidden="true" />
                    <span className="pointer-events-none">{t('form.custom')}</span>
                    {editorState.colorTag && !isPresetConnectionColor(editorState.colorTag) && (
                      <span
                        className="pointer-events-none h-2.5 w-2.5 shrink-0 rounded-full border border-border"
                        style={{ backgroundColor: editorState.colorTag }}
                        data-testid="color-picker-custom-preview"
                      />
                    )}
                    <input
                      type="color"
                      data-testid="color-picker-custom"
                      aria-label={t('form.pickCustomColor')}
                      value={colorInputValue(editorState.colorTag)}
                      onChange={(e) => setEditorState((prev) => ({ ...prev, colorTag: e.target.value }))}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <Badge variant="secondary" className="shrink-0 text-ui-2xs">{t('form.uriBadge')}</Badge>
                <code className="min-w-0 flex-1 truncate font-mono text-ui-2xs text-muted-foreground">{maskUriPassword(buildUri(editorState))}</code>
                <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 gap-1 text-ui-2xs" data-testid="editor-export-uri-btn" onClick={() => openExportDialog(buildUri(editorState), editorState.sshEnabled)}>
                  <Copy size={12} />
                  <span>{t('actions.export')}</span>
                </Button>
              </div>
            </section>

            <div className="flex min-h-0 flex-1">
            {!pendingSave && (
            <aside className={cn(sidebarPanelClass, 'w-48 xl:w-52')}>
              <nav className="flex flex-col gap-0.5 p-2" aria-label={t('editor.tabsAria')}>
                {TABS.map(tab => {
                  const TabIcon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveEditorTab(tab.id)}
                      className={sidebarNavButtonClass(activeEditorTab === tab.id)}
                    >
                      <TabIcon className={cn('h-4 w-4 shrink-0', activeEditorTab === tab.id ? 'text-primary' : '')} />
                      <span className="truncate">{t(tab.labelKey)}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>
            )}

            {/* Editor dialog body views */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            {!pendingSave && (
            <ScrollArea className="min-h-0 flex-1">
            <div className="p-6">
              {activeEditorTab === 'server' && (
                <div className="flex flex-col gap-2.5">
                  {editorState.topology === 'uri' && (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="connection-uri">{t('form.connectionUriLabel')}</Label>
                    {(() => {
                      const masked = maskUriPassword(editorState.uri);
                      const hasSecret = masked !== editorState.uri;
                      const showMasked = hasSecret && !revealUri;
                      return (
                        <div className="relative">
                          <Input
                            id="connection-uri"
                            type="text"
                            value={showMasked ? masked : editorState.uri}
                            readOnly={showMasked}
                            onFocus={() => { if (hasSecret) setRevealUri(true); }}
                            onChange={e => setEditorState(prev => ({ ...prev, uri: e.target.value, topology: 'uri' }))}
                            placeholder="mongodb://localhost:27017"
                            className="font-mono pr-9"
                          />
                          {hasSecret && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="absolute right-0 top-0 h-full w-8"
                              aria-label={revealUri ? t('actions.hidePassword') : t('actions.showPassword')}
                              title={revealUri ? t('actions.hidePassword') : t('form.showPasswordToEdit')}
                              onClick={() => setRevealUri(v => !v)}
                              tabIndex={-1}
                            >
                              {revealUri ? <EyeOff size={13} /> : <Eye size={13} />}
                            </Button>
                          )}
                        </div>
                      );
                    })()}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 w-fit text-xs"
                      data-testid="parse-uri-btn"
                      disabled={!editorState.uri.trim()}
                      onClick={() => setEditorState(prev => ({ ...prev, ...parseUriIntoFields(prev.uri) }))}
                      title={t('form.parseUriTitle')}
                    >
                      <LayoutGrid size={12} /> {t('form.parseIntoFields')}
                    </Button>
                  </div>
                  )}

                  {editorState.topology !== 'uri' && (
                    <div className="flex flex-col gap-1">
                      <Label>
                        {t('form.hostList')} {editorState.protocol === 'mongodb+srv' ? t('form.hostListHostnameOnly') : t('form.hostListHostPort')}
                      </Label>
                      <Input
                        type="text"
                        data-testid="host-list"
                        value={hostsToText(editorState.hosts, editorState.protocol === 'mongodb+srv')}
                        onChange={e => setEditorState(prev => ({ ...prev, hosts: textToHosts(e.target.value) }))}
                        placeholder={editorState.protocol === 'mongodb+srv' ? 'cluster0.abcd.mongodb.net' : '172.18.19.60:27017, 172.18.19.61:27017'}
                        className="font-mono"
                      />
                    </div>
                  )}

                  <div className="flex gap-3 border-t border-border pt-2.5">
                    {editorState.topology !== 'uri' && (
                      <div className="flex flex-1 flex-col gap-1">
                        <Label>{t('form.protocol')}</Label>
                        <Select
                          value={editorState.protocol}
                          onValueChange={(v) => setEditorState(prev => ({ ...prev, protocol: v }))}
                        >
                          <SelectTrigger className="h-8 text-ui-xs" data-testid="protocol-select">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className={NESTED_SELECT_Z}>
                            <SelectItem value="mongodb">mongodb://</SelectItem>
                            <SelectItem value="mongodb+srv">mongodb+srv://</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex flex-1 flex-col gap-1">
                      <Label>{t('form.topology')}</Label>
                      <Select
                        value={editorState.topology}
                        onValueChange={(v) => setEditorState(prev => ({ ...prev, topology: v }))}
                      >
                        <SelectTrigger className="h-8 text-ui-xs" data-testid="topology-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={NESTED_SELECT_Z}>
                          <SelectItem value="standalone">{t('form.topologyStandalone')}</SelectItem>
                          <SelectItem value="replicaSet">{t('form.topologyReplicaSet')}</SelectItem>
                          <SelectItem value="sharded">{t('form.topologySharded')}</SelectItem>
                          <SelectItem value="uri">{t('form.topologyUriOnly')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {editorState.topology === 'replicaSet' && (
                      <div className="flex flex-1 flex-col gap-1">
                        <Label>{t('form.replicaSetName')}</Label>
                        <Input
                          type="text"
                          value={editorState.replicaSetName}
                          onChange={e => setEditorState(prev => ({ ...prev, replicaSetName: e.target.value }))}
                          placeholder="rs0"
                        />
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                    <Label className="text-ui-xs">{t('form.connectionMode')}</Label>
                    <div className="flex flex-col gap-1.5" role="group" aria-label={t('form.connectionMode')}>
                      {CONNECTION_MODE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          data-testid={`connection-mode-${opt.value}`}
                          aria-pressed={editorState.connectionMode === opt.value}
                          className={cn(
                            'flex flex-col items-start gap-0.5 rounded-md border border-border px-2.5 py-1.5 text-left transition-colors hover:border-primary/50 hover:bg-accent',
                            editorState.connectionMode === opt.value && 'border-primary bg-accent ring-1 ring-primary',
                          )}
                          onClick={() => setEditorState((prev) => ({ ...prev, connectionMode: opt.value }))}
                        >
                          <span className="text-[11px] font-medium">{t(opt.labelKey)}</span>
                          <span className="text-[10.5px] leading-relaxed text-muted-foreground">{t(opt.descriptionKey)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                    <label className="flex items-center gap-2 text-[11px]">
                      <input
                        id="mcp-enable"
                        type="checkbox"
                        checked={editorState.mcpEnabled}
                        onChange={e => setEditorState(prev => ({ ...prev, mcpEnabled: e.target.checked }))}
                      />
                      <span>{t('form.mcpEnabled')}</span>
                    </label>
                    <span className="text-[10.5px] leading-relaxed text-muted-foreground">
                      {t('form.mcpEnabledDescription')}
                    </span>
                  </div>
                </div>
              )}

              {activeEditorTab === 'auth' && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-col gap-1">
                    <Label>{t('auth.method')}</Label>
                    <Select value={editorState.authMethod} onValueChange={(v) => setEditorState(prev => ({ ...prev, authMethod: v }))}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        <SelectItem value="none">{t('auth.methodNone')}</SelectItem>
                        <SelectItem value="scram-256">{t('auth.methodScram256')}</SelectItem>
                        <SelectItem value="scram-1">{t('auth.methodScram1')}</SelectItem>
                        <SelectItem value="x509">{t('auth.methodX509')}</SelectItem>
                        <SelectItem value="aws">{t('auth.methodAws')}</SelectItem>
                        <SelectItem value="kerberos">{t('auth.methodKerberos')}</SelectItem>
                        <SelectItem value="ldap">{t('auth.methodLdap')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {editorState.authMethod !== 'none' && (() => {
                    const m = editorState.authMethod;
                    const isScram = m === 'scram-1' || m === 'scram-256';
                    const isExternal = m === 'x509' || m === 'aws' || m === 'kerberos' || m === 'ldap';
                    const userLabel =
                      m === 'aws' ? t('auth.userLabelAws')
                      : m === 'kerberos' ? t('auth.userLabelKerberos')
                      : m === 'x509' ? t('auth.userLabelX509')
                      : t('auth.userLabelDefault');
                    const passLabel = m === 'aws' ? t('auth.passLabelAws') : t('auth.passLabelDefault');
                    const showPasswordField = m !== 'x509' && m !== 'kerberos';
                    return (
                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                      <div className="flex gap-2">
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>{userLabel}</Label>
                          <Input
                            type="text"
                            value={editorState.authUser}
                            onChange={e => setEditorState(prev => ({ ...prev, authUser: e.target.value }))}
                            placeholder={m === 'aws' ? 'AKIA…' : m === 'kerberos' ? 'user@REALM' : 'admin'}
                          />
                        </div>
                        {isScram && (
                          <div className="flex flex-1 flex-col gap-1">
                            <Label>{t('auth.authDatabase')}</Label>
                            <Input
                              type="text"
                              value={editorState.authDb}
                              onChange={e => setEditorState(prev => ({ ...prev, authDb: e.target.value }))}
                              placeholder="admin"
                            />
                          </div>
                        )}
                      </div>

                      {showPasswordField && (
                        <div className="flex flex-col gap-1">
                          <Label>{passLabel}</Label>
                          <div className="relative">
                            <Input
                              type={showPassword ? 'text' : 'password'}
                              value={editorState.authPass}
                              onChange={e => setEditorState(prev => ({ ...prev, authPass: e.target.value }))}
                              placeholder="••••••••"
                              className="pr-9"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="absolute right-0 top-0 h-full w-8"
                              onClick={() => setShowPassword(prev => !prev)}
                            >
                              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                            </Button>
                          </div>
                        </div>
                      )}

                      {m === 'aws' && (
                        <div className="flex flex-col gap-1">
                          <Label>{t('auth.sessionToken')}</Label>
                          <Input
                            type="text"
                            value={editorState.awsSessionToken}
                            onChange={e => setEditorState(prev => ({ ...prev, awsSessionToken: e.target.value }))}
                            placeholder={t('auth.sessionTokenPlaceholder')}
                          />
                        </div>
                      )}

                      {m === 'kerberos' && (
                        <div className="flex flex-col gap-1">
                          <Label>{t('auth.serviceName')}</Label>
                          <Input
                            type="text"
                            value={editorState.kerberosServiceName}
                            onChange={e => setEditorState(prev => ({ ...prev, kerberosServiceName: e.target.value }))}
                            placeholder="mongodb"
                          />
                        </div>
                      )}

                      {m === 'x509' && (
                        <p className="m-0 text-[10px] text-muted-foreground">
                          {t('auth.x509Note')}
                        </p>
                      )}
                      {isExternal && (
                        <p className="m-0 text-[10px] text-muted-foreground">
                          {/* One key, not a prefix/suffix pair around the <code>:
                              German puts the database NAME after the noun
                              ("gegen die Datenbank $external"), which a split
                              that hard-codes English word order cannot express
                              without stranding the final period after a space. */}
                          <Trans i18nKey="connections:auth.externalNote" t={t}>
                            Authenticates against the <code>$external</code> database.
                          </Trans>
                        </p>
                      )}
                    </div>
                    );
                  })()}
                </div>
              )}

              {activeEditorTab === 'tls' && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-col gap-1">
                    <Label>{t('tls.mode')}</Label>
                    <Select value={editorState.tlsMode} onValueChange={(v) => setEditorState(prev => ({ ...prev, tlsMode: v }))}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        <SelectItem value="off">{t('tls.modeOff')}</SelectItem>
                        <SelectItem value="system">{t('tls.modeSystem')}</SelectItem>
                        <SelectItem value="file">{t('tls.modeFile')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {editorState.tlsMode === 'file' && (
                    <div className="flex flex-col gap-1 border-t border-border pt-2.5">
                      <Label>{t('tls.caFilePath')}</Label>
                      <div className="flex gap-1.5">
                        <Input
                          type="text"
                          value={editorState.tlsCa}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsCa: e.target.value }))}
                          placeholder="/path/to/ca.pem"
                          className="flex-1 font-mono"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="ca-file-browse"
                          onClick={() => pickTlsFile('tlsCa')}
                        >
                          {t('actions.browse')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {editorState.tlsMode !== 'off' && (
                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                      <Label>{t('tls.certValidation')}</Label>
                      <label className="flex items-center gap-2 text-[11px]">
                        <input
                          type="checkbox"
                          checked={editorState.tlsAllowInvalidCerts}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsAllowInvalidCerts: e.target.checked }))}
                        />
                        <span>{t('tls.allowInvalidCerts')} <span className="text-destructive">{t('tls.insecureTag')}</span></span>
                      </label>
                      <label className="flex items-center gap-2 text-[11px]">
                        <input
                          type="checkbox"
                          checked={editorState.tlsAllowInvalidHosts}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsAllowInvalidHosts: e.target.checked }))}
                        />
                        <span>{t('tls.allowInvalidHosts')}</span>
                      </label>
                      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
                        {t('tls.validationWarning')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {activeEditorTab === 'ssh' && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="ssh-enable"
                      checked={editorState.sshEnabled}
                      onChange={e => setEditorState(prev => ({ ...prev, sshEnabled: e.target.checked }))}
                    />
                    <Label htmlFor="ssh-enable" className="text-[11px] font-medium">{t('ssh.enableLabel')}</Label>
                  </div>

                  {editorState.sshEnabled && (
                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                      <div className="flex gap-2">
                        <div className="flex flex-[2] flex-col gap-1">
                          <Label>{t('ssh.host')}</Label>
                          <Input
                            type="text"
                            value={editorState.sshHost}
                            onChange={e => setEditorState(prev => ({ ...prev, sshHost: e.target.value }))}
                            placeholder="ssh.server.com"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>{t('ssh.port')}</Label>
                          <Input
                            type="text"
                            value={editorState.sshPort}
                            onChange={e => setEditorState(prev => ({ ...prev, sshPort: e.target.value }))}
                            placeholder="22"
                            className="font-mono"
                          />
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <div className="flex flex-[2] flex-col gap-1">
                          <Label>{t('ssh.username')}</Label>
                          <Input
                            type="text"
                            value={editorState.sshUser}
                            onChange={e => setEditorState(prev => ({ ...prev, sshUser: e.target.value }))}
                            placeholder="deploy"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>{t('ssh.authMethod')}</Label>
                          <Select value={editorState.sshAuth} onValueChange={(v) => setEditorState(prev => ({ ...prev, sshAuth: v }))}>
                            <SelectTrigger className="h-8 text-xs" data-testid="ssh-auth-select">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={NESTED_SELECT_Z}>
                              <SelectItem value="key">{t('ssh.authKey')}</SelectItem>
                              <SelectItem value="password">{t('ssh.authPassword')}</SelectItem>
                              <SelectItem value="agent">{t('ssh.authAgent')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {editorState.sshAuth === 'key' && (
                        <>
                          <div className="flex flex-col gap-1">
                            <Label>{t('ssh.privateKeyPath')}</Label>
                            <Input
                              type="text"
                              value={editorState.sshKey}
                              onChange={e => setEditorState(prev => ({ ...prev, sshKey: e.target.value }))}
                              placeholder="~/.ssh/id_ed25519"
                              className="font-mono"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <Label>{t('ssh.keyPassphrase')}</Label>
                            <PasswordInput
                              value={editorState.sshPass}
                              onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                              placeholder={t('ssh.keyPassphrasePlaceholder')}
                              className="font-mono"
                            />
                          </div>
                        </>
                      )}
                      {editorState.sshAuth === 'password' && (
                        <div className="flex flex-col gap-1">
                          <Label>{t('ssh.password')}</Label>
                          <PasswordInput
                            value={editorState.sshPass}
                            onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                            placeholder="••••••••"
                            className="font-mono"
                          />
                        </div>
                      )}
                      {editorState.sshAuth === 'agent' && (
                        <div
                          data-testid="ssh-agent-note"
                          className="rounded border border-border bg-muted/40 px-2 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground"
                        >
                          {t('ssh.agentNote')}
                        </div>
                      )}

                      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
                        {t('ssh.hostKeyNotePrefix')} <code>~/.ssh/known_hosts</code>{t('ssh.hostKeyNoteSuffix')}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeEditorTab === 'proxy' && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="proxy-enable"
                      checked={editorState.proxyEnabled}
                      onChange={e => setEditorState(prev => ({ ...prev, proxyEnabled: e.target.checked }))}
                    />
                    <Label htmlFor="proxy-enable" className="text-[11px] font-medium">{t('proxy.enableLabel')}</Label>
                  </div>
                  <p className="m-0 text-[10px] text-muted-foreground">
                    {t('proxy.description')}
                  </p>

                  {editorState.proxyEnabled && (
                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                      <div className="flex gap-2">
                        <div className="flex flex-[2] flex-col gap-1">
                          <Label>{t('proxy.host')}</Label>
                          <Input
                            type="text"
                            value={editorState.proxyHost}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyHost: e.target.value }))}
                            placeholder="proxy.internal"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>{t('proxy.port')}</Label>
                          <Input
                            type="text"
                            value={editorState.proxyPort}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyPort: e.target.value }))}
                            placeholder="1080"
                            className="font-mono"
                          />
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>{t('proxy.username')}</Label>
                          <Input
                            type="text"
                            value={editorState.proxyUser}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyUser: e.target.value }))}
                            placeholder="username"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>{t('proxy.password')}</Label>
                          <Input
                            type="password"
                            value={editorState.proxyPass}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyPass: e.target.value }))}
                            placeholder="••••••••"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeEditorTab === 'adv' && (
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <div className="flex flex-1 flex-col gap-1">
                      <Label>{t('advanced.defaultDb')}</Label>
                      <Input
                        type="text"
                        value={editorState.defaultDb}
                        onChange={e => setEditorState(prev => ({ ...prev, defaultDb: e.target.value }))}
                        placeholder="test"
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-1">
                      <Label>{t('advanced.compression')}</Label>
                      <Select value={editorState.compression} onValueChange={(v) => setEditorState(prev => ({ ...prev, compression: v }))}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={NESTED_SELECT_Z}>
                          <SelectItem value="none">{t('advanced.compressionNone')}</SelectItem>
                          <SelectItem value="snappy">{t('advanced.compressionSnappy')}</SelectItem>
                          <SelectItem value="zlib">{t('advanced.compressionZlib')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>
            </ScrollArea>
            )}

            {(testing || testResult) && (
              <div className="mx-4 mb-2 flex max-h-[200px] shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-ui-2xs uppercase tracking-wide text-muted-foreground">{t('test.progressLabel')}</Label>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] font-semibold text-primary">{testProgress}%</span>
                    {testResult && !testing && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        data-testid="test-dismiss"
                        aria-label={t('test.dismissAria')}
                        title={t('test.dismissTitle')}
                        onClick={() => { setTestResult(null); setShowErrDetail(false); setTestProgress(0); }}
                      >
                        <X size={13} />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="h-1 w-full overflow-hidden rounded bg-muted">
                  <div className="h-full bg-primary transition-[width] duration-200 ease-out" style={{ width: `${testProgress}%` }} />
                </div>

                <div className="flex flex-col gap-1">
                  {testSteps.map((step, idx) => (
                    <div key={idx} className="flex items-center justify-between text-[11px]">
                      <span className={cn(
                        step.status === 'pending' && 'text-muted-foreground',
                        step.status === 'running' && 'text-primary',
                        (step.status === 'success' || step.status === 'failed') && 'text-foreground'
                      )}>{t(step.nameKey)}</span>
                      <span>
                        {step.status === 'pending' && <span className="inline-block h-2 w-2 rounded-full border border-border" />}
                        {step.status === 'running' && <RefreshCw size={10} className="animate-spin text-primary" />}
                        {step.status === 'success' && <Check size={11} className="text-success" />}
                        {step.status === 'failed' && <X size={11} className="text-destructive" />}
                      </span>
                    </div>
                  ))}
                </div>

                {testResult && (() => {
                  let summary: string;
                  let hint: string | undefined;
                  if (testResult.success) {
                    summary = t('test.successMessage');
                  } else {
                    ({ summary, hint } = describeConnectionError(testResult.message ?? '', t));
                  }
                  return (
                    <div className={cn(
                      'rounded border p-2 text-[11px]',
                      testResult.success
                        ? 'border-success/30 bg-success/10 text-success'
                        : 'border-destructive/30 bg-destructive/10 text-destructive'
                    )}>
                      <div className="flex items-start gap-1.5">
                        {testResult.success ? <Check size={12} className="mt-px shrink-0" /> : <AlertCircle size={12} className="mt-px shrink-0" />}
                        <span className="font-semibold" data-testid="test-result-summary">{summary}</span>
                      </div>
                      {hint && (
                        <div className="ml-[18px] mt-1 font-normal text-muted-foreground">{hint}</div>
                      )}
                      {!testResult.success && (
                        <>
                          <Button
                            type="button"
                            variant="link"
                            className="ml-[18px] mt-1.5 h-auto p-0 text-[10px] text-muted-foreground"
                            data-testid="test-error-details-toggle"
                            onClick={() => setShowErrDetail(v => !v)}
                          >
                            {showErrDetail ? t('test.hideDetails') : t('test.showDetails')}
                          </Button>
                          {showErrDetail && (
                            <pre data-testid="test-error-detail" className="mb-0 mt-1.5 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                              {testResult.message}
                            </pre>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* The only other `error` outlet sits in the manager pane behind this
                modal, so anything reported while the editor is open — a missing
                display name, a profile that is already connected — had no way of
                reaching the person it was written for. */}
            {error && (
              <div
                className="mx-4 mb-2 flex shrink-0 items-center gap-1.5 rounded border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive"
                data-testid="editor-error"
              >
                <AlertCircle size={12} className="shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {connectError && (() => {
              const { summary, hint } = describeConnectionError(connectError, t);
              return (
                <div
                  className="mx-4 mb-2 shrink-0 rounded border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive"
                  data-testid="connect-error"
                >
                  <div className="flex items-start gap-1.5">
                    <AlertCircle size={12} className="mt-px shrink-0" />
                    <span className="font-semibold" data-testid="connect-error-summary">{summary}</span>
                  </div>
                  {hint && (
                    <div className="ml-[18px] mt-1 font-normal text-muted-foreground">{hint}</div>
                  )}
                  <Button
                    type="button"
                    variant="link"
                    className="ml-[18px] mt-1.5 h-auto p-0 text-[10px] text-muted-foreground"
                    data-testid="connect-error-details-toggle"
                    onClick={() => setShowConnectErrDetail(v => !v)}
                  >
                    {showConnectErrDetail ? t('test.hideDetails') : t('test.showDetails')}
                  </Button>
                  {showConnectErrDetail && (
                    <pre
                      data-testid="connect-error-detail"
                      className="mb-0 mt-1.5 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground"
                    >
                      {connectError}
                    </pre>
                  )}
                </div>
              );
            })()}

            {pendingSave && (
              <div
                className="mx-4 mb-2 shrink-0 rounded border border-success/30 bg-success/10 p-2 text-[11px] text-success"
                data-testid="connect-save-offer"
              >
                <div className="flex items-start gap-1.5">
                  <Check size={12} className="mt-px shrink-0" />
                  <span className="font-semibold">{t('connectNow.connected')}</span>
                </div>
                <div className="ml-[18px] mt-1 font-normal text-muted-foreground">
                  {t('connectNow.saveOffer')}
                </div>
              </div>
            )}

            <footer className="flex shrink-0 items-center justify-between border-t border-border bg-muted/20 px-4 py-3">
              <div className="flex gap-2">
                {!pendingSave && (
                  <>
                    <Button variant="outline" size="sm" onClick={runTestStepSequence} disabled={testing || connecting}>
                      <RefreshCw size={11} className={testing ? 'animate-spin' : ''} />
                      <span>{t('actions.testConnection')}</span>
                    </Button>
                    {importUriMenu()}
                    {importError && (
                      <span className="self-center text-ui-2xs text-destructive" data-testid="import-uri-error">
                        {importError}
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="flex gap-2">
                {pendingSave ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="connect-skip-save-btn"
                      onClick={() => adoptPendingConnection(pendingSave)}
                      disabled={loading}
                    >
                      {t('connectNow.dontSave')}
                    </Button>
                    <Button size="sm" data-testid="connect-save-btn" onClick={handleSaveAndOpen} disabled={loading}>
                      <Check size={11} />
                      <span>{t('common:save')}</span>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" size="sm" onClick={closeEditor}>{t('common:cancel')}</Button>
                    <Button variant="outline" size="sm" onClick={handleSave} disabled={loading || testing || connecting}>
                      <Check size={11} />
                      <span>{t('common:save')}</span>
                    </Button>
                    <Button
                      size="sm"
                      data-testid="editor-connect-btn"
                      onClick={handleEditorConnect}
                      disabled={loading || testing || connecting}
                    >
                      <Play size={11} fill="currentColor" />
                      <span>{connecting ? t('actions.connecting') : t('actions.connect')}</span>
                    </Button>
                  </>
                )}
              </div>
            </footer>
            </div>
            </div>
        </DraggableDialogContent>
      </Dialog>

      <Dialog open={!!exportDialog} onOpenChange={(o) => !o && setExportDialog(null)}>
        <DialogContent className="max-w-lg" data-testid="export-uri-dialog">
          <DialogHeader>
            <DialogTitle>
              {exportDialog?.mode === 'all' ? t('export.allTitle') : t('export.singleTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {exportDialog?.mode === 'all' && (
              <p className="text-ui-2xs text-muted-foreground">
                {t('export.allDescription', { count: profiles.length })}
              </p>
            )}
            <code
              className={cn(
                'block break-all rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-ui-2xs',
                exportDialog?.mode === 'all' && 'max-h-40 overflow-y-auto whitespace-pre-wrap',
              )}
              data-testid="export-uri-preview"
            >
              {exportPreview}
            </code>
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label htmlFor="export-include-password" className="text-ui-xs">{t('export.includePassword')}</Label>
                <p className="text-ui-2xs text-muted-foreground">
                  {t('export.includePasswordDescription')}
                </p>
              </div>
              <Switch
                id="export-include-password"
                checked={exportIncludePassword}
                onCheckedChange={setExportIncludePassword}
                data-testid="export-include-password"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label htmlFor="export-include-settings" className="text-ui-xs">{t('export.includeSettings')}</Label>
                <p className="text-ui-2xs text-muted-foreground">
                  {t('export.includeSettingsDescription')}
                </p>
              </div>
              <Switch
                id="export-include-settings"
                checked={exportIncludeSettings}
                onCheckedChange={setExportIncludeSettings}
                data-testid="export-include-settings"
              />
            </div>
            {exportDialog?.mode === 'single' && exportDialog.hasSsh && (
              <p className="text-ui-2xs text-muted-foreground" data-testid="export-ssh-note">
                {t('export.sshNote')}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              data-testid="export-save-btn"
              onClick={handleExportSave}
            >
              {t('export.saveToFile')}
            </Button>
            <Button
              size="sm"
              data-testid="export-copy-btn"
              onClick={() => navigator.clipboard?.writeText(exportPreview)}
            >
              {t('export.copyToClipboard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

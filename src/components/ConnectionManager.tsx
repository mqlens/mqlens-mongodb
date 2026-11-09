import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { invoke, Channel } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  buildExportAllUris,
  buildExportUri,
  connectionSummary,
  maskUriPassword,
  parseConnectionImportFile,
  readLastConnected,
  stripUriSecrets,
  resolveImportUri,
  uriWithAskedPassword,
  type ImportedConnection,
  type ImportParseErrorCode,
} from '@/lib/connection';
import { useDialogs } from './dialogs/DialogProvider';
import { ServerAccountsPanel } from './ServerAccountsPanel';
import { PasswordInput } from './PasswordInput';
import { useEscapeClose } from '../lib/useEscapeClose';
import { connectErrorText, describeConnectError, isOidcErrorKey } from '../lib/describeConnectError';
import { EPHEMERAL_PROFILE_PREFIX } from '../workspace/persistence';
import { formatShortcut, shortcutById } from '@/lib/shortcuts';
import {
  Plus, X, Server, Play, Edit3, Trash2, Check, AlertCircle, RefreshCw,
  Folder, FolderPlus, FolderOpen, Search, ChevronRight,
  Copy, ExternalLink, Eye, EyeOff, LayoutGrid, ClipboardPaste, Pipette, ArrowUp, ArrowDown, Pencil, ClipboardCopy, FolderInput, Palette,
  type LucideIcon,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  /** Human OIDC settings (#430). Mirrors backend `ConnectionProfile::oidc`. */
  oidc?: { allowed_hosts?: string[]; use_id_token?: boolean; remember_login?: boolean } | null;
}

interface ConnectionManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (id: string, name: string, uri: string, profileId: string, colorTag?: string | null, connectionMode?: ConnectionMode) => void;
  activeConnections?: { id: string; profileId: string; name: string; uri: string }[];
  /** Open on the MQLens Server accounts rather than the profiles. */
  showServerAccounts?: boolean;
}

/**
 * `key` names the backend `TestPhase` this row tracks ('authenticate' is
 * OIDC-only and #430's only dynamic one — it exists only once a real
 * `authenticate` phase update has arrived, spliced in right before `ping`).
 * `message` is the raw (possibly locale-key) text from a `fail` update,
 * translated at render time — see `describeConnectError`.
 */
interface TestStep {
  key: 'parse' | 'resolve' | 'connect' | 'authenticate' | 'ping';
  nameKey: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  message?: string;
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
  /* v8 ignore start -- no browser the app runs in is missing randomUUID */
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  }
  idSequence += 1;
  return `${Date.now().toString(36)}-${idSequence.toString(36)}`;
  /* v8 ignore stop */
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
  // Comma-separated host allowlist for human OIDC login (#430), editor-only
  // text — never written into the URI (`ClientOptions::parse` rejects
  // ALLOWED_HOSTS), split into the profile's `oidc.allowed_hosts` on save.
  oidcAllowedHosts: '',
  // "Use ID token instead of access token" (T21): the profile's
  // `oidc.use_id_token`, for an identity provider whose access tokens MongoDB
  // refuses. Never in the URI either.
  oidcUseIdToken: false,
  oidcRememberLogin: false,
  tlsMode: 'off',
  // The saved URI said tls=false (or ssl=false); kept while TLS stays off.
  tlsOffExplicit: false,
  tlsCa: '',
  tlsClientCert: '',
  tlsClientKey: '',
  tlsKeyPassword: '',
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
  readPreferenceTags: '',
  appName: 'MQLens',
  connectTimeout: '10000',
  serverSelectionTimeout: '30000',
  socketTimeout: '',
  maxIdleTime: '',
  maxPoolSize: '',
  retryWrites: 'default',
  loadBalanced: false,
  writeConcernW: '',
  wtimeout: '',
  journal: 'default',
  extraOptions: '',
  authMechanismExtraProps: '',
  compression: 'none',
  // Stored profile data, not UI copy — intentionally English in every locale (i18n out of scope).
  name: 'New Connection',
  folder: '',
  colorTag: '',
  mcpEnabled: false,
  connectionMode: 'normal' as ConnectionMode,
};

const READ_PREFERENCE_MODES = ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'];

/**
 * URI options (lowercase) the editor's fields own: `parseUriIntoFields` reads
 * them and `buildUri` writes them back, sometimes under their modern name
 * (`ssl` as `tls`). Any other option rides through `extraOptions` untouched.
 */
const FORM_URI_OPTIONS = new Set([
  'replicaset', 'directconnection', 'tls', 'ssl', 'tlscafile', 'sslcertificateauthorityfile',
  'tlscertificatekeyfile', 'sslclientcertificatekeyfile', 'tlscertificatekeyfilepassword',
  'sslclientcertificatekeypassword', 'tlsinsecure', 'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames', 'authmechanism', 'authsource', 'authmechanismproperties',
  'readpreference', 'readpreferencetags', 'compressors', 'appname', 'connecttimeoutms',
  'serverselectiontimeoutms', 'sockettimeoutms', 'maxidletimems', 'maxpoolsize', 'retrywrites',
  'loadbalanced', 'w', 'wtimeoutms', 'journal', 'proxyhost', 'proxyport', 'proxyusername', 'proxypassword',
]);

/**
 * Legacy and singular TLS option names, under the name the form reads them
 * by: the same aliases the backend's `normalize_mongodb_uri_options` accepts,
 * so a setting the driver will apply is never hidden in `extraOptions`.
 */
const TLS_OPTION_ALIASES: Record<string, string> = {
  ssl: 'tls',
  sslcafile: 'tlsCAFile',
  sslcertificateauthorityfile: 'tlsCAFile',
  sslcertificatekeyfile: 'tlsCertificateKeyFile',
  sslpemkeyfile: 'tlsCertificateKeyFile',
  sslclientcertificatekeyfile: 'tlsCertificateKeyFile',
  sslcertificatekeyfilepassword: 'tlsCertificateKeyFilePassword',
  sslpemkeypassword: 'tlsCertificateKeyFilePassword',
  sslclientcertificatekeypassword: 'tlsCertificateKeyFilePassword',
  sslinvalidcertificateallowed: 'tlsAllowInvalidCertificates',
  sslallowinvalidcertificate: 'tlsAllowInvalidCertificates',
  sslallowinvalidcertificates: 'tlsAllowInvalidCertificates',
  tlsallowinvalidcertificate: 'tlsAllowInvalidCertificates',
  sslinvalidhostnameallowed: 'tlsAllowInvalidHostnames',
  sslallowinvalidhostname: 'tlsAllowInvalidHostnames',
  sslallowinvalidhostnames: 'tlsAllowInvalidHostnames',
  tlsallowinvalidhostname: 'tlsAllowInvalidHostnames',
};

type TableSortKey = 'name' | 'server' | 'security' | 'lastConnected';

/** A saved SSH tunnel as the editor's SSH tab fields. */
const sshEditorFields = (ssh: SshConfig) => ({
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
});

/** Percent-encode an option value but keep the `:` and `,` that tag sets and mechanism properties are built from. */
const encodeOptionValue = (value: string) =>
  encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2C/gi, ',');

/** Connection mode editor options (#188 Task 1) — segmented control in the server panel. */
const CONNECTION_MODE_OPTIONS: { value: ConnectionMode; labelKey: string; descriptionKey: string }[] = [
  { value: 'normal', labelKey: 'connectionMode.normal.label', descriptionKey: 'connectionMode.normal.description' },
  { value: 'read_only', labelKey: 'connectionMode.readOnly.label', descriptionKey: 'connectionMode.readOnly.description' },
  { value: 'confirm_destructive', labelKey: 'connectionMode.confirmDestructive.label', descriptionKey: 'connectionMode.confirmDestructive.description' },
];

/** Stacking above the connection-manager shell (z-50) and its nested editor (z-100). */
const NESTED_DIALOG_Z = 'z-[100]';
const NESTED_SELECT_Z = 'z-[110]';

/** Icon-and-label spacing for menu items, as the sidebar's menus use. */
const ctxItemClass = 'gap-2 text-xs [&_svg]:size-3';

/** The editor's horizontal tab strip. */
const editorTabClass = (active: boolean) =>
  cn(
    '-mb-px cursor-pointer border-b-2 px-3 py-2 text-ui-xs transition-colors',
    active
      ? 'border-primary font-medium text-foreground'
      : 'border-transparent text-muted-foreground hover:text-foreground',
  );

const sectionHeadingClass = 'border-t border-border pt-2.5 text-ui-2xs font-semibold uppercase tracking-wide text-muted-foreground';
const helpTextClass = 'm-0 text-[10.5px] leading-relaxed text-muted-foreground';

/** A form row with its label to the left of the control, the editor's density. */
const FormRow = ({ label, htmlFor, children }: { label?: React.ReactNode; htmlFor?: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[minmax(110px,160px)_minmax(0,1fr)] items-start gap-x-3">
    <Label htmlFor={htmlFor} className="pt-2 text-ui-xs font-normal leading-tight text-muted-foreground">{label}</Label>
    <div className="flex min-w-0 flex-col gap-1">{children}</div>
  </div>
);

/** A toolbar button with its icon above its label. */
const ToolbarButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof Button> & { icon: LucideIcon; label: string; iconClassName?: string }>(
  ({ icon: Icon, label, iconClassName, className, ...props }, ref) => (
    <Button
      ref={ref}
      variant="ghost"
      className={cn('h-auto min-w-[60px] flex-col gap-1 px-2 py-1.5 font-normal [&_svg]:size-[18px]', className)}
      {...props}
    >
      <Icon className={iconClassName} />
      {/* Sized here, not on the button: cn() drops text-ui-* when a colour class is passed in. */}
      <span className="text-ui-2xs">{label}</span>
    </Button>
  ),
);
ToolbarButton.displayName = 'ToolbarButton';

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
  { id: 'server', labelKey: 'tabs.server' },
  { id: 'auth', labelKey: 'tabs.auth' },
  { id: 'tls', labelKey: 'tabs.tls' },
  { id: 'ssh', labelKey: 'tabs.ssh' },
  { id: 'proxy', labelKey: 'tabs.proxy' },
  { id: 'adv', labelKey: 'tabs.advanced' },
];

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
 *
 * An OIDC locale key (#430) is not driver text to diagnose: it is already the
 * diagnosis, written as what happened plus what to do. It is translated whole
 * — the first-sentence cut below would drop the half that says what to do —
 * and here, at render, so it follows the current language.
 */
export const describeConnectionError = (
  raw: string,
  t: (key: string) => string,
): { summary: string; hint?: string } => {
  if (isOidcErrorKey(raw)) return { summary: describeConnectError(raw, t) };
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
  let tlsOffExplicit = false;
  let tlsCa = '';
  let tlsClientCert = '';
  let tlsKeyPassword = '';
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
  let authMechanismExtraProps = '';
  let query = '';
  // The Advanced and Proxy fields. Blank means "not in the URI": a saved
  // connection that never set appName or a timeout must not gain one on edit.
  const options = {
    readPreference: 'primary',
    readPreferenceTags: '',
    compression: 'none',
    appName: '',
    connectTimeout: '',
    serverSelectionTimeout: '',
    socketTimeout: '',
    maxIdleTime: '',
    maxPoolSize: '',
    retryWrites: 'default',
    loadBalanced: false,
    writeConcernW: '',
    wtimeout: '',
    journal: 'default',
    proxyEnabled: false,
    proxyHost: '',
    proxyPort: '1080',
    proxyUser: '',
    proxyPass: '',
    extraOptions: '',
  };
  if (m) {
    authUser = m[1] ? decodeURIComponent(m[1]) : '';
    authPass = m[2] ? decodeURIComponent(m[2]) : '';
    hostStr = m[3] || hostStr;
    defaultDb = m[4] || '';
    // `;` separates options as `&` does, for the driver and the backend's
    // normaliser alike, so every lookup below reads either.
    query = (m[5] || '')
      .replace(/;/g, '&')
      .split('&')
      .map((p) => {
        const key = p.split('=')[0];
        const name = TLS_OPTION_ALIASES[key.toLowerCase()];
        return name ? name + p.slice(key.length) : p;
      })
      .join('&');
    const param = (name: string): string | null => {
      const mm = query.match(new RegExp(`(?:^|&)${name}=([^&]*)`, 'i'));
      return mm ? decodeURIComponent(mm[1]) : null;
    };
    const caFile = param('tlsCAFile');
    if (caFile) {
      tlsMode = 'file';
      tlsCa = caFile;
    } else if (/(?:^|&)tls=true/i.test(query)) {
      tlsMode = 'system';
    }
    tlsOffExplicit = tlsMode === 'off' && /(?:^|&)tls=false/i.test(query);
    tlsClientCert = param('tlsCertificateKeyFile') || '';
    tlsKeyPassword = param('tlsCertificateKeyFilePassword') || '';
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
      'MONGODB-OIDC': 'oidc',
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
      else if (entry) authMechanismExtraProps += (authMechanismExtraProps ? ',' : '') + entry;
    }

    const parts = query.split('&').filter(Boolean);
    const values = (name: string) =>
      parts
        .filter((p) => p.split('=')[0].toLowerCase() === name.toLowerCase())
        .map((p) => decodeURIComponent(p.slice(p.indexOf('=') + 1)));
    const one = (name: string) => values(name)[0] ?? '';
    const readPreference = one('readPreference');
    if (READ_PREFERENCE_MODES.includes(readPreference)) options.readPreference = readPreference;
    // One tag set per line, in priority order; the empty set is spelled {}.
    options.readPreferenceTags = values('readPreferenceTags').map((v) => v || '{}').join('\n');
    const compressors = one('compressors');
    if (compressors === 'snappy' || compressors === 'zlib') options.compression = compressors;
    options.appName = one('appName');
    options.connectTimeout = one('connectTimeoutMS');
    options.serverSelectionTimeout = one('serverSelectionTimeoutMS');
    options.socketTimeout = one('socketTimeoutMS');
    options.maxIdleTime = one('maxIdleTimeMS');
    options.maxPoolSize = one('maxPoolSize');
    const flag = (v: string) => (v === 'true' || v === 'false' ? v : 'default');
    options.retryWrites = flag(one('retryWrites'));
    options.loadBalanced = one('loadBalanced') === 'true';
    options.writeConcernW = one('w');
    options.wtimeout = one('wtimeoutMS');
    options.journal = flag(one('journal'));
    options.proxyHost = one('proxyHost');
    options.proxyEnabled = !!options.proxyHost;
    options.proxyPort = one('proxyPort') || '1080';
    options.proxyUser = one('proxyUsername');
    options.proxyPass = one('proxyPassword');
    // Everything the form has no field for is carried through as written, so
    // editing a saved connection never drops an option (buildUri appends it).
    const representable: Record<string, (v: string) => boolean> = {
      readpreference: (v) => READ_PREFERENCE_MODES.includes(v),
      compressors: (v) => v === 'snappy' || v === 'zlib',
      retrywrites: (v) => v === 'true' || v === 'false',
      journal: (v) => v === 'true' || v === 'false',
      loadbalanced: (v) => v === 'true',
    };
    options.extraOptions = parts
      .filter((p) => {
        const key = p.split('=')[0].toLowerCase();
        if (!FORM_URI_OPTIONS.has(key)) return true;
        const check = representable[key];
        return check ? !check(decodeURIComponent(p.slice(p.indexOf('=') + 1))) : false;
      })
      .join('&');
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
    authMechanismExtraProps,
    ...options,
    tlsMode,
    tlsOffExplicit,
    tlsCa,
    tlsClientCert,
    tlsKeyPassword,
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
    // X509 derives the user from the cert; GSSAPI uses a Kerberos ticket; OIDC
    // authenticates through the browser — none of the three sends a password.
    const usesPassword = s.authPass && s.authMethod !== 'x509' && s.authMethod !== 'kerberos' && s.authMethod !== 'oidc';
    const p = usesPassword ? `:${encodeURIComponent(s.authPass)}` : '';
    creds = `${u}${p}@`;
  }
  const params = [];
  if (s.topology === 'replicaSet' && s.replicaSetName) params.push(`replicaSet=${encodeURIComponent(s.replicaSetName)}`);
  // directConnection only makes sense for a single-host, non-SRV standalone,
  // and never with loadBalanced, which the driver refuses alongside it.
  if (s.topology === 'standalone' && s.directConnection && !s.loadBalanced && !isSrv && s.hosts.filter(h => h.host).length <= 1)
    params.push('directConnection=true');
  if (s.tlsMode !== 'off') params.push('tls=true');
  else if (s.tlsOffExplicit) params.push('tls=false');
  // Custom CA file (and optional client cert/key file) must be passed to the driver.
  if (s.tlsMode === 'file' && s.tlsCa) params.push(`tlsCAFile=${encodeURIComponent(s.tlsCa)}`);
  // mongodb+srv:// is TLS unless it says tls=false, so its certificate stays.
  if ((s.tlsMode !== 'off' || (isSrv && !s.tlsOffExplicit)) && s.tlsClientCert) {
    params.push(`tlsCertificateKeyFile=${encodeURIComponent(s.tlsClientCert)}`);
    // Also encode ' ( ) ! * ~ so no character of the secret can end the URI
    // where log redaction reads it in free text.
    if (s.tlsKeyPassword) {
      const value = encodeURIComponent(s.tlsKeyPassword).replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      params.push(`tlsCertificateKeyFilePassword=${value}`);
    }
  }
  if (s.tlsAllowInvalidHosts) params.push('tlsAllowInvalidHostnames=true');
  if (s.tlsAllowInvalidCerts) params.push('tlsAllowInvalidCertificates=true');
  if (s.authMethod === 'scram-1') params.push('authMechanism=SCRAM-SHA-1');
  if (s.authMethod === 'scram-256') params.push('authMechanism=SCRAM-SHA-256');
  if (s.authMethod === 'x509') params.push('authMechanism=MONGODB-X509');
  if (s.authMethod === 'aws') params.push('authMechanism=MONGODB-AWS');
  if (s.authMethod === 'kerberos') params.push('authMechanism=GSSAPI');
  if (s.authMethod === 'ldap') params.push('authMechanism=PLAIN');
  // MONGODB-OIDC (#430): the mechanism only. `oidcAllowedHosts` never
  // reaches the URI — `ClientOptions::parse` rejects ALLOWED_HOSTS outright,
  // so it travels to the backend as the profile's `oidc.allowed_hosts` instead.
  if (s.authMethod === 'oidc') params.push('authMechanism=MONGODB-OIDC');
  // External mechanisms (M5) authenticate against $external; SCRAM uses the chosen auth DB.
  const isExternalAuth = ['x509', 'aws', 'kerberos', 'ldap', 'oidc'].includes(s.authMethod);
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
  const mechanismProps = [];
  if (s.authMethod === 'aws' && s.awsSessionToken) {
    mechanismProps.push(`AWS_SESSION_TOKEN:${encodeURIComponent(s.awsSessionToken)}`);
  }
  if (s.authMethod === 'kerberos' && s.kerberosServiceName) {
    mechanismProps.push(`SERVICE_NAME:${encodeURIComponent(s.kerberosServiceName)}`);
  }
  if (s.authMethod !== 'none' && s.authMechanismExtraProps) mechanismProps.push(encodeOptionValue(s.authMechanismExtraProps));
  if (mechanismProps.length) params.push(`authMechanismProperties=${mechanismProps.join(',')}`);
  if (s.readPreference !== 'primary') {
    params.push(`readPreference=${s.readPreference}`);
    for (const line of (s.readPreferenceTags ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      params.push(`readPreferenceTags=${line === '{}' ? '' : encodeOptionValue(line)}`);
    }
  }
  if (s.compression !== 'none') params.push(`compressors=${s.compression}`);
  if (s.appName) params.push(`appName=${encodeURIComponent(s.appName)}`);
  // Timeouts (M2) and the rest of the Advanced tab; blank leaves the driver default.
  const numeric: [string, string | undefined][] = [
    ['connectTimeoutMS', s.connectTimeout],
    ['serverSelectionTimeoutMS', s.serverSelectionTimeout],
    ['socketTimeoutMS', s.socketTimeout],
    ['maxIdleTimeMS', s.maxIdleTime],
    ['maxPoolSize', s.maxPoolSize],
  ];
  for (const [key, value] of numeric) if (value?.trim()) params.push(`${key}=${encodeURIComponent(value.trim())}`);
  if (s.retryWrites && s.retryWrites !== 'default') params.push(`retryWrites=${s.retryWrites}`);
  if (s.loadBalanced) params.push('loadBalanced=true');
  if (s.writeConcernW?.trim()) params.push(`w=${encodeURIComponent(s.writeConcernW.trim())}`);
  if (s.wtimeout?.trim()) params.push(`wtimeoutMS=${encodeURIComponent(s.wtimeout.trim())}`);
  if (s.journal && s.journal !== 'default') params.push(`journal=${s.journal}`);
  // SOCKS5 proxy (M2): the MongoDB driver only supports SOCKS5 proxy URI options.
  if (s.proxyEnabled && s.proxyHost) {
    params.push(`proxyHost=${encodeURIComponent(s.proxyHost)}`);
    params.push(`proxyPort=${s.proxyPort || 1080}`);
    if (s.proxyUser) params.push(`proxyUsername=${encodeURIComponent(s.proxyUser)}`);
    if (s.proxyPass) params.push(`proxyPassword=${encodeURIComponent(s.proxyPass)}`);
  }
  // A kept option gives way when a form control now writes the same key.
  const keyOf = (p: string) => p.split('=')[0].toLowerCase().replace(/^ssl$/, 'tls');
  const owned = new Set(params.map(keyOf));
  const extra = (s.extraOptions ?? '').trim().replace(/^[?&]+/, '').split('&').filter((p) => p && !owned.has(keyOf(p))).join('&');
  if (extra) params.push(extra);
  const dbPath = s.defaultDb ? `/${s.defaultDb}` : '';
  const scheme = isSrv ? 'mongodb+srv' : 'mongodb';
  return `${scheme}://${creds}${hosts}${dbPath}${params.length ? '?' + params.join('&') : ''}`;
};

/**
 * Build the profile's OIDC config from editor state (#430), or `null` when
 * the method isn't OIDC or no OIDC setting is set (no explicit host to allow,
 * and the ID-token option off). Backs every connect/test-uri call site and
 * the profile save path, so the allowed-hosts text field is split in exactly
 * one place. Each field is present only when set, matching what the backend
 * writes; the names are snake_case because Tauri converts only a command's
 * top-level argument names, not the fields inside them.
 */
export const buildOidcConfig = (
  s: typeof BLANK_CONN,
): { allowed_hosts?: string[]; use_id_token?: boolean; remember_login?: boolean } | null => {
  if (s.authMethod !== 'oidc') return null;
  const hosts = s.oidcAllowedHosts
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const config = {
    ...(hosts.length ? { allowed_hosts: hosts } : {}),
    ...(s.oidcUseIdToken ? { use_id_token: true } : {}),
    ...(s.oidcRememberLogin ? { remember_login: true } : {}),
  };
  return Object.keys(config).length ? config : null;
};

/**
 * Whether a connect targets MONGODB-OIDC, read off the URI itself rather than
 * `buildOidcConfig`'s result (#430): that returns `null` for an OIDC
 * connection with no allowed-hosts restriction (Atlas needs none) exactly as
 * it does for a non-OIDC one, so it can't tell the two apart. This is what a
 * `loginId` is minted from, for both the editor's own Connect and the saved
 * profile list's, since `connect_db` streams no phases for either to key a
 * pending-login UI on otherwise.
 *
 * It reads the URI as the backend's `uri_requests_oidc` (oidc_login.rs) and so
 * the driver do: the query starts at the first `?`, options are split on `&`
 * or `;`, and the value is percent-decoded, so `MONGODB%2DOIDC` counts. A miss
 * here would start a browser login with no Cancel.
 */
export const isOidcUri = (uri: string): boolean => {
  const queryStart = uri.indexOf('?');
  if (queryStart < 0) return false;
  return uri
    .slice(queryStart + 1)
    .split(/[&;]/)
    .some((part) => {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim().toLowerCase() !== 'authmechanism') return false;
      let value = part.slice(eq + 1);
      try {
        value = decodeURIComponent(value);
      } catch {
        // A malformed escape stays as typed, which is not the mechanism's name.
      }
      return value.trim().toUpperCase() === 'MONGODB-OIDC';
    });
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

/**
 * Best-effort: ask the backend to cancel a pending OIDC login (#430). Never
 * awaited and never surfaces its own failure — the login is being abandoned
 * either way (the dialog is closing, or the user asked to stop), and an
 * unknown `loginId` already answers `Ok` on the backend.
 */
const cancelOidcLogin = (loginId: string | null) => {
  if (!loginId) return;
  void invoke('cancel_oidc_login', { loginId }).catch(() => {});
};

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({
  isOpen,
  onClose,
  onConnect,
  activeConnections = [],
  showServerAccounts = false,
}) => {
  const { confirm, prompt } = useDialogs();
  // The MQLens Server accounts, shown in place of the profiles when on.
  const [showServer, setShowServer] = useState(showServerAccounts);
  useEffect(() => {
    if (isOpen) setShowServer(showServerAccounts);
  }, [isOpen, showServerAccounts]);
  const { t } = useTranslation('connections');
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<{ key: TableSortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
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
  // SRV -> seed list: resolved URIs by their SRV form, and the last lookup failure.
  const [exportSeedList, setExportSeedList] = useState(false);
  const [seedUris, setSeedUris] = useState<Record<string, string>>({});
  const [seedError, setSeedError] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<typeof BLANK_CONN>(BLANK_CONN);
  const [activeEditorTab, setActiveEditorTab] = useState('server');
  const [showPassword, setShowPassword] = useState(false);
  const [revealUri, setRevealUri] = useState(false);
  const [revealDetailUri, setRevealDetailUri] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test Connection States
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  const [testProgress, setTestProgress] = useState(0);
  const [testSteps, setTestSteps] = useState<TestStep[]>([
    { key: 'parse', nameKey: 'test.stageParse', status: 'running' },
    { key: 'resolve', nameKey: 'test.stageResolve', status: 'pending' },
    { key: 'connect', nameKey: 'test.stageConnect', status: 'pending' },
    { key: 'ping', nameKey: 'test.stagePing', status: 'pending' },
  ]);
  // A UUID minted before `test_connection_uri`/`connect_db` when the target
  // is OIDC, so Cancel/Reopen can act on the login while that call is still
  // in flight (#430). Cleared once the call settles, or the login is
  // cancelled/the dialog closes.
  const [testLoginId, setTestLoginId] = useState<string | null>(null);
  const [connectLoginId, setConnectLoginId] = useState<string | null>(null);
  // `message` carries the failure exactly as the backend sent it — raw
  // (English) driver text, or an OIDC locale key translated at render (#430),
  // like `connectError` below. The
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

  // A login still waiting on the browser — a test's, or a Connect's, from
  // the editor or the list — has nowhere to report once the manager is gone,
  // so every way out cancels it (#430). App keeps the manager mounted and
  // closes it through `isOpen`, and the X, the footer Close and Escape all
  // call `onClose` directly, so the dialog's own `onOpenChange` never sees
  // those: the close is watched here instead. The ref gives the unmount
  // cleanup the ids of the last render rather than the first.
  const pendingLoginIdsRef = useRef({ test: testLoginId, connect: connectLoginId });
  pendingLoginIdsRef.current = { test: testLoginId, connect: connectLoginId };
  const cancelPendingLogins = () => {
    const { test, connect } = pendingLoginIdsRef.current;
    if (test) { cancelOidcLogin(test); setTestLoginId(null); }
    if (connect) { cancelOidcLogin(connect); setConnectLoginId(null); }
  };
  useEffect(() => {
    if (!isOpen) cancelPendingLogins();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest ids through the ref
  }, [isOpen]);
  useEffect(() => () => {
    const { test, connect } = pendingLoginIdsRef.current;
    cancelOidcLogin(test);
    cancelOidcLogin(connect);
  }, []);

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
    const sshFields = profile.ssh ? sshEditorFields(profile.ssh) : {};

    const opened = {
      ...BLANK_CONN,
      name: profile.name,
      uri: profile.uri,
      ...parsed,
      folder: profileFolderMap[profile.id] || '',
      colorTag: profile.color_tag || '',
      mcpEnabled: profile.mcp_enabled ?? false,
      connectionMode: profile.connection_mode ?? 'normal',
      // Allowed hosts never round-trip through the URI (the driver rejects
      // ALLOWED_HOSTS there), so they are restored from the profile alone —
      // the same source save reads them from (#430).
      oidcAllowedHosts: (profile.oidc?.allowed_hosts ?? []).join(', '),
      oidcUseIdToken: profile.oidc?.use_id_token ?? false,
      oidcRememberLogin: profile.oidc?.remember_login ?? false,
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
      ...parseUriIntoFields(profile.uri),
      folder: profileFolderMap[profile.id] || '',
      colorTag: profile.color_tag || '',
      oidcAllowedHosts: (profile.oidc?.allowed_hosts ?? []).join(', '),
      oidcUseIdToken: profile.oidc?.use_id_token ?? false,
      oidcRememberLogin: profile.oidc?.remember_login ?? false,
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
      oidc: buildOidcConfig(tested ? tested.state : editorState),
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
    const oidc = existing ? existing.oidc ?? null : buildOidcConfig(editorState);
    // Keyed on the saved profile, not on `existing`: an edited profile still
    // saves back onto its own id, and `addActiveConnection` dedupes by
    // profileId — so connecting a second time would leave the user on the old
    // session while the new one leaked, with the profile overwritten under it.
    if (saved && activeConnections.some((c) => c.profileId === saved.id)) {
      setError(t('errors.alreadyActive'));
      return;
    }

    // Asked as in `handleConnectClick`: the password goes to this connect only,
    // never into the URI handed over or saved.
    const connectUri = await uriWithAskedPassword(uri, prompt, {
      title: t('passwordPrompt.title', { name: saved?.name ?? editorState.name }),
      message: t('passwordPrompt.message'),
      confirmLabel: t('actions.connect'),
    });
    if (connectUri === null) return;

    // Held by reference, which is a true snapshot: editorState is only ever
    // replaced with a fresh object, never mutated in place.
    const tested = editorState;
    const attempt = connectAttemptRef.current;
    // Minted only for an OIDC target: `connect_db` streams no phases, so this
    // is what lets Cancel/Reopen act on the login while the call is in flight
    // (#430) — a non-OIDC connect has no login to cancel.
    const loginId = isOidcUri(uri) ? generateUUID() : null;
    setConnecting(true);
    setConnectError(null);
    setShowConnectErrDetail(false);
    setTestResult(null);
    setError(null);
    setConnectLoginId(loginId);
    try {
      const connId = await invoke<string>('connect_db', { uri: connectUri, ssh, oidc, loginId, profileId: saved?.id ?? null });
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
      if (attempt === connectAttemptRef.current) setConnectError(connectErrorText(err));
    } finally {
      // Only the attempt that is still current may release the button. An
      // abandoned one clearing it would re-enable Connect while the NEW attempt
      // is still in flight, and a further click would then run two requests
      // under one generation — both would pass the guard above, and the second
      // to land would overwrite the first pendingSave and strand its connection
      // (#369 review).
      if (attempt === connectAttemptRef.current) {
        setConnecting(false);
        setConnectLoginId(null);
      }
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

    // A login still waiting on the browser (test checklist's Authenticate
    // row, or an OIDC editor Connect with no phase stream to watch) has
    // nowhere left to report to once this dialog is gone — cancel it rather
    // than leave it running unobserved (#430).
    if (testLoginId) { cancelOidcLogin(testLoginId); setTestLoginId(null); }
    if (connectLoginId) { cancelOidcLogin(connectLoginId); setConnectLoginId(null); }

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

    const uri = await uriWithAskedPassword(profile.uri, prompt, {
      title: t('passwordPrompt.title', { name: profile.name }),
      message: t('passwordPrompt.message'),
      confirmLabel: t('actions.connect'),
    });
    if (uri === null) return;

    // See `handleEditorConnect`'s `loginId` comment: minted only for OIDC,
    // since `connect_db` streams no phases Cancel/Reopen could otherwise key on.
    const loginId = isOidcUri(profile.uri) ? generateUUID() : null;
    setLoading(true);
    setError(null);
    setConnectLoginId(loginId);
    try {
      const connId = await invoke<string>('connect_db', { uri, ssh: profile.ssh ?? null, oidc: profile.oidc ?? null, loginId, profileId: profile.id });
      onConnect(connId, profile.name, profile.uri, profile.id, profile.color_tag ?? undefined, profile.connection_mode ?? 'normal');
    } catch (err: any) {
      setError(describeConnectError(err, t));
    } finally {
      setLoading(false);
      setConnectLoginId(null);
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
      const ssh = connections[0].ssh;
      if (ssh) setEditorState((prev) => ({ ...prev, ...sshEditorFields(ssh), sshEnabled: true }));
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
          ssh: connection.ssh ?? null,
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

  const importUriMenu = (trigger: React.ReactElement) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
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
    setExportSeedList(false);
    setSeedError(null);
    setExportDialog({ mode: 'single', uri, hasSsh });
  };

  const openExportAllDialog = () => {
    setExportIncludePassword(false);
    setExportIncludeSettings(true);
    setExportSeedList(false);
    setSeedError(null);
    setExportDialog({ mode: 'all' });
  };

  const exportOpts = {
    includePassword: exportIncludePassword,
    includeSettings: exportIncludeSettings,
  };

  const srvExportUris = !exportDialog
    ? []
    : (exportDialog.mode === 'all' ? profiles.map(p => p.uri) : [exportDialog.uri]).filter(u => /^mongodb\+srv:\/\//i.test(u));
  const seeded = (uri: string) => (exportSeedList ? seedUris[uri] ?? uri : uri);
  // Until every SRV URI has its seed list, the preview would still export SRV.
  const seedPending = exportSeedList && srvExportUris.some(u => !seedUris[u]);

  const toggleSeedList = async (on: boolean) => {
    setExportSeedList(on);
    setSeedError(null);
    if (!on) return;
    const resolved: Record<string, string> = {};
    for (const uri of srvExportUris) {
      if (seedUris[uri]) continue;
      try {
        resolved[uri] = await invoke<string>('resolve_srv_seed_list', { uri });
      } catch (e) {
        setSeedError(t('export.seedListFailed', { error: String(e) }));
      }
    }
    setSeedUris(prev => ({ ...prev, ...resolved }));
  };

  const exportPreview = !exportDialog
    ? ''
    : exportDialog.mode === 'all'
      ? buildExportAllUris(profiles.map(p => ({ ...p, uri: seeded(p.uri) })), exportOpts, { folders, profileFolderMap })
      : buildExportUri(seeded(exportDialog.uri), exportOpts);

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
      { key: 'parse', nameKey: 'test.stageParse', status: 'pending' },
      { key: 'resolve', nameKey: 'test.stageResolve', status: 'pending' },
      { key: 'connect', nameKey: 'test.stageConnect', status: 'pending' },
      { key: 'ping', nameKey: 'test.stagePing', status: 'pending' },
    ];
    setTestSteps([...steps]);

    const targetUri = buildUri(editorState);
    const loginId = generateUUID();
    setTestLoginId(loginId);

    // Live phase updates stream from the backend; paint each row from real
    // results. `authenticate` (#430) is the one phase with no row at start —
    // the backend emits it only for an OIDC login, so it is spliced in, right
    // before Ping, the first time (and only the first time) it is seen. The
    // index is always recomputed from the current row list rather than a
    // fixed map, so that insertion can never misalign the rows after it.
    const channel = new Channel<{ phase: string; status: string; message?: string }>();
    channel.onmessage = (update) => {
      let idx = steps.findIndex((s) => s.key === update.phase);
      if (idx === -1) {
        if (update.phase !== 'authenticate') return;
        const pingIdx = steps.findIndex((s) => s.key === 'ping');
        idx = pingIdx === -1 ? steps.length : pingIdx;
        steps.splice(idx, 0, { key: 'authenticate', nameKey: 'test.stageAuthenticate', status: 'pending' });
      }
      if (update.status === 'start') {
        steps[idx].status = 'running';
      } else if (update.status === 'ok') {
        steps[idx].status = 'success';
        setTestProgress(Math.round(((idx + 1) / steps.length) * 100));
      } else if (update.status === 'fail') {
        steps[idx].status = 'failed';
        steps[idx].message = update.message;
      }
      setTestSteps([...steps]);
    };

    try {
      await invoke('test_connection_uri', {
        uri: targetUri,
        ssh: buildSshConfig(editorState),
        oidc: buildOidcConfig(editorState),
        loginId,
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
      }
      // Any row still 'running' never reached a conclusion of its own — most
      // often Ping, already running when an OIDC login inside it fails
      // (#430): the driver authenticates lazily on the first operation, so
      // Ping's own 'ok'/'fail' never arrives. There's nothing wrong with Ping
      // itself, so it returns to a neutral, not-reached state rather than
      // being shown as failed too, and it must not keep spinning forever.
      steps.forEach((s) => { if (s.status === 'running') s.status = 'pending'; });
      setTestSteps([...steps]);
      setTestResult({ success: false, message: connectErrorText(err) });
    } finally {
      setTesting(false);
      setTestLoginId(null);
    }
  };

  // Discover (replica set): ask a seed member for the set's name and members.
  const handleDiscover = async () => {
    // A reply for an editor that has since closed (and maybe reopened on
    // another connection) is dropped, as a connect's is.
    const attempt = connectAttemptRef.current;
    setDiscovering(true);
    setDiscoverNote(null);
    try {
      const found = await invoke<{ set_name: string | null; hosts: string[] }>('discover_replica_set', {
        uri: buildUri(editorState),
      });
      if (attempt !== connectAttemptRef.current) return;
      // The reply comes from the server, so only plain host:port members are
      // taken; anything else could carry URI syntax into the saved string.
      const members = found.hosts.filter((h) => /^[A-Za-z0-9.-]+:\d{1,5}$/.test(h));
      if (found.set_name && members.length) {
        const setName = found.set_name;
        setEditorState((prev) => ({ ...prev, replicaSetName: setName, hosts: textToHosts(members.join(',')) }));
      } else {
        setDiscoverNote(t('form.discoverNoSet'));
      }
    } catch (err) {
      if (attempt === connectAttemptRef.current) setDiscoverNote(connectErrorText(err));
    } finally {
      setDiscovering(false);
    }
  };

  const setMember = (index: number, patch: Partial<{ host: string; port: string }>) =>
    setEditorState((prev) => ({ ...prev, hosts: prev.hosts.map((h, i) => (i === index ? { ...h, ...patch } : h)) }));

  const handleCancelTestLogin = () => { cancelOidcLogin(testLoginId); };
  const handleReopenTestLogin = () => {
    if (!testLoginId) return;
    void invoke('reopen_oidc_login', { loginId: testLoginId }).catch(() => {});
  };
  const handleCancelConnectLogin = () => { cancelOidcLogin(connectLoginId); };
  const handleReopenConnectLogin = () => {
    if (!connectLoginId) return;
    void invoke('reopen_oidc_login', { loginId: connectLoginId }).catch(() => {});
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

  // Re-read on open so a connect made since the last open shows.
  const lastConnected = useMemo(() => (isOpen ? readLastConnected() : {}), [isOpen]);
  const tableRows = useMemo(() => {
    const rows = filteredProfiles.map(p => {
      const summary = connectionSummary(p.uri);
      const security = [
        [summary.user, summary.mechanism].filter(Boolean).join(' · '),
        summary.tls ? 'TLS' : '',
        p.ssh?.enabled ? 'SSH' : '',
      ].filter(Boolean).join(', ');
      return { profile: p, server: summary.server, security, at: lastConnected[p.id] ?? 0 };
    });
    const value = (r: (typeof rows)[number]) =>
      sort.key === 'name' ? r.profile.name : sort.key === 'server' ? r.server : sort.key === 'security' ? r.security : r.at;
    return rows.sort((a, b) => {
      const x = value(a), y = value(b);
      return (typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string, undefined, { sensitivity: 'base' })) * sort.dir;
    });
  }, [filteredProfiles, lastConnected, sort]);
  // A new column starts ascending, except dates, which start with the most recent.
  const sortBy = (key: TableSortKey) =>
    setSort(prev => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: key === 'lastConnected' ? -1 : 1 }));

  const moveToFolder = (profileId: string, folderId: string) => {
    const map = { ...profileFolderMap };
    if (folderId) map[profileId] = folderId;
    else delete map[profileId];
    saveFoldersToStorage(folders, map);
  };

  const handleRenameFolder = async (folder: FolderNode) => {
    const name = await prompt({
      title: t('folder.renameTitle'),
      defaultValue: folder.name,
      confirmLabel: t('folder.rename'),
      validate: (v) => {
        const next = v.trim().toLowerCase();
        if (!next) return t('errors.folderNameRequired');
        return folders.some(f => f.id !== folder.id && f.name.toLowerCase() === next) ? t('errors.folderNameExists') : null;
      },
    });
    if (name === null) return;
    saveFoldersToStorage(folders.map(f => (f.id === folder.id ? { ...f, name: name.trim() } : f)), profileFolderMap);
  };

  // Deleting a folder never deletes connections: they move to the root.
  const handleDeleteFolder = async (folder: FolderNode) => {
    const ok = await confirm({
      title: t('folder.deleteTitle'),
      message: t('folder.deleteMessage', { name: folder.name }),
      confirmLabel: t('actions.delete'),
      destructive: true,
    });
    if (!ok) return;
    const map = Object.fromEntries(Object.entries(profileFolderMap).filter(([, f]) => f !== folder.id));
    saveFoldersToStorage(folders.filter(f => f.id !== folder.id), map);
  };

  // The profile being dragged; a ref, so a drop works without reading dataTransfer.
  const dragProfileId = useRef<string | null>(null);
  const dragProps = (profileId: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragProfileId.current = profileId;
      e.dataTransfer?.setData('text/plain', profileId);
    },
    onDragEnd: () => { dragProfileId.current = null; },
  });
  const dropProps = (folderId: string) => ({
    'data-folder-id': folderId || 'root',
    onDragOver: (e: React.DragEvent) => { if (dragProfileId.current) e.preventDefault(); },
    onDrop: (e: React.DragEvent) => {
      const id = dragProfileId.current;
      dragProfileId.current = null;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      moveToFolder(id, folderId);
    },
  });

  const profileMenu = (p: ConnectionProfile, row: React.ReactElement) => {
    const isActive = activeConnections.some(c => c.profileId === p.id);
    const current = profileFolderMap[p.id] || '';
    return (
      <ContextMenu key={p.id}>
        <ContextMenuTrigger asChild onContextMenu={() => handleSelect(p.id)}>{row}</ContextMenuTrigger>
        <ContextMenuContent className={NESTED_SELECT_Z}>
          <ContextMenuItem className={ctxItemClass} disabled={isActive || loading} onClick={handleConnectClick}>
            <Play />
            <span>{t('actions.connect')}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className={ctxItemClass} onClick={() => handleEditClick(p.id)}>
            <Edit3 />
            <span>{t('actions.edit')}</span>
          </ContextMenuItem>
          <ContextMenuItem className={ctxItemClass} onClick={() => handleDuplicateClick(p.id)}>
            <Copy />
            <span>{t('actions.duplicate')}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className={ctxItemClass} onClick={() => openExportDialog(p.uri, !!p.ssh?.enabled)}>
            <ExternalLink />
            <span>{t('actions.exportUriEllipsis')}</span>
          </ContextMenuItem>
          <ContextMenuItem className={ctxItemClass} onClick={() => void navigator.clipboard?.writeText(stripUriSecrets(p.uri)).catch(() => {})}>
            <ClipboardCopy />
            <span>{t('actions.copyUri')}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger className={ctxItemClass}>
              <FolderInput />
              <span>{t('actions.moveToFolder')}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className={NESTED_SELECT_Z}>
              <ContextMenuItem disabled={!current} onClick={() => moveToFolder(p.id, '')}>{t('folder.root')}</ContextMenuItem>
              {folders.map(f => (
                <ContextMenuItem key={f.id} disabled={current === f.id} onClick={() => moveToFolder(p.id, f.id)}>{f.name}</ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem className={cn(ctxItemClass, 'text-destructive focus:text-destructive')} onClick={() => handleDelete(p.id)}>
            <Trash2 />
            <span>{t('actions.delete')}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  // The table's rows in one folder ('' for the root), in the chosen sort order.
  const rowsInFolder = (folderId: string) => tableRows.filter(r => (profileFolderMap[r.profile.id] || '') === folderId);

  const profileRow = ({ profile: p, server, security, at }: (typeof tableRows)[number], nested: boolean) => {
    const isSel = p.id === selectedId;
    const isActive = activeConnections.some(c => c.profileId === p.id);
    return profileMenu(p,
      <tr
        className={cn('cursor-default border-b border-border/40 hover:bg-muted/40', isSel && 'bg-primary/10 hover:bg-primary/15')}
        aria-selected={isSel}
        onClick={() => handleSelect(p.id)}
        onDoubleClick={handleConnectClick}
        {...dragProps(p.id)}
      >
        <td className={cn('py-1 pr-2', nested ? 'pl-8' : 'pl-2')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <ConnectionColorDot color={p.color_tag} />
            <Server size={12} className={cn('shrink-0', isSel ? 'text-primary' : 'text-muted-foreground')} />
            <span data-testid="connection-row-name" className={cn('truncate', isSel && 'font-medium')}>{p.name || t('sidebar.unnamedConnection')}</span>
            {isActive && (
              <Badge variant="success" className="h-4 shrink-0 px-1 text-ui-2xs" title={t('sidebar.connectedTitle')}>
                ●
              </Badge>
            )}
          </span>
        </td>
        <td className="truncate px-2 py-1 font-mono">{server}</td>
        <td className="truncate px-2 py-1">{security || t('table.none')}</td>
        <td className="truncate px-2 py-1 tabular-nums text-muted-foreground">{at ? new Date(at).toLocaleString() : t('table.never')}</td>
      </tr>,
    );
  };

  const toggleFolderExpand = (folderId: string) => {
    setExpandedFolders(prev => ({ ...prev, [folderId]: !prev[folderId] }));
  };

  const selectedProfile = profiles.find(p => p.id === selectedId);
  const selectedIsActive = !!selectedProfile && activeConnections.some(c => c.profileId === selectedProfile.id);

  return (
    <>
    {/* No click-outside close: dismiss only via the X button or Escape. */}
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) {
        // A pending test login or connect (the list view's has no nested
        // dialog to close through `closeEditor`) is cancelled with the
        // manager (#430); see `cancelPendingLogins`.
        cancelPendingLogins();
        onClose();
      }
    }}>
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
          className="flex shrink-0 cursor-grab items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5 active:cursor-grabbing"
        >
          <h2 className="flex min-w-0 items-center gap-2 truncate text-ui-sm font-semibold text-foreground">
            <Server className="h-4 w-4 shrink-0 text-primary" />
            {t('title')}
          </h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label={t('common:close')}>
            <X size={14} />
          </Button>
        </header>

        {/* Toolbar: create · change the picked connection · move connections in and out. */}
        <section className="flex shrink-0 flex-row flex-wrap items-stretch gap-0.5 border-b border-border bg-muted/30 px-2 py-1">
          <ToolbarButton icon={Plus} iconClassName="text-primary" label={t('actions.new')} onClick={handleNewClick} />
          <ToolbarButton icon={FolderPlus} iconClassName="text-warning" label={t('actions.newFolder')} onClick={handleNewFolderClick} />
          <ToolbarButton
            icon={Server}
            iconClassName="text-primary"
            label={t('serverAccounts.title')}
            className={cn(showServer && 'bg-secondary')}
            aria-pressed={showServer}
            onClick={() => setShowServer((v) => !v)}
          />
          <div className="mx-1 my-1.5 w-px bg-border" />
          <ToolbarButton icon={Edit3} label={t('actions.edit')} disabled={!selectedProfile} onClick={() => selectedId && handleEditClick(selectedId)} />
          <ToolbarButton icon={Copy} label={t('actions.duplicate')} disabled={!selectedProfile} onClick={() => selectedId && handleDuplicateClick(selectedId)} />
          <ToolbarButton
            icon={Trash2}
            label={t('actions.delete')}
            className="text-destructive hover:text-destructive"
            disabled={!selectedProfile}
            onClick={() => selectedId && handleDelete(selectedId)}
          />
          <div className="mx-1 my-1.5 w-px bg-border" />
          {importUriMenu(<ToolbarButton icon={ClipboardPaste} label={t('actions.importUri')} data-testid="import-uri-toolbar-btn" />)}
          <ToolbarButton
            icon={ExternalLink}
            label={t('actions.exportUri')}
            data-testid="export-uri-btn"
            disabled={!selectedProfile}
            onClick={() => {
              if (selectedProfile) openExportDialog(selectedProfile.uri, !!selectedProfile.ssh?.enabled);
            }}
          />
          <ToolbarButton
            icon={ExternalLink}
            label={t('actions.exportAllUris')}
            data-testid="export-all-uris-btn"
            disabled={profiles.length === 0}
            onClick={openExportAllDialog}
          />
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

        {showServer ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <ServerAccountsPanel
                onConnect={(id, name, profileId, mode) => onConnect(id, name, '', profileId, undefined, mode)}
                activeProfileIds={activeConnections.map((c) => c.profileId)}
              />
            </div>
          </ScrollArea>
        ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <div className="relative flex min-w-[180px] flex-1 items-center">
              <Search size={13} className="absolute left-2.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder={t('filter.placeholder')}
                aria-label={t('filter.placeholder')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-ui-xs"
              />
            </div>
            <Label htmlFor="folder-filter" className="shrink-0 text-ui-xs font-normal text-muted-foreground">{t('filter.showFrom')}</Label>
            <Select value={folderFilter} onValueChange={setFolderFilter}>
              <SelectTrigger id="folder-filter" data-testid="folder-filter-select" className="h-8 w-[170px] text-ui-xs">
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
            <span data-testid="match-count" className="shrink-0 text-ui-xs tabular-nums text-muted-foreground">
              {t('filter.matches', { count: filteredProfiles.length })}
            </span>
          </div>

          <ScrollArea className="min-h-0 flex-1 bg-background">
            <table data-testid="connection-table" className="w-full table-fixed border-collapse text-ui-xs" {...dropProps('')}>
              <colgroup>
                <col className="w-[34%]" />
                <col className="w-[26%]" />
                <col className="w-[22%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="sticky top-0 z-[1] bg-muted/60 backdrop-blur">
                <tr className="border-b border-border text-left">
                  {([
                    ['name', t('table.name')],
                    ['server', t('table.server')],
                    ['security', t('table.security')],
                    ['lastConnected', t('table.lastConnected')],
                  ] as const).map(([key, label]) => (
                    <th
                      key={key}
                      className="border-r border-border/60 px-2 py-1 font-medium text-muted-foreground last:border-r-0"
                      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                    >
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(key)}>
                        {label}
                        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {folders.map(folder => {
                  const rows = rowsInFolder(folder.id);
                  // A filter shows where its matches are: their folders open, the rest drop out.
                  const filtering = searchQuery !== '';
                  if (filtering && rows.length === 0) return null;
                  const isExpanded = filtering || expandedFolders[folder.id];
                  return (
                    <React.Fragment key={folder.id}>
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <tr
                            className="cursor-default border-b border-border/40 hover:bg-muted/40"
                            aria-expanded={!!isExpanded}
                            onClick={() => toggleFolderExpand(folder.id)}
                            {...dropProps(folder.id)}
                          >
                            <td colSpan={4} className="px-2 py-1">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <ChevronRight
                                  size={12}
                                  className={cn('shrink-0 text-muted-foreground transition-transform duration-150', isExpanded && 'rotate-90')}
                                />
                                {isExpanded ? (
                                  <FolderOpen size={13} className="shrink-0 text-warning" />
                                ) : (
                                  <Folder size={13} className="shrink-0 text-warning" />
                                )}
                                <span className="min-w-0 truncate font-medium">{folder.name}</span>
                                <span className="shrink-0 text-ui-2xs tabular-nums text-muted-foreground">({rows.length})</span>
                              </span>
                            </td>
                          </tr>
                        </ContextMenuTrigger>
                        <ContextMenuContent className={NESTED_SELECT_Z}>
                          <ContextMenuItem className={ctxItemClass} onClick={() => handleRenameFolder(folder)}>
                            <Pencil />
                            <span>{t('folder.rename')}</span>
                          </ContextMenuItem>
                          <ContextMenuItem className={cn(ctxItemClass, 'text-destructive focus:text-destructive')} onClick={() => handleDeleteFolder(folder)}>
                            <Trash2 />
                            <span>{t('folder.delete')}</span>
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      {isExpanded && rows.map(row => profileRow(row, true))}
                      {isExpanded && rows.length === 0 && (
                        <tr className="border-b border-border/40">
                          <td colSpan={4} className="py-1 pl-10 text-ui-2xs italic text-muted-foreground">{t('sidebar.emptyFolder')}</td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {rowsInFolder('').map(row => profileRow(row, false))}
                {profiles.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-ui-xs text-muted-foreground">{t('empty.noConnections')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollArea>

          {error && (
            <div
              data-testid="connect-feedback"
              className="flex shrink-0 items-center gap-1.5 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-[11px] text-destructive"
            >
              <AlertCircle size={12} className="shrink-0" />
              <span className="min-w-0 truncate">{error}</span>
            </div>
          )}

          <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {selectedProfile && (
                <>
                  <code data-testid="selected-uri" className="min-w-0 truncate font-mono text-ui-2xs text-muted-foreground select-text">
                    {revealDetailUri ? selectedProfile.uri : maskUriPassword(selectedProfile.uri)}
                  </code>
                  {maskUriPassword(selectedProfile.uri) !== selectedProfile.uri && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => setRevealDetailUri(v => !v)}
                      title={revealDetailUri ? t('actions.hidePassword') : t('actions.showPassword')}
                      aria-label={revealDetailUri ? t('actions.hidePassword') : t('actions.showPassword')}
                    >
                      {revealDetailUri ? <EyeOff size={13} /> : <Eye size={13} />}
                    </Button>
                  )}
                </>
              )}
            </div>
            {/* Not while the editor is open: it is a separate top-layer Dialog
                that renders its own copy of these buttons, and both would
                duplicate the `connect-cancel-login` testid (#430). */}
            {connectLoginId && !showEditDialog && (
              <>
                <Button type="button" variant="outline" size="sm" data-testid="connect-cancel-login" onClick={handleCancelConnectLogin}>
                  {t('test.cancelLogin')}
                </Button>
                <Button type="button" variant="outline" size="sm" data-testid="connect-reopen-login" onClick={handleReopenConnectLogin}>
                  {t('test.openBrowserAgain')}
                </Button>
              </>
            )}
            <Button
              onClick={handleConnectClick}
              disabled={!selectedProfile || loading || selectedIsActive}
              size="sm"
              aria-label={selectedIsActive ? t('actions.alreadyConnected') : loading ? t('actions.connecting') : t('actions.connect')}
            >
              <Play size={11} fill="currentColor" />
              <span>{selectedIsActive ? t('actions.alreadyConnected') : loading ? t('actions.connecting') : t('actions.connect')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common:close')}
            </Button>
          </footer>
        </>
        )}
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
              className="flex shrink-0 cursor-grab items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5 active:cursor-grabbing"
            >
              <h2 className="flex min-w-0 items-center gap-2 truncate text-ui-sm font-semibold text-foreground">
                <Server className="h-4 w-4 shrink-0 text-primary" />
                {editMode === 'new' ? t('editor.newTitle') : editMode === 'duplicate' ? t('editor.duplicateTitle') : t('editor.editTitle')}
              </h2>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={closeEditor} aria-label={t('common:close')}>
                <X size={14} />
              </Button>
            </header>

            {/* Name, colour and folder */}
            <section className="flex shrink-0 flex-col gap-1.5 px-4 pb-2 pt-3">
              <FormRow label={t('form.displayName')} htmlFor="connection-name">
                <div className="flex items-center gap-1.5">
                  <Input
                    id="connection-name"
                    type="text"
                    value={editorState.name}
                    onChange={e => setEditorState(prev => ({ ...prev, name: e.target.value }))}
                    className="h-8 flex-1 text-ui-xs"
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        aria-label={t('form.colorTag')}
                        title={t('form.colorTag')}
                      >
                        {editorState.colorTag ? (
                          <span className="h-3.5 w-3.5 rounded-full border border-border" style={{ backgroundColor: editorState.colorTag }} />
                        ) : (
                          <Palette size={14} className="text-muted-foreground" />
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      className={cn(NESTED_SELECT_Z, 'w-auto p-2')}
                      // Escape closes the popover only: kept from the window listener that closes the editor.
                      onEscapeKeyDown={(e) => e.stopPropagation()}
                    >
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
                    </PopoverContent>
                  </Popover>
                </div>
              </FormRow>
              <FormRow label={t('form.folder')} htmlFor="folder-select">
                <Select value={editorState.folder || '__root__'} onValueChange={(v) => setEditorState(prev => ({ ...prev, folder: v === '__root__' ? '' : v }))}>
                  <SelectTrigger id="folder-select" className="h-8 text-ui-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={NESTED_SELECT_Z}>
                    <SelectItem value="__root__">{t('folder.root')}</SelectItem>
                    {folders.map(f => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRow>
            </section>

            <div className="flex min-h-0 flex-1 flex-col">
            {!pendingSave && (
              <nav className="flex shrink-0 flex-wrap border-b border-border px-3" aria-label={t('editor.tabsAria')}>
                {TABS.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={activeEditorTab === tab.id}
                    onClick={() => setActiveEditorTab(tab.id)}
                    className={editorTabClass(activeEditorTab === tab.id)}
                  >
                    {t(tab.labelKey)}
                  </button>
                ))}
              </nav>
            )}

            {/* Editor dialog body views */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            {!pendingSave && (
            <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 px-4 py-3">
              {activeEditorTab === 'server' && (
                <>
                  <FormRow label={t('form.connectionType')}>
                    <Select
                      value={editorState.topology === 'uri' ? 'uri' : editorState.protocol === 'mongodb+srv' ? 'srv' : editorState.topology}
                      onValueChange={(v) => setEditorState(prev => (
                        // A seedlist is an SRV lookup, which parseUriIntoFields reads as a cluster.
                        v === 'srv' ? { ...prev, protocol: 'mongodb+srv', topology: 'sharded' }
                        : v === 'uri' ? { ...prev, topology: v }
                        : { ...prev, protocol: 'mongodb', topology: v }
                      ))}
                    >
                      <SelectTrigger className="h-8 text-ui-xs" data-testid="topology-select" aria-label={t('form.connectionType')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        <SelectItem value="standalone">{t('form.topologyStandalone')}</SelectItem>
                        <SelectItem value="replicaSet">{t('form.topologyReplicaSet')}</SelectItem>
                        <SelectItem value="sharded">{t('form.topologySharded')}</SelectItem>
                        <SelectItem value="srv">{t('form.topologySrv')}</SelectItem>
                        <SelectItem value="uri">{t('form.topologyUriOnly')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormRow>

                  {editorState.topology === 'uri' && (
                  <FormRow label={t('form.connectionUriLabel')} htmlFor="connection-uri">
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
                  </FormRow>
                  )}

                  {(editorState.topology === 'replicaSet' || editorState.topology === 'sharded') && editorState.protocol !== 'mongodb+srv' ? (
                    <FormRow label={editorState.topology === 'replicaSet' ? t('form.members') : t('form.routers')}>
                    <div className="flex flex-col gap-1.5" data-testid="member-list">
                      {editorState.hosts.map((member, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <Input
                            type="text"
                            data-testid={`member-host-${i}`}
                            aria-label={t('form.memberHost', { index: i + 1 })}
                            value={member.host}
                            onChange={e => setMember(i, { host: e.target.value })}
                            placeholder="db1.example.com"
                            className="flex-[3] font-mono"
                          />
                          <Input
                            type="text"
                            inputMode="numeric"
                            data-testid={`member-port-${i}`}
                            aria-label={t('form.memberPort', { index: i + 1 })}
                            value={member.port}
                            onChange={e => setMember(i, { port: e.target.value })}
                            placeholder="27017"
                            className="flex-1 font-mono"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            disabled={editorState.hosts.length === 1}
                            aria-label={t('form.removeMember', { host: member.host || i + 1 })}
                            onClick={() => setEditorState(prev => ({ ...prev, hosts: prev.hosts.filter((_, j) => j !== i) }))}
                          >
                            <X size={13} />
                          </Button>
                        </div>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 text-xs"
                          onClick={() => setEditorState(prev => ({ ...prev, hosts: [...prev.hosts, { host: '', port: '27017' }] }))}
                        >
                          <Plus size={12} /> {t('form.addMember')}
                        </Button>
                        {editorState.topology === 'replicaSet' && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            data-testid="discover-members-btn"
                            // An SSH tunnel reaches one host only, and Discover
                            // would go around it straight to the seed.
                            disabled={discovering || editorState.sshEnabled || !editorState.hosts.some(h => h.host.trim())}
                            onClick={handleDiscover}
                            title={editorState.sshEnabled ? t('form.discoverNoSsh') : t('form.discoverTitle')}
                          >
                            <RefreshCw size={12} className={cn(discovering && 'animate-spin')} /> {t('form.discover')}
                          </Button>
                        )}
                      </div>
                      {discoverNote && (
                        <p className="m-0 flex items-center gap-1 text-[11px] text-warning" data-testid="discover-note">
                          <AlertCircle size={12} /> {discoverNote}
                        </p>
                      )}
                    </div>
                    </FormRow>
                  ) : editorState.topology !== 'uri' && (
                    <FormRow label={t('form.hostList')} htmlFor="host-list">
                      <Input
                        id="host-list"
                        type="text"
                        data-testid="host-list"
                        value={hostsToText(editorState.hosts, editorState.protocol === 'mongodb+srv')}
                        onChange={e => setEditorState(prev => ({ ...prev, hosts: textToHosts(e.target.value) }))}
                        placeholder={editorState.protocol === 'mongodb+srv' ? 'cluster0.abcd.mongodb.net' : '172.18.19.60:27017, 172.18.19.61:27017'}
                        className="font-mono"
                      />
                      <p className={helpTextClass}>
                        {editorState.protocol === 'mongodb+srv' ? t('form.hostListHostnameOnly') : t('form.hostListHostPort')}
                      </p>
                    </FormRow>
                  )}

                  {editorState.topology === 'replicaSet' && (
                    <FormRow label={t('form.replicaSetName')} htmlFor="replica-set-name">
                      <Input
                        id="replica-set-name"
                        type="text"
                        value={editorState.replicaSetName}
                        onChange={e => setEditorState(prev => ({ ...prev, replicaSetName: e.target.value }))}
                        placeholder="rs0"
                      />
                    </FormRow>
                  )}

                  <div className="border-t border-border" />
                  <FormRow label={t('form.connectionMode')}>
                    <div className="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-label={t('form.connectionMode')}>
                      {CONNECTION_MODE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          data-testid={`connection-mode-${opt.value}`}
                          aria-pressed={editorState.connectionMode === opt.value}
                          className={cn(
                            'rounded px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground',
                            editorState.connectionMode === opt.value && 'bg-primary/15 font-medium text-foreground',
                          )}
                          onClick={() => setEditorState((prev) => ({ ...prev, connectionMode: opt.value }))}
                        >
                          {t(opt.labelKey)}
                        </button>
                      ))}
                    </div>
                    {CONNECTION_MODE_OPTIONS.filter(opt => opt.value === editorState.connectionMode).map(opt => (
                      <p key={opt.value} className={helpTextClass}>{t(opt.descriptionKey)}</p>
                    ))}
                  </FormRow>
                  <FormRow>
                    <label className="flex items-center gap-2 pt-1.5 text-[11px]">
                      <input
                        id="mcp-enable"
                        type="checkbox"
                        checked={editorState.mcpEnabled}
                        onChange={e => setEditorState(prev => ({ ...prev, mcpEnabled: e.target.checked }))}
                      />
                      <span>{t('form.mcpEnabled')}</span>
                    </label>
                    <p className={helpTextClass}>{t('form.mcpEnabledDescription')}</p>
                  </FormRow>

                  <div className="border-t border-border" />
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
                    {importUriMenu(
                      <Button type="button" variant="outline" size="sm" className="h-7 justify-start text-xs" data-testid="import-uri-btn">
                        <ClipboardPaste size={12} />
                        <span>{t('form.fromUri')}</span>
                      </Button>,
                    )}
                    <span className="text-[11px] text-muted-foreground">{t('form.fromUriHelp')}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 justify-start text-xs"
                      data-testid="editor-export-uri-btn"
                      onClick={() => openExportDialog(buildUri(editorState), editorState.sshEnabled)}
                    >
                      <ExternalLink size={12} />
                      <span>{t('form.toUri')}</span>
                    </Button>
                    <span className="text-[11px] text-muted-foreground">{t('form.toUriHelp')}</span>
                  </div>
                </>
              )}

              {activeEditorTab === 'auth' && (
                <>
                  <FormRow label={t('auth.method')}>
                    <Select value={editorState.authMethod} onValueChange={(v) => setEditorState(prev => ({ ...prev, authMethod: v }))}>
                      <SelectTrigger className="h-8 text-xs" data-testid="auth-method-select" aria-label={t('auth.method')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        <SelectItem value="none">{t('auth.methodNone')}</SelectItem>
                        <SelectItem value="scram-256">{t('auth.methodScram256')}</SelectItem>
                        <SelectItem value="scram-1">{t('auth.methodScram1')}</SelectItem>
                        <SelectItem value="x509">{t('auth.methodX509')}</SelectItem>
                        <SelectItem value="kerberos">{t('auth.methodKerberos')}</SelectItem>
                        <SelectItem value="ldap">{t('auth.methodLdap')}</SelectItem>
                        <SelectItem value="aws">{t('auth.methodAws')}</SelectItem>
                        <SelectItem value="oidc">{t('auth.methodOidc')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormRow>

                  {editorState.authMethod !== 'none' && (() => {
                    const m = editorState.authMethod;
                    const isScram = m === 'scram-1' || m === 'scram-256';
                    const isExternal = m === 'x509' || m === 'aws' || m === 'kerberos' || m === 'ldap' || m === 'oidc';
                    const userLabel =
                      m === 'aws' ? t('auth.userLabelAws')
                      : m === 'kerberos' ? t('auth.userLabelKerberos')
                      : m === 'x509' ? t('auth.userLabelX509')
                      : t('auth.userLabelDefault');
                    const passLabel = m === 'aws' ? t('auth.passLabelAws') : t('auth.passLabelDefault');
                    const showPasswordField = m !== 'x509' && m !== 'kerberos' && m !== 'oidc';
                    return (
                    <>
                      <div className="border-t border-border" />
                      <FormRow label={userLabel} htmlFor="auth-user">
                        <Input
                          id="auth-user"
                          type="text"
                          value={editorState.authUser}
                          onChange={e => setEditorState(prev => ({ ...prev, authUser: e.target.value }))}
                          placeholder={m === 'aws' ? 'AKIA…' : m === 'kerberos' ? 'user@REALM' : 'admin'}
                        />
                      </FormRow>

                      {showPasswordField && (
                        <FormRow label={passLabel} htmlFor="auth-pass">
                          <div className="relative">
                            <Input
                              id="auth-pass"
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
                              aria-label={showPassword ? t('actions.hidePassword') : t('actions.showPassword')}
                              onClick={() => setShowPassword(prev => !prev)}
                            >
                              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                            </Button>
                          </div>
                        </FormRow>
                      )}

                      {isScram && (
                        <FormRow label={t('auth.authDatabase')} htmlFor="auth-db">
                          <Input
                            id="auth-db"
                            type="text"
                            value={editorState.authDb}
                            onChange={e => setEditorState(prev => ({ ...prev, authDb: e.target.value }))}
                            placeholder="admin"
                          />
                          <p className={helpTextClass}>{t('auth.authDatabaseHelp')}</p>
                        </FormRow>
                      )}

                      {m === 'aws' && (
                        <FormRow label={t('auth.sessionToken')} htmlFor="auth-aws-token">
                          <Input
                            id="auth-aws-token"
                            type="text"
                            value={editorState.awsSessionToken}
                            onChange={e => setEditorState(prev => ({ ...prev, awsSessionToken: e.target.value }))}
                            placeholder={t('auth.sessionTokenPlaceholder')}
                          />
                        </FormRow>
                      )}

                      {m === 'kerberos' && (
                        <FormRow label={t('auth.serviceName')} htmlFor="auth-kerberos-service">
                          <Input
                            id="auth-kerberos-service"
                            type="text"
                            value={editorState.kerberosServiceName}
                            onChange={e => setEditorState(prev => ({ ...prev, kerberosServiceName: e.target.value }))}
                            placeholder="mongodb"
                          />
                        </FormRow>
                      )}

                      {(m === 'x509' || isExternal) && (
                        <FormRow>
                          {m === 'x509' && <p className={helpTextClass}>{t('auth.x509Note')}</p>}
                          {isExternal && (
                            <p className={helpTextClass}>
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
                        </FormRow>
                      )}
                      {m === 'oidc' && (
                        <>
                          <FormRow>
                            <p className={helpTextClass}>{t('auth.oidcNote')}</p>
                            <label className="flex items-center gap-2 text-[11px]">
                              <input type="checkbox" checked={editorState.oidcRememberLogin}
                                aria-describedby="oidc-remember-help"
                                onChange={e => setEditorState(prev => ({ ...prev, oidcRememberLogin: e.target.checked }))} />
                              <span>{t('auth.oidcRememberLogin')}</span>
                            </label>
                            <span id="oidc-remember-help" className={helpTextClass}>
                              {t('auth.oidcRememberLoginHelp')}
                            </span>
                            {editMode === 'edit' && selectedId && (
                              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={async () => {
                                try {
                                  await invoke('forget_oidc_login', { profileId: selectedId });
                                  setError(null);
                                } catch (err) { setError(String(err)); }
                              }}>{t('auth.oidcForgetLogin')}</Button>
                            )}
                          </FormRow>
                          <FormRow label={t('auth.oidcAllowedHosts')} htmlFor="oidc-allowed-hosts">
                            <Input
                              id="oidc-allowed-hosts"
                              type="text"
                              value={editorState.oidcAllowedHosts}
                              onChange={e => setEditorState(prev => ({ ...prev, oidcAllowedHosts: e.target.value }))}
                              placeholder="mongo.corp.example.com"
                            />
                            <span className={helpTextClass}>
                              {t('auth.oidcAllowedHostsHelp')}
                            </span>
                          </FormRow>
                          <FormRow>
                            <label className="flex items-center gap-2 text-[11px]">
                              <input
                                type="checkbox"
                                id="oidc-use-id-token"
                                aria-describedby="oidc-use-id-token-help"
                                checked={editorState.oidcUseIdToken}
                                onChange={e => setEditorState(prev => ({ ...prev, oidcUseIdToken: e.target.checked }))}
                              />
                              <span>{t('auth.oidcUseIdToken')}</span>
                            </label>
                            <span id="oidc-use-id-token-help" className={helpTextClass}>
                              {t('auth.oidcUseIdTokenHelp')}
                            </span>
                          </FormRow>
                        </>
                      )}
                    </>
                    );
                  })()}
                </>
              )}

              {activeEditorTab === 'tls' && (
                <>
                  <label className="flex items-center gap-2 text-[11px] font-medium">
                    <input
                      type="checkbox"
                      id="tls-enable"
                      checked={editorState.tlsMode !== 'off'}
                      onChange={e => setEditorState(prev => ({
                        ...prev,
                        tlsMode: e.target.checked ? (prev.tlsMode === 'off' ? 'system' : prev.tlsMode) : 'off',
                      }))}
                    />
                    <span>{t('tls.enable')}</span>
                  </label>
                  {/* Greyed out rather than hidden while TLS is off, so the tab keeps its shape. */}
                  <fieldset disabled={editorState.tlsMode === 'off'} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-60">
                    <FormRow label={t('tls.caSource')}>
                      <div className="flex flex-col gap-1 pt-1.5" role="radiogroup" aria-label={t('tls.caSource')}>
                        {([['system', t('tls.caSystem')], ['file', t('tls.caFile')]] as const).map(([value, label]) => (
                          <label key={value} className="flex items-center gap-2 text-[11px]">
                            <input
                              type="radio"
                              name="tls-ca-source"
                              value={value}
                              checked={editorState.tlsMode === value}
                              onChange={() => setEditorState(prev => ({ ...prev, tlsMode: value }))}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </FormRow>
                    <FormRow label={t('tls.caFilePath')} htmlFor="tls-ca-file">
                      <div className="flex gap-1.5">
                        <Input
                          id="tls-ca-file"
                          type="text"
                          value={editorState.tlsCa}
                          disabled={editorState.tlsMode !== 'file'}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsCa: e.target.value }))}
                          placeholder="/path/to/ca.pem"
                          className="flex-1 font-mono"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8"
                          data-testid="ca-file-browse"
                          disabled={editorState.tlsMode !== 'file'}
                          onClick={() => pickTlsFile('tlsCa')}
                        >
                          {t('actions.browse')}
                        </Button>
                      </div>
                    </FormRow>

                    <div className="border-t border-border" />
                    <FormRow label={t('tls.clientCert')} htmlFor="tls-client-cert">
                      <div className="flex gap-1.5">
                        <Input
                          id="tls-client-cert"
                          type="text"
                          value={editorState.tlsClientCert}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsClientCert: e.target.value }))}
                          placeholder="/path/to/client.pem"
                          className="flex-1 font-mono"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8"
                          data-testid="client-cert-browse"
                          onClick={() => pickTlsFile('tlsClientCert')}
                        >
                          {t('actions.browse')}
                        </Button>
                      </div>
                    </FormRow>
                    <FormRow label={t('tls.keyPassword')} htmlFor="tls-key-password">
                      <Input
                        id="tls-key-password"
                        type="password"
                        autoComplete="off"
                        value={editorState.tlsKeyPassword}
                        onChange={e => setEditorState(prev => ({ ...prev, tlsKeyPassword: e.target.value }))}
                        disabled={!editorState.tlsClientCert}
                      />
                      <span className={helpTextClass}>{t('tls.keyPasswordHelp')}</span>
                    </FormRow>

                    <div className="border-t border-border" />
                    <FormRow label={t('tls.certValidation')}>
                      <label className="flex items-center gap-2 pt-1.5 text-[11px]">
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
                      <span className={helpTextClass}>{t('tls.validationWarning')}</span>
                    </FormRow>
                  </fieldset>
                </>
              )}

              {activeEditorTab === 'ssh' && (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="ssh-enable"
                      checked={editorState.sshEnabled}
                      onChange={e => setEditorState(prev => ({ ...prev, sshEnabled: e.target.checked }))}
                    />
                    <Label htmlFor="ssh-enable" className="text-[11px] font-medium">{t('ssh.enableLabel')}</Label>
                  </div>

                  <fieldset disabled={!editorState.sshEnabled} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-60">
                      {profiles.some(p => p.ssh?.enabled) && (
                        <FormRow label={t('ssh.reuse')}>
                          <Select
                            value=""
                            onValueChange={(id) => {
                              const ssh = profiles.find(p => p.id === id)?.ssh;
                              if (ssh) setEditorState(prev => ({ ...prev, ...sshEditorFields(ssh), sshEnabled: true }));
                            }}
                          >
                            <SelectTrigger data-testid="ssh-reuse-select" className="h-8 text-xs" aria-label={t('ssh.reuse')}>
                              <SelectValue placeholder={t('ssh.reusePlaceholder')} />
                            </SelectTrigger>
                            <SelectContent className={NESTED_SELECT_Z}>
                              {profiles.filter(p => p.ssh?.enabled).map(p => (
                                <SelectItem key={p.id} value={p.id}>{`${p.name} (${p.ssh!.user}@${p.ssh!.host}:${p.ssh!.port})`}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormRow>
                      )}
                      {editorState.sshEnabled && (editorState.topology === 'uri'
                        ? /^mongodb\+srv:\/\//i.test(editorState.uri.trim())
                        : editorState.protocol === 'mongodb+srv') && (
                        <div
                          data-testid="ssh-srv-warning"
                          className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400"
                        >
                          <AlertCircle size={12} className="mt-0.5 shrink-0" />
                          <span>{t('ssh.srvWarning')}</span>
                        </div>
                      )}
                      <FormRow label={t('ssh.host')} htmlFor="ssh-host">
                        <div className="flex items-center gap-1.5">
                          <Input
                            id="ssh-host"
                            type="text"
                            value={editorState.sshHost}
                            onChange={e => setEditorState(prev => ({ ...prev, sshHost: e.target.value }))}
                            placeholder="ssh.server.com"
                            className="flex-1"
                          />
                          <Label htmlFor="ssh-port" className="shrink-0 text-ui-xs font-normal text-muted-foreground">{t('ssh.port')}</Label>
                          <Input
                            id="ssh-port"
                            type="text"
                            value={editorState.sshPort}
                            onChange={e => setEditorState(prev => ({ ...prev, sshPort: e.target.value }))}
                            placeholder="22"
                            className="w-20 font-mono"
                          />
                        </div>
                      </FormRow>
                      <FormRow label={t('ssh.username')} htmlFor="ssh-user">
                        <Input
                          id="ssh-user"
                          type="text"
                          value={editorState.sshUser}
                          onChange={e => setEditorState(prev => ({ ...prev, sshUser: e.target.value }))}
                          placeholder="deploy"
                        />
                      </FormRow>
                      <FormRow label={t('ssh.authMethod')}>
                        <Select value={editorState.sshAuth} onValueChange={(v) => setEditorState(prev => ({ ...prev, sshAuth: v }))}>
                          <SelectTrigger className="h-8 text-xs" data-testid="ssh-auth-select" aria-label={t('ssh.authMethod')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className={NESTED_SELECT_Z}>
                            <SelectItem value="key">{t('ssh.authKey')}</SelectItem>
                            <SelectItem value="password">{t('ssh.authPassword')}</SelectItem>
                            <SelectItem value="agent">{t('ssh.authAgent')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormRow>

                      {editorState.sshAuth === 'key' && (
                        <>
                          <FormRow label={t('ssh.privateKeyPath')} htmlFor="ssh-key">
                            <Input
                              id="ssh-key"
                              type="text"
                              value={editorState.sshKey}
                              onChange={e => setEditorState(prev => ({ ...prev, sshKey: e.target.value }))}
                              placeholder="~/.ssh/id_ed25519"
                              className="font-mono"
                            />
                          </FormRow>
                          <FormRow label={t('ssh.keyPassphrase')}>
                            <PasswordInput
                              value={editorState.sshPass}
                              onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                              placeholder={t('ssh.keyPassphrasePlaceholder')}
                              className="font-mono"
                              aria-label={t('ssh.keyPassphrase')}
                            />
                          </FormRow>
                        </>
                      )}
                      {editorState.sshAuth === 'password' && (
                        <FormRow label={t('ssh.password')}>
                          <PasswordInput
                            value={editorState.sshPass}
                            onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                            placeholder="••••••••"
                            className="font-mono"
                            aria-label={t('ssh.password')}
                          />
                        </FormRow>
                      )}
                      {editorState.sshAuth === 'agent' && (
                        <FormRow>
                          <div
                            data-testid="ssh-agent-note"
                            className="rounded border border-border bg-muted/40 px-2 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground"
                          >
                            {t('ssh.agentNote')}
                          </div>
                        </FormRow>
                      )}

                      <FormRow>
                        <p className={helpTextClass}>
                          {t('ssh.hostKeyNotePrefix')} <code>~/.ssh/known_hosts</code>{t('ssh.hostKeyNoteSuffix')}
                        </p>
                      </FormRow>
                  </fieldset>
                </>
              )}

              {activeEditorTab === 'proxy' && (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="proxy-enable"
                      checked={editorState.proxyEnabled}
                      onChange={e => setEditorState(prev => ({ ...prev, proxyEnabled: e.target.checked }))}
                    />
                    <Label htmlFor="proxy-enable" className="text-[11px] font-medium">{t('proxy.enableLabel')}</Label>
                  </div>
                  <p className={helpTextClass}>{t('proxy.description')}</p>

                  <fieldset disabled={!editorState.proxyEnabled} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-60">
                    <FormRow label={t('proxy.host')} htmlFor="proxy-host">
                      <div className="flex items-center gap-1.5">
                        <Input
                          id="proxy-host"
                          type="text"
                          value={editorState.proxyHost}
                          onChange={e => setEditorState(prev => ({ ...prev, proxyHost: e.target.value }))}
                          placeholder="proxy.internal"
                          className="flex-1"
                        />
                        <Label htmlFor="proxy-port" className="shrink-0 text-ui-xs font-normal text-muted-foreground">{t('proxy.port')}</Label>
                        <Input
                          id="proxy-port"
                          type="text"
                          value={editorState.proxyPort}
                          onChange={e => setEditorState(prev => ({ ...prev, proxyPort: e.target.value }))}
                          placeholder="1080"
                          className="w-20 font-mono"
                        />
                      </div>
                    </FormRow>
                    <FormRow label={t('proxy.username')} htmlFor="proxy-user">
                      <Input
                        id="proxy-user"
                        type="text"
                        value={editorState.proxyUser}
                        onChange={e => setEditorState(prev => ({ ...prev, proxyUser: e.target.value }))}
                        placeholder="username"
                      />
                    </FormRow>
                    <FormRow label={t('proxy.password')} htmlFor="proxy-pass">
                      <Input
                        id="proxy-pass"
                        type="password"
                        value={editorState.proxyPass}
                        onChange={e => setEditorState(prev => ({ ...prev, proxyPass: e.target.value }))}
                        placeholder="••••••••"
                      />
                    </FormRow>
                  </fieldset>
                </>
              )}

              {activeEditorTab === 'adv' && (
                <>
                  <FormRow label={t('advanced.defaultDb')} htmlFor="adv-default-db">
                    <Input
                      id="adv-default-db"
                      type="text"
                      value={editorState.defaultDb}
                      onChange={e => setEditorState(prev => ({ ...prev, defaultDb: e.target.value }))}
                      placeholder="test"
                    />
                  </FormRow>
                  <FormRow label={t('advanced.compression')}>
                    <Select value={editorState.compression} onValueChange={(v) => setEditorState(prev => ({ ...prev, compression: v }))}>
                      <SelectTrigger className="h-8 text-xs" aria-label={t('advanced.compression')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        <SelectItem value="none">{t('advanced.compressionNone')}</SelectItem>
                        <SelectItem value="snappy">{t('advanced.compressionSnappy')}</SelectItem>
                        <SelectItem value="zlib">{t('advanced.compressionZlib')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormRow>

                  <h4 className={sectionHeadingClass}>{t('advanced.readSection')}</h4>
                  <FormRow label={t('advanced.readPreference')}>
                    <Select value={editorState.readPreference} onValueChange={(v) => setEditorState(prev => ({ ...prev, readPreference: v }))}>
                      <SelectTrigger data-testid="read-preference-select" className="h-8 text-xs" aria-label={t('advanced.readPreference')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        {/* MongoDB's own mode names, the same in every language. */}
                        {READ_PREFERENCE_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormRow>
                  <FormRow label={t('advanced.readPreferenceTags')} htmlFor="adv-read-tags">
                    <textarea
                      id="adv-read-tags"
                      rows={2}
                      value={editorState.readPreferenceTags}
                      disabled={editorState.readPreference === 'primary'}
                      onChange={e => setEditorState(prev => ({ ...prev, readPreferenceTags: e.target.value }))}
                      placeholder={'dc:ny,rack:1\n{}'}
                      className="w-full resize-y rounded-md border border-input bg-background px-3 py-1 font-mono text-ui-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <p className="m-0 text-[10px] text-muted-foreground">{t('advanced.readPreferenceTagsHelp')}</p>
                  </FormRow>

                  <h4 className={sectionHeadingClass}>{t('advanced.timeoutsSection')}</h4>
                  {([
                    ['maxIdleTime', t('advanced.maxIdleTime'), '0'],
                    ['maxPoolSize', t('advanced.maxPoolSize'), '100'],
                    ['serverSelectionTimeout', t('advanced.serverSelectionTimeout'), '30000'],
                    ['socketTimeout', t('advanced.socketTimeout'), '0'],
                    ['connectTimeout', t('advanced.connectTimeout'), '10000'],
                    ['appName', t('advanced.appName'), 'MQLens'],
                  ] as const).map(([field, label, placeholder]) => (
                    <FormRow key={field} label={label} htmlFor={`adv-${field}`}>
                      <Input
                        id={`adv-${field}`}
                        type="text"
                        inputMode={field === 'appName' ? undefined : 'numeric'}
                        value={editorState[field]}
                        onChange={e => setEditorState(prev => ({ ...prev, [field]: e.target.value }))}
                        placeholder={placeholder}
                        className={field === 'appName' ? undefined : 'font-mono'}
                      />
                    </FormRow>
                  ))}
                  <FormRow>
                    <label className="flex items-center gap-2 pt-1 text-[11px]">
                      <input
                        type="checkbox"
                        id="adv-load-balanced"
                        checked={editorState.loadBalanced}
                        onChange={e => setEditorState(prev => ({ ...prev, loadBalanced: e.target.checked }))}
                      />
                      <span>{t('advanced.loadBalanced')}</span>
                    </label>
                  </FormRow>

                  <h4 className={sectionHeadingClass}>{t('advanced.writesSection')}</h4>
                  {([
                    ['retryWrites', t('advanced.retryWrites'), 'retry-writes-select'],
                    ['journal', t('advanced.journal'), 'journal-select'],
                  ] as const).map(([field, label, testId]) => (
                    <FormRow key={field} label={label}>
                      <Select value={editorState[field]} onValueChange={(v) => setEditorState(prev => ({ ...prev, [field]: v }))}>
                        <SelectTrigger data-testid={testId} className="h-8 text-xs" aria-label={label}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={NESTED_SELECT_Z}>
                          <SelectItem value="default">{t('advanced.driverDefault')}</SelectItem>
                          <SelectItem value="true">{t('advanced.on')}</SelectItem>
                          <SelectItem value="false">{t('advanced.off')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormRow>
                  ))}
                  <FormRow label={t('advanced.writeConcernW')} htmlFor="adv-w">
                    <Input
                      id="adv-w"
                      type="text"
                      value={editorState.writeConcernW}
                      onChange={e => setEditorState(prev => ({ ...prev, writeConcernW: e.target.value }))}
                      placeholder="majority"
                      className="font-mono"
                    />
                  </FormRow>
                  <FormRow label={t('advanced.wtimeout')} htmlFor="adv-wtimeout">
                    <Input
                      id="adv-wtimeout"
                      type="text"
                      inputMode="numeric"
                      value={editorState.wtimeout}
                      onChange={e => setEditorState(prev => ({ ...prev, wtimeout: e.target.value }))}
                      placeholder="0"
                      className="font-mono"
                    />
                  </FormRow>

                  <div className="border-t border-border" />
                  <FormRow label={t('advanced.extraOptions')} htmlFor="adv-extra">
                    <Input
                      id="adv-extra"
                      type="text"
                      value={editorState.extraOptions}
                      onChange={e => setEditorState(prev => ({ ...prev, extraOptions: e.target.value }))}
                      placeholder="maxConnecting=2&zlibCompressionLevel=6"
                      className="font-mono"
                    />
                    <p className="m-0 text-[10px] text-muted-foreground">{t('advanced.extraOptionsHelp')}</p>
                  </FormRow>
                </>
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
                  {testSteps.map((step) => (
                    <div key={step.key} data-testid={`test-step-${step.key}`} data-status={step.status} className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between text-[11px]">
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
                      {step.status === 'failed' && step.message && (
                        <div className="pl-0.5 text-[10px] text-destructive">{describeConnectError(step.message, t)}</div>
                      )}
                    </div>
                  ))}
                </div>

                {testing && testSteps.find((s) => s.key === 'authenticate')?.status === 'running' && (
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" data-testid="test-cancel-login" onClick={handleCancelTestLogin}>
                      {t('test.cancelLogin')}
                    </Button>
                    <Button type="button" variant="outline" size="sm" data-testid="test-reopen-login" onClick={handleReopenTestLogin}>
                      {t('test.openBrowserAgain')}
                    </Button>
                  </div>
                )}

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
                              {describeConnectError(testResult.message ?? '', t)}
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
                      {describeConnectError(connectError, t)}
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
                {/* The tabs are hidden under the offer, so the URI it connected
                    to, and To URI, stay reachable here. */}
                <div className="ml-[18px] mt-1.5 flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-ui-2xs text-muted-foreground">{maskUriPassword(buildUri(editorState))}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 text-ui-2xs"
                    data-testid="editor-export-uri-btn"
                    onClick={() => openExportDialog(buildUri(editorState), editorState.sshEnabled)}
                  >
                    <ExternalLink size={11} />
                    <span>{t('form.toUri')}</span>
                  </Button>
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
                    {connectLoginId && (
                      <>
                        <Button type="button" variant="outline" size="sm" data-testid="connect-cancel-login" onClick={handleCancelConnectLogin}>
                          {t('test.cancelLogin')}
                        </Button>
                        <Button type="button" variant="outline" size="sm" data-testid="connect-reopen-login" onClick={handleReopenConnectLogin}>
                          {t('test.openBrowserAgain')}
                        </Button>
                      </>
                    )}
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
            {srvExportUris.length > 0 && (
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label htmlFor="export-seed-list" className="text-ui-xs">{t('export.seedList')}</Label>
                  <p className="text-ui-2xs text-muted-foreground">{t('export.seedListDescription')}</p>
                </div>
                <Switch
                  id="export-seed-list"
                  checked={exportSeedList}
                  onCheckedChange={(on) => void toggleSeedList(on)}
                  data-testid="export-seed-list"
                />
              </div>
            )}
            {seedError && (
              <p className="text-ui-2xs text-destructive" role="alert">{seedError}</p>
            )}
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
              disabled={seedPending}
              onClick={handleExportSave}
            >
              {t('export.saveToFile')}
            </Button>
            <Button
              size="sm"
              data-testid="export-copy-btn"
              disabled={seedPending}
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

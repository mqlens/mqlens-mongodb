import React, { useState, useEffect, useMemo } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { buildExportUri, findMongoUriInText } from '@/lib/connection';
import { useDialogs } from './dialogs/DialogProvider';
import { PasswordInput } from './PasswordInput';
import { useEscapeClose } from '../lib/useEscapeClose';
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
    | { type: 'key'; path: string; passphrase?: string };
};

interface ConnectionProfile {
  id: string;
  name: string;
  uri: string;
  color_tag?: string | null;
  ssh?: SshConfig | null;
}

interface ConnectionManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (id: string, name: string, uri: string, profileId: string, colorTag?: string | null) => void;
  activeConnections?: { id: string; profileId: string; name: string; uri: string }[];
}

interface TestStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed';
}

const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
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
  name: 'New Connection',
  folder: '',
  colorTag: '',
};

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

const ConnectionColorDot = ({ color, className }: { color?: string | null; className?: string }) =>
  color ? (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
      title="Connection color"
      data-testid="connection-color-dot"
    />
  ) : null;

const TABS = [
  { id: 'server', label: 'Server', icon: Server },
  { id: 'auth', label: 'Authentication', icon: ShieldAlert },
  { id: 'tls', label: 'TLS / SSL', icon: ShieldAlert },
  { id: 'ssh', label: 'SSH Tunnel', icon: ExternalLink },
  { id: 'proxy', label: 'Proxy', icon: RefreshCw },
  { id: 'adv', label: 'Advanced', icon: LayoutGrid },
];

// Replace the password in a mongodb URI (//user:PASSWORD@host) with dots, so the
// connection string can be shown without exposing the credential.
export const maskUriPassword = (uri: string): string =>
  uri.replace(/(\/\/[^/:@\s]+:)([^@/\s]+)(@)/, (_m, a, _p, c) => `${a}••••••${c}`);

// Turn a raw mongodb driver error (often a huge "server selection timeout" with
// the full topology dump) into a concise root-cause headline + actionable hint.
// TLS/auth/refused/DNS are checked first because those causes are usually buried
// inside the topology of a wrapping "server selection timeout".
export const summarizeConnectionError = (raw: string): { summary: string; hint?: string } => {
  const e = (raw || '').toLowerCase();
  if (/invalid peer certificate|unknownissuer|certnotvalidfor|certificate verify failed|self.?signed/.test(e))
    return {
      summary: 'TLS certificate not trusted.',
      hint: 'Provide the cluster’s CA file under TLS, or enable “Allow invalid certificates” for self-signed / dev clusters.',
    };
  if (/authentication failed|\(18\)|bad auth|authenticationfailed/.test(e))
    return { summary: 'Authentication failed.', hint: 'Check the username, password, and authentication database.' };
  if (/connection refused|os error 61|os error 111|actively refused/.test(e))
    return { summary: 'Connection refused.', hint: 'Is the server running and the host/port reachable from this machine?' };
  if (/failed to lookup|name or service not known|no such host|nodename nor servname|dns error/.test(e))
    return { summary: 'Host not found (DNS lookup failed).', hint: 'Check the hostname; for private hosts you may need an SSH tunnel.' };
  if (/server selection timeout|no available servers|no suitable servers/.test(e))
    return {
      summary: 'Couldn’t reach any server (selection timed out).',
      hint: 'Check the host/port and TLS settings, and that this machine can reach the cluster.',
    };
  if (/timed out|timeout/.test(e)) return { summary: 'Connection timed out.' };
  const firstLine = (raw || 'Connection failed').replace(/^kind:\s*/i, '').split(/\n|\. /)[0].trim();
  return { summary: firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine };
};

// Parse a mongodb URI into structured editor fields so the form (protocol / hosts
// / auth / TLS) can be edited interactively, auto-detecting the deployment type.
// Used both when editing a saved profile and when importing a pasted URI.
export const parseUriIntoFields = (uri: string) => {
  const isSrv = /^mongodb\+srv:\/\//i.test(uri);
  const m = uri.match(/mongodb(?:\+srv)?:\/\/(?:([^:@]+):([^@]*)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?/i);
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
    if (authUser) authMethod = 'scram-256';
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
  } else if (s.authMethod !== 'none' && s.authDb && s.authDb !== 'admin') {
    params.push(`authSource=${s.authDb}`);
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
export const buildSshConfig = (s: typeof BLANK_CONN): SshConfig | null => {
  if (!s.sshEnabled || !s.sshHost) return null;
  const auth =
    s.sshAuth === 'password'
      ? { type: 'password' as const, password: s.sshPass }
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
  // Export-URI dialog: the URI being exported and whether the source profile
  // has an SSH tunnel (which can't be represented in a mongodb:// URI).
  const [exportDialog, setExportDialog] = useState<{ uri: string; hasSsh: boolean } | null>(null);
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
    { name: 'Parse Connection URI', status: 'running' },
    { name: 'Resolve Host & Port', status: 'pending' },
    { name: 'Initialize Driver Client', status: 'pending' },
    { name: 'Verify Connection (Ping)', status: 'pending' },
  ]);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showErrDetail, setShowErrDetail] = useState(false);

  // Initialize folders and load connection profiles
  useEffect(() => {
    if (isOpen) {
      loadProfiles();
      loadFoldersFromStorage();
    }
  }, [isOpen]);

  // Escape closes the topmost layer: the nested editor dialog when it is
  // open, otherwise the manager itself.
  useEscapeClose(isOpen && showEditDialog, () => setShowEditDialog(false));
  useEscapeClose(isOpen && !showEditDialog, onClose);

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
          sshAuth: ssh.auth.type === 'password' ? 'password' : 'key',
          sshKey: ssh.auth.type === 'key' ? ssh.auth.path : '',
          sshPass:
            ssh.auth.type === 'password'
              ? ssh.auth.password
              : ssh.auth.passphrase || '',
        }
      : {};

    setEditorState({
      ...BLANK_CONN,
      name: profile.name,
      uri: profile.uri,
      ...parsed,
      folder: profileFolderMap[profile.id] || '',
      colorTag: profile.color_tag || '',
      ...sshFields,
    });

    setError(null);
    setTestResult(null);
    setTesting(false);
    setActiveEditorTab('server');
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
    });
    setError(null);
    setTestResult(null);
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
      setFolderError('Folder name is required');
      return;
    }
    const folderExists = folders.some((folder) => folder.name.toLowerCase() === folderName.toLowerCase());
    if (folderExists) {
      setFolderError('A folder with this name already exists');
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

  const handleSave = async () => {
    if (!editorState.name.trim()) {
      setError('Display Name is required');
      return;
    }

    const uriToSave = buildUri(editorState);
    const id = editMode === 'edit' && selectedId ? selectedId : generateUUID();
    const profile: ConnectionProfile = {
      id,
      name: editorState.name,
      uri: uriToSave,
      ssh: buildSshConfig(editorState),
      color_tag: editorState.colorTag
        ? normalizeHexColor(editorState.colorTag) ?? editorState.colorTag
        : null,
    };

    setLoading(true);
    try {
      await invoke('save_connection_profile', { profile });
      
      // Update profile folder mapping
      const updatedMap = { ...profileFolderMap, [id]: editorState.folder };
      saveFoldersToStorage(folders, updatedMap);

      setShowEditDialog(false);
      await loadProfiles();
      setSelectedId(id);
    } catch (err: any) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (profileId: string) => {
    if (
      !(await confirm({
        title: 'Delete connection profile',
        message: 'Are you sure you want to delete this connection profile?',
        confirmLabel: 'Delete',
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
      setError('This connection is already active');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const connId = await invoke<string>('connect_db', { uri: profile.uri, ssh: profile.ssh ?? null });
      onConnect(connId, profile.name, profile.uri, profile.id, profile.color_tag ?? undefined);
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
        title: 'Select certificate file',
        filters: [
          { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'key', 'p12', 'pfx'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (typeof path === 'string') setEditorState(prev => ({ ...prev, [field]: path }));
    } catch {
      /* user cancelled */
    }
  };

  // Apply an imported connection string → auto-detect protocol, hosts, auth,
  // and topology. Accepts free-form text (a .env line, a note) and extracts
  // the first mongodb:// / mongodb+srv:// URI from it.
  const applyImportedUri = (raw: string | null | undefined, sourceHint: string) => {
    const found = raw ? findMongoUriInText(raw) : null;
    if (!found) {
      setImportError(`No mongodb:// or mongodb+srv:// connection string found ${sourceHint}.`);
      return;
    }
    setImportError(null);
    setEditorState(prev => ({ ...prev, uri: found, ...parseUriIntoFields(found) }));
    setActiveEditorTab('server');
  };

  const handleImportFromClipboard = async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      applyImportedUri(text, 'in the clipboard');
    } catch {
      setImportError('Could not read the clipboard.');
    }
  };

  const handleImportFromFile = async () => {
    try {
      const path = await open({ multiple: false, title: 'Import connection URI from file' });
      if (typeof path !== 'string') return;
      const text = await readTextFile(path);
      applyImportedUri(text, `in ${path.split(/[\\/]/).pop()}`);
    } catch {
      setImportError('Could not read the selected file.');
    }
  };

  // Manual paste fallback (the original Import URI dialog).
  const handleImportUri = async () => {
    const uri = await prompt({
      title: 'Import Connection URI',
      message: `Paste a mongodb:// or mongodb+srv:// connection string. Protocol, hosts, auth, TLS, and topology are detected automatically. (${formatShortcut(shortcutById('submit-dialog')!)} to import)`,
      placeholder: 'mongodb://user:pass@host1:27017,host2:27017/?replicaSet=rs0&tls=true',
      confirmLabel: 'Import',
      multiline: true,
      validate: (v) => (/^mongodb(\+srv)?:\/\//i.test(v.trim()) ? null : 'Enter a mongodb:// or mongodb+srv:// URI'),
    });
    if (!uri || !uri.trim()) return;
    setImportError(null);
    const clean = uri.trim();
    setEditorState(prev => ({ ...prev, uri: clean, ...parseUriIntoFields(clean) }));
    setActiveEditorTab('server');
  };

  // Export a URI with the password stripped by default (SSH/proxy secrets too);
  // the toggles opt back into secrets or drop the settings query entirely.
  const openExportDialog = (uri: string, hasSsh: boolean) => {
    setExportIncludePassword(false);
    setExportIncludeSettings(true);
    setExportDialog({ uri, hasSsh });
  };

  const exportPreview = exportDialog
    ? buildExportUri(exportDialog.uri, {
        includePassword: exportIncludePassword,
        includeSettings: exportIncludeSettings,
      })
    : '';

  const handleExportSave = async () => {
    if (!exportDialog) return;
    try {
      const path = await save({ defaultPath: 'connection-uri.txt', title: 'Save connection URI' });
      if (!path) return;
      await writeTextFile(path, `${exportPreview}\n`);
      setExportDialog(null);
    } catch {
      /* user cancelled or write failed — keep the dialog open */
    }
  };

  const runTestStepSequence = async () => {
    setTesting(true);
    setTestResult(null);
    setShowErrDetail(false);
    setTestProgress(0);

    const steps: TestStep[] = [
      { name: 'Parse Connection URI', status: 'pending' },
      { name: 'Resolve Host & Port', status: 'pending' },
      { name: 'Initialize Driver Client', status: 'pending' },
      { name: 'Verify Connection (Ping)', status: 'pending' },
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
      setTestResult({ success: true, message: 'Connection test successful' });
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
              <h2 className="text-sm font-semibold leading-tight text-foreground">Connection Manager</h2>
              <p className="truncate text-ui-xs text-muted-foreground">Manage saved MongoDB profiles and folders</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="Close">
            <X size={14} />
          </Button>
        </header>

        {/* Toolbar */}
        <section className="flex shrink-0 flex-row flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={handleNewClick} aria-label="New...">
            <Plus size={12} className="text-primary" />
            <span>New...</span>
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={handleNewFolderClick}>
            <FolderPlus size={12} className="text-warning" />
            <span>New Folder</span>
          </Button>
          {selectedId && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={() => handleEditClick(selectedId)}>
                <Edit3 size={12} className="text-primary" />
                <span>Edit</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" onClick={() => handleDuplicateClick(selectedId)}>
                <Copy size={12} className="text-muted-foreground" />
                <span>Duplicate</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs text-destructive hover:text-destructive" onClick={() => handleDelete(selectedId)}>
                <Trash2 size={12} />
                <span>Delete</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-ui-xs" data-testid="export-uri-btn" onClick={() => {
                if (selectedProfile) openExportDialog(selectedProfile.uri, !!selectedProfile.ssh?.enabled);
              }}>
                <ExternalLink size={12} />
                <span>Export URI</span>
              </Button>
            </>
          )}
        </section>

        {/* Content splits */}
        <div className="flex min-h-0 flex-1">
          {/* Left profile explorer tree */}
          <aside className={cn(sidebarPanelClass, 'w-[min(280px,34%)]')}>
            <div className="shrink-0 space-y-2 border-b border-sidebar-border px-3 py-3">
              <div className="relative flex items-center">
                <Search size={13} className="absolute left-2.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search connections..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="h-8 border-sidebar-border bg-background/80 pl-8 text-ui-xs"
                />
              </div>
              <Select value={folderFilter} onValueChange={setFolderFilter}>
                <SelectTrigger data-testid="folder-filter-select" className="h-8 w-full border-sidebar-border bg-background/80 text-ui-xs">
                  <SelectValue placeholder="All folders" />
                </SelectTrigger>
                <SelectContent className={NESTED_SELECT_Z}>
                  <SelectItem value="all">All Folders</SelectItem>
                  <SelectItem value="root">(root)</SelectItem>
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
                              <span className="min-w-0 truncate">{p.name || 'Unnamed connection'}</span>
                              {isActive && (
                                <Badge variant="success" className="ml-auto h-4 px-1 text-ui-2xs" title="Connected">
                                  ●
                                </Badge>
                              )}
                            </div>
                          );
                        })}
                        {folderProfiles.length === 0 && (
                          <div className="pl-4 text-ui-2xs italic text-muted-foreground">Empty folder</div>
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
                    <span className="min-w-0 truncate">{p.name || 'Unnamed connection'}</span>
                    {isActive && (
                      <Badge variant="success" className="ml-auto h-4 px-1 text-ui-2xs" title="Connected">
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
                      <p className="text-ui-xs text-muted-foreground">Connection profile</p>
                    </div>
                  </div>

                  <div className="mb-4 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-ui-2xs uppercase tracking-wide text-muted-foreground">Connection URI</Label>
                      {maskUriPassword(selectedProfile.uri) !== selectedProfile.uri && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => setRevealDetailUri(v => !v)}
                          title={revealDetailUri ? 'Hide password' : 'Show password'}
                          aria-label={revealDetailUri ? 'Hide password' : 'Show password'}
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
                    <Label className="text-ui-2xs uppercase tracking-wide text-muted-foreground">Connection Metadata</Label>
                    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 text-ui-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Status:</span>
                        <span className="font-medium">
                          {activeConnections.some(c => c.profileId === selectedProfile.id) ? 'Connected (Active)' : 'Disconnected'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Profile ID:</span>
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
                    aria-label={activeConnections.some(c => c.profileId === selectedProfile.id) ? "Already Connected" : loading ? "Connecting..." : "Connect"}
                  >
                    <Play size={11} fill="currentColor" />
                    <span>{activeConnections.some(c => c.profileId === selectedProfile.id) ? "Already Connected" : loading ? "Connecting..." : "Connect"}</span>
                  </Button>
                  <Button variant="outline" size="sm" onClick={onClose}>
                    Close
                  </Button>
                </footer>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                  <Server size={28} className="text-muted-foreground" />
                </div>
                <span className="max-w-sm text-ui-xs leading-relaxed">Select a connection from the sidebar, or choose &quot;New…&quot; in the toolbar to create one.</span>
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
                <DialogTitle className="text-sm">New Folder</DialogTitle>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="Close folder dialog" onClick={() => setShowFolderDialog(false)}>
                <X size={13} />
              </Button>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <Label htmlFor="new-folder-name">Folder Name</Label>
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
              <Button type="button" variant="outline" onClick={() => setShowFolderDialog(false)}>Cancel</Button>
              <Button type="submit">
                <Check size={11} />
                <span>Create</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
        </DialogPortal>
      </Dialog>

      {/* Editor Dialog nested modal */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
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
                    {editMode === 'new' ? 'New Connection' : editMode === 'duplicate' ? 'Duplicate Connection' : 'Edit Connection'}
                  </h2>
                  <p className="truncate text-ui-xs text-muted-foreground">Configure server, auth, TLS, and advanced options</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowEditDialog(false)} aria-label="Close">
                <X size={14} />
              </Button>
            </header>

            {/* Dialog Meta details */}
            <section className="shrink-0 space-y-2 border-b border-border bg-muted/20 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="connection-name" className="shrink-0 text-ui-xs">Display Name</Label>
                <Input
                  id="connection-name"
                  type="text"
                  value={editorState.name}
                  onChange={e => setEditorState(prev => ({ ...prev, name: e.target.value }))}
                  className="h-8 min-w-[160px] flex-1 text-ui-xs"
                />

                <Label htmlFor="folder-select" className="shrink-0 text-ui-xs">Folder</Label>
                <Select value={editorState.folder || '__root__'} onValueChange={(v) => setEditorState(prev => ({ ...prev, folder: v === '__root__' ? '' : v }))}>
                  <SelectTrigger id="folder-select" className="h-8 w-[140px] text-ui-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={NESTED_SELECT_Z}>
                    <SelectItem value="__root__">(root)</SelectItem>
                    {folders.map(f => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Label className="shrink-0 text-ui-xs">Color tag</Label>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Connection color tag">
                  <button
                    type="button"
                    data-testid="color-swatch-none"
                    title="No color"
                    aria-label="No color"
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
                      title={swatch.label}
                      aria-label={swatch.label}
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
                    title="Pick a custom color"
                  >
                    <Pipette size={11} className="pointer-events-none shrink-0" aria-hidden="true" />
                    <span className="pointer-events-none">Custom</span>
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
                      aria-label="Pick a custom color"
                      value={colorInputValue(editorState.colorTag)}
                      onChange={(e) => setEditorState((prev) => ({ ...prev, colorTag: e.target.value }))}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <Badge variant="secondary" className="shrink-0 text-ui-2xs">URI</Badge>
                <code className="min-w-0 flex-1 truncate font-mono text-ui-2xs text-muted-foreground">{maskUriPassword(buildUri(editorState))}</code>
                <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 gap-1 text-ui-2xs" data-testid="editor-export-uri-btn" onClick={() => openExportDialog(buildUri(editorState), editorState.sshEnabled)}>
                  <Copy size={12} />
                  <span>Export…</span>
                </Button>
              </div>
            </section>

            <div className="flex min-h-0 flex-1">
            <aside className={cn(sidebarPanelClass, 'w-48 xl:w-52')}>
              <nav className="flex flex-col gap-0.5 p-2" aria-label="Connection settings sections">
                {TABS.map(t => {
                  const TabIcon = t.icon;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setActiveEditorTab(t.id)}
                      className={sidebarNavButtonClass(activeEditorTab === t.id)}
                    >
                      <TabIcon className={cn('h-4 w-4 shrink-0', activeEditorTab === t.id ? 'text-primary' : '')} />
                      <span className="truncate">{t.label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            {/* Editor dialog body views */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <ScrollArea className="min-h-0 flex-1">
            <div className="p-6">
              {activeEditorTab === 'server' && (
                <div className="flex flex-col gap-2.5">
                  {editorState.topology === 'uri' && (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="connection-uri">Connection URI</Label>
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
                              aria-label={revealUri ? 'Hide password' : 'Show password'}
                              title={revealUri ? 'Hide password' : 'Show password to edit'}
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
                      title="Fill the Server and Auth form fields from this URI so you can edit them"
                    >
                      <LayoutGrid size={12} /> Parse into form fields
                    </Button>
                  </div>
                  )}

                  {editorState.topology !== 'uri' && (
                    <div className="flex flex-col gap-1">
                      <Label>
                        Host List {editorState.protocol === 'mongodb+srv' ? '(hostname only)' : '(host:port, comma-separated)'}
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
                        <Label>Protocol</Label>
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
                      <Label>Topology</Label>
                      <Select
                        value={editorState.topology}
                        onValueChange={(v) => setEditorState(prev => ({ ...prev, topology: v }))}
                      >
                        <SelectTrigger className="h-8 text-ui-xs" data-testid="topology-select">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={NESTED_SELECT_Z}>
                          <SelectItem value="standalone">Standalone / Direct</SelectItem>
                          <SelectItem value="replicaSet">Replica Set</SelectItem>
                          <SelectItem value="sharded">Sharded Cluster (mongos)</SelectItem>
                          <SelectItem value="uri">Full URI String Only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {editorState.topology === 'replicaSet' && (
                      <div className="flex flex-1 flex-col gap-1">
                        <Label>Replica Set Name</Label>
                        <Input
                          type="text"
                          value={editorState.replicaSetName}
                          onChange={e => setEditorState(prev => ({ ...prev, replicaSetName: e.target.value }))}
                          placeholder="rs0"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeEditorTab === 'auth' && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-col gap-1">
                    <Label>Authentication Method</Label>
                    <Select value={editorState.authMethod} onValueChange={(v) => setEditorState(prev => ({ ...prev, authMethod: v }))}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        <SelectItem value="none">None (Guest Access)</SelectItem>
                        <SelectItem value="scram-256">SCRAM-SHA-256 (Default)</SelectItem>
                        <SelectItem value="scram-1">SCRAM-SHA-1</SelectItem>
                        <SelectItem value="x509">x.509 Client Certificate</SelectItem>
                        <SelectItem value="aws">MONGODB-AWS (IAM)</SelectItem>
                        <SelectItem value="kerberos">GSSAPI (Kerberos)</SelectItem>
                        <SelectItem value="ldap">LDAP (PLAIN)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {editorState.authMethod !== 'none' && (() => {
                    const m = editorState.authMethod;
                    const isScram = m === 'scram-1' || m === 'scram-256';
                    const isExternal = m === 'x509' || m === 'aws' || m === 'kerberos' || m === 'ldap';
                    const userLabel =
                      m === 'aws' ? 'Access Key ID'
                      : m === 'kerberos' ? 'Principal'
                      : m === 'x509' ? 'Username (optional — derived from certificate)'
                      : 'Username';
                    const passLabel = m === 'aws' ? 'Secret Access Key' : 'Password';
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
                            <Label>Authentication Database</Label>
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
                          <Label>Session Token (optional)</Label>
                          <Input
                            type="text"
                            value={editorState.awsSessionToken}
                            onChange={e => setEditorState(prev => ({ ...prev, awsSessionToken: e.target.value }))}
                            placeholder="for temporary STS credentials"
                          />
                        </div>
                      )}

                      {m === 'kerberos' && (
                        <div className="flex flex-col gap-1">
                          <Label>Service Name (optional, default: mongodb)</Label>
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
                          Requires TLS with a client certificate (TLS tab).
                        </p>
                      )}
                      {isExternal && (
                        <p className="m-0 text-[10px] text-muted-foreground">
                          Authenticates against the <code>$external</code> database.
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
                    <Label>SSL / TLS Certificate Mode</Label>
                    <Select value={editorState.tlsMode} onValueChange={(v) => setEditorState(prev => ({ ...prev, tlsMode: v }))}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={NESTED_SELECT_Z}>
                        <SelectItem value="off">Off (Insecure Plaintext)</SelectItem>
                        <SelectItem value="system">System Root CA Certificates</SelectItem>
                        <SelectItem value="file">Custom CA File Upload</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {editorState.tlsMode === 'file' && (
                    <div className="flex flex-col gap-1 border-t border-border pt-2.5">
                      <Label>CA File Path</Label>
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
                          Browse…
                        </Button>
                      </div>
                    </div>
                  )}

                  {editorState.tlsMode !== 'off' && (
                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                      <Label>Certificate Validation</Label>
                      <label className="flex items-center gap-2 text-[11px]">
                        <input
                          type="checkbox"
                          checked={editorState.tlsAllowInvalidCerts}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsAllowInvalidCerts: e.target.checked }))}
                        />
                        <span>Allow invalid certificates <span className="text-destructive">(insecure)</span></span>
                      </label>
                      <label className="flex items-center gap-2 text-[11px]">
                        <input
                          type="checkbox"
                          checked={editorState.tlsAllowInvalidHosts}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsAllowInvalidHosts: e.target.checked }))}
                        />
                        <span>Allow invalid hostnames</span>
                      </label>
                      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
                        Disabling certificate validation exposes the connection to man-in-the-middle
                        attacks. Enable only for trusted/self-signed test servers.
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
                    <Label htmlFor="ssh-enable" className="text-[11px] font-medium">Enable SSH Tunnel Proxy Gateway</Label>
                  </div>

                  {editorState.sshEnabled && (
                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                      <div className="flex gap-2">
                        <div className="flex flex-[2] flex-col gap-1">
                          <Label>SSH Server Host</Label>
                          <Input
                            type="text"
                            value={editorState.sshHost}
                            onChange={e => setEditorState(prev => ({ ...prev, sshHost: e.target.value }))}
                            placeholder="ssh.server.com"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>SSH Port</Label>
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
                          <Label>SSH Username</Label>
                          <Input
                            type="text"
                            value={editorState.sshUser}
                            onChange={e => setEditorState(prev => ({ ...prev, sshUser: e.target.value }))}
                            placeholder="deploy"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>Auth Method</Label>
                          <Select value={editorState.sshAuth} onValueChange={(v) => setEditorState(prev => ({ ...prev, sshAuth: v }))}>
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={NESTED_SELECT_Z}>
                              <SelectItem value="key">Private Key</SelectItem>
                              <SelectItem value="password">Password</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {editorState.sshAuth === 'key' ? (
                        <>
                          <div className="flex flex-col gap-1">
                            <Label>Private Key Path</Label>
                            <Input
                              type="text"
                              value={editorState.sshKey}
                              onChange={e => setEditorState(prev => ({ ...prev, sshKey: e.target.value }))}
                              placeholder="~/.ssh/id_ed25519"
                              className="font-mono"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <Label>Key Passphrase (optional)</Label>
                            <PasswordInput
                              value={editorState.sshPass}
                              onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                              placeholder="Leave blank if the key is unencrypted"
                              className="font-mono"
                            />
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <Label>SSH Password</Label>
                          <PasswordInput
                            value={editorState.sshPass}
                            onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                            placeholder="••••••••"
                            className="font-mono"
                          />
                        </div>
                      )}

                      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
                        The SSH server's host key must be in <code>~/.ssh/known_hosts</code>. Credentials are
                        stored with the profile (plaintext); prefer key-based auth.
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
                    <Label htmlFor="proxy-enable" className="text-[11px] font-medium">Enable SOCKS5 Client Proxy</Label>
                  </div>
                  <p className="m-0 text-[10px] text-muted-foreground">
                    The MongoDB driver tunnels its connection through a SOCKS5 proxy. (HTTP proxies are not supported by the driver.)
                  </p>

                  {editorState.proxyEnabled && (
                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                      <div className="flex gap-2">
                        <div className="flex flex-[2] flex-col gap-1">
                          <Label>Proxy Host</Label>
                          <Input
                            type="text"
                            value={editorState.proxyHost}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyHost: e.target.value }))}
                            placeholder="proxy.internal"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>Proxy Port</Label>
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
                          <Label>Proxy Username (optional)</Label>
                          <Input
                            type="text"
                            value={editorState.proxyUser}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyUser: e.target.value }))}
                            placeholder="username"
                          />
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <Label>Proxy Password (optional)</Label>
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
                      <Label>Default Database</Label>
                      <Input
                        type="text"
                        value={editorState.defaultDb}
                        onChange={e => setEditorState(prev => ({ ...prev, defaultDb: e.target.value }))}
                        placeholder="test"
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-1">
                      <Label>BSON Compression</Label>
                      <Select value={editorState.compression} onValueChange={(v) => setEditorState(prev => ({ ...prev, compression: v }))}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={NESTED_SELECT_Z}>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="snappy">Snappy</SelectItem>
                          <SelectItem value="zlib">Zlib</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>
            </ScrollArea>

            {(testing || testResult) && (
              <div className="mx-4 mb-2 flex max-h-[200px] shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-ui-2xs uppercase tracking-wide text-muted-foreground">Connection Test Progress</Label>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] font-semibold text-primary">{testProgress}%</span>
                    {testResult && !testing && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        data-testid="test-dismiss"
                        aria-label="Dismiss test result"
                        title="Dismiss"
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
                      )}>{step.name}</span>
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
                  const info = testResult.success
                    ? { summary: testResult.message, hint: undefined as string | undefined }
                    : summarizeConnectionError(testResult.message);
                  return (
                    <div className={cn(
                      'rounded border p-2 text-[11px]',
                      testResult.success
                        ? 'border-success/30 bg-success/10 text-success'
                        : 'border-destructive/30 bg-destructive/10 text-destructive'
                    )}>
                      <div className="flex items-start gap-1.5">
                        {testResult.success ? <Check size={12} className="mt-px shrink-0" /> : <AlertCircle size={12} className="mt-px shrink-0" />}
                        <span className="font-semibold" data-testid="test-result-summary">{info.summary}</span>
                      </div>
                      {info.hint && (
                        <div className="ml-[18px] mt-1 font-normal text-muted-foreground">{info.hint}</div>
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
                            {showErrDetail ? 'Hide details' : 'Show details'}
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

            <footer className="flex shrink-0 items-center justify-between border-t border-border bg-muted/20 px-4 py-3">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={runTestStepSequence} disabled={testing}>
                  <RefreshCw size={11} className={testing ? 'animate-spin' : ''} />
                  <span>Test Connection</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" data-testid="import-uri-btn">
                      <ClipboardPaste size={11} />
                      <span>Import URI</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={handleImportFromClipboard} data-testid="import-from-clipboard">
                      From clipboard
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleImportFromFile} data-testid="import-from-file">
                      From a file…
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleImportUri} data-testid="import-paste-manually">
                      Paste manually…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {importError && (
                  <span className="self-center text-ui-2xs text-destructive" data-testid="import-uri-error">
                    {importError}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowEditDialog(false)}>Cancel</Button>
                <Button size="sm" onClick={handleSave} disabled={loading || testing}>
                  <Check size={11} />
                  <span>Save</span>
                </Button>
              </div>
            </footer>
            </div>
            </div>
        </DraggableDialogContent>
      </Dialog>

      <Dialog open={!!exportDialog} onOpenChange={(o) => !o && setExportDialog(null)}>
        <DialogContent className="max-w-lg" data-testid="export-uri-dialog">
          <DialogHeader>
            <DialogTitle>Export connection URI</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <code
              className="block break-all rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-ui-2xs"
              data-testid="export-uri-preview"
            >
              {exportPreview}
            </code>
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label htmlFor="export-include-password" className="text-ui-xs">Include password</Label>
                <p className="text-ui-2xs text-muted-foreground">
                  Off strips the auth password and proxy/token secrets so the URI is safe to share.
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
                <Label htmlFor="export-include-settings" className="text-ui-xs">Include connection settings</Label>
                <p className="text-ui-2xs text-muted-foreground">
                  TLS files, replica set, auth mechanism, appName, proxy, and timeouts.
                </p>
              </div>
              <Switch
                id="export-include-settings"
                checked={exportIncludeSettings}
                onCheckedChange={setExportIncludeSettings}
                data-testid="export-include-settings"
              />
            </div>
            {exportDialog?.hasSsh && (
              <p className="text-ui-2xs text-muted-foreground" data-testid="export-ssh-note">
                This connection uses an SSH tunnel. Tunnel settings can’t be represented in a
                MongoDB URI and are not exported.
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
              Save to file…
            </Button>
            <Button
              size="sm"
              data-testid="export-copy-btn"
              onClick={() => navigator.clipboard?.writeText(exportPreview)}
            >
              Copy to clipboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

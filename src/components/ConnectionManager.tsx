import React, { useState, useEffect, useMemo } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useDialogs } from './dialogs/DialogProvider';
import { PasswordInput } from './PasswordInput';
import {
  Plus, X, Server, Play, Edit3, Trash2, Check, AlertCircle, RefreshCw,
  Folder, FolderPlus, FolderOpen, Search, ChevronDown, ChevronRight,
  Copy, ExternalLink, ShieldAlert, Eye, EyeOff, LayoutGrid, ClipboardPaste
} from 'lucide-react';

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
  ssh?: SshConfig | null;
}

interface ConnectionManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (id: string, name: string, uri: string, profileId: string) => void;
  activeConnections?: { id: string; profileId: string; name: string; uri: string }[];
}

interface TestStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed';
}

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  shared?: boolean;
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
};

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

  const loadFoldersFromStorage = () => {
    try {
      const storedFolders = localStorage.getItem('mqlens_folders');
      const storedMap = localStorage.getItem('mqlens_profile_folders');
      
      let currentFolders: FolderNode[] = [];
      if (storedFolders) {
        currentFolders = JSON.parse(storedFolders);
      } else {
        // Initial Seed Folder
        currentFolders = [
          { id: 'local-resources', name: 'Local resources', parentId: null, shared: false }
        ];
        localStorage.setItem('mqlens_folders', JSON.stringify(currentFolders));
      }
      setFolders(currentFolders);

      // Default expand local resources
      setExpandedFolders(prev => ({ 'local-resources': true, ...prev }));

      if (storedMap) {
        setProfileFolderMap(JSON.parse(storedMap));
      } else {
        setProfileFolderMap({});
      }
    } catch (err) {
      console.error('Failed to load connection folders', err);
    }
  };

  const saveFoldersToStorage = (updatedFolders: FolderNode[], updatedMap: Record<string, string>) => {
    try {
      localStorage.setItem('mqlens_folders', JSON.stringify(updatedFolders));
      localStorage.setItem('mqlens_profile_folders', JSON.stringify(updatedMap));
      setFolders(updatedFolders);
      setProfileFolderMap(updatedMap);
    } catch (err) {
      console.error('Failed to save connection folders', err);
    }
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
      onConnect(connId, profile.name, profile.uri, profile.id);
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

  // Paste a connection string → auto-detect protocol, hosts, auth, and topology.
  const handleImportUri = async () => {
    const uri = await prompt({
      title: 'Import Connection URI',
      message: 'Paste a mongodb:// or mongodb+srv:// connection string. Protocol, hosts, auth, TLS, and topology are detected automatically. (⌘/Ctrl+Enter to import)',
      placeholder: 'mongodb://user:pass@host1:27017,host2:27017/?replicaSet=rs0&tls=true',
      confirmLabel: 'Import',
      multiline: true,
      validate: (v) => (/^mongodb(\+srv)?:\/\//i.test(v.trim()) ? null : 'Enter a mongodb:// or mongodb+srv:// URI'),
    });
    if (!uri || !uri.trim()) return;
    const clean = uri.trim();
    setEditorState(prev => ({ ...prev, uri: clean, ...parseUriIntoFields(clean) }));
    setActiveEditorTab('server');
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

  if (!isOpen) return null;

  return (
    <div className="modal-overlay mql-modal-overlay" onClick={onClose}>
      <div className="modal-container mql-ncd" style={{ width: '820px', height: '620px', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <header className="mql-ncd-titlebar">
          <div className="mql-row" style={{ gap: 8 }}>
            <Server size={14} className="text-[var(--accent-blue)]" />
            <span style={{ fontSize: 12, fontWeight: 600 }}>Connection Manager</span>
          </div>
          <button onClick={onClose} className="mql-icon-btn" aria-label="Close">
            <X size={13} />
          </button>
        </header>

        {/* Toolbar */}
        <section style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'row', gap: 6, alignItems: 'center', background: 'var(--bg-panel)', flexShrink: 0 }}>
          <button className="mql-btn mql-btn-ghost mql-btn-outlined" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={handleNewClick} aria-label="New...">
            <Plus size={11} className="mr-1 text-[var(--accent-blue)]" />
            <span>New...</span>
          </button>
          <button className="mql-btn mql-btn-ghost mql-btn-outlined" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={handleNewFolderClick}>
            <FolderPlus size={11} className="mr-1 text-[var(--accent-amber)]" />
            <span>New Folder</span>
          </button>
          {selectedId && (
            <>
              <div className="mql-ctx-sep" style={{ height: '16px', margin: '0 4px', width: '1px', background: 'var(--border-color)' }} />
              <button className="mql-btn mql-btn-ghost mql-btn-outlined" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={() => handleEditClick(selectedId)}>
                <Edit3 size={11} className="mr-1 text-[var(--accent-blue)]" />
                <span>Edit</span>
              </button>
              <button className="mql-btn mql-btn-ghost mql-btn-outlined" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={() => handleDuplicateClick(selectedId)}>
                <Copy size={11} className="mr-1 text-[var(--accent-teal)]" />
                <span>Duplicate</span>
              </button>
              <button className="mql-btn mql-btn-ghost mql-btn-outlined mql-btn-danger" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={() => handleDelete(selectedId)}>
                <Trash2 size={11} className="mr-1 text-[var(--accent-red)]" />
                <span>Delete</span>
              </button>
              <button className="mql-btn mql-btn-ghost mql-btn-outlined" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={() => {
                if (selectedProfile) navigator.clipboard?.writeText(selectedProfile.uri);
              }}>
                <ExternalLink size={11} className="mr-1" />
                <span>Copy URI</span>
              </button>
            </>
          )}
        </section>

        {/* Filter Input */}
        <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-input-blend)' }}>
          <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, color: 'var(--text-dim)' }} />
            <input 
              type="text" 
              placeholder="Search connections..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ width: '100%', padding: '4px 8px 4px 26px', fontSize: 11, background: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-main)' }}
            />
          </div>
          <div className="mql-ncd-select-wrap" style={{ width: 140 }}>
            <select 
              className="mql-ncd-select" 
              value={folderFilter} 
              onChange={e => setFolderFilter(e.target.value)}
              style={{ fontSize: 11, padding: '4px 8px' }}
            >
              <option value="all">All Folders</option>
              <option value="root">(root)</option>
              {folders.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <ChevronDown size={10} color="var(--text-dim)" style={{ right: 8 }} />
          </div>
        </div>

        {/* Content splits */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Left profile explorer tree */}
          <div style={{ width: '280px', borderRight: '1px solid var(--border-color)', overflowY: 'auto', padding: '6px', background: 'var(--bg-sidebar)' }}>
            <div className="mql-tree-scroll">
              {folders.map(folder => {
                const isExpanded = expandedFolders[folder.id];
                const folderProfiles = filteredProfiles.filter(p => profileFolderMap[p.id] === folder.id);

                return (
                  <div key={folder.id} className="mql-tree-node">
                    <div 
                      className="mql-row-h mql-tree-row"
                      style={{ padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                      onClick={() => toggleFolderExpand(folder.id)}
                    >
                      <ChevronRight 
                        size={11} 
                        className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} 
                        style={{ color: 'var(--text-dim)', flexShrink: 0 }} 
                      />
                      {isExpanded ? (
                        <FolderOpen size={12} className="text-[var(--accent-amber)]" />
                      ) : (
                        <Folder size={12} className="text-[var(--accent-amber)]" />
                      )}
                      <span className="mql-folder-label" style={{ fontWeight: 500 }}>{folder.name}</span>
                      <span className="mql-count">({folderProfiles.length})</span>
                    </div>

                    {isExpanded && (
                      <div className="mql-tree-children" style={{ marginLeft: 16, borderLeft: '1px solid var(--tree-guide-color)', paddingLeft: 4 }}>
                        {folderProfiles.map(p => {
                          const isSel = p.id === selectedId;
                          const isActive = activeConnections.some(c => c.profileId === p.id);
                          return (
                            <div 
                              key={p.id}
                              className={`mql-row-h mql-tree-row mql-coll-row ${isSel ? 'is-active' : ''}`}
                              style={{ padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                              onClick={() => handleSelect(p.id)}
                              onDoubleClick={handleConnectClick}
                            >
                              <Server size={11} className={isSel ? 'text-[var(--accent-blue)]' : 'text-[var(--text-muted)]'} />
                              <span className="mql-coll-name" style={{ fontSize: '11px' }}>{p.name || 'Unnamed connection'}</span>
                              {isActive && <span className="mql-live-dot" title="Connected" />}
                            </div>
                          );
                        })}
                        {folderProfiles.length === 0 && (
                          <div style={{ fontSize: '10px', color: 'var(--text-dim)', paddingLeft: '20px', fontStyle: 'italic' }}>Empty folder</div>
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
                    className={`mql-row-h mql-tree-row mql-coll-row ${isSel ? 'is-active' : ''}`}
                    style={{ padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, margin: '2px 0' }}
                    onClick={() => handleSelect(p.id)}
                    onDoubleClick={handleConnectClick}
                  >
                    <Server size={11} className={isSel ? 'text-[var(--accent-blue)]' : 'text-[var(--text-muted)]'} />
                    <span className="mql-coll-name" style={{ fontSize: '11px' }}>{p.name || 'Unnamed connection'}</span>
                    {isActive && <span className="mql-live-dot" title="Connected" />}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right connection preview panel */}
          <div style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflowY: 'auto' }}>
            {selectedProfile ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', paddingBottom: 8, marginBottom: 12 }}>
                    <Server size={16} className="text-[var(--accent-blue)]" />
                    <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-main)' }}>{selectedProfile.name}</h3>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="mql-label" style={{ fontSize: 9 }}>Connection URI</span>
                      {maskUriPassword(selectedProfile.uri) !== selectedProfile.uri && (
                        <button
                          type="button"
                          onClick={() => setRevealDetailUri(v => !v)}
                          title={revealDetailUri ? 'Hide password' : 'Show password'}
                          aria-label={revealDetailUri ? 'Hide password' : 'Show password'}
                          style={{ display: 'inline-flex', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}
                        >
                          {revealDetailUri ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      )}
                    </div>
                    <div style={{ padding: 10, background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all', userSelect: 'text' }}>
                      {revealDetailUri ? selectedProfile.uri : maskUriPassword(selectedProfile.uri)}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span className="mql-label" style={{ fontSize: 9 }}>Connection Metadata</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: 'var(--bg-input-blend)', border: '1px solid var(--border-color)', borderRadius: 4, fontSize: 11 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Status:</span>
                        <span style={{ fontWeight: 500 }}>
                          {activeConnections.some(c => c.profileId === selectedProfile.id) ? 'Connected (Active)' : 'Disconnected'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Profile ID:</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{selectedProfile.id}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="text-rose-400 text-[10px] bg-rose-950/20 border border-rose-900/30 p-1.5 rounded truncate mb-3" style={{ fontSize: 11, padding: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertCircle size={12} />
                    <span>{error}</span>
                  </div>
                )}

                <footer style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button 
                    onClick={handleConnectClick}
                    disabled={loading || activeConnections.some(c => c.profileId === selectedProfile.id)}
                    className="mql-btn mql-btn-primary"
                    aria-label={activeConnections.some(c => c.profileId === selectedProfile.id) ? "Already Connected" : loading ? "Connecting..." : "Connect"}
                  >
                    <Play size={11} className="mr-1" fill="white" />
                    <span>{activeConnections.some(c => c.profileId === selectedProfile.id) ? "Already Connected" : loading ? "Connecting..." : "Connect"}</span>
                  </button>
                  <button 
                    onClick={onClose}
                    className="mql-btn mql-btn-ghost mql-btn-outlined"
                  >
                    Close
                  </button>
                </footer>
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', textAlign: 'center', padding: 16 }}>
                <Server size={32} style={{ marginBottom: 12, color: 'var(--border-color)' }} />
                <span style={{ fontSize: 11 }}>Select a connection profile from the tree sheet, or choose "New Connection" in the toolbar above to set one up.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {showFolderDialog && (
        <div
          className="mql-mini-overlay"
          onClick={(event) => {
            event.stopPropagation();
            setShowFolderDialog(false);
          }}
        >
          <form
            className="mql-mini"
            style={{ width: 360 }}
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              handleCreateFolder();
            }}
          >
            <header className="mql-mini-h">
              <div className="mql-row" style={{ gap: 8 }}>
                <FolderPlus size={14} className="text-[var(--accent-amber)]" />
                <span className="mql-mini-title">New Folder</span>
              </div>
              <button type="button" className="mql-icon-btn" aria-label="Close folder dialog" onClick={() => setShowFolderDialog(false)}>
                <X size={13} />
              </button>
            </header>
            <div className="mql-mini-body">
              <label htmlFor="new-folder-name" className="mql-label">Folder Name</label>
              <input
                id="new-folder-name"
                data-testid="new-folder-name-input"
                className="mql-ncd-input"
                value={newFolderName}
                onChange={(event) => {
                  setNewFolderName(event.target.value);
                  if (folderError) setFolderError(null);
                }}
                autoFocus
              />
              {folderError && (
                <div className="text-rose-400 text-[11px] bg-rose-950/20 border border-rose-900/30 p-1.5 rounded" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertCircle size={12} />
                  <span>{folderError}</span>
                </div>
              )}
            </div>
            <footer className="mql-mini-foot">
              <button type="button" className="mql-btn mql-btn-ghost mql-btn-outlined" onClick={() => setShowFolderDialog(false)}>Cancel</button>
              <button type="submit" className="mql-btn mql-btn-primary">
                <Check size={11} className="mr-1" />
                <span>Create</span>
              </button>
            </footer>
          </form>
        </div>
      )}

      {/* Editor Dialog nested modal */}
      {showEditDialog && (
        <div className="nested-modal-overlay mql-modal-overlay" style={{ zIndex: 110 }} onClick={() => setShowEditDialog(false)}>
          <div className="nested-modal-container mql-ncd" style={{ width: '680px', height: '520px', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            {/* Dialog Header */}
            <header className="mql-ncd-titlebar">
              <div className="mql-row" style={{ gap: 8 }}>
                <Server size={14} className="text-[var(--accent-blue)]" />
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {editMode === 'new' ? 'New Connection' : editMode === 'duplicate' ? 'Duplicate Connection' : 'Edit Connection'}
                </span>
              </div>
              <button className="mql-icon-btn" onClick={() => setShowEditDialog(false)}>
                <X size={13} />
              </button>
            </header>

            {/* Dialog Meta details */}
            <section className="mql-ncd-meta">
              <div className="mql-ncd-meta-row">
                <label htmlFor="connection-name" className="mql-label" style={{ fontSize: 10, marginRight: 8 }}>Display Name</label>
                <input 
                  id="connection-name"
                  type="text" 
                  value={editorState.name}
                  onChange={e => setEditorState(prev => ({ ...prev, name: e.target.value }))}
                  className="mql-ncd-input" 
                  style={{ flex: 1 }}
                />
                
                <label htmlFor="folder-select" className="mql-label" style={{ fontSize: 10, margin: '0 8px 0 12px' }}>Folder</label>
                <div className="mql-ncd-select-wrap" style={{ width: 140 }}>
                  <select 
                    id="folder-select"
                    className="mql-ncd-select" 
                    value={editorState.folder} 
                    onChange={e => setEditorState(prev => ({ ...prev, folder: e.target.value }))}
                  >
                    <option value="">(root)</option>
                    {folders.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                  <ChevronDown size={10} color="var(--text-dim)" />
                </div>
              </div>

              <div className="mql-ncd-uri-row">
                <span className="mql-ncd-uri-badge">URI</span>
                <code className="mql-ncd-uri">{maskUriPassword(buildUri(editorState))}</code>
                <button className="mql-ncd-copy" onClick={() => navigator.clipboard?.writeText(buildUri(editorState))}>
                  <Copy size={11} />
                  <span>Copy</span>
                </button>
              </div>
            </section>

            {/* Editor dialog tabs */}
            <nav className="mql-ncd-tabs">
              {TABS.map(t => {
                const TabIcon = t.icon;
                return (
                  <button
                    key={t.id}
                    className={`mql-ncd-tab ${activeEditorTab === t.id ? 'is-active' : ''}`}
                    onClick={() => setActiveEditorTab(t.id)}
                  >
                    <TabIcon size={12} style={{ marginRight: 4 }} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </nav>

            {/* Editor dialog body views */}
            <div className="mql-ncd-body" style={{ flex: 1, minHeight: 0, padding: 12, overflowY: 'auto' }}>
              {activeEditorTab === 'server' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {editorState.topology === 'uri' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label htmlFor="connection-uri" className="mql-label">Connection URI</label>
                    {(() => {
                      // Show the readable URI (protocol/host/db) with only the
                      // password masked. Focusing the field — or the eye — reveals
                      // the full string so it stays editable.
                      const masked = maskUriPassword(editorState.uri);
                      const hasSecret = masked !== editorState.uri;
                      const showMasked = hasSecret && !revealUri;
                      return (
                        <div className="mql-password-field">
                          <input
                            id="connection-uri"
                            type="text"
                            value={showMasked ? masked : editorState.uri}
                            readOnly={showMasked}
                            onFocus={() => { if (hasSecret) setRevealUri(true); }}
                            onChange={e => setEditorState(prev => ({ ...prev, uri: e.target.value, topology: 'uri' }))}
                            placeholder="mongodb://localhost:27017"
                            className="mql-ncd-input font-mono"
                          />
                          {hasSecret && (
                            <button
                              type="button"
                              className="mql-password-toggle"
                              aria-label={revealUri ? 'Hide password' : 'Show password'}
                              title={revealUri ? 'Hide password' : 'Show password to edit'}
                              onClick={() => setRevealUri(v => !v)}
                              tabIndex={-1}
                            >
                              {revealUri ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                    <button
                      type="button"
                      className="mql-ncd-parse-btn"
                      data-testid="parse-uri-btn"
                      disabled={!editorState.uri.trim()}
                      onClick={() => setEditorState(prev => ({ ...prev, ...parseUriIntoFields(prev.uri) }))}
                      title="Fill the Server and Auth form fields from this URI so you can edit them"
                    >
                      <LayoutGrid size={12} /> Parse into form fields
                    </button>
                  </div>
                  )}

                  {editorState.topology !== 'uri' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="mql-label">
                        Host List {editorState.protocol === 'mongodb+srv' ? '(hostname only)' : '(host:port, comma-separated)'}
                      </span>
                      <input
                        type="text"
                        data-testid="host-list"
                        value={hostsToText(editorState.hosts, editorState.protocol === 'mongodb+srv')}
                        onChange={e => setEditorState(prev => ({ ...prev, hosts: textToHosts(e.target.value) }))}
                        placeholder={editorState.protocol === 'mongodb+srv' ? 'cluster0.abcd.mongodb.net' : '172.18.19.60:27017, 172.18.19.61:27017'}
                        className="mql-ncd-input font-mono"
                      />
                    </div>
                  )}

                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 10, display: 'flex', gap: 12 }}>
                    {editorState.topology !== 'uri' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                        <span className="mql-label">Protocol</span>
                        <div className="mql-ncd-select-wrap">
                          <select
                            className="mql-ncd-select"
                            data-testid="protocol-select"
                            value={editorState.protocol}
                            onChange={e => setEditorState(prev => ({ ...prev, protocol: e.target.value }))}
                          >
                            <option value="mongodb">mongodb://</option>
                            <option value="mongodb+srv">mongodb+srv://</option>
                          </select>
                          <ChevronDown size={10} color="var(--text-dim)" />
                        </div>
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      <span className="mql-label">Topology</span>
                      <div className="mql-ncd-select-wrap">
                        <select
                          className="mql-ncd-select"
                          data-testid="topology-select"
                          value={editorState.topology}
                          onChange={e => setEditorState(prev => ({ ...prev, topology: e.target.value }))}
                        >
                          <option value="standalone">Standalone / Direct</option>
                          <option value="replicaSet">Replica Set</option>
                          <option value="sharded">Sharded Cluster (mongos)</option>
                          <option value="uri">Full URI String Only</option>
                        </select>
                        <ChevronDown size={10} color="var(--text-dim)" />
                      </div>
                    </div>

                    {editorState.topology === 'replicaSet' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                        <span className="mql-label">Replica Set Name</span>
                        <input 
                          type="text" 
                          value={editorState.replicaSetName}
                          onChange={e => setEditorState(prev => ({ ...prev, replicaSetName: e.target.value }))}
                          placeholder="rs0"
                          className="mql-ncd-input"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeEditorTab === 'auth' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="mql-label">Authentication Method</span>
                    <div className="mql-ncd-select-wrap">
                      <select 
                        className="mql-ncd-select" 
                        value={editorState.authMethod} 
                        onChange={e => setEditorState(prev => ({ ...prev, authMethod: e.target.value }))}
                      >
                        <option value="none">None (Guest Access)</option>
                        <option value="scram-256">SCRAM-SHA-256 (Default)</option>
                        <option value="scram-1">SCRAM-SHA-1</option>
                        <option value="x509">x.509 Client Certificate</option>
                        <option value="aws">MONGODB-AWS (IAM)</option>
                        <option value="kerberos">GSSAPI (Kerberos)</option>
                        <option value="ldap">LDAP (PLAIN)</option>
                      </select>
                      <ChevronDown size={10} color="var(--text-dim)" />
                    </div>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                          <span className="mql-label">{userLabel}</span>
                          <input
                            type="text"
                            value={editorState.authUser}
                            onChange={e => setEditorState(prev => ({ ...prev, authUser: e.target.value }))}
                            placeholder={m === 'aws' ? 'AKIA…' : m === 'kerberos' ? 'user@REALM' : 'admin'}
                            className="mql-ncd-input"
                          />
                        </div>
                        {isScram && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                            <span className="mql-label">Authentication Database</span>
                            <input
                              type="text"
                              value={editorState.authDb}
                              onChange={e => setEditorState(prev => ({ ...prev, authDb: e.target.value }))}
                              placeholder="admin"
                              className="mql-ncd-input"
                            />
                          </div>
                        )}
                      </div>

                      {showPasswordField && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className="mql-label">{passLabel}</span>
                          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                            <input
                              type={showPassword ? 'text' : 'password'}
                              value={editorState.authPass}
                              onChange={e => setEditorState(prev => ({ ...prev, authPass: e.target.value }))}
                              placeholder="••••••••"
                              className="mql-ncd-input"
                              style={{ width: '100%', paddingRight: '32px' }}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword(prev => !prev)}
                              style={{ position: 'absolute', right: 8, cursor: 'pointer', color: 'var(--text-muted)' }}
                            >
                              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          </div>
                        </div>
                      )}

                      {m === 'aws' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className="mql-label">Session Token (optional)</span>
                          <input
                            type="text"
                            value={editorState.awsSessionToken}
                            onChange={e => setEditorState(prev => ({ ...prev, awsSessionToken: e.target.value }))}
                            placeholder="for temporary STS credentials"
                            className="mql-ncd-input"
                          />
                        </div>
                      )}

                      {m === 'kerberos' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className="mql-label">Service Name (optional, default: mongodb)</span>
                          <input
                            type="text"
                            value={editorState.kerberosServiceName}
                            onChange={e => setEditorState(prev => ({ ...prev, kerberosServiceName: e.target.value }))}
                            placeholder="mongodb"
                            className="mql-ncd-input"
                          />
                        </div>
                      )}

                      {m === 'x509' && (
                        <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: 0 }}>
                          Requires TLS with a client certificate (TLS tab).
                        </p>
                      )}
                      {isExternal && (
                        <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: 0 }}>
                          Authenticates against the <code>$external</code> database.
                        </p>
                      )}
                    </div>
                    );
                  })()}
                </div>
              )}

              {activeEditorTab === 'tls' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="mql-label">SSL / TLS Certificate Mode</span>
                    <div className="mql-ncd-select-wrap">
                      <select 
                        className="mql-ncd-select" 
                        value={editorState.tlsMode} 
                        onChange={e => setEditorState(prev => ({ ...prev, tlsMode: e.target.value }))}
                      >
                        <option value="off">Off (Insecure Plaintext)</option>
                        <option value="system">System Root CA Certificates</option>
                        <option value="file">Custom CA File Upload</option>
                      </select>
                      <ChevronDown size={10} color="var(--text-dim)" />
                    </div>
                  </div>

                  {editorState.tlsMode === 'file' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
                      <span className="mql-label">CA File Path</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="text"
                          value={editorState.tlsCa}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsCa: e.target.value }))}
                          placeholder="/path/to/ca.pem"
                          className="mql-ncd-input font-mono"
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="mql-btn mql-btn-ghost mql-btn-outlined"
                          data-testid="ca-file-browse"
                          onClick={() => pickTlsFile('tlsCa')}
                        >
                          Browse…
                        </button>
                      </div>
                    </div>
                  )}

                  {editorState.tlsMode !== 'off' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
                      <span className="mql-label">Certificate Validation</span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                        <input
                          type="checkbox"
                          checked={editorState.tlsAllowInvalidCerts}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsAllowInvalidCerts: e.target.checked }))}
                        />
                        <span>Allow invalid certificates <span style={{ color: 'var(--accent-red)' }}>(insecure)</span></span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                        <input
                          type="checkbox"
                          checked={editorState.tlsAllowInvalidHosts}
                          onChange={e => setEditorState(prev => ({ ...prev, tlsAllowInvalidHosts: e.target.checked }))}
                        />
                        <span>Allow invalid hostnames</span>
                      </label>
                      <span style={{ fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                        Disabling certificate validation exposes the connection to man-in-the-middle
                        attacks. Enable only for trusted/self-signed test servers.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {activeEditorTab === 'ssh' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input 
                      type="checkbox" 
                      id="ssh-enable"
                      checked={editorState.sshEnabled} 
                      onChange={e => setEditorState(prev => ({ ...prev, sshEnabled: e.target.checked }))}
                    />
                    <label htmlFor="ssh-enable" style={{ fontSize: 11, fontWeight: 500 }}>Enable SSH Tunnel Proxy Gateway</label>
                  </div>

                  {editorState.sshEnabled && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 2 }}>
                          <span className="mql-label">SSH Server Host</span>
                          <input 
                            type="text" 
                            value={editorState.sshHost} 
                            onChange={e => setEditorState(prev => ({ ...prev, sshHost: e.target.value }))}
                            placeholder="ssh.server.com"
                            className="mql-ncd-input"
                          />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                          <span className="mql-label">SSH Port</span>
                          <input
                            type="text"
                            value={editorState.sshPort}
                            onChange={e => setEditorState(prev => ({ ...prev, sshPort: e.target.value }))}
                            placeholder="22"
                            className="mql-ncd-input font-mono"
                          />
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 2 }}>
                          <span className="mql-label">SSH Username</span>
                          <input
                            type="text"
                            value={editorState.sshUser}
                            onChange={e => setEditorState(prev => ({ ...prev, sshUser: e.target.value }))}
                            placeholder="deploy"
                            className="mql-ncd-input"
                          />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                          <span className="mql-label">Auth Method</span>
                          <div className="mql-ncd-select-wrap">
                            <select
                              className="mql-ncd-select"
                              value={editorState.sshAuth}
                              onChange={e => setEditorState(prev => ({ ...prev, sshAuth: e.target.value }))}
                            >
                              <option value="key">Private Key</option>
                              <option value="password">Password</option>
                            </select>
                            <ChevronDown size={10} color="var(--text-dim)" />
                          </div>
                        </div>
                      </div>

                      {editorState.sshAuth === 'key' ? (
                        <>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span className="mql-label">Private Key Path</span>
                            <input
                              type="text"
                              value={editorState.sshKey}
                              onChange={e => setEditorState(prev => ({ ...prev, sshKey: e.target.value }))}
                              placeholder="~/.ssh/id_ed25519"
                              className="mql-ncd-input font-mono"
                            />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span className="mql-label">Key Passphrase (optional)</span>
                            <PasswordInput
                              value={editorState.sshPass}
                              onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                              placeholder="Leave blank if the key is unencrypted"
                              className="mql-ncd-input font-mono"
                            />
                          </div>
                        </>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className="mql-label">SSH Password</span>
                          <PasswordInput
                            value={editorState.sshPass}
                            onChange={e => setEditorState(prev => ({ ...prev, sshPass: e.target.value }))}
                            placeholder="••••••••"
                            className="mql-ncd-input font-mono"
                          />
                        </div>
                      )}

                      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                        The SSH server's host key must be in <code>~/.ssh/known_hosts</code>. Credentials are
                        stored with the profile (plaintext); prefer key-based auth.
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeEditorTab === 'proxy' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      id="proxy-enable"
                      checked={editorState.proxyEnabled}
                      onChange={e => setEditorState(prev => ({ ...prev, proxyEnabled: e.target.checked }))}
                    />
                    <label htmlFor="proxy-enable" style={{ fontSize: 11, fontWeight: 500 }}>Enable SOCKS5 Client Proxy</label>
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: 0 }}>
                    The MongoDB driver tunnels its connection through a SOCKS5 proxy. (HTTP proxies are not supported by the driver.)
                  </p>

                  {editorState.proxyEnabled && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 2 }}>
                          <span className="mql-label">Proxy Host</span>
                          <input
                            type="text"
                            value={editorState.proxyHost}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyHost: e.target.value }))}
                            placeholder="proxy.internal"
                            className="mql-ncd-input"
                          />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                          <span className="mql-label">Proxy Port</span>
                          <input
                            type="text"
                            value={editorState.proxyPort}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyPort: e.target.value }))}
                            placeholder="1080"
                            className="mql-ncd-input font-mono"
                          />
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                          <span className="mql-label">Proxy Username (optional)</span>
                          <input
                            type="text"
                            value={editorState.proxyUser}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyUser: e.target.value }))}
                            placeholder="username"
                            className="mql-ncd-input"
                          />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                          <span className="mql-label">Proxy Password (optional)</span>
                          <input
                            type="password"
                            value={editorState.proxyPass}
                            onChange={e => setEditorState(prev => ({ ...prev, proxyPass: e.target.value }))}
                            placeholder="••••••••"
                            className="mql-ncd-input"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeEditorTab === 'adv' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      <span className="mql-label">Default Database</span>
                      <input 
                        type="text" 
                        value={editorState.defaultDb} 
                        onChange={e => setEditorState(prev => ({ ...prev, defaultDb: e.target.value }))}
                        placeholder="test"
                        className="mql-ncd-input"
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                      <span className="mql-label">BSON Compression</span>
                      <div className="mql-ncd-select-wrap">
                        <select 
                          className="mql-ncd-select" 
                          value={editorState.compression} 
                          onChange={e => setEditorState(prev => ({ ...prev, compression: e.target.value }))}
                        >
                          <option value="none">None</option>
                          <option value="snappy">Snappy</option>
                          <option value="zlib">Zlib</option>
                        </select>
                        <ChevronDown size={10} color="var(--text-dim)" />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Test progress strip — pinned above the footer, capped so a long
                error scrolls inside it instead of growing the dialog. */}
            {(testing || testResult) && (
              <div style={{ flexShrink: 0, margin: '0 12px', padding: '10px', maxHeight: 200, overflowY: 'auto', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span className="mql-label" style={{ fontSize: 9 }}>Connection Test Progress</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent-blue)', fontWeight: 600 }}>{testProgress}%</span>
                    {testResult && !testing && (
                      <button
                        type="button"
                        data-testid="test-dismiss"
                        aria-label="Dismiss test result"
                        title="Dismiss"
                        onClick={() => { setTestResult(null); setShowErrDetail(false); setTestProgress(0); }}
                        style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-muted)' }}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                </div>
                
                {/* Progress bar fill */}
                <div style={{ width: '100%', height: '4px', background: 'var(--bg-item-active)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${testProgress}%`, height: '100%', background: 'var(--accent-blue)', transition: 'width 250ms ease-out' }} />
                </div>

                {/* Checklist steps */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {testSteps.map((step, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                      <span style={{ color: step.status === 'pending' ? 'var(--text-dim)' : step.status === 'running' ? 'var(--accent-blue)' : 'var(--text-main)' }}>{step.name}</span>
                      <span>
                        {step.status === 'pending' && <span style={{ display: 'inline-block', width: 8, height: 8, border: '1px solid var(--border-color)', borderRadius: '50%' }} />}
                        {step.status === 'running' && <RefreshCw size={10} className="animate-spin text-[var(--accent-blue)]" />}
                        {step.status === 'success' && <Check size={11} className="text-[var(--accent-green)]" />}
                        {step.status === 'failed' && <X size={11} className="text-[var(--accent-red)]" />}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Final status feedback */}
                {testResult && (() => {
                  const info = testResult.success
                    ? { summary: testResult.message, hint: undefined as string | undefined }
                    : summarizeConnectionError(testResult.message);
                  return (
                    <div style={{ padding: '8px 10px', borderRadius: '4px', fontSize: '11px', border: '1px solid transparent',
                      background: testResult.success ? 'var(--soft-green-bg)' : 'var(--soft-red-bg)',
                      borderColor: testResult.success ? 'var(--soft-green-bd)' : 'var(--soft-red-bd)',
                      color: testResult.success ? 'var(--accent-green)' : 'var(--accent-red)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                        {testResult.success ? <Check size={12} style={{ flex: 'none', marginTop: 1 }} /> : <AlertCircle size={12} style={{ flex: 'none', marginTop: 1 }} />}
                        <span style={{ fontWeight: 600 }} data-testid="test-result-summary">{info.summary}</span>
                      </div>
                      {info.hint && (
                        <div style={{ marginTop: 4, marginLeft: 18, color: 'var(--text-muted)', fontWeight: 400 }}>{info.hint}</div>
                      )}
                      {!testResult.success && (
                        <>
                          <button
                            type="button"
                            data-testid="test-error-details-toggle"
                            onClick={() => setShowErrDetail(v => !v)}
                            style={{ marginTop: 6, marginLeft: 18, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, textDecoration: 'underline' }}
                          >
                            {showErrDetail ? 'Hide details' : 'Show details'}
                          </button>
                          {showErrDetail && (
                            <pre data-testid="test-error-detail" style={{ marginTop: 6, marginBottom: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 10, lineHeight: 1.5, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
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

            {/* Dialog Footer */}
            <footer className="mql-ncd-foot">
              <div className="mql-row" style={{ gap: 8 }}>
                <button className="mql-btn mql-btn-ghost mql-btn-outlined" onClick={runTestStepSequence} disabled={testing}>
                  <RefreshCw size={11} className={`mr-1 ${testing ? 'animate-spin' : ''}`} />
                  <span>Test Connection</span>
                </button>
                <button className="mql-btn mql-btn-ghost mql-btn-outlined" onClick={handleImportUri} data-testid="import-uri-btn">
                  <ClipboardPaste size={11} className="mr-1" />
                  <span>Import URI</span>
                </button>
              </div>
              <div className="mql-row" style={{ gap: 8 }}>
                <button className="mql-btn mql-btn-ghost mql-btn-outlined" onClick={() => setShowEditDialog(false)}>Cancel</button>
                <button className="mql-btn mql-btn-primary" onClick={handleSave} disabled={loading || testing}>
                  <Check size={11} className="mr-1" />
                  <span>Save</span>
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
};

import React, { useEffect, useState, useRef} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  LayoutGrid,
  Save,
  Terminal,
  Sparkles,
  ShieldCheck,
  ArrowUpCircle,
  Server,
  Keyboard,
  Wrench,
  Copy,
  Languages,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import {
  changeVaultPassword,
  resetVault,
  biometricStatus,
  biometricEnable,
  biometricDisable,
  type BiometricStatus,
} from '../lib/vault';
import { useLocale } from '@/components/i18n/I18nProvider';
import { SUPPORTED_LOCALES, SYSTEM_LOCALE, type LocaleSetting } from '@/lib/i18n/locales';
import { getMcpStatus, mcpSetEnabled, mcpRegenerateToken, type McpStatusUi } from '@/lib/mcpApi';
import type { ConnectionProfile } from '@/lib/connection';
import { CHECK_UPDATE_EVENT } from './UpdatePrompt';
import { useTabVisible } from '../workspace/tabVisibility';
import {
  formatLastChecked,
  readUpdateCheckSnapshot,
  UPDATE_CHECK_STATE_EVENT,
  updateCheckResultLabel,
  type UpdateCheckSnapshot,
} from '@/lib/updateCheckState';
import { AppearanceSettings } from '@/components/theme/AppearanceSettings';
import { KeyboardShortcutsSettings } from '@/components/KeyboardShortcutsSettings';
import type { AppearanceSettings as AppearanceSettingsType } from '@/lib/themes/schema';
import { Button } from '@/components/ui/button';
import { AiProviderManager, type AiProvider } from '@/components/AiProviderManager';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ManagedToolStatusUi } from './ToolSetupDialog';
import {
  AI_HISTORY_RETENTION_OPTIONS,
  DEFAULT_AI_HISTORY_RETENTION_MONTHS,
  normalizeAiHistoryRetentionMonths,
  saveAiHistoryRetentionMonths,
  type AiHistoryRetentionMonths,
} from '@/lib/aiChatStore';

interface AppSettings {
  mongosh_path: string;
  appearance?: AppearanceSettingsType;
  ai_provider?: string;
  anthropic_api_key?: string;
  anthropic_model?: string;
  openai_api_key?: string;
  openai_model?: string;
  gemini_api_key?: string;
  gemini_model?: string;
  local_commands?: Record<string, string>;
  ai_providers?: AiProvider[];
  ai_custom_instructions?: string;
  ai_history_retention_months?: number;
  audit_enabled?: boolean;
  audit_level?: string;
  audit_retention_days?: number;
  audit_include_payloads?: boolean;
  update_channel?: string;
}

const AUDIT_LEVELS = ['A', 'B', 'C'] as const;
const AUDIT_RETENTION_DAYS = [7, 30, 90] as const;
type AuditLevel = (typeof AUDIT_LEVELS)[number];

function normalizeAuditLevel(value: unknown): AuditLevel {
  const s = String(value ?? 'A').toUpperCase();
  return (AUDIT_LEVELS as readonly string[]).includes(s) ? (s as AuditLevel) : 'A';
}

function normalizeAuditRetentionDays(value: unknown): number {
  const n = Number(value);
  return (AUDIT_RETENTION_DAYS as readonly number[]).includes(n) ? n : 30;
}

interface AgentDetection {
  id: string;
  binary: string;
  available: boolean;
  version: string;
}

const CLOUD_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
const LOCAL_AGENTS = ['claude-code', 'codex', 'cursor', 'antigravity'] as const;
const DEFAULT_LOCAL_COMMANDS: Record<string, string> = {
  'claude-code': 'claude -p {prompt}',
  codex: 'codex exec {prompt}',
  cursor: 'cursor-agent -p {prompt}',
  antigravity: 'antigravity {prompt}',
};
/** localStorage key for the MongoDB Database Tools directory (mongodump/mongorestore). */
export const MONGO_TOOLS_DIR_KEY = 'mqlens.mongoToolsDir';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (ChatGPT)',
  gemini: 'Google Gemini',
  'claude-code': 'Claude Code (local)',
  codex: 'Codex (local)',
  cursor: 'Cursor (local)',
  antigravity: 'Antigravity (local)',
};

type SettingsTabId =
  | 'appearance'
  | 'ai'
  | 'mcp'
  | 'tools'
  | 'updates'
  | 'shortcuts'
  | 'security'
  | 'audit'
  | 'language';

const SETTINGS_TABS: {
  id: SettingsTabId;
  labelKey: string;
  descriptionKey: string;
  Icon: LucideIcon;
  persistFooter?: boolean;
}[] = [
  {
    id: 'appearance',
    labelKey: 'appearance.tabLabel',
    descriptionKey: 'appearance.tabDescription',
    Icon: LayoutGrid,
  },
  {
    id: 'ai',
    labelKey: 'ai.tabLabel',
    descriptionKey: 'ai.tabDescription',
    Icon: Sparkles,
    persistFooter: true,
  },
  {
    id: 'mcp',
    labelKey: 'mcp.tabLabel',
    descriptionKey: 'mcp.tabDescription',
    Icon: Server,
  },
  {
    id: 'tools',
    labelKey: 'tools.tabLabel',
    descriptionKey: 'tools.tabDescription',
    Icon: Wrench,
    persistFooter: true,
  },
  {
    id: 'updates',
    labelKey: 'updates.tabLabel',
    descriptionKey: 'updates.tabDescription',
    Icon: ArrowUpCircle,
    persistFooter: true,
  },
  {
    id: 'shortcuts',
    labelKey: 'shortcuts.tabLabel',
    descriptionKey: 'shortcuts.tabDescription',
    Icon: Keyboard,
  },
  {
    id: 'security',
    labelKey: 'security.tabLabel',
    descriptionKey: 'security.tabDescription',
    Icon: ShieldCheck,
  },
  {
    id: 'audit',
    labelKey: 'audit.tabLabel',
    descriptionKey: 'audit.tabDescription',
    Icon: ScrollText,
    persistFooter: true,
  },
  {
    id: 'language',
    labelKey: 'language.tabLabel',
    descriptionKey: 'language.tabDescription',
    Icon: Languages,
  },
];

// Lowest/highest port the MCP port field accepts (final fix wave): below
// 1024 is the OS's reserved/privileged range (binding usually fails or needs
// elevated permissions anyway — not worth letting a user configure it only
// to hit a confusing bind error), 65535 is the highest a `u16` port can be.
const MCP_MIN_PORT = 1024;
const MCP_MAX_PORT = 65535;

/** `HH:MM:SS` (local time, zero-padded) from a call-log entry's `tsMs`. */
function formatMcpLogTime(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * MCP tab content, extracted out of `renderTabContent` (unlike the other
 * tabs, which stay inline) because it owns a non-trivial amount of local
 * state and a 2s status-poll lifecycle of its own — keeping that isolated
 * here means it only ever mounts/unmounts (and starts/stops polling) when
 * the MCP tab itself is selected, not on every `SettingsView` re-render.
 */
const McpSettingsPanel: React.FC = () => {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<McpStatusUi | null>(null);
  const [portInput, setPortInput] = useState(String(8765));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [regenerated, setRegenerated] = useState(false);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // The instructions MQLens's own MCP server sends. Shown here so a user
  // pointing an external client at MQLens can paste the same guidance instead of
  // writing a system prompt themselves.
  const [agentPrompt, setAgentPrompt] = useState('');

  useEffect(() => {
    invoke<string>('mcp_agent_instructions')
      .then(setAgentPrompt)
      // Purely informational: the embedded server sends these regardless, so a
      // failure to display them changes nothing about how agents behave.
      .catch(() => setAgentPrompt(''));
  }, []);

  // Initial status fetch — separate from the poll effect below so the panel
  // renders a real state immediately instead of waiting on the 2s cadence.
  useEffect(() => {
    let cancelled = false;
    getMcpStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setPortInput(String(s.port));
      })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Opted-in profile list — read-only here; managed from the Connection
  // Manager's own "Expose to MCP agents" checkbox (#98 Task 3).
  useEffect(() => {
    let cancelled = false;
    invoke<ConnectionProfile[]>('load_connection_profiles')
      .then((list) => {
        if (cancelled) return;
        setProfiles((list || []).filter((p) => p.mcp_enabled));
      })
      .catch(() => { if (!cancelled) setProfiles([]); });
    return () => { cancelled = true; };
  }, []);

  // Poll precedent: App.tsx's resource-usage/export-task polls (App.tsx
  // ~424-436) — `active` flag + `clearInterval` on cleanup, StrictMode-safe.
  // Only runs while this tab is on screen AND the server is enabled, since
  // there is nothing new to poll for while disabled — and nobody to show it
  // to while the Settings tab is kept mounted but hidden (#240).
  const tabVisible = useTabVisible();
  useEffect(() => {
    if (!status?.enabled || !tabVisible) return;
    let active = true;
    const id = setInterval(() => {
      getMcpStatus()
        .then((s) => { if (active) setStatus(s); })
        .catch(() => { /* transient poll failure — keep last known status */ });
    }, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [status?.enabled, tabVisible]);

  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
  };

  const onToggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    setRegenerated(false);
    try {
      const parsedPort = parseInt(portInput, 10);
      // Friendly range validation before ever calling `invoke` (final fix
      // wave) — an out-of-range port used to sail straight through to the
      // backend bind attempt, surfacing as an opaque OS-level bind error
      // instead of a clear "pick a different port" message.
      if (next && (!Number.isFinite(parsedPort) || parsedPort < MCP_MIN_PORT || parsedPort > MCP_MAX_PORT)) {
        setError(t('mcp.portRangeError', { min: MCP_MIN_PORT, max: MCP_MAX_PORT }));
        return;
      }
      const port = next ? parsedPort : undefined;
      const s = await mcpSetEnabled(next, port);
      setStatus(s);
      setPortInput(String(s.port));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRegenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await mcpRegenerateToken();
      setStatus(s);
      setRegenerated(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const port = status?.port ?? (parseInt(portInput, 10) || 8765);
  const token = status?.token ?? '';
  const vaultLocked = !!error && /vault is locked/i.test(error);

  const claudeSnippet = `claude mcp add --transport http mqlens http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`;
  const cursorSnippet = JSON.stringify(
    { mcpServers: { mqlens: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4 text-primary" />
            {t('mcp.title')}
          </CardTitle>
          <CardDescription>{t('mcp.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              data-testid="mcp-enable-toggle"
              checked={enabled}
              disabled={busy}
              onCheckedChange={onToggle}
            />
            <Label className="font-normal">{enabled ? t('mcp.enabled') : t('mcp.disabled')}</Label>
          </div>

          <div className="max-w-[10rem] space-y-2">
            <Label htmlFor="mcp-port">{t('mcp.port')}</Label>
            <Input
              id="mcp-port"
              type="number"
              min={MCP_MIN_PORT}
              max={MCP_MAX_PORT}
              className="font-mono"
              value={portInput}
              disabled={enabled}
              onChange={(e) => setPortInput(e.target.value)}
              data-testid="mcp-port-input"
            />
            <p className="text-xs text-muted-foreground">
              {t('mcp.portHint', { min: MCP_MIN_PORT, max: MCP_MAX_PORT })}
            </p>
          </div>

          {error && (
            <div
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid={vaultLocked ? 'mcp-vault-locked' : 'mcp-error'}
            >
              {error}
            </div>
          )}

          {enabled && (
            <div className="space-y-2 border-t border-border pt-4">
              <Label>{t('mcp.bearerToken')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm" data-testid="mcp-token-display">
                  {tokenRevealed ? token : '••••••••••••••••'}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTokenRevealed((v) => !v)}
                  data-testid="mcp-token-reveal"
                >
                  {tokenRevealed ? t('mcp.hide') : t('mcp.reveal')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copy('token', token)}
                  data-testid="mcp-token-copy"
                >
                  <Copy className="h-3 w-3" />
                  {copiedKey === 'token' ? t('mcp.copied') : t('mcp.copy')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRegenerate}
                  disabled={busy}
                  data-testid="mcp-token-regenerate"
                >
                  {t('mcp.regenerate')}
                </Button>
              </div>
              {regenerated && (
                <p className="text-xs text-warning" data-testid="mcp-regenerate-note">
                  {t('mcp.tokenRegeneratedNote')}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {enabled && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Claude Code</CardTitle>
              <CardDescription>{t('mcp.claudeSnippetHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <code
                className="block whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 text-xs"
                data-testid="mcp-claude-snippet"
              >
                {claudeSnippet}
              </code>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copy('claude', claudeSnippet)}
                  data-testid="mcp-claude-copy"
                >
                  <Copy className="h-3 w-3" />
                  {copiedKey === 'claude' ? t('mcp.copied') : t('mcp.copy')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cursor</CardTitle>
              <CardDescription>{t('mcp.cursorSnippetHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <code
                className="block whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 text-xs"
                data-testid="mcp-cursor-snippet"
              >
                {cursorSnippet}
              </code>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copy('cursor', cursorSnippet)}
                  data-testid="mcp-cursor-copy"
                >
                  <Copy className="h-3 w-3" />
                  {copiedKey === 'cursor' ? t('mcp.copied') : t('mcp.copy')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {agentPrompt && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('mcp.agentPromptTitle')}</CardTitle>
            <CardDescription>{t('mcp.agentPromptDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-xs text-foreground"
              data-testid="mcp-agent-prompt"
            >
              {agentPrompt}
            </pre>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => copy('agent-prompt', agentPrompt)}
                data-testid="mcp-agent-prompt-copy"
              >
                <Copy className="h-3 w-3" />
                {copiedKey === 'agent-prompt' ? t('mcp.copied') : t('mcp.copy')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('mcp.profilesTitle')}</CardTitle>
          <CardDescription>{t('mcp.profilesDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="mcp-profiles-empty">
              {t('mcp.profilesEmpty')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {profiles.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 text-sm"
                  data-testid={`mcp-profile-${p.id}`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: p.color_tag || 'var(--muted-foreground)' }}
                  />
                  {p.name}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t('mcp.manageInConnectionManager')}</p>
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">{t('mcp.callLogTitle')}</CardTitle>
          <CardDescription>{t('mcp.callLogDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!status || status.log.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="mcp-log-empty">
              {t('mcp.callLogEmpty')}
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto font-mono text-[11px]" data-testid="mcp-log-list">
              {[...status.log].reverse().map((entry, i) => (
                <div
                  key={`${entry.tsMs}-${i}`}
                  className="flex items-center gap-2"
                  data-testid="mcp-log-row"
                >
                  <span className="text-muted-foreground">{formatMcpLogTime(entry.tsMs)}</span>
                  <span>{entry.tool}</span>
                  <span className="truncate text-muted-foreground">{entry.summary}</span>
                  <span className={entry.ok ? 'text-success' : 'text-destructive'}>
                    {entry.ok ? '' : t('mcp.err')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export type { SettingsTabId };

export interface SettingsViewProps {
  initialTab?: SettingsTabId;
  onInstallTools?: () => void;
  /**
   * Bumped by the parent (e.g. after the guided tool-setup dialog's "Done"
   * handler) to re-trigger this view's own `managed_tools_status` fetch, so
   * the "Managed tools" card doesn't go stale after an install completes
   * while Settings is still mounted.
   */
  toolStatusRefreshNonce?: number;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ initialTab, onInstallTools, toolStatusRefreshNonce }) => {
  const { t } = useTranslation('settings');
  const { localeSetting, setLocale } = useLocale();
  const [tab, setTab] = useState<SettingsTabId>(initialTab ?? 'appearance');
  const [mongoshPath, setMongoshPath] = useState('');
  const [managedTools, setManagedTools] = useState<ManagedToolStatusUi[] | null>(null);
  const [mongoToolsDir, setMongoToolsDir] = useState(() => {
    try {
      return localStorage.getItem(MONGO_TOOLS_DIR_KEY) || '';
    } catch {
      return '';
    }
  });
  const [aiProvider, setAiProvider] = useState('anthropic');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('claude-opus-4-8');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o');
  const [geminiKey, setGeminiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-1.5-flash');
  const [localCommands, setLocalCommands] = useState<Record<string, string>>({});
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [historyRetentionMonths, setHistoryRetentionMonths] = useState<AiHistoryRetentionMonths>(
    DEFAULT_AI_HISTORY_RETENTION_MONTHS
  );
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [auditLevel, setAuditLevel] = useState<AuditLevel>('A');
  const [auditRetentionDays, setAuditRetentionDays] = useState(30);
  const [auditIncludePayloads, setAuditIncludePayloads] = useState(false);
  const [updateChannel, setUpdateChannel] = useState<'stable' | 'dev'>('stable');
  const [agents, setAgents] = useState<AgentDetection[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [secMsg, setSecMsg] = useState('');
  const [secMsgKind, setSecMsgKind] = useState<'success' | 'error' | ''>('');
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckSnapshot | null>(() =>
    readUpdateCheckSnapshot(),
  );

  const activeTab = SETTINGS_TABS.find((entry) => entry.id === tab) ?? SETTINGS_TABS[0];

  useEffect(() => {
    const sync = () => setUpdateCheck(readUpdateCheckSnapshot());
    window.addEventListener(UPDATE_CHECK_STATE_EVENT, sync);
    return () => window.removeEventListener(UPDATE_CHECK_STATE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>('load_app_settings')
      .then((s) => {
        if (cancelled) return;
        setMongoshPath(s.mongosh_path || '');
        setAiProvider(s.ai_provider || 'anthropic');
        setAnthropicKey(s.anthropic_api_key || '');
        setAnthropicModel(s.anthropic_model || 'claude-opus-4-8');
        setOpenaiKey(s.openai_api_key || '');
        setOpenaiModel(s.openai_model || 'gpt-4o');
        setGeminiKey(s.gemini_api_key || '');
        setGeminiModel(s.gemini_model || 'gemini-1.5-flash');
        setLocalCommands(s.local_commands || {});
        setAiProviders(s.ai_providers || []);
        setCustomInstructions(s.ai_custom_instructions || '');
        setHistoryRetentionMonths(
          normalizeAiHistoryRetentionMonths(s.ai_history_retention_months)
        );
        setAuditEnabled(s.audit_enabled !== false);
        setAuditLevel(normalizeAuditLevel(s.audit_level));
        setAuditRetentionDays(normalizeAuditRetentionDays(s.audit_retention_days));
        setAuditIncludePayloads(!!s.audit_include_payloads);
        setUpdateChannel(s.update_channel === 'dev' ? 'dev' : 'stable');
        // Keep the localStorage mirror in sync so AI Helper prune uses the vault value.
        saveAiHistoryRetentionMonths(
          normalizeAiHistoryRetentionMonths(s.ai_history_retention_months)
        );
      })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    invoke<AgentDetection[]>('detect_local_agents')
      .then((a) => { if (!cancelled) setAgents(a); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    biometricStatus().then(setBio).catch(() => setBio(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<ManagedToolStatusUi[]>('managed_tools_status')
      .then((s) => { if (!cancelled) setManagedTools(s); })
      .catch(() => { if (!cancelled) setManagedTools([]); });
    return () => { cancelled = true; };
  }, [toolStatusRefreshNonce]);

  const localCommandFor = (agent: string) =>
    localCommands[agent] ?? DEFAULT_LOCAL_COMMANDS[agent] ?? '{prompt}';

  // Writes the provider list (and the active choice) without waiting for the
  // form's Save, since the button says "Save provider".
  //
  // No frontend queue: every settings write is now a single `patch_app_settings`
  // call that loads, merges and saves inside one backend lock, so two writers
  // cannot interleave a load with the other's save. That also covers the writers
  // outside this component — theme, locale, shell path.
  //
  // Two mechanisms, two jobs, and both are needed. `patch_app_settings` merges
  // under a backend lock, which is what stops one writer's save from erasing
  // another's field — including writers in other components (theme, locale,
  // shell path). What a mutex does not give is *order*: two patches of the same
  // field can acquire it either way round, so adding a provider and quickly
  // removing it could finish with the add last and the provider back. Writes of
  // this list are queued here, where the causal order is known; fields owned by
  // other components are disjoint, so ordering between components never arises.
  const settingsWrites = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Chain a patch after every earlier one from this form.
   *
   * Save goes through here too, not only the provider writes: both patch
   * `ai_provider` and `ai_providers`, so a Save issued directly could overtake a
   * queued provider patch that had captured the *previous* active provider, and
   * that older patch would then land last and revert the choice just saved.
   */
  const queueSettingsPatch = (patch: Record<string, unknown>) => {
    const write = () => invoke('patch_app_settings', { patch });
    const run = settingsWrites.current.then(write, write);
    settingsWrites.current = run.catch(() => {});
    return run;
  };
  const persistProviders = (next: AiProvider[], active: string) =>
    queueSettingsPatch({ ai_providers: next, ai_provider: active }).catch((e) =>
      setError(t('ai.providerSaveFailed', { error: String(e) }))
    );

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      // A patch of exactly the fields this form owns. Spreading a loaded copy
      // used to echo back every field it does not own — appearance, locale —
      // so a theme or language change made while the form was open was undone
      // by pressing Save. The backend merges under its own lock.
      await queueSettingsPatch({
          mongosh_path: mongoshPath.trim(),
          ai_provider: aiProvider,
          anthropic_api_key: anthropicKey.trim(),
          anthropic_model: anthropicModel.trim() || 'claude-opus-4-8',
          openai_api_key: openaiKey.trim(),
          openai_model: openaiModel.trim() || 'gpt-4o',
          gemini_api_key: geminiKey.trim(),
          gemini_model: geminiModel.trim() || 'gemini-1.5-flash',
          local_commands: localCommands,
          ai_providers: aiProviders,
          ai_custom_instructions: customInstructions,
          ai_history_retention_months: historyRetentionMonths,
          audit_enabled: auditEnabled,
          audit_level: auditLevel,
          audit_retention_days: auditRetentionDays,
          audit_include_payloads: auditIncludePayloads,
          update_channel: updateChannel,
      });
      saveAiHistoryRetentionMonths(historyRetentionMonths);
      setStatus(t('footer.settingsSaved'));
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const onChangeMongoToolsDir = (value: string) => {
    setMongoToolsDir(value);
    try {
      localStorage.setItem(MONGO_TOOLS_DIR_KEY, value);
    } catch {
      /* localStorage unavailable — best-effort persistence only */
    }
  };

  const testMongosh = async () => {
    setTesting(true);
    setError(null);
    setStatus(null);
    try {
      const version = await invoke<string>('test_mongosh_path', { path: mongoshPath.trim() });
      setStatus(version || t('tools.mongoshPathResolved'));
    } catch (err) {
      setError(String(err));
    } finally {
      setTesting(false);
    }
  };

  const onChangePw = async () => {
    setSecMsg('');
    setSecMsgKind('');
    if (!oldPw) { setSecMsg(t('security.currentPasswordRequired')); setSecMsgKind('error'); return; }
    if (!newPw) { setSecMsg(t('security.newPasswordRequired')); setSecMsgKind('error'); return; }
    if (newPw !== newPw2) { setSecMsg(t('security.passwordsDoNotMatch')); setSecMsgKind('error'); return; }
    try {
      await changeVaultPassword(oldPw, newPw);
      setSecMsg(t('security.passwordChanged'));
      setSecMsgKind('success');
      setOldPw(''); setNewPw(''); setNewPw2('');
    } catch (e) { setSecMsg(String(e)); setSecMsgKind('error'); }
  };

  const toggleBiometric = async (checked: boolean) => {
    if (!bio) return;
    setBioBusy(true);
    try {
      if (checked) {
        await biometricEnable();
        setBio({ ...bio, enrolled: true });
      } else {
        await biometricDisable();
        setBio({ ...bio, enrolled: false });
      }
    } catch (e) {
      setSecMsg(String(e));
      setSecMsgKind('error');
    } finally {
      setBioBusy(false);
    }
  };

  const onResetVault = async () => {
    if (!window.confirm(t('security.resetVaultConfirm'))) return;
    setSecMsg('');
    try {
      await resetVault();
      setSecMsg(t('security.resetVaultSuccess'));
      // Deliberately 'error' (not a bug): reuses the existing red/destructive
      // styling to underline that the vault reset is destructive, even
      // though this is the success path.
      setSecMsgKind('error');
    } catch (e) { setSecMsg(String(e)); setSecMsgKind('error'); }
  };

  const renderTabContent = () => {
    switch (tab) {
      case 'appearance':
        return <AppearanceSettings />;

      case 'mcp':
        return <McpSettingsPanel />;

      case 'updates':
        return (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ArrowUpCircle className="h-4 w-4 text-primary" />
                  {t('updates.channelTitle')}
                </CardTitle>
                <CardDescription>{t('updates.channelDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('updates.channelLabel')}</Label>
                  <div role="group" aria-label={t('updates.channelGroupAriaLabel')} className="flex flex-wrap gap-2">
                    {(['stable', 'dev'] as const).map((ch) => (
                      <Button
                        key={ch}
                        type="button"
                        variant={updateChannel === ch ? 'default' : 'outline'}
                        size="sm"
                        data-testid={`update-channel-${ch}`}
                        onClick={() => setUpdateChannel(ch)}
                      >
                        {ch === 'stable' ? t('updates.stable') : t('updates.devPrerelease')}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('updates.channelHint')}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('updates.manualCheckTitle')}</CardTitle>
                <CardDescription>{t('updates.manualCheckDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {updateCheck ? (
                  <div className="space-y-1 text-sm" data-testid="update-last-checked">
                    <p className="text-muted-foreground">
                      {t('updates.lastChecked', { time: formatLastChecked(updateCheck.checkedAt) })}
                    </p>
                    <p className="text-foreground">
                      {t('updates.result', { result: t(updateCheckResultLabel(updateCheck.result)) })}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="update-last-checked">
                    {t('updates.noCheckYet')}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  data-testid="check-updates-btn"
                  onClick={() => window.dispatchEvent(new Event(CHECK_UPDATE_EVENT))}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {t('updates.checkForUpdatesBtn')}
                </Button>
              </CardContent>
            </Card>
          </div>
        );

      case 'tools':
        return (
          <>
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="h-4 w-4 text-success" />
                {t('tools.mongoshTitle')}
              </CardTitle>
              <CardDescription>{t('tools.mongoshDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mongosh-path">{t('tools.mongoshPath')}</Label>
                <Input
                  id="mongosh-path"
                  className="font-mono"
                  value={mongoshPath}
                  onChange={(event) => setMongoshPath(event.target.value)}
                  placeholder="mongosh or /usr/local/bin/mongosh"
                  data-testid="mongosh-path-input"
                />
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={testMongosh} disabled={testing} type="button">
                  <Terminal className="h-3 w-3" />
                  {testing ? t('tools.testing') : t('tools.testPath')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="max-w-3xl mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="h-4 w-4 text-success" />
                {t('tools.dbToolsTitle')}
              </CardTitle>
              <CardDescription>{t('tools.dbToolsDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="mongo-tools-dir">{t('tools.dirLabel')}</Label>
              <Input
                id="mongo-tools-dir"
                className="font-mono"
                value={mongoToolsDir}
                onChange={(event) => onChangeMongoToolsDir(event.target.value)}
                placeholder="/usr/local/bin"
                data-testid="mongo-tools-dir-input"
              />
              <p className="text-xs text-muted-foreground">{t('tools.dirHint')}</p>
            </CardContent>
          </Card>

          <Card className="max-w-3xl mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wrench className="h-4 w-4 text-success" />
                {t('tools.managedTitle')}
              </CardTitle>
              <CardDescription>{t('tools.managedDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {managedTools === null ? (
                <p className="text-xs text-muted-foreground">{t('tools.checkingInstalled')}</p>
              ) : (
                <ul className="space-y-1">
                  {managedTools.map((tool) => (
                    <li
                      key={tool.name}
                      className="text-xs text-muted-foreground"
                      data-testid={`settings-managed-tool-${tool.name}`}
                    >
                      {tool.name}: {tool.installed
                        ? t('tools.installedVersion', { version: tool.version })
                        : t('tools.notInstalled')}
                    </li>
                  ))}
                </ul>
              )}
              {onInstallTools && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onInstallTools}
                    data-testid="settings-install-tools-btn"
                  >
                    <Wrench className="h-3 w-3" />
                    {t('tools.installToolsBtn')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
          </>
        );

      case 'ai':
        return (
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" />
                  {t('ai.providerTitle')}
                </CardTitle>
                <CardDescription>{t('ai.providerDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-w-md space-y-2">
                  <Label>{t('ai.activeProvider')}</Label>
                  <Select value={aiProvider} onValueChange={setAiProvider}>
                    <SelectTrigger data-testid="ai-provider-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[...CLOUD_PROVIDERS, ...LOCAL_AGENTS].map((p) => (
                        <SelectItem key={p} value={p}>{PROVIDER_LABELS[p]}</SelectItem>
                      ))}
                      {aiProviders.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {aiProvider === 'anthropic' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Anthropic</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="anthropic-key">{t('ai.apiKey')}</Label>
                    <Input
                      id="anthropic-key"
                      type="password"
                      className="font-mono"
                      value={anthropicKey}
                      onChange={(e) => setAnthropicKey(e.target.value)}
                      placeholder="sk-ant-..."
                      data-testid="anthropic-key-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="anthropic-model">{t('ai.model')}</Label>
                    <Input
                      id="anthropic-model"
                      className="font-mono"
                      value={anthropicModel}
                      onChange={(e) => setAnthropicModel(e.target.value)}
                      placeholder="claude-opus-4-8"
                      data-testid="anthropic-model-input"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {aiProvider === 'openai' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">OpenAI</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="openai-key">{t('ai.apiKey')}</Label>
                    <Input
                      id="openai-key"
                      type="password"
                      className="font-mono"
                      value={openaiKey}
                      onChange={(e) => setOpenaiKey(e.target.value)}
                      placeholder="sk-..."
                      data-testid="openai-key-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openai-model">{t('ai.model')}</Label>
                    <Input
                      id="openai-model"
                      className="font-mono"
                      value={openaiModel}
                      onChange={(e) => setOpenaiModel(e.target.value)}
                      placeholder="gpt-4o"
                      data-testid="openai-model-input"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {aiProvider === 'gemini' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Google Gemini</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="gemini-key">{t('ai.apiKey')}</Label>
                    <Input
                      id="gemini-key"
                      type="password"
                      className="font-mono"
                      value={geminiKey}
                      onChange={(e) => setGeminiKey(e.target.value)}
                      placeholder="AIza..."
                      data-testid="gemini-key-input"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="gemini-model">{t('ai.model')}</Label>
                    <Input
                      id="gemini-model"
                      className="font-mono"
                      value={geminiModel}
                      onChange={(e) => setGeminiModel(e.target.value)}
                      placeholder="gemini-1.5-flash"
                      data-testid="gemini-model-input"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {(LOCAL_AGENTS as readonly string[]).includes(aiProvider) && (
              <Card className="xl:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">{t('ai.localAgentTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {(() => {
                    const det = agents.find((a) => a.id === aiProvider);
                    return (
                      <p className="text-xs text-muted-foreground" data-testid="agent-availability">
                        {det?.available
                          ? (det.version
                              ? t('ai.detectedInstalledWithVersion', { version: det.version })
                              : t('ai.detectedInstalled'))
                          : t('ai.notDetected')}
                      </p>
                    );
                  })()}
                  <div className="space-y-2">
                    <Label htmlFor="local-command">{t('ai.localCommandLabel')}</Label>
                    <Input
                      id="local-command"
                      className="font-mono"
                      value={localCommandFor(aiProvider)}
                      onChange={(e) => setLocalCommands((prev) => ({ ...prev, [aiProvider]: e.target.value }))}
                      placeholder={DEFAULT_LOCAL_COMMANDS[aiProvider]}
                      data-testid="local-command-input"
                    />
                    <p className="text-xs text-muted-foreground">{t('ai.localCommandHint')}</p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">{t('ai.yourProvidersTitle')}</CardTitle>
                <CardDescription>{t('ai.yourProvidersDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <AiProviderManager
                  providers={aiProviders}
                  onChange={(next) => {
                    setAiProviders(next);
                    // A removed provider must not stay selected: the backend would
                    // reject the id, and the message would arrive at generation
                    // time rather than here.
                    const stillValid = next.some((p) => p.id === aiProvider) || !!PROVIDER_LABELS[aiProvider];
                    const active = stillValid ? aiProvider : 'anthropic';
                    if (!stillValid) setAiProvider(active);
                    // The button says "Save provider", so it saves. Until this the
                    // list lived only in React state and vanished with the window
                    // unless the form's own Save was also pressed.
                    void persistProviders(next, active);
                  }}
                  reservedIds={[...CLOUD_PROVIDERS, ...LOCAL_AGENTS]}
                />
              </CardContent>
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">{t('ai.customInstructionsTitle')}</CardTitle>
                <CardDescription>{t('ai.customInstructionsDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <textarea
                  id="ai-instructions"
                  rows={5}
                  className={cn(
                    'flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder={t('ai.customInstructionsPlaceholder')}
                  data-testid="ai-instructions-input"
                />
              </CardContent>
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">{t('ai.historyRetentionTitle')}</CardTitle>
                <CardDescription>{t('ai.historyRetentionDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-w-md space-y-2">
                  <Label htmlFor="ai-history-retention">{t('ai.historyRetentionLabel')}</Label>
                  <Select
                    value={String(historyRetentionMonths)}
                    onValueChange={(v) =>
                      setHistoryRetentionMonths(normalizeAiHistoryRetentionMonths(Number(v)))
                    }
                  >
                    <SelectTrigger id="ai-history-retention" data-testid="ai-history-retention-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AI_HISTORY_RETENTION_OPTIONS.map((months) => (
                        <SelectItem key={months} value={String(months)}>
                          {t('ai.historyRetentionMonths', { count: months })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>
        );

      case 'shortcuts':
        return <KeyboardShortcutsSettings />;

      case 'security':
        return (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4 text-warning" />
                  {t('security.masterPassword')}
                </CardTitle>
                <CardDescription>{t('security.masterPasswordDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="sec-old-pw">{t('security.currentPassword')}</Label>
                  <Input
                    id="sec-old-pw"
                    type="password"
                    className="font-mono"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    placeholder={t('security.currentPassword')}
                    data-testid="sec-old-pw"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="sec-new-pw">{t('security.newPassword')}</Label>
                    <Input
                      id="sec-new-pw"
                      type="password"
                      className="font-mono"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      placeholder={t('security.newPassword')}
                      data-testid="sec-new-pw"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sec-new-pw2">{t('security.confirmPassword')}</Label>
                    <Input
                      id="sec-new-pw2"
                      type="password"
                      className="font-mono"
                      value={newPw2}
                      onChange={(e) => setNewPw2(e.target.value)}
                      placeholder={t('security.confirmNewPasswordPlaceholder')}
                      data-testid="sec-new-pw2"
                    />
                  </div>
                </div>

                {secMsg && (
                  <div
                    className={cn(
                      'rounded-md px-3 py-2 text-sm',
                      secMsgKind === 'success'
                        ? 'bg-success/10 text-success'
                        : 'bg-destructive/10 text-destructive'
                    )}
                    data-testid="sec-msg"
                  >
                    {secMsg}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button onClick={onChangePw} type="button" data-testid="sec-change-pw-btn">
                    <ShieldCheck className="h-3 w-3" />
                    {t('security.changePasswordBtn')}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-col gap-6">
              {bio?.available && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{t('security.biometricTitle')}</CardTitle>
                    <CardDescription>{t('security.biometricDescription')}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-3">
                      <Switch
                        data-testid="sec-biometric-toggle"
                        checked={!!bio.enrolled}
                        disabled={bioBusy}
                        onCheckedChange={toggleBiometric}
                      />
                      <Label className="font-normal">
                        {t('security.unlockWith', {
                          type:
                            bio.biometryType === 2
                              ? 'Touch ID'
                              : bio.biometryType === 3
                                ? 'Face ID'
                                : t('security.biometricsGeneric'),
                        })}
                      </Label>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card className="border-destructive/30">
                <CardHeader>
                  <CardTitle className="text-base text-destructive">{t('security.dangerZoneTitle')}</CardTitle>
                  <CardDescription>{t('security.dangerZoneDescription')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    onClick={onResetVault}
                    type="button"
                    data-testid="sec-reset-btn"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    {t('security.resetVaultBtn')}
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        );

      case 'audit':
        return (
          <div className="grid max-w-2xl gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('audit.enabledTitle')}</CardTitle>
                <CardDescription>{t('audit.enabledDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <Switch
                    data-testid="audit-enabled-toggle"
                    checked={auditEnabled}
                    onCheckedChange={setAuditEnabled}
                  />
                  <Label className="font-normal">{t('audit.enabledLabel')}</Label>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('audit.levelTitle')}</CardTitle>
                <CardDescription>{t('audit.levelDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="audit-level">{t('audit.levelLabel')}</Label>
                <Select
                  value={auditLevel}
                  onValueChange={(v) => setAuditLevel(normalizeAuditLevel(v))}
                  disabled={!auditEnabled}
                >
                  <SelectTrigger id="audit-level" data-testid="audit-level-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">{t('audit.levelA')}</SelectItem>
                    <SelectItem value="B">{t('audit.levelB')}</SelectItem>
                    <SelectItem value="C">{t('audit.levelC')}</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('audit.retentionTitle')}</CardTitle>
                <CardDescription>{t('audit.retentionDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="audit-retention">{t('audit.retentionLabel')}</Label>
                <Select
                  value={String(auditRetentionDays)}
                  onValueChange={(v) => setAuditRetentionDays(normalizeAuditRetentionDays(Number(v)))}
                  disabled={!auditEnabled}
                >
                  <SelectTrigger id="audit-retention" data-testid="audit-retention-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIT_RETENTION_DAYS.map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {t('audit.retentionDays', { count: days })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('audit.payloadsTitle')}</CardTitle>
                <CardDescription>{t('audit.payloadsDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <Switch
                    data-testid="audit-include-payloads-toggle"
                    checked={auditIncludePayloads}
                    disabled={!auditEnabled}
                    onCheckedChange={setAuditIncludePayloads}
                  />
                  <Label className="font-normal">{t('audit.payloadsLabel')}</Label>
                </div>
              </CardContent>
            </Card>
          </div>
        );

      case 'language':
        return (
          <section className="max-w-md space-y-2">
            <Label>{t('language.label')}</Label>
            <Select
              value={localeSetting}
              onValueChange={(v) => setLocale(v as LocaleSetting)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SYSTEM_LOCALE}>{t('language.system')}</SelectItem>
                {SUPPORTED_LOCALES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t('language.fallbackNote')}</p>
          </section>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background" data-testid="settings-view">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar/40 xl:w-60">
        <div className="shrink-0 border-b border-border px-4 py-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <LayoutGrid className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold leading-tight">{t('nav.title')}</h2>
              <p className="truncate text-[10px] text-muted-foreground">{t('nav.subtitle')}</p>
            </div>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <nav className="flex flex-col gap-0.5 p-2" aria-label={t('nav.sectionsAriaLabel')}>
            {SETTINGS_TABS.map(({ id, labelKey, Icon }) => (
              <button
                key={id}
                type="button"
                data-testid={`settings-tab-${id}`}
                onClick={() => setTab(id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors cursor-pointer',
                  tab === id
                    ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', tab === id ? 'text-primary' : '')} />
                <span className="truncate">{t(labelKey)}</span>
              </button>
            ))}
          </nav>
        </ScrollArea>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-border bg-muted/20 px-6 py-5 lg:px-8">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <activeTab.Icon className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight">{t(activeTab.labelKey)}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">{t(activeTab.descriptionKey)}</p>
            </div>
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 py-6 lg:px-8 lg:py-8">
            {renderTabContent()}
          </div>
        </ScrollArea>

        {activeTab.persistFooter && (
          <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-8">
            <div className="flex min-w-0 items-center gap-3 text-sm">
              {status && <span className="text-success">{status}</span>}
              {error && <span className="text-destructive">{error}</span>}
            </div>
            <Button onClick={saveSettings} disabled={saving} type="button" data-testid="settings-save-btn">
              <Save className="h-3.5 w-3.5" />
              {saving ? t('footer.saving') : t('footer.saveChanges')}
            </Button>
          </footer>
        )}
      </div>
    </div>
  );
};

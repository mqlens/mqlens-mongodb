import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  LayoutGrid,
  Save,
  Terminal,
  Sparkles,
  ShieldCheck,
  ArrowUpCircle,
  Server,
  Keyboard,
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
import { CHECK_UPDATE_EVENT } from './UpdatePrompt';
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
  ai_custom_instructions?: string;
  update_channel?: string;
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
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (ChatGPT)',
  gemini: 'Google Gemini',
  'claude-code': 'Claude Code (local)',
  codex: 'Codex (local)',
  cursor: 'Cursor (local)',
  antigravity: 'Antigravity (local)',
};

type SettingsTabId = 'appearance' | 'ai' | 'mcp' | 'mongosh' | 'updates' | 'shortcuts' | 'security';

const SETTINGS_TABS: {
  id: SettingsTabId;
  label: string;
  description: string;
  Icon: LucideIcon;
  persistFooter?: boolean;
}[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme presets, typography, spacing, and color mode.',
    Icon: LayoutGrid,
  },
  {
    id: 'ai',
    label: 'AI Assistant',
    description: 'Cloud API keys, local agents, and custom query instructions.',
    Icon: Sparkles,
    persistFooter: true,
  },
  {
    id: 'mcp',
    label: 'MCP',
    description: 'Model Context Protocol servers for AI tool integrations.',
    Icon: Server,
  },
  {
    id: 'mongosh',
    label: 'Mongosh',
    description: 'Path to the MongoDB shell binary used by the integrated terminal.',
    Icon: Terminal,
    persistFooter: true,
  },
  {
    id: 'updates',
    label: 'Updates',
    description: 'Release channel and manual update checks.',
    Icon: ArrowUpCircle,
    persistFooter: true,
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Keyboard shortcuts reference for the workspace.',
    Icon: Keyboard,
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Master password, biometrics, and vault recovery.',
    Icon: ShieldCheck,
  },
];

export type { SettingsTabId };

export interface SettingsViewProps {
  initialTab?: SettingsTabId;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ initialTab }) => {
  const [tab, setTab] = useState<SettingsTabId>(initialTab ?? 'appearance');
  const [mongoshPath, setMongoshPath] = useState('');
  const [aiProvider, setAiProvider] = useState('anthropic');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('claude-opus-4-8');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o');
  const [geminiKey, setGeminiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-1.5-flash');
  const [localCommands, setLocalCommands] = useState<Record<string, string>>({});
  const [customInstructions, setCustomInstructions] = useState('');
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
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckSnapshot | null>(() =>
    readUpdateCheckSnapshot(),
  );

  const activeTab = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];

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
        setCustomInstructions(s.ai_custom_instructions || '');
        setUpdateChannel(s.update_channel === 'dev' ? 'dev' : 'stable');
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

  const localCommandFor = (agent: string) =>
    localCommands[agent] ?? DEFAULT_LOCAL_COMMANDS[agent] ?? '{prompt}';

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const current = await invoke<AppSettings>('load_app_settings');
      await invoke('save_app_settings', {
        settings: {
          ...current,
          mongosh_path: mongoshPath.trim(),
          ai_provider: aiProvider,
          anthropic_api_key: anthropicKey.trim(),
          anthropic_model: anthropicModel.trim() || 'claude-opus-4-8',
          openai_api_key: openaiKey.trim(),
          openai_model: openaiModel.trim() || 'gpt-4o',
          gemini_api_key: geminiKey.trim(),
          gemini_model: geminiModel.trim() || 'gemini-1.5-flash',
          local_commands: localCommands,
          ai_custom_instructions: customInstructions,
          update_channel: updateChannel,
        },
      });
      setStatus('Settings saved');
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const testMongosh = async () => {
    setTesting(true);
    setError(null);
    setStatus(null);
    try {
      const version = await invoke<string>('test_mongosh_path', { path: mongoshPath.trim() });
      setStatus(version || 'mongosh path resolved');
    } catch (err) {
      setError(String(err));
    } finally {
      setTesting(false);
    }
  };

  const onChangePw = async () => {
    setSecMsg('');
    if (!oldPw) { setSecMsg('Current password is required'); return; }
    if (!newPw) { setSecMsg('New password is required'); return; }
    if (newPw !== newPw2) { setSecMsg('New passwords do not match'); return; }
    try {
      await changeVaultPassword(oldPw, newPw);
      setSecMsg('Master password changed');
      setOldPw(''); setNewPw(''); setNewPw2('');
    } catch (e) { setSecMsg(String(e)); }
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
    } finally {
      setBioBusy(false);
    }
  };

  const onResetVault = async () => {
    if (!window.confirm('Reset deletes ALL saved connections and API keys. Continue?')) return;
    setSecMsg('');
    try {
      await resetVault();
      setSecMsg('Vault reset — please restart the app.');
    } catch (e) { setSecMsg(String(e)); }
  };

  const renderTabContent = () => {
    switch (tab) {
      case 'appearance':
        return <AppearanceSettings />;

      case 'mcp':
        return (
          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="h-4 w-4 text-primary" />
                MCP Servers
              </CardTitle>
              <CardDescription>
                Configure Model Context Protocol servers for AI integrations. Coming soon (#98).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                MCP server configuration will be available in a future update. You&apos;ll be able to
                add stdio and HTTP servers, manage credentials, and attach them to the AI assistant.
              </p>
            </CardContent>
          </Card>
        );

      case 'updates':
        return (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ArrowUpCircle className="h-4 w-4 text-primary" />
                  Release channel
                </CardTitle>
                <CardDescription>
                  MQLens checks for updates on launch and installs only after you approve.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Channel</Label>
                  <div role="group" aria-label="Update channel" className="flex flex-wrap gap-2">
                    {(['stable', 'dev'] as const).map((ch) => (
                      <Button
                        key={ch}
                        type="button"
                        variant={updateChannel === ch ? 'default' : 'outline'}
                        size="sm"
                        data-testid={`update-channel-${ch}`}
                        onClick={() => setUpdateChannel(ch)}
                      >
                        {ch === 'stable' ? 'Stable' : 'Dev (pre-release)'}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Dev receives pre-release builds. Switching to Dev pulls newer dev builds; switching
                    back to Stable won&apos;t downgrade automatically. Click Save to apply.
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Manual check</CardTitle>
                <CardDescription>Trigger an update check without restarting the app.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {updateCheck ? (
                  <div className="space-y-1 text-sm" data-testid="update-last-checked">
                    <p className="text-muted-foreground">
                      Last checked: {formatLastChecked(updateCheck.checkedAt)}
                    </p>
                    <p className="text-foreground">
                      Result: {updateCheckResultLabel(updateCheck.result)}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="update-last-checked">
                    No update check recorded yet.
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  data-testid="check-updates-btn"
                  onClick={() => window.dispatchEvent(new Event(CHECK_UPDATE_EVENT))}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  Check for updates
                </Button>
              </CardContent>
            </Card>
          </div>
        );

      case 'mongosh':
        return (
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="h-4 w-4 text-success" />
                Mongosh binary
              </CardTitle>
              <CardDescription>
                Absolute path or command name resolved via your system PATH.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mongosh-path">Executable path</Label>
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
                  {testing ? 'Testing...' : 'Test path'}
                </Button>
              </div>
            </CardContent>
          </Card>
        );

      case 'ai':
        return (
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Provider
                </CardTitle>
                <CardDescription>
                  Choose a cloud API or a local agent CLI for the query assistant.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-w-md space-y-2">
                  <Label>Active provider</Label>
                  <Select value={aiProvider} onValueChange={setAiProvider}>
                    <SelectTrigger data-testid="ai-provider-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[...CLOUD_PROVIDERS, ...LOCAL_AGENTS].map((p) => (
                        <SelectItem key={p} value={p}>{PROVIDER_LABELS[p]}</SelectItem>
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
                    <Label htmlFor="anthropic-key">API key</Label>
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
                    <Label htmlFor="anthropic-model">Model</Label>
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
                    <Label htmlFor="openai-key">API key</Label>
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
                    <Label htmlFor="openai-model">Model</Label>
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
                    <Label htmlFor="gemini-key">API key</Label>
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
                    <Label htmlFor="gemini-model">Model</Label>
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
                  <CardTitle className="text-base">Local agent</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {(() => {
                    const det = agents.find((a) => a.id === aiProvider);
                    return (
                      <p className="text-xs text-muted-foreground" data-testid="agent-availability">
                        {det?.available
                          ? `✓ Installed${det.version ? ` — ${det.version}` : ''}`
                          : '✗ Not detected on PATH — install it or set an absolute path below.'}
                      </p>
                    );
                  })()}
                  <div className="space-y-2">
                    <Label htmlFor="local-command">Command (use {'{prompt}'} for the prompt)</Label>
                    <Input
                      id="local-command"
                      className="font-mono"
                      value={localCommandFor(aiProvider)}
                      onChange={(e) => setLocalCommands((prev) => ({ ...prev, [aiProvider]: e.target.value }))}
                      placeholder={DEFAULT_LOCAL_COMMANDS[aiProvider]}
                      data-testid="local-command-input"
                    />
                    <p className="text-xs text-muted-foreground">
                      Runs the agent locally using its own auth — no API key stored.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Custom instructions</CardTitle>
                <CardDescription>Optional system prompt appended to every AI query request.</CardDescription>
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
                  placeholder="e.g. Always project only the fields the user mentions; prefer $regex for text search."
                  data-testid="ai-instructions-input"
                />
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
                  Master password
                </CardTitle>
                <CardDescription>Encrypts stored connections and API keys in the vault.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="sec-old-pw">Current password</Label>
                  <Input
                    id="sec-old-pw"
                    type="password"
                    className="font-mono"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    placeholder="Current password"
                    data-testid="sec-old-pw"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="sec-new-pw">New password</Label>
                    <Input
                      id="sec-new-pw"
                      type="password"
                      className="font-mono"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      placeholder="New password"
                      data-testid="sec-new-pw"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sec-new-pw2">Confirm</Label>
                    <Input
                      id="sec-new-pw2"
                      type="password"
                      className="font-mono"
                      value={newPw2}
                      onChange={(e) => setNewPw2(e.target.value)}
                      placeholder="Confirm new password"
                      data-testid="sec-new-pw2"
                    />
                  </div>
                </div>

                {secMsg && (
                  <div
                    className={cn(
                      'rounded-md px-3 py-2 text-sm',
                      secMsg === 'Master password changed'
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
                    Change password
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-col gap-6">
              {bio?.available && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Biometric unlock</CardTitle>
                    <CardDescription>Unlock the vault with Touch ID or Face ID on this device.</CardDescription>
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
                        Unlock with {bio.biometryType === 2 ? 'Touch ID' : bio.biometryType === 3 ? 'Face ID' : 'biometrics'}
                      </Label>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card className="border-destructive/30">
                <CardHeader>
                  <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
                  <CardDescription>Permanently deletes all saved connections and secrets.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    onClick={onResetVault}
                    type="button"
                    data-testid="sec-reset-btn"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    Reset vault
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
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
              <h2 className="text-sm font-semibold leading-tight">Settings</h2>
              <p className="truncate text-[10px] text-muted-foreground">MQLens preferences</p>
            </div>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <nav className="flex flex-col gap-0.5 p-2" aria-label="Settings sections">
            {SETTINGS_TABS.map(({ id, label, Icon }) => (
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
                <span className="truncate">{label}</span>
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
              <h1 className="text-lg font-semibold tracking-tight">{activeTab.label}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">{activeTab.description}</p>
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
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </footer>
        )}
      </div>
    </div>
  );
};

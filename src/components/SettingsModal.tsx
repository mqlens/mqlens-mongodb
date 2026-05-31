import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, LayoutGrid, Save, Terminal, Sparkles, ShieldCheck } from 'lucide-react';
import { changeVaultPassword, resetVault } from '../lib/vault';

interface AppSettings {
  mongosh_path: string;
  ai_provider?: string;
  anthropic_api_key?: string;
  anthropic_model?: string;
  openai_api_key?: string;
  openai_model?: string;
  gemini_api_key?: string;
  gemini_model?: string;
  local_commands?: Record<string, string>;
  ai_custom_instructions?: string;
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

interface SettingsViewProps {
  density: 'roomy' | 'cozy' | 'compact';
  onChangeDensity: (density: 'roomy' | 'cozy' | 'compact') => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  density,
  onChangeDensity,
}) => {
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
  const [agents, setAgents] = useState<AgentDetection[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Security section state
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [secMsg, setSecMsg] = useState('');

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
      })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    invoke<AgentDetection[]>('detect_local_agents')
      .then((a) => { if (!cancelled) setAgents(a); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const localCommandFor = (agent: string) =>
    localCommands[agent] ?? DEFAULT_LOCAL_COMMANDS[agent] ?? '{prompt}';

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await invoke('save_app_settings', {
        settings: {
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

  const onResetVault = async () => {
    if (!window.confirm('Reset deletes ALL saved connections and API keys. Continue?')) return;
    setSecMsg('');
    try {
      await resetVault();
      setSecMsg('Vault reset — please restart the app.');
    } catch (e) { setSecMsg(String(e)); }
  };

  return (
    <div className="mql-settings" data-testid="settings-view">
      <header className="mql-settings-h">
        <div className="mql-row" style={{ gap: 8 }}>
          <LayoutGrid size={16} className="text-[var(--accent-blue)]" />
          <div>
            <h2>Settings</h2>
            <span className="mql-mono">Application configuration</span>
          </div>
        </div>
      </header>

      <div className="mql-settings-body">
        <section className="mql-settings-section">
          <div className="mql-settings-section-h">
            <LayoutGrid size={13} color="var(--accent-blue)" />
            <span className="mql-label">Layout Density</span>
          </div>
          <div className="mql-density-picker">
            {(['roomy', 'cozy', 'compact'] as const).map((opt) => {
              const isActive = density === opt;
              return (
                <button
                  key={opt}
                  onClick={() => onChangeDensity(opt)}
                  className="mql-density-row"
                  data-testid={`density-option-${opt}`}
                  type="button"
                >
                  <div>
                    <div className="mql-settings-option-title" style={{ color: isActive ? 'var(--accent-blue)' : 'var(--text-main)' }}>
                      {opt}
                    </div>
                    <div className="mql-settings-option-copy">
                      {opt === 'roomy' && 'Larger spacing and font sizing for comfortable reading.'}
                      {opt === 'cozy' && 'Balanced padding and standard grid heights (recommended).'}
                      {opt === 'compact' && 'Dense spacing and smaller font sizes for maximum data display.'}
                    </div>
                  </div>
                  {isActive && <Check size={14} className="text-[var(--accent-green)] flex-shrink-0" data-testid={`density-check-${opt}`} />}
                </button>
              );
            })}
          </div>
        </section>

        <section className="mql-settings-section">
          <div className="mql-settings-section-h">
            <Terminal size={13} color="var(--accent-green)" />
            <span className="mql-label">Mongosh Binary</span>
          </div>
          <label className="mql-field-group">
            <span className="mql-settings-field-label">Executable path</span>
            <input
              className="mql-settings-input mql-mono"
              value={mongoshPath}
              onChange={(event) => setMongoshPath(event.target.value)}
              placeholder="mongosh or /usr/local/bin/mongosh"
              data-testid="mongosh-path-input"
            />
          </label>
          <div className="mql-settings-actions">
            <button className="mql-btn" onClick={testMongosh} disabled={testing} type="button">
              <Terminal size={11} />
              {testing ? 'Testing...' : 'Test Path'}
            </button>
            <button className="mql-btn mql-btn-primary" onClick={saveSettings} disabled={saving} type="button">
              <Save size={11} />
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {status && <div className="mql-settings-status">{status}</div>}
          {error && <div className="mql-settings-error">{error}</div>}
        </section>

        <section className="mql-settings-section">
          <div className="mql-settings-section-h">
            <Sparkles size={13} color="var(--accent-blue)" />
            <span className="mql-label">AI Query Assistant</span>
          </div>

          <label className="mql-field-group">
            <span className="mql-settings-field-label">Provider</span>
            <select
              className="mql-settings-input"
              value={aiProvider}
              onChange={(e) => setAiProvider(e.target.value)}
              data-testid="ai-provider-select"
            >
              {[...CLOUD_PROVIDERS, ...LOCAL_AGENTS].map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </label>

          {aiProvider === 'anthropic' && (
            <>
              <label className="mql-field-group">
                <span className="mql-settings-field-label">Anthropic API key</span>
                <input type="password" className="mql-settings-input mql-mono" value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)} placeholder="sk-ant-..."
                  data-testid="anthropic-key-input" />
              </label>
              <label className="mql-field-group">
                <span className="mql-settings-field-label">Model</span>
                <input className="mql-settings-input mql-mono" value={anthropicModel}
                  onChange={(e) => setAnthropicModel(e.target.value)} placeholder="claude-opus-4-8"
                  data-testid="anthropic-model-input" />
              </label>
            </>
          )}

          {aiProvider === 'openai' && (
            <>
              <label className="mql-field-group">
                <span className="mql-settings-field-label">OpenAI API key</span>
                <input type="password" className="mql-settings-input mql-mono" value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)} placeholder="sk-..."
                  data-testid="openai-key-input" />
              </label>
              <label className="mql-field-group">
                <span className="mql-settings-field-label">Model</span>
                <input className="mql-settings-input mql-mono" value={openaiModel}
                  onChange={(e) => setOpenaiModel(e.target.value)} placeholder="gpt-4o"
                  data-testid="openai-model-input" />
              </label>
            </>
          )}

          {aiProvider === 'gemini' && (
            <>
              <label className="mql-field-group">
                <span className="mql-settings-field-label">Gemini API key</span>
                <input type="password" className="mql-settings-input mql-mono" value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)} placeholder="AIza..."
                  data-testid="gemini-key-input" />
              </label>
              <label className="mql-field-group">
                <span className="mql-settings-field-label">Model</span>
                <input className="mql-settings-input mql-mono" value={geminiModel}
                  onChange={(e) => setGeminiModel(e.target.value)} placeholder="gemini-1.5-flash"
                  data-testid="gemini-model-input" />
              </label>
            </>
          )}

          {(LOCAL_AGENTS as readonly string[]).includes(aiProvider) && (
            <>
              {(() => {
                const det = agents.find((a) => a.id === aiProvider);
                return (
                  <div className="mql-settings-option-copy" data-testid="agent-availability">
                    {det?.available
                      ? `✓ Installed${det.version ? ` — ${det.version}` : ''}`
                      : '✗ Not detected on PATH — install it or set an absolute path below.'}
                  </div>
                );
              })()}
              <label className="mql-field-group">
                <span className="mql-settings-field-label">Command (use {'{prompt}'} for the prompt)</span>
                <input className="mql-settings-input mql-mono" value={localCommandFor(aiProvider)}
                  onChange={(e) => setLocalCommands((prev) => ({ ...prev, [aiProvider]: e.target.value }))}
                  placeholder={DEFAULT_LOCAL_COMMANDS[aiProvider]}
                  data-testid="local-command-input" />
                <span className="mql-settings-option-copy">
                  Runs the agent locally using its own auth — no API key stored. The prompt is passed as a single argument.
                </span>
              </label>
            </>
          )}

          <label className="mql-field-group">
            <span className="mql-settings-field-label">Custom instructions (optional)</span>
            <textarea className="mql-settings-input mql-mono" rows={3} value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder="e.g. Always project only the fields the user mentions; prefer $regex for text search."
              data-testid="ai-instructions-input" />
          </label>

          <div className="mql-settings-actions">
            <button className="mql-btn mql-btn-primary" onClick={saveSettings} disabled={saving} type="button">
              <Save size={11} />
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </section>

        <section className="mql-settings-section">
          <div className="mql-settings-section-h">
            <ShieldCheck size={13} color="var(--accent-amber)" />
            <span className="mql-label">Security</span>
          </div>

          <label className="mql-field-group">
            <span className="mql-settings-field-label">Current master password</span>
            <input
              type="password"
              className="mql-settings-input mql-mono"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              placeholder="Current password"
              data-testid="sec-old-pw"
            />
          </label>
          <label className="mql-field-group">
            <span className="mql-settings-field-label">New master password</span>
            <input
              type="password"
              className="mql-settings-input mql-mono"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="New password"
              data-testid="sec-new-pw"
            />
          </label>
          <label className="mql-field-group">
            <span className="mql-settings-field-label">Confirm new password</span>
            <input
              type="password"
              className="mql-settings-input mql-mono"
              value={newPw2}
              onChange={(e) => setNewPw2(e.target.value)}
              placeholder="Confirm new password"
              data-testid="sec-new-pw2"
            />
          </label>

          {secMsg && (
            <div
              className={secMsg === 'Master password changed' ? 'mql-settings-status' : 'mql-settings-error'}
              data-testid="sec-msg"
            >
              {secMsg}
            </div>
          )}

          <div className="mql-settings-actions">
            <button className="mql-btn mql-btn-primary" onClick={onChangePw} type="button" data-testid="sec-change-pw-btn">
              <ShieldCheck size={11} />
              Change master password
            </button>
            <button className="mql-btn" onClick={onResetVault} type="button" data-testid="sec-reset-btn"
              style={{ color: 'var(--soft-red-text)', borderColor: 'var(--soft-red-bd)' }}>
              Reset vault
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};

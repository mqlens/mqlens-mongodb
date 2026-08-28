/**
 * Add and edit AI providers (#283).
 *
 * The three original providers each had their own card with their own key and
 * model field, which is why adding a fourth meant editing this file and the Rust
 * dispatch. Providers here are data instead: pick the wire format, give it an
 * endpoint, a key and a model, and the backend routes on the format.
 *
 * Presets come from Rust (`ai_provider_presets`) rather than being restated here,
 * because the same base URLs are what the request adapters build their URLs from.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type ProviderKind = 'openai-compatible' | 'anthropic-compatible' | 'local-cli';

export interface AiProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  api_key: string;
  model: string;
  command: string;
}

interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  command: string;
  needsKey: boolean;
}

export const PROVIDER_KINDS: ProviderKind[] = [
  'openai-compatible',
  'anthropic-compatible',
  'local-cli',
];

export function emptyProvider(): AiProvider {
  return {
    id: '',
    name: '',
    kind: 'openai-compatible',
    base_url: '',
    api_key: '',
    model: '',
    command: '',
  };
}

/**
 * A url/name-safe id derived from the display name.
 *
 * The id is what `ai_provider` stores, so it has to be stable and free of the
 * characters a settings file round-trip would complicate. Generated rather than
 * asked for: one field the user has to invent is one more than necessary.
 */
export function slugify(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'provider';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

interface Props {
  providers: AiProvider[];
  onChange: (next: AiProvider[]) => void;
  /** Ids that are already taken by the built-in providers. */
  reservedIds: string[];
}

export const AiProviderManager: React.FC<Props> = ({ providers, onChange, reservedIds }) => {
  const { t } = useTranslation('settings');
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [draft, setDraft] = useState<AiProvider | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ProviderPreset[]>('ai_provider_presets')
      .then(setPresets)
      // Presets only prefill the form; without them every field is still typeable,
      // so a failure here must not block adding a provider.
      .catch(() => setPresets([]));
  }, []);

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = presets.find((p) => p.id === presetId);
      if (!preset) return;
      setDraft((prev) => ({
        ...(prev ?? emptyProvider()),
        name: preset.name,
        kind: preset.kind,
        base_url: preset.baseUrl,
        model: preset.model,
        command: preset.command,
      }));
      setDraftError(null);
    },
    [presets]
  );

  const commit = useCallback(async () => {
    if (!draft) return;
    const taken = [...reservedIds, ...providers.map((p) => p.id)];
    const candidate: AiProvider = {
      ...draft,
      name: draft.name.trim(),
      base_url: draft.base_url.trim(),
      model: draft.model.trim(),
      command: draft.command.trim(),
      id: draft.id || slugify(draft.name, taken),
    };
    try {
      // Validated in Rust so the rules cannot drift from the ones the request
      // path enforces — and so the user sees the problem before saving rather
      // than as a failed generation later.
      await invoke('validate_ai_provider', { provider: candidate });
    } catch (e) {
      setDraftError(String(e));
      return;
    }
    const existing = providers.findIndex((p) => p.id === candidate.id);
    const next = [...providers];
    if (existing >= 0) next[existing] = candidate;
    else next.push(candidate);
    onChange(next);
    setDraft(null);
    setDraftError(null);
  }, [draft, onChange, providers, reservedIds]);

  const kindLabel = (kind: ProviderKind) => t(`ai.providerKinds.${kind}`);
  const isCli = draft?.kind === 'local-cli';

  return (
    <div className="space-y-4" data-testid="ai-provider-manager">
      {providers.length > 0 && (
        <ul className="space-y-2" data-testid="ai-provider-list">
          {providers.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              data-testid={`ai-provider-row-${p.id}`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{p.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {kindLabel(p.kind)} · {p.kind === 'local-cli' ? p.command : `${p.base_url} · ${p.model}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(p);
                    setDraftError(null);
                  }}
                  data-testid={`ai-provider-edit-${p.id}`}
                >
                  {t('ai.providerEdit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => onChange(providers.filter((x) => x.id !== p.id))}
                  aria-label={t('ai.providerRemove')}
                  data-testid={`ai-provider-remove-${p.id}`}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!draft && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDraft(emptyProvider());
            setDraftError(null);
          }}
          data-testid="ai-provider-add"
        >
          <Plus size={14} className="mr-1.5" />
          {t('ai.providerAdd')}
        </Button>
      )}

      {draft && (
        <div className="space-y-4 rounded-md border border-border p-3" data-testid="ai-provider-form">
          {presets.length > 0 && (
            <div className="space-y-2">
              <Label>{t('ai.providerPreset')}</Label>
              <Select value="" onValueChange={applyPreset}>
                <SelectTrigger data-testid="ai-provider-preset-select">
                  <SelectValue placeholder={t('ai.providerPresetPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('ai.providerPresetHint')}</p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ai-provider-name">{t('ai.providerName')}</Label>
              <Input
                id="ai-provider-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                data-testid="ai-provider-name-input"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('ai.providerKind')}</Label>
              <Select
                value={draft.kind}
                onValueChange={(kind) => setDraft({ ...draft, kind: kind as ProviderKind })}
              >
                <SelectTrigger data-testid="ai-provider-kind-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kindLabel(kind)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isCli ? (
            <div className="space-y-2">
              <Label htmlFor="ai-provider-command">{t('ai.providerCommand')}</Label>
              <Input
                id="ai-provider-command"
                className="font-mono"
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder="opencode run {prompt}"
                data-testid="ai-provider-command-input"
              />
              <p className="text-xs text-muted-foreground">{t('ai.providerCommandHint')}</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="ai-provider-url">{t('ai.providerBaseUrl')}</Label>
                <Input
                  id="ai-provider-url"
                  className="font-mono"
                  value={draft.base_url}
                  onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                  data-testid="ai-provider-url-input"
                />
                <p className="text-xs text-muted-foreground">{t('ai.providerBaseUrlHint')}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ai-provider-model">{t('ai.providerModel')}</Label>
                  <Input
                    id="ai-provider-model"
                    className="font-mono"
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    placeholder="deepseek-chat"
                    data-testid="ai-provider-model-input"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ai-provider-key">{t('ai.providerApiKey')}</Label>
                  <Input
                    id="ai-provider-key"
                    type="password"
                    value={draft.api_key}
                    onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
                    data-testid="ai-provider-key-input"
                  />
                  <p className="text-xs text-muted-foreground">{t('ai.providerApiKeyHint')}</p>
                </div>
              </div>
            </>
          )}

          {draftError && (
            <p
              className="flex items-start gap-1.5 text-xs text-destructive"
              data-testid="ai-provider-error"
            >
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              {draftError}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={commit} data-testid="ai-provider-save">
              <Check size={14} className="mr-1.5" />
              {t('ai.providerSave')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setDraftError(null);
              }}
              data-testid="ai-provider-cancel"
            >
              {t('ai.providerCancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

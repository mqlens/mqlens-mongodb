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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Check, AlertCircle, RefreshCw } from 'lucide-react';
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
  /** For `local-cli`: a command whose stdout lists models, one per line. */
  models_command: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  command: string;
  modelsCommand: string;
  needsKey: boolean;
}

/** Select item that hands the field back to free typing. */
const TYPE_MODEL = '__type_a_model__';
/** Select item standing for a typed model the provider did not list. */
const CURRENT_MODEL = '__current_model__';

export const PROVIDER_KINDS: ProviderKind[] = [
  'openai-compatible',
  'anthropic-compatible',
  'local-cli',
];

/**
 * A preset applied to the current draft.
 *
 * The key is kept only if the preset points at the same place the draft already
 * does. Otherwise the auto-load that follows would send one vendor's secret to
 * another vendor's endpoint 600 ms after the click — before anything is saved.
 */
/**
 * `https://api.x.com/v1/chat` → `https://api.x.com`; null while the URL is still
 * being typed, or when nothing would send a request there anyway.
 *
 * Parsed rather than matched with a regex, because the origin decides whether a
 * key follows the endpoint and a regex disagreed with the thing making the
 * request. `https:evil.example/v1` and `https:/evil.example/v1` are request-valid
 * — reqwest's URL parser normalizes both to `https://evil.example` — but matched
 * no `https?://host` pattern, so the origin read as "still typing", the key was
 * kept, and the model load then sent one vendor's secret to another host. `URL`
 * is the same WHATWG parsing the backend applies, so the two now agree.
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null; // not a URL yet, and not one reqwest would accept either
  }
  // Only the schemes this app requests over, and only with a host to send to.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.host === '') return null;
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

/**
 * The draft with a new endpoint. The key is cleared when the *origin* changes:
 * the auto-load 600 ms later would otherwise send the old host's key to the new
 * one. Fixing a path on the same host keeps the key, and so does a URL that has
 * no host yet — clearing while someone is still typing "https://" would be
 * infuriating and protects nothing, since nothing loads without a host.
 */
export function withEndpoint(prev: AiProvider, base_url: string, keyOrigin: string | null): AiProvider {
  const after = originOf(base_url);
  // Compared against the origin the *key* belongs to, not the previous field
  // value: clearing the field and pasting another host is two edits, and
  // comparing with the empty intermediate would keep the key through both.
  const hostChanged = keyOrigin !== null && after !== null && after !== keyOrigin;
  return { ...prev, base_url, api_key: hostChanged ? '' : prev.api_key };
}

/**
 * Whether the service at `baseUrl` authenticates, judged by the presets.
 *
 * Derived from the endpoint rather than remembered from the preset that was
 * clicked, which was wrong in both directions: starting from DeepSeek and then
 * pointing at a keyless LAN server could not be saved without inventing a key,
 * and reopening a saved DeepSeek forgot the requirement entirely, so clearing
 * its key and saving sent the schema and the prompt out unauthenticated.
 */
export function keyRequiredFor(baseUrl: string, presets: ProviderPreset[]): boolean {
  const origin = originOf(baseUrl);
  if (!origin) return false;
  return presets.some((p) => p.needsKey && originOf(p.baseUrl) === origin);
}

export function applyPresetToDraft(prev: AiProvider, preset: ProviderPreset): AiProvider {
  const sameEndpoint =
    prev.kind === preset.kind && prev.base_url.trim().replace(/\/+$/, '') === preset.baseUrl.trim().replace(/\/+$/, '');
  return {
    ...prev,
    name: preset.name,
    kind: preset.kind,
    base_url: preset.baseUrl,
    model: preset.model,
    command: preset.command,
    models_command: preset.modelsCommand,
    api_key: sameEndpoint ? prev.api_key : '',
  };
}

export function emptyProvider(): AiProvider {
  return {
    id: '',
    name: '',
    kind: 'openai-compatible',
    base_url: '',
    api_key: '',
    model: '',
    command: '',
    models_command: '',
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

  // Models the provider says it offers. Purely a convenience layered on a plain
  // text field: if the list cannot be fetched — no network, wrong key, CLI not
  // installed — the field stays typeable and saving is unaffected.
  const [models, setModels] = useState<string[]>([]);
  const [modelsStatus, setModelsStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [modelsError, setModelsError] = useState<string>('');
  // A real dropdown once models are known. `<datalist>` was tried first and is
  // barely surfaced by WKWebView, which is what the app runs in — the user saw
  // "3 models available" and nothing to pick from. Free typing is kept behind a
  // "Type a name…" item so a model missing from the list is still reachable.
  const [modelMode, setModelMode] = useState<'pick' | 'type'>('type');
  // The origin the current key was entered for. Set when the key is typed, when
  // a draft opens, and when a preset keeps the key; cleared with the key.
  const keyOriginRef = useRef<string | null>(null);
  const loadSeq = useRef(0);

  const openDraft = useCallback((p: AiProvider) => {
    keyOriginRef.current = p.api_key ? originOf(p.base_url) : null;
    setDraft(p);
    setDraftError(null);
    setModels([]);
    setModelsStatus('idle');
    setModelsError('');
    setModelMode('type');
  }, []);

  const loadModels = useCallback(async (p: AiProvider) => {
    const seq = ++loadSeq.current;
    setModelsStatus('loading');
    setModelsError('');
    try {
      const raw = await invoke<unknown>('list_ai_models', { provider: p });
      if (seq !== loadSeq.current) return; // a newer request superseded this one
      const list = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : [];
      setModels(list);
      setModelsStatus('loaded');
      if (list.length > 0) setModelMode('pick');
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setModels([]);
      setModelsStatus('error');
      setModelsError(String(e));
    }
  }, []);

  // What the listing needs before it is worth asking: an endpoint for the HTTP
  // kinds (a key too, unless the endpoint is local and wants none), or a
  // listing command for a CLI.
  // Manual loading needs only an address to ask; automatic loading is stricter
  // so a remote endpoint is not hit with no key just to receive a 401. A
  // keyless server on a LAN host, IPv6 loopback or container alias is a valid
  // setup, so the button never depends on the hostname.
  const canLoadModels = (p: AiProvider | null): boolean => {
    if (!p) return false;
    if (p.kind === 'local-cli') return p.models_command.trim() !== '';
    return p.base_url.trim() !== '';
  };
  const canAutoLoad = (p: AiProvider | null): boolean => {
    if (!canLoadModels(p) || !p) return false;
    // Never automatically. A CLI entry is an arbitrary shell command, and a
    // debounce would run it while it was still being typed — a half-finished
    // `touch …` has already happened by the time the user notices. Listing a
    // CLI's models stays behind the explicit Load models click.
    if (p.kind === 'local-cli') return false;
    return p.api_key.trim() !== '' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(p.base_url.trim());
  };

  // Auto-load once the inputs are there, debounced so a key being typed does
  // not fire a request per keystroke.
  const draftUrl = draft?.base_url ?? '';
  const draftKey = draft?.api_key ?? '';
  const draftModelsCommand = draft?.models_command ?? '';
  const draftKind = draft?.kind;
  useEffect(() => {
    // Any change to what a request would ask makes the previous answer stale —
    // whether it is still in flight or already displayed. Dropping only the
    // in-flight one left a loaded dropdown offering the *old* provider's models,
    // and a model from it could be saved against the new one.
    loadSeq.current += 1;
    setModels([]);
    setModelsStatus('idle');
    setModelsError('');
    setModelMode('type');
    if (!draft || !canAutoLoad(draft)) return;
    const handle = window.setTimeout(() => void loadModels(draft), 600);
    return () => window.clearTimeout(handle);
    // Only the inputs that change what the request asks for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftUrl, draftKey, draftModelsCommand, draftKind]);

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
      // Computed here rather than inside the updater: React may run an updater
      // during render and runs it twice under StrictMode, so writing the ref in
      // there is a side effect in a function that has to be pure.
      const next = applyPresetToDraft(draft ?? emptyProvider(), preset);
      keyOriginRef.current = next.api_key ? originOf(next.base_url) : null;
      setDraft(next);
      setDraftError(null);
    },
    [presets, draft]
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
      models_command: draft.models_command.trim(),
      api_key: draft.api_key.trim(),
      id: draft.id || slugify(draft.name, taken),
    };
    if (
      candidate.kind !== 'local-cli' &&
      candidate.api_key === '' &&
      keyRequiredFor(candidate.base_url, presets)
    ) {
      // Rust refuses this too (`authenticated_service` in `validate`), so this is
      // not the only line of defence — it is here to name the provider and the
      // field before a round trip, rather than surfacing as a backend error.
      setDraftError(t('ai.providerKeyRequired', { name: candidate.name }));
      return;
    }
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
    // `presets` included deliberately: `keyRequiredFor` reads it, and the list
    // arrives asynchronously — without it this callback kept the initial empty
    // array and a preset endpoint that requires a key could be saved without one.
  }, [draft, onChange, providers, reservedIds, presets]);

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
                  onClick={() => openDraft(p)}
                  data-testid={`ai-provider-edit-${p.id}`}
                >
                  {t('ai.providerEdit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    // Leaving the form open on a removed provider meant Save found
                    // no match and pushed it back, silently undoing the removal.
                    if (draft?.id === p.id) {
                      setDraft(null);
                      setDraftError(null);
                    }
                    onChange(providers.filter((x) => x.id !== p.id));
                  }}
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
          onClick={() => openDraft(emptyProvider())}
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
                onValueChange={(kind) => {
                  if (kind !== draft.kind) keyOriginRef.current = null;
                  setDraft({ ...draft, kind: kind as ProviderKind, api_key: kind === draft.kind ? draft.api_key : '' });
                }}
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
            <>
              <div className="space-y-2">
                <Label htmlFor="ai-provider-command">{t('ai.providerCommand')}</Label>
                <Input
                  id="ai-provider-command"
                  className="font-mono"
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder="ollama run {model} {prompt}"
                  data-testid="ai-provider-command-input"
                />
                <p className="text-xs text-muted-foreground">{t('ai.providerCommandHint')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-provider-models-command">{t('ai.providerModelsCommand')}</Label>
                <Input
                  id="ai-provider-models-command"
                  className="font-mono"
                  value={draft.models_command}
                  onChange={(e) => setDraft({ ...draft, models_command: e.target.value })}
                  placeholder="ollama list"
                  data-testid="ai-provider-models-command-input"
                />
                <p className="text-xs text-muted-foreground">{t('ai.providerModelsCommandHint')}</p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="ai-provider-url">{t('ai.providerBaseUrl')}</Label>
                <Input
                  id="ai-provider-url"
                  className="font-mono"
                  value={draft.base_url}
                  onChange={(e) => {
                    const next = withEndpoint(draft, e.target.value, keyOriginRef.current);
                    if (!next.api_key) keyOriginRef.current = null;
                    setDraft(next);
                  }}
                  placeholder="https://api.deepseek.com/v1"
                  data-testid="ai-provider-url-input"
                />
                <p className="text-xs text-muted-foreground">{t('ai.providerBaseUrlHint')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-provider-key">{t('ai.providerApiKey')}</Label>
                <Input
                  id="ai-provider-key"
                  type="password"
                  value={draft.api_key}
                  onChange={(e) => {
                    // A key typed now belongs to the endpoint shown now.
                    keyOriginRef.current = e.target.value ? originOf(draft.base_url) : null;
                    setDraft({ ...draft, api_key: e.target.value });
                  }}
                  data-testid="ai-provider-key-input"
                />
                <p className="text-xs text-muted-foreground">{t('ai.providerApiKeyHint')}</p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="ai-provider-model">{t('ai.providerModel')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={!canLoadModels(draft) || modelsStatus === 'loading'}
                onClick={() => void loadModels(draft)}
                data-testid="ai-provider-models-load"
              >
                <RefreshCw size={12} className={modelsStatus === 'loading' ? 'animate-spin' : ''} />
                {t('ai.providerModelsLoad')}
              </Button>
            </div>
            {modelMode === 'pick' && models.length > 0 ? (
              <Select
                value={draft.model && !models.includes(draft.model) ? CURRENT_MODEL : draft.model}
                onValueChange={(v) => {
                  if (v === TYPE_MODEL) {
                    setModelMode('type');
                    return;
                  }
                  if (v === CURRENT_MODEL) return;
                  setDraft({ ...draft, model: v });
                }}
              >
                <SelectTrigger className="font-mono" data-testid="ai-provider-model-select">
                  <SelectValue placeholder={isCli ? 'llama3' : 'deepseek-chat'} />
                </SelectTrigger>
                <SelectContent data-testid="ai-provider-model-options">
                  {/* A model typed earlier that the provider did not list stays selectable. */}
                  {draft.model && !models.includes(draft.model) && (
                    <SelectItem value={CURRENT_MODEL} className="font-mono">
                      {draft.model}
                    </SelectItem>
                  )}
                  {models.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono">
                      {m}
                    </SelectItem>
                  ))}
                  <SelectItem value={TYPE_MODEL} data-testid="ai-provider-model-type-own">
                    {t('ai.providerModelTypeOwn')}
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="ai-provider-model"
                className="font-mono"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder={isCli ? 'llama3' : 'deepseek-chat'}
                data-testid="ai-provider-model-input"
              />
            )}
            <p className="text-xs text-muted-foreground" data-testid="ai-provider-models-status">
              {modelsStatus === 'loading' && t('ai.providerModelsLoading')}
              {modelsStatus === 'loaded' && t('ai.providerModelsLoaded', { count: models.length })}
              {modelsStatus === 'error' && t('ai.providerModelsFailed', { error: modelsError })}
              {modelsStatus === 'idle' && (isCli ? t('ai.providerModelCliHint') : t('ai.providerModelHint'))}
            </p>
          </div>

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

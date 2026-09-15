// AI helper commands (#396). Providers come from the saved settings, and the
// models they list from the seed. Each generation takes the next reply from the
// seed's queue; once the queue is empty it fails the way it does with no
// provider configured.
import type { Backend, Handler } from '../backend';
import type { E2EState } from '../state';

interface ProviderDraft {
  id?: string;
  name?: string;
  kind?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  command?: string;
  models_command?: string;
}

/** The built-in agents' command templates (`default_local_command` in src-tauri/src/connections.rs). */
const DEFAULT_LOCAL_COMMANDS: Record<string, string> = {
  'claude-code': 'claude -p {prompt}',
  codex: 'codex exec {prompt}',
  cursor: 'cursor-agent -p {prompt}',
  antigravity: 'antigravity {prompt}',
};

const LOCAL_AGENTS: Array<[string, string]> = [
  ['claude-code', 'Claude Code (local)'],
  ['codex', 'Codex (local)'],
  ['cursor', 'Cursor (local)'],
  ['antigravity', 'Antigravity (local)'],
];

/**
 * The providers the chat panel can pick from, built from the saved settings the
 * way `ai_provider_options` builds them (src-tauri/src/lib.rs): the built-in
 * vendors and local agents, then the user's own, with the settings default
 * flagged. A setting that was never saved takes the backend's default.
 */
function providerOptions(settings: Record<string, unknown>): unknown[] {
  const text = (key: string, fallback: string) => (typeof settings[key] === 'string' ? (settings[key] as string) : fallback);
  const defaultId = text('ai_provider', 'anthropic').trim();
  const localCommands = (settings.local_commands ?? {}) as Record<string, string>;
  const entry = (id: string, name: string, kind: string, model: string, usesModel: boolean, canListModels: boolean) => ({
    id,
    name,
    kind,
    model,
    isDefault: id === defaultId,
    usesModel,
    canListModels,
  });
  const agentCommand = (agent: string) => (localCommands[agent]?.trim() ? localCommands[agent] : DEFAULT_LOCAL_COMMANDS[agent]);
  return [
    entry('anthropic', 'Anthropic (Claude)', 'anthropic-compatible', text('anthropic_model', 'claude-opus-4-8'), true, true),
    entry('openai', 'OpenAI (ChatGPT)', 'openai-compatible', text('openai_model', 'gpt-4o'), true, true),
    // Listed for selection only: `list_ai_models_for` refuses Gemini.
    entry('gemini', 'Google Gemini', 'gemini', text('gemini_model', 'gemini-1.5-flash'), true, false),
    // A built-in agent uses a model only when its command slots one in, and never lists models.
    ...LOCAL_AGENTS.map(([agent, label]) => entry(agent, label, 'local-cli', '', agentCommand(agent).includes('{model}'), false)),
    ...((settings.ai_providers ?? []) as ProviderDraft[]).map((provider) => {
      const local = provider.kind === 'local-cli';
      return entry(
        provider.id ?? '',
        provider.name ?? '',
        provider.kind ?? '',
        provider.model ?? '',
        !local || (provider.command ?? '').includes('{model}'),
        local ? (provider.models_command ?? '').trim() !== '' : true,
      );
    }),
  ];
}

/**
 * Services known to authenticate every request, by a URL on their host: the
 * key-needing presets first, then the built-in OpenAI, Anthropic and Gemini
 * endpoints (`authenticated_service` in src-tauri/src/ai_providers.rs).
 */
const AUTHENTICATED_SERVICES: Array<[string, string]> = [
  ['https://api.deepseek.com/v1', 'DeepSeek'],
  ['https://openrouter.ai/api/v1', 'OpenRouter'],
  ['https://api.groq.com/openai/v1', 'Groq'],
  ['https://api.together.xyz/v1', 'Together AI'],
  ['https://api.mistral.ai/v1', 'Mistral'],
  ['https://api.x.ai/v1', 'xAI (Grok)'],
  ['https://api.anthropic.com/v1', 'Anthropic-compatible endpoint'],
  ['https://api.openai.com/v1/chat/completions', 'OpenAI'],
  ['https://api.anthropic.com/v1/messages', 'Anthropic'],
  ['https://generativelanguage.googleapis.com/v1beta/models', 'Google Gemini'],
];

/** An http(s) URL, or null for anything this app wouldn't send a request to. */
function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '' ? parsed : null;
  } catch {
    return null;
  }
}

const hostOf = (url: string) => parseHttpUrl(url)?.hostname.toLowerCase() ?? null;

/** The service a URL reaches, when it's one that authenticates requests; the scheme doesn't matter. */
function authenticatedService(url: string): string | undefined {
  const host = hostOf(url);
  return host === null ? undefined : AUTHENTICATED_SERVICES.find(([known]) => hostOf(known) === host)?.[1];
}

/** Whether a request to `url` would leave this machine without TLS (`is_cleartext_remote`). */
function isCleartextRemote(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed || parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  return !(/^127\.\d+\.\d+\.\d+$/.test(host) || host === '::1');
}

const SCOPE_FIELDS = ['connectionName', 'database', 'collection', 'variant'] as const;

/** The messages a saved chat keeps (`MAX_MESSAGES` in src-tauri/src/chats.rs). */
const MAX_CHAT_MESSAGES = 200;

/** Whether a stored chat belongs to a history scope; a null scope takes in every chat. */
function inScope(chat: Record<string, unknown>, scope: unknown): boolean {
  if (!scope) return true;
  const within = scope as Record<string, unknown>;
  return SCOPE_FIELDS.every((field) => chat[field] === within[field]);
}

export function registerAiHandlers(backend: Backend, state: E2EState): void {
  const chats = new Map<string, Record<string, unknown>>();
  // Which panel holds each open chat, by chat id (`open_chats` in chats.rs).
  const claims = new Map<string, string>();

  const handlers: Record<string, Handler> = {
    ai_provider_options: () => providerOptions(state.settings),
    // The first two of src-tauri/src/ai_providers.rs PRESETS, shaped as the command returns them.
    ai_provider_presets: () => [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        command: '',
        modelsCommand: '',
        needsKey: true,
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        kind: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: '',
        command: '',
        modelsCommand: '',
        needsKey: true,
      },
    ],
    list_ai_models_for: () => structuredClone(state.aiModels),
    list_ai_models: () => structuredClone(state.aiModels),
    // `AiProvider::validate` and `check_transport` (src-tauri/src/ai_providers.rs),
    // in their order and with their messages.
    validate_ai_provider: ({ provider }) => {
      const draft = (provider ?? {}) as ProviderDraft;
      const name = draft.name?.trim() ?? '';
      if (!draft.id?.trim()) throw 'A provider needs an id.';
      if (!name) throw `Provider \`${draft.id}\` needs a display name.`;
      if (draft.kind === 'local-cli') {
        const command = draft.command?.trim() ?? '';
        if (!command) throw `${draft.name} needs a command.`;
        if (command.includes('{model}') && !draft.model?.trim()) {
          throw `${draft.name}'s command uses {model} but no model is set. Load the list or type one.`;
        }
        return null;
      }
      const baseUrl = draft.base_url?.trim() ?? '';
      if (!baseUrl) throw `${draft.name} has no endpoint URL. Add one in Settings → AI.`;
      if (hostOf(baseUrl) === null) {
        throw `${draft.name}'s URL must be an http:// or https:// address with a host. \`${baseUrl}\` is not one.`;
      }
      if (!draft.model?.trim()) throw `${draft.name} needs a model name.`;
      // Transport first: over http:// the answer is "use https", not "add a key".
      const service = authenticatedService(baseUrl);
      if (service && parseHttpUrl(baseUrl)?.protocol !== 'https:') {
        throw `${draft.name} must reach ${service} over https://. Over http:// the collection schema, your prompt and any API key would cross the network in clear text.`;
      }
      const key = draft.api_key?.trim() ?? '';
      if (key && isCleartextRemote(baseUrl)) {
        throw `${draft.name}'s API key would be sent in clear text, because its URL is http:// and not on this machine. Use https://, or remove the key.`;
      }
      if (!key && service) {
        throw `${draft.name} needs an API key: ${service} authenticates every request, so without one the collection schema and your prompt would be sent to it unauthenticated.`;
      }
      return null;
    },
    generate_mql_query: () => {
      const reply = state.aiReplies.shift();
      if (!reply) throw 'No AI provider is configured';
      if ('error' in reply) throw reply.error;
      return { query: JSON.stringify(reply.query), thoughts: reply.thoughts, notes: reply.notes };
    },

    // Summaries, newest first, of the chats in a scope (or every chat when it's null).
    list_chats: ({ scope }) =>
      [...chats.values()]
        .filter((chat) => inScope(chat, scope))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((chat) => ({
          connectionName: chat.connectionName,
          database: chat.database,
          collection: chat.collection,
          variant: chat.variant,
          id: chat.id,
          title: chat.title,
          updatedAt: chat.updatedAt,
          messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
        })),
    load_chat: ({ id }) => structuredClone(chats.get(String(id)) ?? null),
    // A panel saves the whole chat from the copy it loaded. A reply parked since
    // then by append_chat_message isn't in that copy, so it's kept at the end
    // (`merge_appended`), and the newest messages up to the limit are stored.
    save_chat: ({ chat }) => {
      const next = structuredClone(chat as Record<string, unknown>);
      const stored = chats.get(String(next.id));
      const messages = Array.isArray(next.messages) ? (next.messages as Array<Record<string, unknown>>) : [];
      if (stored && Array.isArray(stored.messages)) {
        const have = new Set(messages.map((message) => message.id));
        const missed = (stored.messages as Array<Record<string, unknown>>).filter((message) => !have.has(message.id));
        messages.push(...structuredClone(missed));
      }
      next.messages = messages.slice(-MAX_CHAT_MESSAGES);
      chats.set(String(next.id), next);
      return null;
    },
    // A reply that finished after its tab moved on, parked in its saved chat
    // (src-tauri/src/chats.rs): the next message id, the oldest dropped past
    // the limit, and the caller's timestamp. An unknown chat is ignored.
    append_chat_message: ({ chatId, role, text, query, error, thoughts, toolCalls, updatedAt }) => {
      const chat = chats.get(String(chatId));
      if (!chat) return null;
      const messages = Array.isArray(chat.messages) ? (chat.messages as Array<Record<string, unknown>>) : [];
      const last = messages.reduce((max, message) => Math.max(max, Number(String(message.id).slice(1)) || 0), -1);
      messages.push({
        id: `m${last + 1}`,
        role,
        text,
        ...(query == null ? {} : { query }),
        ...(error == null ? {} : { error }),
        ...(thoughts == null ? {} : { thoughts }),
        ...(toolCalls == null ? {} : { toolCalls }),
      });
      if (messages.length > MAX_CHAT_MESSAGES) messages.splice(0, messages.length - MAX_CHAT_MESSAGES);
      chat.messages = messages;
      chat.updatedAt = updatedAt;
      return null;
    },
    delete_chat: ({ id }) => {
      chats.delete(String(id));
      return null;
    },
    clear_chats: ({ scope }) => {
      for (const [id, chat] of chats) if (inScope(chat, scope)) chats.delete(id);
      return null;
    },
    // A renamed namespace takes its saved chats with it. A null collection moves
    // every chat in the database, and a null variant every variant.
    retarget_chat_scope: ({ connectionName, database, collection, variant, newDatabase, newCollection }) => {
      for (const chat of chats.values()) {
        const moves =
          chat.connectionName === connectionName &&
          chat.database === database &&
          (collection == null || chat.collection === collection) &&
          (variant == null || chat.variant === variant);
        if (!moves) continue;
        chat.database = newDatabase;
        if (newCollection != null) chat.collection = newCollection;
      }
      return null;
    },
    // One panel at a time holds a chat, so two can't overwrite each other's
    // snapshots. Claiming again as the holder succeeds; another owner is refused.
    claim_chat: ({ chatId, owner }) => {
      const holder = claims.get(String(chatId));
      if (holder !== undefined && holder !== owner) return false;
      claims.set(String(chatId), String(owner));
      return true;
    },
    // A release from anyone but the holder is ignored, so a late one can't free a chat its new holder took.
    release_chat: ({ chatId, owner }) => {
      if (claims.get(String(chatId)) === owner) claims.delete(String(chatId));
      return null;
    },
    release_owner_chats: ({ owner }) => {
      for (const [id, holder] of claims) if (holder === owner) claims.delete(id);
      return null;
    },
  };

  backend.register(handlers);
}

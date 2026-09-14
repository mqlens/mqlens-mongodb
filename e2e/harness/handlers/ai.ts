// AI helper commands (#396). Providers and the models they list come from the
// seed. Each generation takes the next reply from the seed's queue; once the
// queue is empty it fails the way it does with no provider configured.
import type { Backend, Handler } from '../backend';
import type { E2EState } from '../state';

interface ProviderDraft {
  id?: string;
  name?: string;
  kind?: string;
  base_url?: string;
  model?: string;
  command?: string;
}

const SCOPE_FIELDS = ['connectionName', 'database', 'collection', 'variant'] as const;

/** Whether a stored chat belongs to a history scope; a null scope takes in every chat. */
function inScope(chat: Record<string, unknown>, scope: unknown): boolean {
  if (!scope) return true;
  const within = scope as Record<string, unknown>;
  return SCOPE_FIELDS.every((field) => chat[field] === within[field]);
}

export function registerAiHandlers(backend: Backend, state: E2EState): void {
  const chats = new Map<string, Record<string, unknown>>();

  const handlers: Record<string, Handler> = {
    ai_provider_options: () => structuredClone(state.aiProviders),
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
    // The checks of ai_providers.rs validate_provider a form can trip, with its messages.
    validate_ai_provider: ({ provider }) => {
      const draft = (provider ?? {}) as ProviderDraft;
      if (!draft.id) throw 'A provider needs an id.';
      if (!draft.name) throw `Provider \`${draft.id}\` needs a display name.`;
      if (draft.kind === 'local-cli') {
        if (!draft.command) throw `${draft.name} needs a command.`;
        return null;
      }
      if (!draft.base_url) throw `${draft.name} has no endpoint URL. Add one in Settings → AI.`;
      if (!draft.model) throw `${draft.name} needs a model name.`;
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
    save_chat: ({ chat }) => {
      const next = chat as Record<string, unknown>;
      chats.set(String(next.id), structuredClone(next));
      return null;
    },
    append_chat_message: () => null,
    delete_chat: ({ id }) => {
      chats.delete(String(id));
      return null;
    },
    clear_chats: ({ scope }) => {
      for (const [id, chat] of chats) if (inScope(chat, scope)) chats.delete(id);
      return null;
    },
    retarget_chat_scope: () => null,
    claim_chat: () => true,
    release_chat: () => null,
    release_owner_chats: () => null,
  };

  backend.register(handlers);
}

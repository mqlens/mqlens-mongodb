// AI helper commands (#396). Enough for the panel to open and keep its chat
// history; providers come from the seed, and with none configured the panel
// shows its set-up state.
import type { Backend, Handler } from '../backend';
import type { E2EState } from '../state';

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
    list_ai_models_for: () => [],
    generate_mql_query: () => {
      throw 'No AI provider is configured';
    },

    list_chats: () => [...chats.values()].map((chat) => structuredClone(chat)),
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
    clear_chats: () => {
      chats.clear();
      return null;
    },
    retarget_chat_scope: () => null,
    claim_chat: () => true,
    release_chat: () => null,
    release_owner_chats: () => null,
  };

  backend.register(handlers);
}

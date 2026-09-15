// App shell commands: vault, settings, workspace, windows, polling, updater,
// crash logging and the Tauri plugins the app uses (#396).
import type { Backend, Handler } from '../backend';
import { jsonEqual } from '../mongo';
import type { E2EState } from '../state';
import { recordTask } from '../tasks';

/** The settings the AI provider options are built from, and the built-in keys (`ai_options_changed` in src-tauri/src/lib.rs). */
const AI_OPTION_FIELDS = [
  'ai_provider', 'ai_providers', 'anthropic_model', 'openai_model', 'gemini_model', 'local_commands',
  'anthropic_api_key', 'openai_api_key', 'gemini_api_key',
];

export function registerAppHandlers(backend: Backend, state: E2EState): void {
  const requireUnlocked = () => {
    // Settings live in the encrypted vault, so the backend refuses them while it's locked.
    if (state.vault !== 'unlocked') throw 'vault is locked';
  };

  // A locked vault never leaves the embedded MCP server listening
  // (`mcp::stop_if_running`). Its settings still say it's enabled, so the next
  // unlock starts it again with the token it had (`mcp::restore_on_unlock`).
  let mcpToRestore: { port: number; token: string } | null = null;
  const stopMcp = () => {
    mcpToRestore = state.mcp.enabled ? { port: state.mcp.port, token: state.mcp.token } : null;
    state.mcp.enabled = false;
    state.mcp.token = '';
  };
  const restoreMcp = () => {
    if (!mcpToRestore) return;
    state.mcp.enabled = true;
    state.mcp.port = mcpToRestore.port;
    state.mcp.token = mcpToRestore.token;
    mcpToRestore = null;
  };

  const handlers: Record<string, Handler> = {
    // Vault and biometrics
    vault_status: () => state.vault,
    vault_initialize: ({ password }) => {
      state.vaultPassword = String(password);
      state.vault = 'unlocked';
      return null;
    },
    vault_unlock: ({ password }) => {
      if (state.vaultPassword !== null && password !== state.vaultPassword) throw 'Incorrect master password';
      state.vault = 'unlocked';
      restoreMcp();
      return 'unlocked';
    },
    vault_lock: () => {
      state.vault = 'locked';
      stopMcp();
      return null;
    },
    vault_change_password: ({ oldPassword, newPassword }) => {
      if (state.vaultPassword !== null && oldPassword !== state.vaultPassword) throw 'Incorrect master password';
      state.vaultPassword = String(newPassword);
      return null;
    },
    // A reset deletes everything the vault held: the activity log, profiles and
    // settings, the MCP server's saved state and the biometric copy of the key.
    vault_reset: () => {
      state.audit.events = [];
      state.vault = 'uninitialized';
      state.vaultPassword = null;
      state.profiles = [];
      state.settings = {};
      stopMcp();
      mcpToRestore = null;
      state.biometric.enrolled = false;
      return null;
    },
    biometric_status: () => {
      const { available, biometryType, enrolled } = state.biometric;
      return { available, biometryType, enrolled };
    },
    biometric_unlock: () => {
      if (!state.biometric.available || !state.biometric.enrolled) throw 'Biometric unlock is not available';
      if (state.biometric.unlockError) throw state.biometric.unlockError;
      state.vault = 'unlocked';
      restoreMcp();
      return 'unlocked';
    },
    biometric_enable: () => {
      state.biometric.enrolled = true;
      return null;
    },
    biometric_disable: () => {
      state.biometric.enrolled = false;
      return null;
    },

    // Settings
    load_app_settings: () => {
      requireUnlocked();
      return structuredClone(state.settings);
    },
    patch_app_settings: async ({ patch }) => {
      requireUnlocked();
      const before = structuredClone(state.settings);
      Object.assign(state.settings, patch as Record<string, unknown>);
      // Every open AI panel re-reads its provider options when a setting they're built from changes.
      if (AI_OPTION_FIELDS.some((field) => !jsonEqual(before[field], state.settings[field]))) {
        await backend.emit('ai-providers-changed', null);
      }
      return null;
    },

    // Workspace persistence and windows
    workspace_get: () => structuredClone(state.workspace),
    workspace_apply: ({ op }) => {
      state.workspaceOps.push(op);
      return null;
    },
    spawn_saved_windows: () => null,
    focus_window: () => null,
    workspace_detach_tab: () => null,
    close_workspace_window: () => null,

    // Background polls
    get_resource_usage: () => ({ cpu_percent: 1.5, memory_bytes: 128 * 1024 * 1024 }),
    list_export_tasks: () => structuredClone(state.tasks),
    clear_finished_export_tasks: () => {
      state.tasks = state.tasks.filter((task) => task.status === 'running');
      return structuredClone(state.tasks);
    },
    cancel_task: ({ id }) => {
      const task = state.tasks.find((candidate) => candidate.id === id);
      if (task) task.status = 'cancelled';
      return null;
    },

    // Managed tool install (mongosh, database tools), finished at once like every fake task.
    start_tool_install_task: ({ tools }) =>
      recordTask(state, {
        kind: 'tool_install',
        label: `Install ${((tools as string[] | undefined) ?? []).join(', ')}`,
        startMessage: 'Downloading…',
        message: 'Installed',
        processed: 1,
        total: 1,
      }),

    // Updater and crash log
    update_check: () => null,
    update_install: () => null,
    log_frontend_error: ({ message }) => {
      state.frontendErrors.push(String(message));
      return null;
    },

    // Tauri plugins
    'plugin:app|version': () => state.appVersion,
    'plugin:path|resolve_directory': () => '/tmp/MQLens',
    'plugin:opener|open_url': () => null,
    'plugin:process|restart': () => null,
    'plugin:dialog|open': () => structuredClone(state.dialog.open),
    'plugin:dialog|save': () => structuredClone(state.dialog.save),
    'plugin:fs|write_text_file': () => null,
    // The plugin decodes the bytes it gets back itself.
    'plugin:fs|read_text_file': ({ path }) => {
      const text = state.files[String(path)];
      if (text === undefined) throw `failed to open file at path: ${String(path)}`;
      return Array.from(new TextEncoder().encode(text));
    },
  };

  backend.register(handlers);
}

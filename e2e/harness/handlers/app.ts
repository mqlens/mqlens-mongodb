// App shell commands: vault, settings, workspace, windows, polling, updater,
// crash logging and the Tauri plugins the app uses (#396).
import type { Backend, Handler } from '../backend';
import type { E2EState } from '../state';

export function registerAppHandlers(backend: Backend, state: E2EState): void {
  const requireUnlocked = () => {
    // Settings live in the encrypted vault, so the backend refuses them while it's locked.
    if (state.vault !== 'unlocked') throw 'vault is locked';
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
      return 'unlocked';
    },
    vault_lock: () => {
      state.vault = 'locked';
      return null;
    },
    vault_change_password: ({ oldPassword, newPassword }) => {
      if (state.vaultPassword !== null && oldPassword !== state.vaultPassword) throw 'Incorrect master password';
      state.vaultPassword = String(newPassword);
      return null;
    },
    vault_reset: () => {
      state.vault = 'uninitialized';
      state.vaultPassword = null;
      state.profiles = [];
      return null;
    },
    biometric_status: () => ({ available: false, biometryType: 0, enrolled: false }),
    biometric_unlock: () => {
      throw 'Biometric unlock is not available';
    },
    biometric_enable: () => null,
    biometric_disable: () => null,

    // Settings
    load_app_settings: () => {
      requireUnlocked();
      return structuredClone(state.settings);
    },
    patch_app_settings: ({ patch }) => {
      requireUnlocked();
      Object.assign(state.settings, patch as Record<string, unknown>);
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
    // Tab-close cleanup: closing a tab stops any change stream it ran, whether or
    // not it had one. Its shell session is released in ./shell.
    stop_change_stream: () => null,

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
  };

  backend.register(handlers);
}

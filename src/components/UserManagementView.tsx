import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Users,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { useDialogs } from './dialogs/DialogProvider';
import { useEscapeClose } from '../lib/useEscapeClose';
import {
  listUsers,
  createUser,
  updateUser,
  dropUser,
  listRoles,
  type MongoUser,
  type RoleSpec,
} from '../lib/usersApi';

const ALL_DBS = '__all__';

interface UserManagementViewProps {
  connectionId: string;
}

interface EditorState {
  mode: 'create' | 'edit';
  user?: MongoUser;
}

// ── User editor modal (shared by create & edit) ───────────────────────────────

interface UserEditorModalProps {
  connectionId: string;
  editor: EditorState;
  databases: string[];
  onClose: () => void;
  onSaved: () => void;
}

const UserEditorModal: React.FC<UserEditorModalProps> = ({
  connectionId,
  editor,
  databases,
  onClose,
  onSaved,
}) => {
  const { toast } = useDialogs();
  const isEdit = editor.mode === 'edit';
  const [username, setUsername] = useState(editor.user?.user ?? '');
  const [authDb, setAuthDb] = useState(editor.user?.db ?? (databases[0] || 'admin'));
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<RoleSpec[]>(
    editor.user?.roles?.length ? editor.user.roles.map((r) => ({ ...r })) : []
  );
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeClose(true, onClose);

  // Role-name suggestions for the picker; built-in names are db-agnostic.
  useEffect(() => {
    let cancelled = false;
    listRoles(connectionId, authDb || 'admin')
      .then((rs) => {
        if (cancelled) return;
        setRoleNames([...new Set(rs.map((r) => r.role))]);
      })
      .catch(() => {
        // Suggestions are best-effort; free-text role entry still works.
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, authDb]);

  const setRole = (idx: number, updates: Partial<RoleSpec>) =>
    setRoles((prev) => prev.map((r, i) => (i === idx ? { ...r, ...updates } : r)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const name = username.trim();
    if (!name) {
      setError('Username is required');
      return;
    }
    if (!isEdit && !password) {
      setError('Password is required');
      return;
    }
    const cleanRoles = roles
      .map((r) => ({ role: r.role.trim(), db: r.db.trim() || authDb }))
      .filter((r) => r.role);
    setSaving(true);
    try {
      if (isEdit) {
        await updateUser(connectionId, authDb, name, password || null, cleanRoles);
        toast(`Updated user ${name}`, 'success');
      } else {
        await createUser(connectionId, authDb, name, password, cleanRoles);
        toast(`Created user ${name}`, 'success');
      }
      onSaved();
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="nested-modal-overlay select-none" data-testid="user-editor-modal" onClick={onClose}>
      <div className="index-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3 mb-4 select-none">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-[var(--accent-blue)]" />
            <h2 className="text-sm font-semibold text-[var(--text-main)]">
              {isEdit ? `Edit User: ${editor.user?.user}` : 'Create New User'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--bg-item-hover)] rounded text-[var(--text-muted)] hover:text-[var(--text-main)] cursor-pointer flex items-center justify-center"
            aria-label="Close modal"
          >
            <X size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="index-modal-form">
          <div className="flex flex-col gap-1">
            <label className="index-modal-label">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. app_user"
              disabled={isEdit}
              required
              className="index-modal-input"
              data-testid="user-name-input"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="index-modal-label">Authentication Database</label>
            <input
              type="text"
              list="user-auth-dbs"
              value={authDb}
              onChange={(e) => setAuthDb(e.target.value)}
              placeholder="admin"
              disabled={isEdit}
              required
              className="index-modal-input"
              data-testid="user-authdb-input"
            />
            <datalist id="user-auth-dbs">
              {databases.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            <span className="index-modal-help-text">The database the user authenticates against.</span>
          </div>

          <div className="flex flex-col gap-1">
            <label className="index-modal-label">{isEdit ? 'New Password (optional)' : 'Password'}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isEdit ? 'Leave blank to keep current password' : 'Password'}
              required={!isEdit}
              className="index-modal-input"
              data-testid="user-password-input"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="index-modal-label">Roles</label>
            <div className="index-modal-keys-list">
              {roles.map((rule, idx) => (
                <div key={idx} className="index-modal-key-row">
                  <input
                    type="text"
                    list="user-role-names"
                    value={rule.role}
                    onChange={(e) => setRole(idx, { role: e.target.value })}
                    placeholder="Role (e.g. readWrite)"
                    className="index-modal-key-field"
                  />
                  <div className="index-modal-key-divider" />
                  <input
                    type="text"
                    list="user-auth-dbs"
                    value={rule.db}
                    onChange={(e) => setRole(idx, { db: e.target.value })}
                    placeholder={`Database (default: ${authDb || 'admin'})`}
                    className="index-modal-key-field"
                  />
                  <div className="index-modal-key-divider" />
                  <button
                    type="button"
                    onClick={() => setRoles((prev) => prev.filter((_, i) => i !== idx))}
                    className="index-modal-btn-delete"
                    title="Remove role"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <datalist id="user-role-names">
                {roleNames.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={() => setRoles((prev) => [...prev, { role: '', db: authDb }])}
                className="index-modal-btn-add"
                data-testid="add-role-btn"
              >
                <Plus size={12} />
                <span>Add Role</span>
              </button>
            </div>
            {isEdit && (
              <span className="index-modal-help-text">
                Saving replaces the user's role set with the list above.
              </span>
            )}
          </div>

          {error && <div className="index-modal-error">{error}</div>}

          <div className="flex items-center justify-end gap-2 border-t border-[var(--border-color)] pt-3">
            <button type="button" onClick={onClose} className="index-modal-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="index-modal-btn-primary" data-testid="save-user-btn">
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── Main view ─────────────────────────────────────────────────────────────────

export const UserManagementView: React.FC<UserManagementViewProps> = ({ connectionId }) => {
  const { toast, confirm } = useDialogs();
  const [users, setUsers] = useState<MongoUser[]>([]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [scope, setScope] = useState<string>(ALL_DBS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setHint(null);
    try {
      if (scope === ALL_DBS) {
        try {
          setUsers(await listUsers(connectionId));
        } catch {
          // forAllDBs needs cluster-wide privileges; fall back to per-database.
          const dbs = await invoke<string[]>('list_databases', { id: connectionId });
          const results = await Promise.allSettled(dbs.map((db) => listUsers(connectionId, db)));
          setUsers(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
          setHint('Not authorized to list users across all databases — showing users from databases you can access.');
        }
      } else {
        setUsers(await listUsers(connectionId, scope));
      }
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>('list_databases', { id: connectionId })
      .then((dbs) => {
        if (!cancelled) setDatabases(dbs);
      })
      .catch(() => {
        // Database list is only used for the scope selector / suggestions.
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const handleDrop = async (user: MongoUser) => {
    const ok = await confirm({
      title: 'Drop User',
      message: `Drop user "${user.user}" on database "${user.db}"? This cannot be undone.`,
      confirmLabel: 'Drop User',
    });
    if (!ok) return;
    try {
      await dropUser(connectionId, user.db, user.user);
      toast(`Dropped user ${user.user}`, 'success');
      refresh();
    } catch (err: any) {
      toast(`Failed to drop user: ${err?.message || err}`, 'error');
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="user-management-view">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-main)]">
          <Users size={14} className="text-[var(--accent-blue)]" />
          <span>User Management</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="mql-cm-select"
            data-testid="user-db-scope"
            title="Database scope"
          >
            <option value={ALL_DBS}>All databases</option>
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button
            onClick={refresh}
            className="p-1.5 hover:bg-[var(--bg-item-hover)] rounded text-[var(--text-muted)] hover:text-[var(--text-main)] cursor-pointer"
            title="Refresh"
            data-testid="refresh-users-btn"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => setEditor({ mode: 'create' })}
            className="index-modal-btn-primary flex items-center gap-1.5"
            data-testid="create-user-btn"
          >
            <Plus size={12} />
            <span>Create User</span>
          </button>
        </div>
      </div>

      {hint && (
        <div className="px-4 py-2 text-[11px] text-amber-400 border-b border-[var(--border-color)]">{hint}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-full text-[var(--text-muted)] gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading users…
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-full p-6">
          <div className="flex items-center gap-2 text-rose-400 text-sm font-mono">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      ) : users.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text-muted)] text-sm">
          <ShieldCheck size={24} className="opacity-50" />
          <span>No users found{scope !== ALL_DBS ? ` in ${scope}` : ''}.</span>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[var(--bg-panel)]">
              <tr className="text-[var(--text-dim)] border-b border-[var(--border-color)]">
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Auth DB</th>
                <th className="px-4 py-2 font-medium">Roles</th>
                <th className="px-4 py-2 font-medium">Mechanisms</th>
                <th className="px-4 py-2 font-medium w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={`${u.db}.${u.user}`}
                  className="border-b border-[var(--border-color)] hover:bg-[var(--bg-item-hover)]"
                  data-testid={`user-row-${u.db}.${u.user}`}
                >
                  <td className="px-4 py-2 font-mono text-[var(--text-main)]">
                    <span className="flex items-center gap-1.5">
                      <KeyRound size={11} className="text-[var(--text-dim)]" />
                      {u.user}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-[var(--text-muted)]">{u.db}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 ? (
                        <span className="text-[var(--text-dim)]">—</span>
                      ) : (
                        u.roles.map((r, i) => (
                          <span
                            key={i}
                            className="px-1.5 py-0.5 rounded bg-[var(--bg-item-hover)] font-mono text-[11px] text-[var(--text-muted)]"
                          >
                            {r.role}
                            <span className="text-[var(--text-dim)]">@{r.db}</span>
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-[var(--text-dim)]">{u.mechanisms.join(', ') || '—'}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditor({ mode: 'edit', user: u })}
                        className="p-1 hover:bg-[var(--bg-item-hover)] rounded text-[var(--text-muted)] hover:text-[var(--text-main)] cursor-pointer"
                        title="Edit user"
                        data-testid={`edit-user-${u.user}`}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => handleDrop(u)}
                        className="p-1 hover:bg-[var(--bg-item-hover)] rounded text-[var(--text-muted)] hover:text-rose-400 cursor-pointer"
                        title="Drop user"
                        data-testid={`drop-user-${u.user}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor && (
        <UserEditorModal
          connectionId={connectionId}
          editor={editor}
          databases={databases}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
};

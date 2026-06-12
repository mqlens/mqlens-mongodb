import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Users,
  User,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  ChevronRight,
  ScrollText,
  ShieldCheck,
  Database,
} from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { PasswordInput } from './PasswordInput';
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
  /** Optional initial database scope (e.g. opened from a database's context menu). */
  database?: string;
}

interface EditorState {
  mode: 'create' | 'edit';
  user?: MongoUser;
}

/** Merge a current value into a dropdown's option list so it is always selectable. */
const withValue = (options: string[], value: string): string[] =>
  value && !options.includes(value) ? [value, ...options] : options;

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
  const [authDb, setAuthDb] = useState(
    editor.user?.db ?? (databases.includes('admin') ? 'admin' : databases[0] || 'admin')
  );
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<RoleSpec[]>(
    editor.user?.roles?.length ? editor.user.roles.map((r) => ({ ...r })) : []
  );
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeClose(true, onClose);

  // Role options for the pickers; built-in role names are db-agnostic.
  useEffect(() => {
    let cancelled = false;
    listRoles(connectionId, authDb || 'admin')
      .then((rs) => {
        if (cancelled) return;
        setRoleNames([...new Set(rs.map((r) => r.role))]);
      })
      .catch(() => {
        // Role options are best-effort; existing selections remain selectable.
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, authDb]);

  const dbOptions = withValue(databases, authDb);

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
    // Deliberately no click-outside close: a half-filled user form (with a
    // typed password) is too easy to lose to a stray click. Close via the X
    // button, Cancel, or Escape.
    <div className="nested-modal-overlay select-none" data-testid="user-editor-modal">
      <div className="index-modal-container">
        <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3 mb-4 select-none">
          {/* Breadcrumb-style context: who is being created/edited, and where. */}
          <div className="mql-user-crumb">
            <User size={13} className="text-[var(--accent-blue)]" />
            <span className="mql-user-crumb-name">
              {username.trim() || (isEdit ? editor.user?.user : 'New User')}
            </span>
            <ChevronRight size={11} className="mql-user-crumb-sep" />
            <Database size={12} className="text-[var(--text-muted)]" />
            <span>{authDb}</span>
            <span className="mql-user-crumb-mode">{isEdit ? 'Edit User' : 'Add User'}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--bg-item-hover)] rounded text-[var(--text-muted)] hover:text-[var(--text-main)] cursor-pointer flex items-center justify-center"
            aria-label="Close modal"
            data-testid="close-user-editor"
          >
            <X size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="index-modal-form">
          <div className="mql-user-form-row">
            <label className="mql-user-form-label">Name:</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. app_user"
              disabled={isEdit}
              required
              className="index-modal-input flex-1"
              data-testid="user-name-input"
            />
          </div>

          <div className="mql-user-form-row">
            <label className="mql-user-form-label">Password:</label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isEdit ? '' : 'Password'}
              required={!isEdit}
              className="index-modal-input"
              data-testid="user-password-input"
            />
          </div>
          <div className="mql-user-form-help">
            {isEdit
              ? 'Leave blank to keep the current password.'
              : 'Use the field above to set the password. The password must be set.'}
          </div>

          <div className="mql-user-form-row">
            <label className="mql-user-form-label">Database:</label>
            <select
              value={authDb}
              onChange={(e) => setAuthDb(e.target.value)}
              disabled={isEdit}
              required
              className="index-modal-input flex-1"
              data-testid="user-authdb-input"
              title="The database the user authenticates against"
            >
              {dbOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          {/* Roles: bordered Role|Database panel with Grant/Revoke beside it. */}
          <div className="flex flex-col gap-1.5">
            <label className="index-modal-label">Roles</label>
            <div className="mql-user-roles">
              <div className="mql-user-roles-panel">
                <div className="mql-user-roles-head">
                  <span>Role</span>
                  <span>Database</span>
                </div>
                <div className="mql-user-roles-body">
                  {roles.length === 0 ? (
                    <div className="mql-user-roles-empty">No roles granted — click "Grant Role".</div>
                  ) : (
                    roles.map((rule, idx) => (
                      <div
                        key={idx}
                        className={`mql-user-roles-row${selectedRole === idx ? ' is-selected' : ''}`}
                        onClick={() => setSelectedRole(idx)}
                        data-testid={`role-row-${idx}`}
                      >
                        <span className="mql-user-roles-cell">
                          <ScrollText size={11} className="text-[var(--text-dim)] flex-shrink-0" />
                          <select
                            value={rule.role}
                            onChange={(e) => setRole(idx, { role: e.target.value })}
                            className="mql-user-roles-select"
                            data-testid={`role-select-${idx}`}
                          >
                            <option value="" disabled>
                              Select role…
                            </option>
                            {withValue(roleNames, rule.role).map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </span>
                        <span className="mql-user-roles-cell">
                          <select
                            value={rule.db}
                            onChange={(e) => setRole(idx, { db: e.target.value })}
                            className="mql-user-roles-select"
                            data-testid={`role-db-select-${idx}`}
                          >
                            {withValue(databases, rule.db).map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="mql-user-roles-btns">
                <button
                  type="button"
                  onClick={() => {
                    setRoles((prev) => [...prev, { role: '', db: authDb }]);
                    setSelectedRole(roles.length);
                  }}
                  className="index-modal-btn-secondary"
                  data-testid="add-role-btn"
                >
                  Grant Role
                </button>
                <button
                  type="button"
                  disabled={selectedRole === null}
                  onClick={() => {
                    if (selectedRole === null) return;
                    setRoles((prev) => prev.filter((_, i) => i !== selectedRole));
                    setSelectedRole(null);
                  }}
                  className="index-modal-btn-secondary"
                  data-testid="revoke-role-btn"
                >
                  Revoke
                </button>
              </div>
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
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── Main view ─────────────────────────────────────────────────────────────────

export const UserManagementView: React.FC<UserManagementViewProps> = ({ connectionId, database }) => {
  const { toast, confirm } = useDialogs();
  const [users, setUsers] = useState<MongoUser[]>([]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [scope, setScope] = useState<string>(database || ALL_DBS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; user: MongoUser | null } | null>(null);

  const userKey = (u: MongoUser) => `${u.db}.${u.user}`;

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Follow re-opens scoped to another database (sidebar db context menu).
  useEffect(() => {
    if (database) setScope(database);
  }, [database]);

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
        // Database list is only used for the scope selector / role db options.
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
            {withValue(databases, scope === ALL_DBS ? '' : scope).map((d) => (
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
            className="mql-users-create-btn"
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
        <div
          className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text-muted)] text-sm"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, user: null });
          }}
        >
          <ShieldCheck size={24} className="opacity-50" />
          <span>No users found{scope !== ALL_DBS ? ` in ${scope}` : ''}.</span>
        </div>
      ) : (
        <div
          className="flex-1 overflow-auto mql-users-tree"
          data-testid="users-tree"
          onContextMenu={(e) => {
            // Empty-space right click → create; rows stopPropagation below.
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, user: null });
          }}
        >
          <div className="mql-users-head">
            <span className="mql-users-head-cell">User</span>
            <span className="mql-users-head-cell">Database</span>
            <span className="mql-users-head-cell">Auth Mechanism</span>
          </div>
          {users.map((u) => {
            const key = userKey(u);
            const isOpen = expanded.has(key);
            return (
              <div key={key} className="mql-users-node">
                <div
                  className="mql-users-row"
                  data-testid={`user-row-${key}`}
                  onClick={() => toggleExpanded(key)}
                  onDoubleClick={() => setEditor({ mode: 'edit', user: u })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, user: u });
                  }}
                >
                  <span className="mql-users-cell">
                    <ChevronRight size={12} className={`mql-users-chev${isOpen ? ' is-open' : ''}`} />
                    <User size={13} className="text-[var(--accent-blue)] flex-shrink-0" />
                    <span className="mql-users-name">{u.user}</span>
                  </span>
                  <span className="mql-users-cell text-[var(--text-muted)]">{u.db}</span>
                  <span className="mql-users-cell text-[var(--text-dim)]">{u.mechanisms.join(', ') || '—'}</span>
                </div>
                {isOpen && (
                  <div className="mql-users-children">
                    {u.roles.length === 0 ? (
                      <div className="mql-users-role-row is-empty">No roles granted</div>
                    ) : (
                      u.roles.map((r, i) => (
                        <div key={i} className="mql-users-role-row">
                          <ScrollText size={12} className="text-[var(--text-dim)] flex-shrink-0" />
                          <span>{`${r.role}@${r.db}`}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            [
              ...(menu.user
                ? [
                    {
                      label: 'Edit User',
                      icon: <Pencil size={12} />,
                      onClick: () => setEditor({ mode: 'edit', user: menu.user! }),
                    },
                    {
                      label: 'Drop User',
                      icon: <Trash2 size={12} />,
                      danger: true,
                      onClick: () => handleDrop(menu.user!),
                    },
                  ]
                : []),
              {
                label: 'Create User',
                icon: <Plus size={12} />,
                separatorBefore: !!menu.user,
                onClick: () => setEditor({ mode: 'create' }),
              },
              { label: 'Refresh', icon: <RefreshCw size={12} />, onClick: refresh },
            ] as ContextMenuItem[]
          }
        />
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

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
} from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
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
            data-testid="close-user-editor"
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
            <select
              value={authDb}
              onChange={(e) => setAuthDb(e.target.value)}
              disabled={isEdit}
              required
              className="index-modal-input"
              data-testid="user-authdb-input"
            >
              {dbOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
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
                  <select
                    value={rule.role}
                    onChange={(e) => setRole(idx, { role: e.target.value })}
                    className="index-modal-key-select"
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
                  <div className="index-modal-key-divider" />
                  <select
                    value={rule.db}
                    onChange={(e) => setRole(idx, { db: e.target.value })}
                    className="index-modal-key-select"
                    data-testid={`role-db-select-${idx}`}
                  >
                    {withValue(databases, rule.db).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
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
                  <ChevronRight size={12} className={`mql-users-chev${isOpen ? ' is-open' : ''}`} />
                  <User size={13} className="text-[var(--accent-blue)] flex-shrink-0" />
                  <span className="mql-users-name">{u.user}</span>
                  <span className="mql-users-meta">
                    @{u.db}
                    {u.mechanisms.length > 0 ? ` · ${u.mechanisms.join(', ')}` : ''}
                  </span>
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

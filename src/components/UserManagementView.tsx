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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DraggableDialogContent } from '@/components/ui/draggable-dialog-content';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
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
  database?: string;
}

interface EditorState {
  mode: 'create' | 'edit';
  user?: MongoUser;
}

const withValue = (options: string[], value: string): string[] =>
  value && !options.includes(value) ? [value, ...options] : options;

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

  useEffect(() => {
    let cancelled = false;
    listRoles(connectionId, authDb || 'admin')
      .then((rs) => {
        if (cancelled) return;
        setRoleNames([...new Set(rs.map((r) => r.role))]);
      })
      .catch(() => undefined);
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
    const cleanRoles = roles.map((r) => ({ role: r.role.trim(), db: r.db.trim() }));
    if (cleanRoles.some((r) => !r.role || !r.db)) {
      setError('Select a role and a database for every granted role');
      return;
    }
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
    <Dialog open onOpenChange={() => {}}>
      <DraggableDialogContent
        resetKey={editor}
        defaultWidth={540}
        defaultHeight={560}
        minWidth={420}
        minHeight={360}
        hideClose
        className="flex min-h-0 flex-col gap-0 p-0"
        data-testid="user-editor-modal"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <DialogHeader
          data-dialog-drag-handle
          className="flex cursor-grab flex-row items-center justify-between border-b border-border px-4 py-3 active:cursor-grabbing"
        >
          <DialogTitle className="flex items-center gap-2 text-sm">
            <User size={14} className="text-primary" />
            {isEdit ? `Edit User — ${editor.user?.user}` : 'New User'}
          </DialogTitle>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close modal" data-testid="close-user-editor">
            <X size={13} />
          </Button>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-name-input">Username</Label>
              <Input
                id="user-name-input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. app_user"
                disabled={isEdit}
                required
                data-testid="user-name-input"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-password-input">{isEdit ? 'New Password' : 'Password'}</Label>
              <PasswordInput
                id="user-password-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isEdit ? 'Leave blank to keep current password' : 'Password'}
                required={!isEdit}
                data-testid="user-password-input"
              />
              {!isEdit && <span className="text-[11px] text-muted-foreground">The password must be set.</span>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Authentication Database</Label>
              <Select value={authDb} onValueChange={setAuthDb} disabled={isEdit}>
                <SelectTrigger data-testid="user-authdb-input">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dbOptions.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">The database the user authenticates against.</span>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Roles</Label>
              {roles.length > 0 && (
                <div className="flex max-h-[170px] flex-col gap-2 overflow-y-auto pr-1">
                  {roles.map((rule, idx) => (
                    <div key={idx} className="flex items-center gap-2" data-testid={`role-row-${idx}`}>
                      <Select value={rule.role || '__none__'} onValueChange={(v) => setRole(idx, { role: v === '__none__' ? '' : v })}>
                        <SelectTrigger className="flex-[1.2]" data-testid={`role-select-${idx}`}>
                          <SelectValue placeholder="Select role…" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" disabled>
                            Select role…
                          </SelectItem>
                          {withValue(roleNames, rule.role).map((r) => (
                            <SelectItem key={r} value={r}>
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={rule.db} onValueChange={(v) => setRole(idx, { db: v })}>
                        <SelectTrigger className="flex-1" data-testid={`role-db-select-${idx}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {withValue(databases, rule.db).map((d) => (
                            <SelectItem key={d} value={d}>
                              {d}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => setRoles((prev) => prev.filter((_, i) => i !== idx))}
                        title="Revoke role"
                        data-testid={`revoke-role-${idx}`}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit text-xs"
                onClick={() => setRoles((prev) => [...prev, { role: '', db: authDb }])}
                data-testid="add-role-btn"
              >
                <Plus size={12} />
                Grant Role
              </Button>
              {isEdit && (
                <span className="text-[11px] text-muted-foreground">
                  Saving replaces the user&apos;s role set with the list above.
                </span>
              )}
            </div>
          </div>

          <DialogFooter className="border-t border-border px-4 py-3 sm:justify-between">
            <span className="min-w-0 text-[11px] text-destructive" data-testid="user-editor-error">
              {error}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} data-testid="save-user-btn">
                {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add User'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DraggableDialogContent>
    </Dialog>
  );
};

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
      .catch(() => undefined);
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
    <div className="flex h-full flex-col overflow-hidden" data-testid="user-management-view">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Users size={14} className="text-primary" />
          <span>User Management</span>
        </div>
        <div className="flex items-center gap-2">
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="h-8 w-[160px] text-xs" data-testid="user-db-scope" title="Database scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_DBS}>All databases</SelectItem>
              {withValue(databases, scope === ALL_DBS ? '' : scope).map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={refresh} title="Refresh" data-testid="refresh-users-btn">
            <RefreshCw size={13} />
          </Button>
          <Button type="button" size="sm" onClick={() => setEditor({ mode: 'create' })} data-testid="create-user-btn">
            <Plus size={12} />
            Create User
          </Button>
        </div>
      </div>

      {hint && (
        <div className="border-b border-border px-4 py-2 text-[11px] text-warning">{hint}</div>
      )}

      {loading ? (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          Loading users…
        </div>
      ) : error ? (
        <div className="flex h-full items-center justify-center p-6">
          <div className="flex items-center gap-2 font-mono text-sm text-destructive">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      ) : users.length === 0 ? (
        <div
          className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, user: null });
          }}
        >
          <ShieldCheck size={24} className="opacity-50" />
          <span>No users found{scope !== ALL_DBS ? ` in ${scope}` : ''}.</span>
        </div>
      ) : (
        <ScrollArea className="flex-1" data-testid="users-tree">
          <div
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, user: null });
            }}
          >
            <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 border-b border-border bg-muted/50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>User</span>
              <span>Database</span>
              <span>Auth Mechanism</span>
            </div>
            {users.map((u) => {
              const key = userKey(u);
              const isOpen = expanded.has(key);
              return (
                <div key={key} className="border-b border-border">
                  <div
                    className="grid cursor-pointer grid-cols-[1.2fr_1fr_1fr] gap-2 px-4 py-2 text-xs hover:bg-accent/50"
                    data-testid={`user-row-${key}`}
                    onClick={() => toggleExpanded(key)}
                    onDoubleClick={() => setEditor({ mode: 'edit', user: u })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, user: u });
                    }}
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <ChevronRight size={12} className={cn('flex-shrink-0 transition-transform', isOpen && 'rotate-90')} />
                      <User size={13} className="flex-shrink-0 text-primary" />
                      <span className="truncate font-medium text-foreground">{u.user}</span>
                    </span>
                    <span className="truncate text-muted-foreground">{u.db}</span>
                    <span className="truncate text-muted-foreground">{u.mechanisms.join(', ') || '—'}</span>
                  </div>
                  {isOpen && (
                    <div className="border-t border-border bg-muted/20 px-4 py-1">
                      {u.roles.length === 0 ? (
                        <div className="py-2 pl-6 text-xs italic text-muted-foreground">No roles granted</div>
                      ) : (
                        u.roles.map((r, i) => (
                          <div key={i} className="flex items-center gap-2 py-1.5 pl-6 text-xs text-foreground">
                            <ScrollText size={12} className="flex-shrink-0 text-muted-foreground" />
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
        </ScrollArea>
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

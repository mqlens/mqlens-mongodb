import { invoke } from '@tauri-apps/api/core';

export interface RoleSpec {
  role: string;
  db: string;
}

export interface MongoUser {
  user: string;
  db: string;
  roles: RoleSpec[];
  mechanisms: string[];
}

export interface RoleInfo {
  role: string;
  db: string;
  isBuiltin: boolean;
}

/** List users of one database, or of all databases when `database` is omitted. */
export const listUsers = (id: string, database?: string) =>
  invoke<MongoUser[]>('list_users', { id, database: database ?? null });

export const createUser = (id: string, database: string, username: string, password: string, roles: RoleSpec[]) =>
  invoke<void>('create_user', { id, database, username, password, roles });

/** Pass `password` and/or `roles`; `null` leaves that aspect unchanged. */
export const updateUser = (
  id: string,
  database: string,
  username: string,
  password: string | null,
  roles: RoleSpec[] | null
) => invoke<void>('update_user', { id, database, username, password, roles });

export const dropUser = (id: string, database: string, username: string) =>
  invoke<void>('drop_user', { id, database, username });

export const listRoles = (id: string, database: string) =>
  invoke<RoleInfo[]>('list_roles', { id, database });

import { invoke } from '@tauri-apps/api/core';

export interface ServerStatus {
  host: string;
  version: string;
  uptimeSeconds: number;
  connections: { current: number; available: number; totalCreated: number };
  opcounters: { insert: number; query: number; update: number; delete: number; getmore: number; command: number };
  memory: { residentMb: number; virtualMb: number };
  network: { bytesIn: number; bytesOut: number; numRequests: number };
  cache?: { bytesInCache: number; maxBytes: number; dirtyBytes: number };
  replSet?: string;
}

export interface CurrentOp {
  opid: number;
  op: string;
  ns: string;
  secsRunning: number;
  client: string;
  desc: string;
  command: string;
}

export interface ProfilingStatus {
  level: number;
  slowMs: number;
}

export interface ProfileEntry {
  op: string;
  ns: string;
  millis: number;
  tsMs: number;
  planSummary: string;
  command: string;
}

export const serverStatus = (id: string) => invoke<ServerStatus>('server_status', { id });
export const currentOps = (id: string) => invoke<CurrentOp[]>('current_ops', { id });
export const killOp = (id: string, opid: number) => invoke<void>('kill_op', { id, opid });
export const getProfilingStatus = (id: string, database: string) =>
  invoke<ProfilingStatus>('get_profiling_status', { id, database });
export const setProfilingLevel = (id: string, database: string, level: number, slowMs: number) =>
  invoke<ProfilingStatus>('set_profiling_level', { id, database, level, slowMs });
export const readProfile = (id: string, database: string, limit: number) =>
  invoke<ProfileEntry[]>('read_profile', { id, database, limit });

export interface ReplSetMember {
  name: string;
  stateStr: string;
  health: number;
  self: boolean;
  uptimeSecs: number;
  optimeDateMs: number;
  pingMs?: number | null;
  syncSource: string;
  lagSecs?: number | null;
}

export interface ReplSetStatus {
  isReplicaSet: boolean;
  clusterType: string;
  set: string;
  myStateStr: string;
  mongoVersion: string;
  members: ReplSetMember[];
}

export const replSetStatus = (id: string) => invoke<ReplSetStatus>('repl_set_status', { id });

import { invoke } from '@tauri-apps/api/core';

/** One rolling call-log row. Mirrors backend `mcp::McpLogEntry` (camelCase serde). */
export interface McpLogEntry {
  tsMs: number;
  tool: string;
  connectionId?: string | null;
  summary: string;
  ok: boolean;
}

/** Mirrors backend `mcp::McpStatusUi` (camelCase serde). */
export interface McpStatusUi {
  enabled: boolean;
  port: number;
  token: string;
  log: McpLogEntry[];
}

export const getMcpStatus = () => invoke<McpStatusUi>('mcp_get_status');

export const mcpSetEnabled = (enabled: boolean, port?: number) =>
  invoke<McpStatusUi>('mcp_set_enabled', { enabled, port: port ?? null });

export const mcpRegenerateToken = () => invoke<McpStatusUi>('mcp_regenerate_token');

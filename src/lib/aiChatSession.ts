import type { GeneratedQuery } from './mongoCommand';

/** One bubble in a persisted AI Helper conversation. */
export interface AiChatSessionMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  query?: GeneratedQuery;
  error?: boolean;
}

/** A previously sent prompt for this collection’s History menu. */
export interface AiChatSessionPrompt {
  id: string;
  text: string;
  sentAt: string;
}

export interface AiChatSession {
  isOpen: boolean;
  messages: AiChatSessionMessage[];
  /** Prompt History for this collection only (newest first). */
  prompts: AiChatSessionPrompt[];
  updatedAt: string;
}

const STORAGE_KEY = 'mqlens_ai_chat_sessions';
export const AI_CHAT_SESSIONS_STORAGE_KEY = STORAGE_KEY;

/** Mirrored from AppSettings so prune can run synchronously in the renderer. */
export const AI_HISTORY_RETENTION_KEY = 'mqlens_ai_history_retention_months';
export const AI_HISTORY_RETENTION_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type AiHistoryRetentionMonths = (typeof AI_HISTORY_RETENTION_OPTIONS)[number];
export const DEFAULT_AI_HISTORY_RETENTION_MONTHS: AiHistoryRetentionMonths = 3;

/** Max distinct scopes kept (oldest `updatedAt` dropped first). */
export const AI_CHAT_SESSION_MAX_SCOPES = 40;
/** Max messages kept per scope. */
export const AI_CHAT_SESSION_MAX_MESSAGES = 100;
/** Max History prompts kept per collection. */
export const AI_CHAT_SESSION_MAX_PROMPTS = 50;

type SessionMap = Record<string, AiChatSession>;

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `aih-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function aiChatSessionKey(parts: {
  connectionName: string;
  database: string;
  collection: string;
  variant: 'editor' | 'shell';
}): string {
  return `${parts.variant}::${parts.connectionName}::${parts.database}::${parts.collection}`;
}

export function normalizeAiHistoryRetentionMonths(value: unknown): AiHistoryRetentionMonths {
  const n = typeof value === 'number' ? value : Number(value);
  if ((AI_HISTORY_RETENTION_OPTIONS as readonly number[]).includes(n)) {
    return n as AiHistoryRetentionMonths;
  }
  return DEFAULT_AI_HISTORY_RETENTION_MONTHS;
}

export function loadAiHistoryRetentionMonths(): AiHistoryRetentionMonths {
  try {
    return normalizeAiHistoryRetentionMonths(localStorage.getItem(AI_HISTORY_RETENTION_KEY));
  } catch {
    return DEFAULT_AI_HISTORY_RETENTION_MONTHS;
  }
}

export function saveAiHistoryRetentionMonths(months: number): AiHistoryRetentionMonths {
  const normalized = normalizeAiHistoryRetentionMonths(months);
  try {
    localStorage.setItem(AI_HISTORY_RETENTION_KEY, String(normalized));
  } catch {
    /* best-effort */
  }
  pruneAiChatSessions(normalized);
  return normalized;
}

/** ISO cutoff for “N calendar months ago”. */
export function retentionCutoffIso(retentionMonths: number, now = new Date()): string {
  const months = normalizeAiHistoryRetentionMonths(retentionMonths);
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff.toISOString();
}

function loadAll(): SessionMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SessionMap;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveAll(map: SessionMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    console.error('Failed to save AI chat sessions', err);
  }
}

function pruneByScopeCount(map: SessionMap): SessionMap {
  const entries = Object.entries(map);
  if (entries.length <= AI_CHAT_SESSION_MAX_SCOPES) return map;
  entries.sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? -1 : 1));
  const drop = entries.length - AI_CHAT_SESSION_MAX_SCOPES;
  const next: SessionMap = { ...map };
  for (let i = 0; i < drop; i++) delete next[entries[i][0]];
  return next;
}

function normalizeSession(session: Partial<AiChatSession> | null | undefined): AiChatSession | null {
  if (!session || typeof session !== 'object') return null;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const prompts = Array.isArray(session.prompts) ? session.prompts : [];
  return {
    isOpen: !!session.isOpen,
    messages: messages.filter(
      (m) => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'assistant')
    ),
    prompts: prompts.filter((p) => p && typeof p.text === 'string' && p.text.trim().length > 0),
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '',
  };
}

/** Drop prompts/sessions older than the configured retention window. */
export function pruneAiChatSessions(
  retentionMonths: number = loadAiHistoryRetentionMonths(),
  now = new Date()
): void {
  const cutoff = retentionCutoffIso(retentionMonths, now);
  const map = loadAll();
  let changed = false;
  for (const [key, raw] of Object.entries(map)) {
    const session = normalizeSession(raw);
    if (!session) {
      delete map[key];
      changed = true;
      continue;
    }
    const prompts = session.prompts.filter((p) => !p.sentAt || p.sentAt >= cutoff);
    const sessionExpired = !!session.updatedAt && session.updatedAt < cutoff;
    const messages = sessionExpired ? [] : session.messages;
    const isOpen = sessionExpired ? false : session.isOpen;
    if (prompts.length === 0 && messages.length === 0 && !isOpen) {
      delete map[key];
      changed = true;
      continue;
    }
    if (
      prompts.length !== session.prompts.length ||
      messages.length !== session.messages.length ||
      isOpen !== session.isOpen
    ) {
      map[key] = {
        ...session,
        prompts,
        messages,
        isOpen,
        updatedAt: session.updatedAt || now.toISOString(),
      };
      changed = true;
    }
  }
  if (changed) saveAll(map);
}

export function loadAiChatSession(key: string): AiChatSession | null {
  pruneAiChatSessions();
  return normalizeSession(loadAll()[key]);
}

export function saveAiChatSession(
  key: string,
  patch: {
    isOpen?: boolean;
    messages?: AiChatSessionMessage[];
    prompts?: AiChatSessionPrompt[];
  }
): void {
  const prev = normalizeSession(loadAll()[key]) ?? {
    isOpen: false,
    messages: [],
    prompts: [],
    updatedAt: '',
  };
  const messages = (patch.messages ?? prev.messages).slice(-AI_CHAT_SESSION_MAX_MESSAGES);
  const prompts = (patch.prompts ?? prev.prompts).slice(0, AI_CHAT_SESSION_MAX_PROMPTS);
  const isOpen = patch.isOpen ?? prev.isOpen;

  // Drop only when the whole collection session is empty and closed.
  if (!isOpen && messages.length === 0 && prompts.length === 0) {
    clearAiChatSession(key);
    return;
  }

  const map = pruneByScopeCount({
    ...loadAll(),
    [key]: {
      isOpen,
      messages,
      prompts,
      updatedAt: new Date().toISOString(),
    },
  });
  saveAll(map);
  pruneAiChatSessions();
}

/**
 * Record a sent prompt for this collection session. Identical text is moved to
 * the front. Does not touch open state or chat messages.
 */
export function recordAiChatPrompt(key: string, text: string): AiChatSessionPrompt[] {
  const trimmed = text.trim();
  const prev = loadAiChatSession(key);
  const existing = prev?.prompts ?? [];
  if (!trimmed) return existing;

  const prompts = [
    { id: newId(), text: trimmed, sentAt: new Date().toISOString() },
    ...existing.filter((p) => p.text !== trimmed),
  ].slice(0, AI_CHAT_SESSION_MAX_PROMPTS);
  saveAiChatSession(key, { prompts });
  return loadAiChatSession(key)?.prompts ?? prompts;
}

export function clearAiChatPrompts(key: string): void {
  saveAiChatSession(key, { prompts: [] });
}

export function clearAiChatSession(key: string): void {
  const map = loadAll();
  if (!(key in map)) return;
  delete map[key];
  saveAll(map);
}

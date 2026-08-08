import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from '../components/AIChatPanel';

/**
 * Durable AI Helper conversations, owned by the backend (`chats.json`).
 *
 * This replaced a localStorage document. Two reasons the renderer was the wrong
 * owner: a conversation should survive the same things a saved query survives —
 * which is already backend-stored, see `queries.rs` — and localStorage is
 * per-origin, so a second window and a reload each had their own idea of the
 * history.
 *
 * Chats are addressed by id and carry their own scope, so the panel can show
 * one collection's conversations or every conversation without the store being
 * reshaped. The backend keeps no clock: timestamps and the retention cutoff are
 * computed here and passed in, which keeps every "when" decision in one place.
 */

export interface ChatScope {
  connectionName: string;
  database: string;
  collection: string;
  variant: 'editor' | 'shell';
}

export interface StoredChat extends ChatScope {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

/** A chat without its transcript — what the history list renders. */
export interface ChatSummary extends ChatScope {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export const AI_HISTORY_RETENTION_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type AiHistoryRetentionMonths = (typeof AI_HISTORY_RETENTION_OPTIONS)[number];
export const DEFAULT_AI_HISTORY_RETENTION_MONTHS: AiHistoryRetentionMonths = 3;
/** Mirrored from AppSettings so the cutoff can be computed without an await. */
export const AI_HISTORY_RETENTION_KEY = 'mqlens_ai_history_retention_months';

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
    /* best-effort: the authoritative copy is in AppSettings */
  }
  return normalized;
}

/** ISO cutoff for "N calendar months ago" — what the backend prunes against. */
export function retentionCutoffIso(retentionMonths: number, now = new Date()): string {
  const months = normalizeAiHistoryRetentionMonths(retentionMonths);
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff.toISOString();
}

const cutoff = () => retentionCutoffIso(loadAiHistoryRetentionMonths());

/** A title derived from the opening prompt — chats are never named by hand
 *  unless the user renames them, and "New chat" everywhere is unreadable. */
export function titleFromMessages(messages: ChatMessage[], fallback: string): string {
  const first = messages.find((m) => m.role === 'user')?.text?.trim();
  if (!first) return fallback;
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

export function newChatId(): string {
  // No `Math.random()` fallback: CodeQL flags it as insecure randomness, and an
  // id that two tabs could collide on is worth avoiding on its own merits.
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  return `chat-${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Chats currently open in a panel in THIS renderer.
 *
 * A second tab on a collection must not adopt the conversation the first tab is
 * already holding: both would render it and both would save over each other. A
 * tab therefore only inherits the most recent chat if nothing else has it open,
 * and starts a fresh one otherwise.
 */
const openChats = new Set<string>();

export function claimOpenChat(id: string): void {
  openChats.add(id);
}

export function releaseOpenChat(id: string): void {
  openChats.delete(id);
}

export function isChatOpenElsewhere(id: string): boolean {
  return openChats.has(id);
}

/** Test seam. */
export function resetOpenChats(): void {
  openChats.clear();
}

/**
 * Conversations, newest first. `scope` narrows to one collection; omit it for
 * the global list.
 *
 * Never rejects: the history menu failing to open must not be able to break the
 * assistant, so a backend error reads as "no history".
 */
export async function listChats(scope?: ChatScope): Promise<ChatSummary[]> {
  const chats = await invoke<ChatSummary[]>('list_chats', {
    scope: scope ?? null,
    cutoffIso: cutoff(),
  }).catch(() => []);
  return Array.isArray(chats) ? chats : [];
}

export async function loadChat(id: string): Promise<StoredChat | undefined> {
  const chat = await invoke<StoredChat | null>('load_chat', { id }).catch(() => null);
  return chat ?? undefined;
}

/** Create or update a conversation. Fire-and-forget at the call sites: the
 *  panel already shows the messages, and a failed write must not interrupt. */
export async function saveChat(chat: StoredChat): Promise<void> {
  await invoke('save_chat', { chat, cutoffIso: cutoff() }).catch(() => undefined);
}

export async function deleteChat(id: string): Promise<void> {
  await invoke('delete_chat', { id }).catch(() => undefined);
}

/** Delete every chat, or every chat in one scope. */
export async function clearChats(scope?: ChatScope): Promise<void> {
  await invoke('clear_chats', { scope: scope ?? null }).catch(() => undefined);
}

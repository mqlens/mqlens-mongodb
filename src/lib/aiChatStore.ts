import { invoke } from '@tauri-apps/api/core';
import { windowLabel } from '../workspace/workspaceStore';
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
  // Clamp the day first. `setMonth` does not shorten the date: on the 31st,
  // going back one month lands on the 31st of a 28- or 30-day month, which
  // overflows into the month AFTER the one intended — a one-month policy
  // applied on 31 March would cut off at 3 March and delete four weeks of
  // history that is still inside the configured window.
  const target = new Date(cutoff.getFullYear(), cutoff.getMonth() - months + 1, 0).getDate();
  cutoff.setDate(Math.min(cutoff.getDate(), target));
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
 * Which conversations are open in a panel right now.
 *
 * A tab must not adopt a conversation another tab is already holding: both
 * would render it and both would then save their own transcript over the
 * other's. The claim lives in the BACKEND because two windows are two
 * renderers — a module-local set here would let each of them adopt the same
 * chat, which is exactly the case it is meant to prevent.
 *
 * The local set is only a fast path for release and for reasoning about our own
 * claims; the backend is the authority.
 */
const locallyHeld = new Set<string>();

/**
 * A token identifying one PANEL, not one window.
 *
 * Two tabs in the same window are two panels and must not both hold a chat, so
 * a window label alone is too coarse; the window prefix is still there because
 * a closing window has to be able to drop everything its panels held.
 */
let panelSeq = 0;
export function newPanelOwner(): string {
  panelSeq += 1;
  return `${windowLabel()}#${panelSeq}`;
}

/** Take a conversation, or find out that another panel has it. */
export async function claimOpenChat(id: string, owner: string): Promise<boolean> {
  const won = await invoke<boolean>('claim_chat', { chatId: id, owner }).catch(
    // A backend that cannot answer must not stop the panel working; the worst
    // case is the collision this guards against, which is what it was before.
    () => true
  );
  if (won !== false) locallyHeld.add(id);
  return won !== false;
}

export function releaseOpenChat(id: string, owner: string): void {
  locallyHeld.delete(id);
  void invoke('release_chat', { chatId: id, owner }).catch(() => undefined);
}

export function isHeldLocally(id: string): boolean {
  return locallyHeld.has(id);
}

/** Test seam. */
export function resetOpenChats(): void {
  locallyHeld.clear();
  panelSeq = 0;
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

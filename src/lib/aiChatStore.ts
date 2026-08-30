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
  /** Provider chosen for this conversation in the panel; absent = settings default. */
  providerId?: string;
  model?: string;
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
 * A token identifying one TAB, not one panel instance and not one window.
 *
 * Two tabs in the same window must not both hold a conversation, so a window
 * label alone is too coarse. Nor can it be per mount: inactive tabs unmount and
 * a tab that comes back has to be able to re-take the chat it never stopped
 * pointing at. The window prefix stays because a closing window drops
 * everything its tabs held.
 */
export function tabChatOwner(tabId: string): string {
  return `${windowLabel()}#${tabId}`;
}

/** For a panel rendered outside the tab system, which owns nothing shared. */
let looseSeq = 0;
export function newPanelOwner(): string {
  looseSeq += 1;
  return `${windowLabel()}#loose-${looseSeq}`;
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
  looseSeq = 0;
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
  const chat = await invoke<unknown>('load_chat', { id }).catch(() => null);
  // Shape-checked rather than trusted: this crosses the IPC boundary, and
  // anything merely truthy — an array, say — would otherwise be read for fields
  // it does not have. A chat with no id is not a chat, and treating one as a
  // scope silently puts the panel into read-only mode.
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return undefined;
  const candidate = chat as Partial<StoredChat>;
  if (typeof candidate.id !== 'string') return undefined;
  return {
    ...(candidate as StoredChat),
    messages: Array.isArray(candidate.messages) ? candidate.messages : [],
  };
}

/** Create or update a conversation. Fire-and-forget at the call sites: the
 *  panel already shows the messages, and a failed write must not interrupt. */
export async function saveChat(chat: StoredChat): Promise<void> {
  await invoke('save_chat', { chat, cutoffIso: cutoff() }).catch(() => undefined);
}

export async function deleteChat(id: string): Promise<void> {
  await invoke('delete_chat', { id }).catch(() => undefined);
}

/**
 * Append an assistant reply to a stored conversation the panel is not showing.
 *
 * Used when an answer arrives with nowhere local to land — the tab moved to
 * another window, or the panel has since switched conversations. One backend
 * command, because load-then-save is two round trips with the store lock
 * released between them: a panel saving in that window would either lose this
 * message or be overwritten by it. The message id is assigned backend-side for
 * the same reason.
 */
export async function appendReplyToChat(
  chatId: string,
  reply: {
    text: string;
    query?: unknown;
    error?: boolean;
    thoughts?: string | null;
    toolCalls?: { name: string; input?: string; output?: string; failed?: boolean }[];
  }
): Promise<void> {
  await invoke('append_chat_message', {
    chatId,
    role: 'assistant',
    text: reply.text,
    query: reply.query ?? null,
    error: reply.error ?? null,
    // Carried through, or a reply parked by a closing tab reaches History
    // without the reasoning it was shown with — and the same for what it ran.
    thoughts: reply.thoughts ?? null,
    toolCalls: reply.toolCalls ?? null,
    updatedAt: new Date().toISOString(),
  }).catch(() => undefined);
}

/**
 * Follow a renamed database or collection.
 *
 * The rename re-keys the tab but leaves the stored conversations naming the old
 * namespace, after which the panel reads its own chat as foreign and refuses to
 * continue it.
 */
export async function retargetChatScope(
  scope: { connectionName: string; database: string; collection?: string; variant?: 'editor' | 'shell' },
  next: { database: string; collection?: string }
): Promise<void> {
  await invoke('retarget_chat_scope', {
    connectionName: scope.connectionName,
    database: scope.database,
    // Omitted for a database rename: conversations about collections with no
    // open tab have to move too, and the caller cannot enumerate those.
    collection: scope.collection ?? null,
    variant: scope.variant ?? null,
    newDatabase: next.database,
    newCollection: next.collection ?? null,
  }).catch(() => undefined);
}

/** Move a conversation's claim to a tab's new id — renames and profile rebinds
 *  mint new tab ids, and the owner token is built from one. */
export async function transferChatClaim(
  chatId: string,
  oldTabId: string,
  newTabId: string
): Promise<void> {
  await invoke('release_chat', { chatId, owner: tabChatOwner(oldTabId) }).catch(() => undefined);
  await claimOpenChat(chatId, tabChatOwner(newTabId));
}

/** Give up every conversation a tab was holding — called when the tab closes,
 *  since nothing else will. */
export function releaseChatsForTab(tabId: string): void {
  void invoke('release_owner_chats', { owner: tabChatOwner(tabId) }).catch(() => undefined);
}

/** Delete every chat, or every chat in one scope. */
export async function clearChats(scope?: ChatScope): Promise<void> {
  await invoke('clear_chats', { scope: scope ?? null }).catch(() => undefined);
}

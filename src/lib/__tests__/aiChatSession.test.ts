import { describe, it, expect, beforeEach } from 'vitest';
import {
  aiChatSessionKey,
  loadAiChatSession,
  saveAiChatSession,
  clearAiChatSession,
  recordAiChatPrompt,
  clearAiChatPrompts,
  pruneAiChatSessions,
  saveAiHistoryRetentionMonths,
  loadAiHistoryRetentionMonths,
  retentionCutoffIso,
  AI_CHAT_SESSION_MAX_MESSAGES,
  AI_CHAT_SESSIONS_STORAGE_KEY,
} from '../aiChatSession';

const usersKey = aiChatSessionKey({
  connectionName: 'Local',
  database: 'app',
  collection: 'users',
  variant: 'editor',
});
const ordersKey = aiChatSessionKey({
  connectionName: 'Local',
  database: 'app',
  collection: 'orders',
  variant: 'editor',
});

describe('aiChatSession', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('builds a stable scope key', () => {
    expect(usersKey).toBe('editor::Local::app::users');
  });

  it('round-trips open state and messages without wiping prompts', () => {
    recordAiChatPrompt(usersKey, 'prior prompt');
    saveAiChatSession(usersKey, {
      isOpen: true,
      messages: [
        { id: 'm0', role: 'user', text: 'hi' },
        { id: 'm1', role: 'assistant', text: 'hello', query: { queryType: 'find', filter: {} } },
      ],
    });
    const loaded = loadAiChatSession(usersKey);
    expect(loaded?.isOpen).toBe(true);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.prompts.map((p) => p.text)).toEqual(['prior prompt']);
  });

  it('keeps prompt history isolated per collection', () => {
    recordAiChatPrompt(usersKey, 'users only');
    recordAiChatPrompt(ordersKey, 'orders only');
    expect(loadAiChatSession(usersKey)?.prompts.map((p) => p.text)).toEqual(['users only']);
    expect(loadAiChatSession(ordersKey)?.prompts.map((p) => p.text)).toEqual(['orders only']);
  });

  it('dedupes prompts within a collection', () => {
    recordAiChatPrompt(usersKey, 'adults');
    recordAiChatPrompt(usersKey, 'seniors');
    recordAiChatPrompt(usersKey, 'adults');
    expect(loadAiChatSession(usersKey)?.prompts.map((p) => p.text)).toEqual(['adults', 'seniors']);
  });

  it('clearAiChatPrompts only clears prompts for that collection', () => {
    recordAiChatPrompt(usersKey, 'x');
    recordAiChatPrompt(ordersKey, 'y');
    clearAiChatPrompts(usersKey);
    expect(loadAiChatSession(usersKey)?.prompts ?? []).toEqual([]);
    expect(loadAiChatSession(ordersKey)?.prompts.map((p) => p.text)).toEqual(['y']);
  });

  it('closing an empty chat keeps prompt history', () => {
    recordAiChatPrompt(usersKey, 'keep me');
    saveAiChatSession(usersKey, { isOpen: false, messages: [] });
    expect(loadAiChatSession(usersKey)?.prompts.map((p) => p.text)).toEqual(['keep me']);
    expect(loadAiChatSession(usersKey)?.isOpen).toBe(false);
  });

  it('clearAiChatSession removes a key', () => {
    saveAiChatSession(usersKey, { isOpen: true, messages: [] });
    clearAiChatSession(usersKey);
    expect(loadAiChatSession(usersKey)).toBeNull();
  });

  it('caps messages per session', () => {
    const messages = Array.from({ length: AI_CHAT_SESSION_MAX_MESSAGES + 5 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      text: `p${i}`,
    }));
    saveAiChatSession(usersKey, { isOpen: true, messages });
    expect(loadAiChatSession(usersKey)?.messages).toHaveLength(AI_CHAT_SESSION_MAX_MESSAGES);
    expect(loadAiChatSession(usersKey)?.messages[0].text).toBe('p5');
  });

  it('prunes prompts older than the retention window', () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    localStorage.setItem(
      AI_CHAT_SESSIONS_STORAGE_KEY,
      JSON.stringify({
        [usersKey]: {
          isOpen: false,
          messages: [],
          prompts: [
            { id: 'old', text: 'ancient', sentAt: '2025-01-01T00:00:00.000Z' },
            { id: 'new', text: 'recent', sentAt: '2026-07-01T00:00:00.000Z' },
          ],
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      })
    );
    pruneAiChatSessions(3, now);
    // loadAiChatSession also prunes with wall-clock; read storage directly after prune.
    const stored = JSON.parse(localStorage.getItem(AI_CHAT_SESSIONS_STORAGE_KEY) || '{}');
    expect(stored[usersKey].prompts.map((p: { text: string }) => p.text)).toEqual(['recent']);
  });

  it('mirrors retention months and drops expired sessions when shortened', () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    localStorage.setItem(
      AI_CHAT_SESSIONS_STORAGE_KEY,
      JSON.stringify({
        [usersKey]: {
          isOpen: true,
          messages: [{ id: 'm0', role: 'user', text: 'hi' }],
          prompts: [{ id: 'p0', text: 'hi', sentAt: '2026-05-01T00:00:00.000Z' }],
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      })
    );
    expect(retentionCutoffIso(1, now) > '2026-05-01T00:00:00.000Z').toBe(true);
    saveAiHistoryRetentionMonths(1);
    pruneAiChatSessions(1, now);
    expect(loadAiHistoryRetentionMonths()).toBe(1);
    expect(JSON.parse(localStorage.getItem(AI_CHAT_SESSIONS_STORAGE_KEY) || '{}')[usersKey]).toBeUndefined();
  });
});

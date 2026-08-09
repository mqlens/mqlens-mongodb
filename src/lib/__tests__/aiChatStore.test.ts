import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  claimOpenChat,
  isHeldLocally,
  newPanelOwner,
  listChats,
  newChatId,
  releaseOpenChat,
  resetOpenChats,
  retentionCutoffIso,
  saveChat,
  titleFromMessages,
} from '../aiChatStore';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

describe('AI chat store', () => {
  beforeEach(() => {
    resetOpenChats();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    localStorage.clear();
  });

  describe('retention cutoff', () => {
    const day = (iso: string) => iso.slice(0, 10);

    it('does not overflow into the following month on a 31st', () => {
      // `setMonth` does not shorten the date: from 31 March, one month back is
      // "31 February", which rolls forward to 3 March — four weeks LATER than
      // intended, so a month of history still inside the policy is deleted.
      expect(day(retentionCutoffIso(1, new Date(2026, 2, 31, 12)))).toBe('2026-02-28');
      expect(day(retentionCutoffIso(1, new Date(2026, 4, 31, 12)))).toBe('2026-04-30');
    });

    it('leaves a day that exists in the target month alone', () => {
      expect(day(retentionCutoffIso(3, new Date(2026, 5, 15, 12)))).toBe('2026-03-15');
    });

    it('handles a leap February', () => {
      expect(day(retentionCutoffIso(1, new Date(2024, 2, 30, 12)))).toBe('2024-02-29');
    });

    it('falls back to the default for an unusable setting', () => {
      const asked = day(retentionCutoffIso(NaN, new Date(2026, 5, 15, 12)));
      expect(asked).toBe(day(retentionCutoffIso(3, new Date(2026, 5, 15, 12))));
    });
  });

  describe('open-chat claims', () => {
    it('asks the BACKEND, because two windows are two renderers', async () => {
      // A module-local guard would let each window adopt the same conversation
      // — the exact collision it exists to prevent.
      invokeMock.mockResolvedValue(true);

      await claimOpenChat('c1', 'main#1');

      expect(invokeMock).toHaveBeenCalledWith('claim_chat', {
        chatId: 'c1',
        owner: 'main#1',
      });
      expect(isHeldLocally('c1')).toBe(true);
    });

    it('reports the loss when another panel already holds it', async () => {
      invokeMock.mockResolvedValue(false);

      expect(await claimOpenChat('c1', 'main#1')).toBe(false);
      expect(isHeldLocally('c1')).toBe(false);
    });

    it('releases under the same owner that took it', () => {
      releaseOpenChat('c1', 'main#1');
      expect(invokeMock).toHaveBeenCalledWith('release_chat', {
        chatId: 'c1',
        owner: 'main#1',
      });
    });

    it('gives each panel its own owner token, since two tabs share a window', () => {
      expect(newPanelOwner()).not.toBe(newPanelOwner());
      expect(newPanelOwner().startsWith('main#')).toBe(true);
    });

    it('keeps working if the backend cannot answer', async () => {
      // Degrades to the pre-existing behaviour rather than blocking the panel.
      invokeMock.mockRejectedValue(new Error('nope'));
      expect(await claimOpenChat('c1', 'main#1')).toBe(true);
    });
  });

  it('titles a conversation from its opening question', () => {
    expect(
      titleFromMessages(
        [
          { id: 'm0', role: 'assistant', text: 'greeting' },
          { id: 'm1', role: 'user', text: 'active users over 30' },
        ],
        'fallback'
      )
    ).toBe('active users over 30');
  });

  it('falls back when there is no question yet, and truncates a long one', () => {
    expect(titleFromMessages([], 'Untitled chat')).toBe('Untitled chat');
    const long = 'a'.repeat(100);
    const title = titleFromMessages([{ id: 'm0', role: 'user', text: long }], 'x');
    expect(title).toHaveLength(58);
    expect(title.endsWith('…')).toBe(true);
  });

  it('mints ids without Math.random — CodeQL flags it, and collisions matter here', () => {
    const ids = new Set(Array.from({ length: 50 }, newChatId));
    expect(ids.size).toBe(50);
  });

  it('passes the retention cutoff to the backend on both read and write', () => {
    void listChats();
    void saveChat({
      id: 'c1',
      title: 't',
      messages: [],
      connectionName: 'Local',
      database: 'db',
      collection: 'coll',
      variant: 'editor',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    for (const cmd of ['list_chats', 'save_chat']) {
      const call = invokeMock.mock.calls.find((c) => c[0] === cmd);
      expect(call?.[1]?.cutoffIso, `${cmd} carried no cutoff`).toBeTruthy();
    }
  });

  it('reads a backend failure as no history rather than throwing', async () => {
    // The history menu failing to open must not be able to break the assistant.
    invokeMock.mockRejectedValue(new Error('backend gone'));
    await expect(listChats()).resolves.toEqual([]);
  });
});

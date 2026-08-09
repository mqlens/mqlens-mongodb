import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyUpdateCheckError,
  readUpdateCheckSnapshot,
  updateCheckBackoffMs,
  updateCheckResultLabel,
  writeUpdateCheckSnapshot,
} from '../updateCheckState';

describe('updateCheckState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('classifies offline vs server errors', () => {
    expect(classifyUpdateCheckError(new Error('network timeout'))).toBe('offline');
    expect(classifyUpdateCheckError(new Error('invalid signature'))).toBe('check-failed');
  });

  it('persists and reads the last check snapshot', () => {
    writeUpdateCheckSnapshot({
      checkedAt: '2026-06-15T12:00:00.000Z',
      result: 'uptodate',
    });
    expect(readUpdateCheckSnapshot()).toEqual({
      checkedAt: '2026-06-15T12:00:00.000Z',
      result: 'uptodate',
    });
  });

  it('returns translation keys (translated at the call site) for settings display', () => {
    expect(updateCheckResultLabel('offline')).toBe('updates.resultValues.offline');
    expect(updateCheckResultLabel('check-failed')).toBe('updates.resultValues.checkFailed');
  });

  it('backs off exponentially up to five minutes', () => {
    expect(updateCheckBackoffMs(0)).toBe(30_000);
    expect(updateCheckBackoffMs(1)).toBe(60_000);
    expect(updateCheckBackoffMs(4)).toBe(300_000);
    expect(updateCheckBackoffMs(8)).toBe(300_000);
  });
});

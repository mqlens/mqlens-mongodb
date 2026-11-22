import { describe, it, expect, beforeEach } from 'vitest';
import {
  BEHAVIOR_SETTINGS_KEY,
  DEFAULT_BEHAVIOR_SETTINGS,
  getBehaviorSettings,
  updateBehaviorSettings,
} from '../behaviorSettings';

describe('behaviorSettings', () => {
  beforeEach(() => localStorage.clear());

  it('returns the defaults when nothing is stored', () => {
    expect(getBehaviorSettings()).toEqual(DEFAULT_BEHAVIOR_SETTINGS);
  });

  it('keeps a stable snapshot until the stored value changes', () => {
    const first = getBehaviorSettings();
    expect(getBehaviorSettings()).toBe(first);
    updateBehaviorSettings({ pageSize: 100 });
    expect(getBehaviorSettings()).not.toBe(first);
    expect(getBehaviorSettings().pageSize).toBe(100);
  });

  it('merges a partial update and persists it', () => {
    updateBehaviorSettings({ expandCollectionsOnDbOpen: true });
    updateBehaviorSettings({ autoConvertObjectId: false });
    expect(JSON.parse(localStorage.getItem(BEHAVIOR_SETTINGS_KEY)!)).toEqual({
      ...DEFAULT_BEHAVIOR_SETTINGS,
      expandCollectionsOnDbOpen: true,
      autoConvertObjectId: false,
    });
  });

  it('falls back to defaults for corrupt or out-of-range values', () => {
    localStorage.setItem(BEHAVIOR_SETTINGS_KEY, '{not json');
    expect(getBehaviorSettings()).toEqual(DEFAULT_BEHAVIOR_SETTINGS);
    localStorage.setItem(BEHAVIOR_SETTINGS_KEY, JSON.stringify({ pageSize: 7, defaultIdSearch: 'yes', defaultViewMode: 'chart' }));
    expect(getBehaviorSettings()).toEqual(DEFAULT_BEHAVIOR_SETTINGS);
  });
});

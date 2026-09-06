import { describe, it, expect } from 'vitest';
import {
  keepAliveTabs,
  withActiveFirst,
  DEFAULT_KEEP_ALIVE_LIMITS,
  type KeepAliveTab,
} from '../keepAlive';

const collection = (id: string): KeepAliveTab => ({ id, kind: 'collection' });
const shell = (id: string): KeepAliveTab => ({ id, kind: 'shell' });

describe('keepAliveTabs', () => {
  const limits = { shell: 2, other: 3 };

  it('keeps the most recently active tabs and drops the rest', () => {
    const tabs = ['a', 'b', 'c', 'd', 'e'].map(collection);
    expect(keepAliveTabs(['e', 'd', 'c', 'b', 'a'], tabs, limits)).toEqual(['e', 'd', 'c']);
  });

  it('budgets shells separately, so they cannot crowd out collection tabs', () => {
    // #240: an idle mongosh session is ~272 MB, two orders of magnitude more
    // than a collection tab. Sharing one budget would let three shells evict
    // every collection tab the user was switching between.
    const tabs = [shell('s1'), shell('s2'), shell('s3'), collection('c1'), collection('c2')];
    const kept = keepAliveTabs(['s1', 's2', 's3', 'c1', 'c2'], tabs, limits);

    expect(kept).toEqual(['s1', 's2', 'c1', 'c2']);
    expect(kept).not.toContain('s3'); // third shell is over its own budget
  });

  it('does not let collection tabs consume the shell budget either', () => {
    const tabs = [collection('c1'), collection('c2'), collection('c3'), shell('s1')];
    const kept = keepAliveTabs(['c1', 'c2', 'c3', 's1'], tabs, limits);
    expect(kept).toEqual(['c1', 'c2', 'c3', 's1']);
  });

  it('ignores ids for tabs that have closed or moved to another pane', () => {
    const tabs = [collection('a'), collection('c')];
    expect(keepAliveTabs(['a', 'gone', 'c'], tabs, limits)).toEqual(['a', 'c']);
  });

  it('mounts nothing for a tab that has never been active here', () => {
    // Recency is what a pane has actually shown; an unopened tab is not mounted
    // until the user goes to it.
    const tabs = [collection('a'), collection('b')];
    expect(keepAliveTabs(['a'], tabs, limits)).toEqual(['a']);
  });

  it('ships with a shell budget well below the others', () => {
    // The whole point of separate caps. Guarded because raising this quietly
    // would put ~272 MB per extra shell back into a "just a tab" change.
    expect(DEFAULT_KEEP_ALIVE_LIMITS.shell).toBeLessThan(DEFAULT_KEEP_ALIVE_LIMITS.other);
    expect(DEFAULT_KEEP_ALIVE_LIMITS.shell).toBeLessThanOrEqual(2);
  });
});

describe('withActiveFirst', () => {
  const live = (...ids: string[]) => new Set(ids);

  it('moves the active tab to the front', () => {
    expect(withActiveFirst(['a', 'b', 'c'], 'c', live('a', 'b', 'c'))).toEqual(['c', 'a', 'b']);
  });

  it('adds an active tab that was not in the list yet', () => {
    expect(withActiveFirst(['a'], 'b', live('a', 'b'))).toEqual(['b', 'a']);
  });

  it('drops ids whose tabs are gone', () => {
    expect(withActiveFirst(['a', 'closed', 'b'], 'b', live('a', 'b'))).toEqual(['b', 'a']);
  });

  it('returns the same array when nothing moved, so state does not churn', () => {
    // A caller holds this in state and sets it from an effect: a fresh array
    // every pass would re-render forever.
    const prev = ['a', 'b'];
    expect(withActiveFirst(prev, 'a', live('a', 'b'))).toBe(prev);
  });

  it('keeps the list when there is no active tab, dropping only dead ids', () => {
    const prev = ['a', 'b'];
    expect(withActiveFirst(prev, null, live('a', 'b'))).toBe(prev);
    expect(withActiveFirst(prev, null, live('a'))).toEqual(['a']);
  });
});

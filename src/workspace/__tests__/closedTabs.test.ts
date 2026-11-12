import { describe, it, expect } from 'vitest';
import { CLOSED_TAB_HISTORY_LIMIT, rememberClosedTab, takeClosedTab } from '../closedTabs';

const tab = (id: string, type = 'collection') => ({ tab: { id, type } });

describe('closed tab history', () => {
  it('reopens newest first', () => {
    let history = rememberClosedTab([], tab('a'));
    history = rememberClosedTab(history, tab('b'));
    const { entry, history: rest } = takeClosedTab(history, () => true);
    expect(entry?.tab.id).toBe('b');
    expect(rest.map((e) => e.tab.id)).toEqual(['a']);
  });

  it('skips tabs that cannot come back', () => {
    expect(rememberClosedTab([], tab('quickstart', 'quickstart'))).toEqual([]);
    expect(rememberClosedTab([], tab('x', 'export'))).toEqual([]);
  });

  it('keeps one entry per id and caps the history', () => {
    let history = rememberClosedTab([], tab('a'));
    history = rememberClosedTab(history, tab('b'));
    history = rememberClosedTab(history, tab('a'));
    expect(history.map((e) => e.tab.id)).toEqual(['b', 'a']);

    for (let i = 0; i < CLOSED_TAB_HISTORY_LIMIT + 5; i++) history = rememberClosedTab(history, tab(`t${i}`));
    expect(history).toHaveLength(CLOSED_TAB_HISTORY_LIMIT);
    expect(history.at(-1)?.tab.id).toBe(`t${CLOSED_TAB_HISTORY_LIMIT + 4}`);
  });

  it('drops newer entries whose connection is gone', () => {
    const history = [tab('a'), tab('gone-1'), tab('gone-2')];
    const { entry, history: rest } = takeClosedTab(history, (t) => !t.id.startsWith('gone'));
    expect(entry?.tab.id).toBe('a');
    expect(rest).toEqual([]);
    expect(takeClosedTab([tab('gone')], () => false)).toEqual({ entry: null, history: [] });
  });
});

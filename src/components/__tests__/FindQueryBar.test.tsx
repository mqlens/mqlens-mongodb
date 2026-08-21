import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// QueryEditor wraps Monaco, which has no usable DOM under jsdom — mock it as a
// plain textarea that round-trips value/onChange, matching the other tests.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, wrapperProps }: { value: string; onChange?: (v: string) => void; wrapperProps?: Record<string, unknown> }) => (
    <textarea
      data-testid={wrapperProps?.['data-testid'] as string | undefined}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

const themeConfig: Record<string, unknown> = { presetId: 'mqlens-dark', mode: 'dark', fontSize: 13, uiZoom: 1, queryBarHeight: 29 };
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ config: themeConfig, resolvedMode: 'dark' as const }),
  useThemeOptional: () => ({ config: themeConfig, resolvedMode: 'dark' as const }),
}));

import { FindQueryBar } from '../FindQueryBar';

const noop = () => {};
const renderBar = (over: Partial<React.ComponentProps<typeof FindQueryBar>> = {}) =>
  render(
    <FindQueryBar
      collapsibleOptions
      filter=""
      projection=""
      sort=""
      onFilterChange={noop}
      onProjectionChange={noop}
      onSortChange={noop}
      fields={['name', 'age']}
      {...over}
    />,
  );

const section = () => screen.getByTestId('query-options-section');

describe('FindQueryBar — Options disclosure (#217)', () => {
  it('shows only Query by default, hiding projection/sort behind Options', () => {
    renderBar();
    // The Query field is always present and visible.
    expect(screen.getByTestId('query-filter-input')).toBeInTheDocument();
    // Projection/sort stay mounted (Monaco keeps its model) but are hidden.
    expect(screen.getByTestId('projection-query-input')).toBeInTheDocument();
    expect(section()).toHaveClass('hidden');
    expect(screen.getByTestId('query-options-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('reveals the options when the toggle is clicked, and hides them again', () => {
    renderBar();
    const toggle = screen.getByTestId('query-options-toggle');

    fireEvent.click(toggle);
    expect(section()).not.toHaveClass('hidden');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(section()).toHaveClass('hidden');
  });

  it('auto-reveals when a query already carries a sort, so nothing is hidden', () => {
    renderBar({ sort: '{"age": -1}' });
    expect(section()).not.toHaveClass('hidden');
  });

  it('auto-reveals for a non-default skip/limit', () => {
    renderBar({ skip: '20', limit: '50', onSkipChange: noop, onLimitChange: noop });
    expect(section()).not.toHaveClass('hidden');
  });

  it('treats an empty or {} projection/sort as default (stays collapsed)', () => {
    renderBar({ projection: '{}', sort: '  ' });
    expect(section()).toHaveClass('hidden');
  });

  it('marks the toggle with a dot when options are set but collapsed', () => {
    renderBar({ sort: '{"age": -1}' });
    // Auto-revealed, so no dot yet.
    expect(screen.queryByTestId('query-options-dot')).not.toBeInTheDocument();
    // Collapsing it while a sort is set surfaces the indicator.
    fireEvent.click(screen.getByTestId('query-options-toggle'));
    expect(screen.getByTestId('query-options-dot')).toBeInTheDocument();
  });

  it('wires the toggle to the section the way Compass does (aria-controls + More/Fewer Options)', () => {
    renderBar();
    const toggle = screen.getByTestId('query-options-toggle');
    // Compass names the region "additional-query-options-container" and swaps
    // the toggle's accessible name between More/Fewer Options. We suffix the id
    // per instance so two panes can't collide, but the toggle must still point
    // at its own region.
    const regionId = section().getAttribute('id');
    expect(regionId).toMatch(/^additional-query-options-container/);
    expect(toggle).toHaveAttribute('aria-controls', regionId!);
    expect(toggle).toHaveAttribute('aria-label', 'More Options');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-label', 'Fewer Options');
  });

  it('keeps the old always-visible layout when collapsibleOptions is off', () => {
    renderBar({ collapsibleOptions: false });
    expect(screen.queryByTestId('query-options-toggle')).not.toBeInTheDocument();
    expect(section()).not.toHaveClass('hidden');
  });
});

describe('FindQueryBar — configurable Query height (#217)', () => {
  const heightOf = (label: string) => (screen.getByText(label) as HTMLElement).style.height;

  it('sizes the Query row from the setting', () => {
    themeConfig.queryBarHeight = 29;
    renderBar();
    const queryLabel = screen.getByText('Query') as HTMLElement;
    expect(queryLabel.style.minHeight).toBe(`${29 / 13}rem`);
    expect(queryLabel.style.height).toBe('');
    expect(queryLabel).toHaveClass('self-stretch');
  });

  it('grows only the Query row — option rows stay compact', () => {
    themeConfig.queryBarHeight = 58;
    renderBar();
    expect((screen.getByText('Query') as HTMLElement).style.minHeight).toBe(`${58 / 13}rem`);
    // Projection/sort keep the compact height so the whole bar doesn't inflate.
    const compact = `${22.75 / 13}rem`;
    expect(heightOf('Projection')).toBe(compact);
    expect(heightOf('Sort')).toBe(compact);
    themeConfig.queryBarHeight = 29;
  });

  it('keeps skip/limit compact too', () => {
    themeConfig.queryBarHeight = 58;
    renderBar({ skip: '0', limit: '50', onSkipChange: noop, onLimitChange: noop });
    const compact = `${22.75 / 13}rem`;
    expect(heightOf('Skip')).toBe(compact);
    expect(heightOf('Limit')).toBe(compact);
    themeConfig.queryBarHeight = 29;
  });

  it('clamps an out-of-range stored value instead of trusting it', () => {
    themeConfig.queryBarHeight = 9999;
    renderBar();
    expect((screen.getByText('Query') as HTMLElement).style.minHeight).toBe(`${64 / 13}rem`);
    themeConfig.queryBarHeight = 29;
  });
});

describe('FindQueryBar — export view is unaffected by the Query height setting (review #229)', () => {
  const heightOf = (label: string) => (screen.getByText(label) as HTMLElement).style.height;

  it('keeps the Query label compact when the field itself is not sized by the setting', () => {
    // ExportView renders the bar without `collapsibleOptions`, so QueryEditor
    // uses the compact height — the label must not grow past its own input.
    themeConfig.queryBarHeight = 64;
    renderBar({ collapsibleOptions: false });
    const compact = `${22.75 / 13}rem`;
    const queryLabel = screen.getByText('Query') as HTMLElement;
    expect(queryLabel.style.minHeight).toBe(compact);
    expect(queryLabel.style.height).toBe('');
    expect(queryLabel).toHaveClass('self-stretch');
    expect(heightOf('Projection')).toBe(compact);
    themeConfig.queryBarHeight = 29;
  });

  it('still sizes the Query label when the field is sized (main query bar)', () => {
    themeConfig.queryBarHeight = 64;
    renderBar({ collapsibleOptions: true });
    expect((screen.getByText('Query') as HTMLElement).style.minHeight).toBe(`${64 / 13}rem`);
    themeConfig.queryBarHeight = 29;
  });

  it('gives each query bar its own options region id so split panes do not collide', () => {
    const a = renderBar();
    const first = a.getByTestId('query-options-section').getAttribute('id');
    const b = renderBar();
    const ids = b.container.ownerDocument.querySelectorAll('[data-testid="query-options-section"]');
    const all = Array.from(ids).map((el) => el.getAttribute('id'));
    expect(first).toBeTruthy();
    expect(new Set(all).size).toBe(all.length);
    // aria-controls must point at that instance's own region.
    const toggles = Array.from(
      b.container.ownerDocument.querySelectorAll('[data-testid="query-options-toggle"]'),
    ).map((el) => el.getAttribute('aria-controls'));
    expect(new Set(toggles).size).toBe(toggles.length);
    expect(toggles).toEqual(expect.arrayContaining(all));
  });
});

describe('FindQueryBar — persisted Options state (review #229)', () => {
  it('reports toggles so a host can persist them', () => {
    const onChange = vi.fn();
    renderBar({ onOptionsOpenChange: onChange });
    fireEvent.click(screen.getByTestId('query-options-toggle'));
    expect(onChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId('query-options-toggle'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('honours a persisted collapse even though a sort is set', () => {
    // The regression: remounting (tab switch) used to re-run auto-reveal and
    // undo the user's deliberate collapse.
    const onChange = vi.fn();
    renderBar({ sort: '{"age": -1}', optionsOpen: false, onOptionsOpenChange: onChange });
    expect(section()).toHaveClass('hidden');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('honours a persisted expand', () => {
    renderBar({ optionsOpen: true });
    expect(section()).not.toHaveClass('hidden');
  });

  it('still auto-reveals on a fresh bar when a query arrives with options set', () => {
    renderBar({ sort: '{"age": -1}' });
    expect(section()).not.toHaveClass('hidden');
  });
});

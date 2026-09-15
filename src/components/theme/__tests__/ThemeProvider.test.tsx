import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => mockInvoke(...a) }));

import { ThemeProvider, useTheme } from '../ThemeProvider';

function Probe() {
  const { setPreset } = useTheme();
  return <button onClick={() => setPreset('nord')}>to-nord</button>;
}

/** Renders the provider and waits until its settings load has finished. */
async function renderHydrated(settings: unknown) {
  mockInvoke.mockImplementation(async (cmd: string) =>
    cmd === 'load_app_settings' ? settings : undefined,
  );
  render(<ThemeProvider><Probe /></ThemeProvider>);
  // The load resolves on microtasks only; a macrotask runs after all of them.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(mockInvoke).toHaveBeenCalledWith('load_app_settings');
  vi.useFakeTimers();
}

const appearanceSaves = () =>
  mockInvoke.mock.calls.filter(([cmd]) => cmd === 'patch_app_settings');

describe('ThemeProvider auto-save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A fresh install loads no appearance. The provider used to skip "the change
  // hydration makes" with a flag that only a load cleared, so without a load it
  // swallowed the user's first change: never saved, never cached, gone after a
  // restart.
  it.each([
    ['settings without an appearance', {}],
    [
      // What AppearanceSettings' derived Default used to serialize.
      'an appearance with an empty preset_id',
      {
        appearance: {
          preset_id: '',
          mode: '',
          overrides: {},
          font_sans: '',
          font_mono: '',
          font_size: 0,
          spacing_density: '',
          ui_zoom: 0,
          query_bar_height: 0,
        },
      },
    ],
  ])('saves the first change after loading %s', async (_label, settings) => {
    await renderHydrated(settings);

    fireEvent.click(screen.getByText('to-nord'));

    act(() => vi.advanceTimersByTime(399));
    expect(appearanceSaves()).toHaveLength(0);

    act(() => vi.advanceTimersByTime(1));
    expect(appearanceSaves()).toEqual([
      [
        'patch_app_settings',
        { patch: { appearance: expect.objectContaining({ preset_id: 'nord', mode: 'dark' }) } },
      ],
    ]);
    expect(JSON.parse(localStorage.getItem('mqlens-appearance')!)).toMatchObject({
      preset_id: 'nord',
    });
  });

  it('does not write a loaded appearance back, but saves the change after it', async () => {
    await renderHydrated({
      appearance: {
        preset_id: 'mqlens-light',
        mode: 'light',
        overrides: {},
        font_sans: 'Inter',
        font_mono: 'JetBrains Mono',
        font_size: 13,
        spacing_density: 'cozy',
        ui_zoom: 1,
        query_bar_height: 29,
      },
    });

    act(() => vi.advanceTimersByTime(1000));
    expect(appearanceSaves()).toHaveLength(0);

    fireEvent.click(screen.getByText('to-nord'));
    act(() => vi.advanceTimersByTime(400));
    expect(appearanceSaves()).toEqual([
      [
        'patch_app_settings',
        { patch: { appearance: expect.objectContaining({ preset_id: 'nord', mode: 'dark' }) } },
      ],
    ]);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMonacoTheme } from '../useMonacoTheme';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('useMonacoTheme', () => {
  it('defaults to vs-dark', () => {
    const { result } = renderHook(() => useMonacoTheme());
    expect(result.current).toBe('vs-dark');
  });

  it('returns light when the app theme is light', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const { result } = renderHook(() => useMonacoTheme());
    expect(result.current).toBe('light');
  });

  it('updates when the app theme changes after mount', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const { result } = renderHook(() => useMonacoTheme());
    expect(result.current).toBe('vs-dark');

    document.documentElement.setAttribute('data-theme', 'light');
    await waitFor(() => expect(result.current).toBe('light'));

    document.documentElement.setAttribute('data-theme', 'dark');
    await waitFor(() => expect(result.current).toBe('vs-dark'));
  });
});

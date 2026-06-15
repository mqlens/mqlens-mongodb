import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useMonacoTheme } from '../useMonacoTheme';
import { ThemeContext, type ThemeContextValue } from '@/components/theme/theme-context';
import { DEFAULT_THEME_CONFIG } from '@/lib/themes/schema';
import { THEME_PRESETS } from '@/lib/themes/presets';

function createWrapper(resolvedMode: 'dark' | 'light') {
  const value: ThemeContextValue = {
    config: DEFAULT_THEME_CONFIG,
    resolvedMode,
    presets: THEME_PRESETS,
    setPreset: () => {},
    setMode: () => {},
    setFontSize: () => {},
    setUiZoom: () => {},
    zoomIn: () => {},
    zoomOut: () => {},
    resetZoom: () => {},
    setSpacingDensity: () => {},
    setFontSans: () => {},
    setFontMono: () => {},
    setOverride: () => {},
    clearOverrides: () => {},
    updateConfig: () => {},
    exportTheme: () => '',
    importTheme: () => DEFAULT_THEME_CONFIG,
    saveAppearance: async () => {},
  };

  return ({ children }: { children: ReactNode }) => (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

afterEach(() => {
  document.documentElement.classList.remove('light', 'dark');
});

describe('useMonacoTheme', () => {
  it('defaults to mqlens-dark without theme context', () => {
    const { result } = renderHook(() => useMonacoTheme());
    expect(result.current).toBe('mqlens-dark');
  });

  it('returns mqlens-light when resolved mode is light', () => {
    const { result } = renderHook(() => useMonacoTheme(), {
      wrapper: createWrapper('light'),
    });
    expect(result.current).toBe('mqlens-light');
  });

  it('updates when resolved mode changes', () => {
    let mode: 'dark' | 'light' = 'dark';
    const wrapper = ({ children }: { children: ReactNode }) => {
      const value: ThemeContextValue = {
        config: DEFAULT_THEME_CONFIG,
        resolvedMode: mode,
        presets: THEME_PRESETS,
        setPreset: () => {},
        setMode: () => {},
        setFontSize: () => {},
        setUiZoom: () => {},
        zoomIn: () => {},
        zoomOut: () => {},
        resetZoom: () => {},
        setSpacingDensity: () => {},
        setFontSans: () => {},
        setFontMono: () => {},
        setOverride: () => {},
        clearOverrides: () => {},
        updateConfig: () => {},
        exportTheme: () => '',
        importTheme: () => DEFAULT_THEME_CONFIG,
        saveAppearance: async () => {},
      };
      return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
    };

    const { result, rerender } = renderHook(() => useMonacoTheme(), { wrapper });
    expect(result.current).toBe('mqlens-dark');

    mode = 'light';
    rerender();
    expect(result.current).toBe('mqlens-light');
  });
});

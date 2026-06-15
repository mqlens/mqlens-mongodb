import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  applyTheme,
  getEffectiveTokens,
  exportThemeJson,
  importThemeJson,
  resetAppliedThemeCache,
} from '@/lib/themes/apply-theme';
import {
  APPEARANCE_CACHE_KEY,
  DEFAULT_THEME_CONFIG,
  migrateLegacyTheme,
  readAppearanceCache,
  readInitialThemeConfig,
  themeConfigToAppearance,
  appearanceToThemeConfig,
  writeAppearanceCache,
} from '@/lib/themes/schema';

describe('applyTheme', () => {
  beforeEach(() => {
    resetAppliedThemeCache();
  });

  it('applies dark class and CSS variables', () => {
    const mode = applyTheme(DEFAULT_THEME_CONFIG);
    expect(mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--primary')).toBeTruthy();
  });

  it('applies light mode from preset', () => {
    applyTheme({ ...DEFAULT_THEME_CONFIG, presetId: 'mqlens-light', mode: 'light' });
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('sets font size and spacing density attributes', () => {
    applyTheme({
      ...DEFAULT_THEME_CONFIG,
      fontSize: 15,
      spacingDensity: 'compact',
    });
    expect(document.documentElement.style.getPropertyValue('--font-size-base')).toBe('15px');
    expect(document.documentElement.getAttribute('data-spacing')).toBe('compact');
  });
});

describe('theme config serialization', () => {
  it('round-trips export/import JSON', () => {
    const config = {
      ...DEFAULT_THEME_CONFIG,
      presetId: 'nord',
      fontSize: 14,
    };
    const restored = importThemeJson(exportThemeJson(config));
    expect(restored.presetId).toBe('nord');
    expect(restored.fontSize).toBe(14);
  });

  it('converts appearance settings to theme config', () => {
    const appearance = themeConfigToAppearance(DEFAULT_THEME_CONFIG);
    const restored = appearanceToThemeConfig(appearance);
    expect(restored.presetId).toBe(DEFAULT_THEME_CONFIG.presetId);
    expect(restored.fontSize).toBe(DEFAULT_THEME_CONFIG.fontSize);
  });
});

describe('getEffectiveTokens', () => {
  it('merges preset with overrides', () => {
    const tokens = getEffectiveTokens({
      ...DEFAULT_THEME_CONFIG,
      overrides: { primary: '200 100% 50%' },
    });
    expect(tokens.primary).toBe('200 100% 50%');
  });
});

describe('migrateLegacyTheme', () => {
  it('reads legacy localStorage keys', () => {
    localStorage.setItem('mqlens-theme', 'light');
    localStorage.setItem('mqlens-density', 'roomy');
    const migrated = migrateLegacyTheme();
    expect(migrated.presetId).toBe('mqlens-light');
    expect(migrated.spacingDensity).toBe('roomy');
    localStorage.removeItem('mqlens-theme');
    localStorage.removeItem('mqlens-density');
  });
});

describe('appearance cache', () => {
  afterEach(() => {
    localStorage.removeItem(APPEARANCE_CACHE_KEY);
  });

  it('round-trips theme config through localStorage cache', () => {
    const config = {
      ...DEFAULT_THEME_CONFIG,
      presetId: 'nord',
      mode: 'light' as const,
      fontSize: 15,
      spacingDensity: 'roomy' as const,
    };
    writeAppearanceCache(config);
    expect(readAppearanceCache()).toEqual(config);
  });

  it('prefers appearance cache over legacy keys', () => {
    writeAppearanceCache({
      ...DEFAULT_THEME_CONFIG,
      presetId: 'nord',
      mode: 'dark',
    });
    localStorage.setItem('mqlens-theme', 'light');
    expect(readInitialThemeConfig().presetId).toBe('nord');
    localStorage.removeItem('mqlens-theme');
  });
});

import { describe, it, expect } from 'vitest';
import { gridfsMetadataForUpload, validateGridfsMetadataJson } from '../gridfsUpload';

describe('gridfsUpload helpers', () => {
  // The real catalog rather than a stub `t`, so a missing or renamed key fails
  // here instead of silently rendering the raw key in the dialog.
  const tFor = async (lng: 'en' | 'de') => {
    const { i18next } = await import('@/lib/i18n');
    return i18next.getFixedT(lng, 'admin');
  };

  it('allows empty metadata', async () => {
    const t = await tFor('en');
    expect(validateGridfsMetadataJson('', t)).toBeNull();
    expect(validateGridfsMetadataJson('   ', t)).toBeNull();
    expect(gridfsMetadataForUpload('')).toBeNull();
    expect(gridfsMetadataForUpload('  ')).toBeNull();
  });

  it('accepts a JSON object', async () => {
    const t = await tFor('en');
    expect(validateGridfsMetadataJson('{"source":"test"}', t)).toBeNull();
    expect(gridfsMetadataForUpload('{"source":"test"}')).toBe('{"source":"test"}');
  });

  it('rejects non-object JSON', async () => {
    const t = await tFor('en');
    expect(validateGridfsMetadataJson('[]', t)).toMatch(/object/i);
    expect(validateGridfsMetadataJson('null', t)).toMatch(/object/i);
    expect(validateGridfsMetadataJson('{"', t)).toMatch(/json/i);
  });

  it('returns German validation messages under a German locale', async () => {
    const t = await tFor('de');
    expect(validateGridfsMetadataJson('[]', t)).toBe('Metadaten müssen ein JSON-Objekt sein');
    expect(validateGridfsMetadataJson('{"', t)).toBe('Ungültiges JSON');
  });
});

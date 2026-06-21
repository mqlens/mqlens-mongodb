import { describe, it, expect } from 'vitest';
import { gridfsMetadataForUpload, validateGridfsMetadataJson } from '../gridfsUpload';

describe('gridfsUpload helpers', () => {
  it('allows empty metadata', () => {
    expect(validateGridfsMetadataJson('')).toBeNull();
    expect(validateGridfsMetadataJson('   ')).toBeNull();
    expect(gridfsMetadataForUpload('')).toBeNull();
    expect(gridfsMetadataForUpload('  ')).toBeNull();
  });

  it('accepts a JSON object', () => {
    expect(validateGridfsMetadataJson('{"source":"test"}')).toBeNull();
    expect(gridfsMetadataForUpload('{"source":"test"}')).toBe('{"source":"test"}');
  });

  it('rejects non-object JSON', () => {
    expect(validateGridfsMetadataJson('[]')).toMatch(/object/i);
    expect(validateGridfsMetadataJson('null')).toMatch(/object/i);
    expect(validateGridfsMetadataJson('{"')).toMatch(/json/i);
  });
});

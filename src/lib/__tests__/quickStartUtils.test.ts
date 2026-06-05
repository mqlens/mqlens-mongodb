import { describe, it, expect } from 'vitest';
import { hostFromUri, avatarColor, initial, AVATAR_PALETTE } from '../quickStartUtils';

describe('hostFromUri', () => {
  it('returns host:port for a standard uri', () => {
    expect(hostFromUri('mongodb://localhost:27017')).toBe('localhost:27017');
  });
  it('strips credentials', () => {
    expect(hostFromUri('mongodb://alice:secret@10.2.0.4:27017/db')).toBe('10.2.0.4:27017');
  });
  it('handles srv uris (no port)', () => {
    expect(hostFromUri('mongodb+srv://bob:pw@cluster0.x9k2.mongodb.net/db'))
      .toBe('cluster0.x9k2.mongodb.net');
  });
  it('returns empty string for junk', () => {
    expect(hostFromUri('not a uri')).toBe('');
  });
});

describe('initial', () => {
  it('uppercases the first alphanumeric char', () => {
    expect(initial('prod-east')).toBe('P');
    expect(initial('  9lives')).toBe('9');
  });
  it('falls back to ? when empty', () => {
    expect(initial('')).toBe('?');
    expect(initial('   ')).toBe('?');
  });
});

describe('avatarColor', () => {
  it('is deterministic for the same name', () => {
    expect(avatarColor('prod-east')).toBe(avatarColor('prod-east'));
  });
  it('returns a value from the palette', () => {
    expect(AVATAR_PALETTE).toContain(avatarColor('staging'));
  });
  it('returns a palette color even for empty input', () => {
    expect(AVATAR_PALETTE).toContain(avatarColor(''));
  });
});

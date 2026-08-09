import { describe, it, expect } from 'vitest';
import {
  hostFromUri,
  avatarColor,
  initial,
  topology,
  AVATAR_PALETTE,
  primaryShortcutModifier,
} from '../quickStartUtils';

describe('primaryShortcutModifier', () => {
  it('uses the Command symbol on Apple platforms', () => {
    expect(primaryShortcutModifier('MacIntel')).toBe('⌘');
    expect(primaryShortcutModifier('iPhone')).toBe('⌘');
  });

  it('uses Ctrl on other platforms', () => {
    expect(primaryShortcutModifier('Win32')).toBe('Ctrl');
    expect(primaryShortcutModifier('Linux x86_64')).toBe('Ctrl');
  });
});

describe('topology', () => {
  // The real catalog rather than a stub `t`, so a missing or renamed key fails
  // here instead of silently rendering the raw key on the connection card.
  const tFor = async (lng: 'en' | 'de') => {
    const { i18next } = await import('@/lib/i18n');
    return i18next.getFixedT(lng, 'shell');
  };

  it('labels srv uris as SRV cluster', async () => {
    const t = await tFor('en');
    expect(topology('mongodb+srv://c.x9k2.mongodb.net/db', t)).toBe('SRV cluster');
  });
  it('counts replica-set nodes from a multi-host uri', async () => {
    const t = await tFor('en');
    expect(topology('mongodb://h1:27017,h2:27017,h3:27017/db', t)).toBe('Replica set · 3 nodes');
  });
  it('labels a single host as standalone', async () => {
    const t = await tFor('en');
    expect(topology('mongodb://localhost:27017', t)).toBe('Standalone');
  });
  it('labels all three topologies in German', async () => {
    const t = await tFor('de');
    expect(topology('mongodb+srv://c.x9k2.mongodb.net/db', t)).toBe('SRV-Cluster');
    expect(topology('mongodb://h1:27017,h2:27017,h3:27017/db', t)).toBe('Replikatset · 3 Knoten');
    // "Standalone" deliberately stays English in German: it is the same term
    // the user picks in the connection editor (connections:form.topologyStandalone
    // = "Standalone / Direkt"), and reporting it back translated meant the card
    // never matched the choice.
    expect(topology('mongodb://localhost:27017', t)).toBe('Standalone');
  });
});

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

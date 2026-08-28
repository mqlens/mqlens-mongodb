import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_BYTES } from '@/components/AIChatPanel';

/**
 * The panel decides what to attach; the backend decides what it will send. When
 * those two lists disagree the user gets a preview and then a failure after the
 * prompt has already been cleared, which is how the mismatch was found.
 */
describe('accepted image types', () => {
  it('matches the backend allowlist exactly', () => {
    const rust = readFileSync('src-tauri/src/ai.rs', 'utf8');
    const line = rust.split('\n').find((l) => l.includes('ALLOWED_IMAGE_TYPES'));
    expect(line, 'ALLOWED_IMAGE_TYPES not found in src-tauri/src/ai.rs').toBeTruthy();
    const backend = [...line!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...ACCEPTED_IMAGE_TYPES].sort()).toEqual([...backend].sort());
  });

  it('matches the backend size cap', () => {
    const rust = readFileSync('src-tauri/src/ai.rs', 'utf8');
    const line = rust.split('\n').find((l) => l.includes('MAX_IMAGE_BYTES'));
    expect(line, 'MAX_IMAGE_BYTES not found in src-tauri/src/ai.rs').toBeTruthy();
    // e.g. `pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;`
    const expr = line!.slice(line!.indexOf('=') + 1).replace(/[;].*$/, '').trim();
    const backend = expr.split('*').reduce((a, b) => a * Number(b.trim()), 1);
    expect(MAX_IMAGE_BYTES).toBe(backend);
  });
});

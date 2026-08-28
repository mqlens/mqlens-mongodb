import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACCEPTED_IMAGE_TYPES } from '@/components/AIChatPanel';

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
});

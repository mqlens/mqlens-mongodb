import { describe, it, expect } from 'vitest';
// Monaco's markdown renderer sanitizes with its own vendored copy of DOMPurify,
// not the npm `dompurify` package (whose version package.json's override pins).
// This is the copy the app bundles, so it is the one whose version matters.
import purify from 'monaco-editor/base/browser/dompurify/dompurify.js';

/** Compares dotted version strings numerically: negative, zero or positive. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe("Monaco's vendored DOMPurify", () => {
  // 3.4.13 is the first release outside the range of every DOMPurify advisory
  // that covered Monaco 0.55.1's bundled 3.2.7 (GHSA-55q2-fjhq-7xh7 was the
  // last of them to be fixed).
  it('is 3.4.13 or later', () => {
    expect(compareVersions(purify.version, '3.4.13'), `bundled DOMPurify ${purify.version}`).toBeGreaterThanOrEqual(0);
  });
});

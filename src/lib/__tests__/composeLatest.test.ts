import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The release workflow runs this script to write the updater's `latest.json`
// from the `.sig` files attached to a release.
const SCRIPT = resolve(__dirname, '../../../.github/scripts/compose-latest.cjs');

/** Run the script against a release holding `artifacts`; returns platform -> artifact. */
function compose(artifacts: string[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'compose-latest-'));
  try {
    mkdirSync(join(dir, 'sigs'));
    for (const a of artifacts) writeFileSync(join(dir, 'sigs', `${a}.sig`), `sig-of-${a}\n`);
    execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      env: { ...process.env, REPO: 'mqlens/mqlens-mongodb', REL_TAG: 'mqlens-v0.22.0', VERSION: '0.22.0' },
      stdio: 'pipe',
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
    return Object.fromEntries(
      Object.entries<{ url: string; signature: string }>(manifest.platforms).map(([platform, entry]) => {
        const artifact = decodeURIComponent(entry.url.split('/').pop()!);
        expect(entry.signature).toBe(`sig-of-${artifact}`);
        return [platform, artifact];
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('compose-latest.cjs', () => {
  // The signed artifacts of the 0.22.0 release.
  const stable = [
    'MQLens-0.22.0-1.x86_64.rpm',
    'MQLens_0.22.0_aarch64.app.tar.gz',
    'MQLens_0.22.0_amd64.AppImage',
    'MQLens_0.22.0_amd64.deb',
    'MQLens_0.22.0_x64-setup.exe',
    'MQLens_0.22.0_x64.app.tar.gz',
    'MQLens_0.22.0_x64_en-US.msi',
  ];

  it('gives .deb and .rpm installs their own package, not the AppImage', () => {
    // The updater looks up `linux-x86_64-deb` / `-rpm` before `linux-x86_64`.
    // Falling back, a package install downloads the AppImage and its installer
    // rejects it ("invalid updater binary format").
    expect(compose(stable)).toEqual({
      'darwin-aarch64': 'MQLens_0.22.0_aarch64.app.tar.gz',
      'darwin-x86_64': 'MQLens_0.22.0_x64.app.tar.gz',
      'linux-x86_64': 'MQLens_0.22.0_amd64.AppImage',
      'linux-x86_64-deb': 'MQLens_0.22.0_amd64.deb',
      'linux-x86_64-rpm': 'MQLens-0.22.0-1.x86_64.rpm',
      'windows-x86_64': 'MQLens_0.22.0_x64-setup.exe',
    });
  });

  it('leaves out a package the release does not have', () => {
    // Linux dev builds skip the .rpm.
    const platforms = compose(['MQLens_0.22.1-293_amd64.AppImage', 'MQLens_0.22.1-293_amd64.deb']);
    expect(platforms).toEqual({
      'linux-x86_64': 'MQLens_0.22.1-293_amd64.AppImage',
      'linux-x86_64-deb': 'MQLens_0.22.1-293_amd64.deb',
    });
  });
});

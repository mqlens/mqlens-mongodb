import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = join(process.cwd(), '.github', 'workflows');

/** The workflow-level `permissions:` block: the key's own line plus its indented body. */
function topLevelPermissions(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^permissions:/.test(line));
  if (start === -1) return [];
  // The next top-level key ends the block; a comment in column zero does not.
  const end = lines.findIndex((line, i) => i > start && /^[^\s#]/.test(line));
  return lines.slice(start, end === -1 ? undefined : end);
}

// A workflow-level grant reaches every job, including ones added later. A job
// that publishes something asks for write access itself (OpenSSF Scorecard's
// Token-Permissions check scores a workflow-level write as 0).
describe('GitHub workflow token permissions', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

  it('reads past a comment in column zero inside the block', () => {
    const yaml = 'permissions:\n# Token scopes\n  contents: write\n\njobs:\n  build: {}\n';
    expect(topLevelPermissions(yaml)).toContain('  contents: write');
  });

  it.each(files)('%s grants no write access at workflow level', (name) => {
    const block = topLevelPermissions(readFileSync(join(WORKFLOWS, name), 'utf8'));
    expect(block.length, 'workflow must declare top-level permissions').toBeGreaterThan(0);
    expect(block.filter((line) => /\bwrite(-all)?\b/.test(line.replace(/#.*$/, '')))).toEqual([]);
  });
});

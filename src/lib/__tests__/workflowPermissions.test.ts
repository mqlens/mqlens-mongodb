import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = join(process.cwd(), '.github', 'workflows');

/** The workflow-level `permissions:` block: the key's own line plus its indented body. */
function topLevelPermissions(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^permissions:/.test(line));
  if (start === -1) return [];
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end);
}

// A workflow-level grant reaches every job, including ones added later. A job
// that publishes something asks for write access itself (OpenSSF Scorecard's
// Token-Permissions check scores a workflow-level write as 0).
describe('GitHub workflow token permissions', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

  it.each(files)('%s grants no write access at workflow level', (name) => {
    const block = topLevelPermissions(readFileSync(join(WORKFLOWS, name), 'utf8'));
    expect(block.length, 'workflow must declare top-level permissions').toBeGreaterThan(0);
    expect(block.filter((line) => /\bwrite(-all)?\b/.test(line.replace(/#.*$/, '')))).toEqual([]);
  });
});

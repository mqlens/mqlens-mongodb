import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The queue's own behaviour is covered through the panel, in
 * `AIChatPanel.test.tsx`. What is left here is the wiring either side of it,
 * where both ends were right and the join was not: who starts the subscription,
 * and whether the two languages agree on the event name.
 */
describe('write-request wiring', () => {
  it('is started by App, not by the confirmation UI', () => {
    // Started lazily from the panel, a write arriving before any panel had ever
    // mounted was broadcast to nobody — and an external MCP client's write, which
    // is confirmed on every route now, never comes from a panel at all. `App` is
    // mounted for the life of the webview; the panel is unmounted on a tab switch.
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app, 'App.tsx must import the starter').toMatch(
      /import \{[^}]*startWriteRequests[^}]*\} from '\.\/lib\/mcpWriteRequests'/,
    );
    // Called in a mount effect rather than merely imported.
    const call = app.indexOf('startWriteRequests();');
    expect(call, 'App.tsx must call startWriteRequests()').toBeGreaterThan(0);
    const effect = app.lastIndexOf('useEffect(() => {', call);
    expect(effect, 'the call must sit inside a useEffect').toBeGreaterThan(0);
    expect(
      app.slice(call, call + 60),
      'it must run once on mount, not on every render',
    ).toMatch(/\}, \[\]\);/);
  });

  it('listens for the event name the backend emits', () => {
    // A rename on one side is silent: the prompt simply never clears, which looks
    // exactly like the stale-prompt bug this event exists to fix.
    const rust = readFileSync('src-tauri/src/mcp.rs', 'utf8');
    const store = readFileSync('src/workspace/workspaceStore.ts', 'utf8');
    for (const event of ['mcp-write-request', 'mcp-write-settled']) {
      expect(rust, `${event} must be emitted`).toContain(`"${event}"`);
      expect(store, `${event} must be listened for`).toContain(`'${event}'`);
    }
  });

  it('settles the request for every outcome, not only an answer', () => {
    // A refusal and a timeout leave the other webviews holding the prompt just as
    // an approval does. Emitting from the resolve command would have covered the
    // answer alone, so this is emitted where the wait ends — before the outcome is
    // even inspected.
    const rust = readFileSync('src-tauri/src/mcp.rs', 'utf8');
    const body = rust.slice(0, rust.indexOf('\n#[cfg(test)]') + 1 || undefined);
    const confirm = body.split('async fn confirm_write')[1];
    expect(confirm, 'confirm_write not found').toBeTruthy();
    const settled = confirm.indexOf('"mcp-write-settled"');
    const outcome = confirm.indexOf('let (approved, refusal) = match answer');
    expect(settled, 'confirm_write must emit mcp-write-settled').toBeGreaterThan(0);
    expect(outcome).toBeGreaterThan(0);
    expect(settled, 'it must be emitted before the outcome is branched on').toBeLessThan(outcome);
  });
});

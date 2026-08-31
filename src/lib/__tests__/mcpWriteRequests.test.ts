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

  it('settles the request for every outcome, cancellation included', () => {
    // A refusal, a timeout and a cancelled handler all leave the other webviews
    // holding the prompt just as an approval does. Emitting from the resolve
    // command would have covered the answer alone; emitting after the `await`
    // covered everything except cancellation, because a dropped future never gets
    // there. So the broadcast belongs to the guard that owns the entry, and the
    // frontend TTL below is only a backstop for a lost event.
    const rust = readFileSync('src-tauri/src/mcp.rs', 'utf8');
    const body = rust.slice(0, rust.indexOf('\n#[cfg(test)]') + 1 || undefined);
    const guard = body.split("impl<'a> ConfirmEntry<'a>")[1];
    expect(guard, 'ConfirmEntry impl not found').toBeTruthy();
    const settle = guard.slice(0, guard.indexOf('impl Drop'));
    expect(settle, 'the guard must invoke the settled broadcast').toContain('(self.settled)(&id);');
    // Reached from Drop, which is the path cancellation takes.
    expect(body, 'Drop must settle').toMatch(
      /impl Drop for ConfirmEntry<'_> \{\s*fn drop\(&mut self\) \{\s*self\.settle\(\);/,
    );
    // And not left behind on the answered path as a second, skippable emit.
    const confirm = body.split('async fn confirm_write')[1];
    expect(confirm).not.toContain('app_handle.emit("mcp-write-settled"');
  });
});

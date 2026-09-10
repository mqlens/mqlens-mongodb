import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { logFrontendError, installCrashHandlers } from '../crashLog';

describe('crashLog (#379)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('sends the message to the log_frontend_error command', () => {
    logFrontendError('boom');
    expect(invokeMock).toHaveBeenCalledWith('log_frontend_error', { message: 'boom' });
  });

  it('never throws when the invoke rejects — logging a crash must not crash', () => {
    invokeMock.mockRejectedValue(new Error('ipc down'));
    expect(() => logFrontendError('boom')).not.toThrow();
  });

  it('never throws when invoke throws synchronously (no Tauri host)', () => {
    invokeMock.mockImplementation(() => {
      throw new Error('not in a webview');
    });
    expect(() => logFrontendError('boom')).not.toThrow();
  });

  describe('installCrashHandlers', () => {
    // Dispatch on a stand-in EventTarget rather than the real `window`: vitest
    // installs its own window error listener and treats a dispatched `error`
    // event as an unhandled error, which fails the whole run. installCrashHandlers
    // accepts any EventTarget precisely so this can be exercised in isolation.
    let target: EventTarget;
    beforeEach(() => {
      target = new EventTarget();
    });

    it('logs a window error event with its stack', () => {
      const cleanup = installCrashHandlers(target);
      const err = new Error('render exploded');
      target.dispatchEvent(new ErrorEvent('error', { error: err, message: err.message }));
      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [, { message }] = invokeMock.mock.calls[0] as [string, { message: string }];
      expect(message).toContain('window.onerror');
      expect(message).toContain('render exploded');
      cleanup();
    });

    it('logs an unhandled promise rejection', () => {
      const cleanup = installCrashHandlers(target);
      // jsdom does not synthesise unhandledrejection from real promises, so the
      // event is dispatched directly — the handler wiring is what is under test.
      const ev: any = new Event('unhandledrejection');
      ev.reason = new Error('async boom');
      target.dispatchEvent(ev);
      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [, { message }] = invokeMock.mock.calls[0] as [string, { message: string }];
      expect(message).toContain('unhandledrejection');
      expect(message).toContain('async boom');
      cleanup();
    });

    it('detaches its listeners on cleanup', () => {
      const cleanup = installCrashHandlers(target);
      cleanup();
      target.dispatchEvent(new ErrorEvent('error', { error: new Error('x'), message: 'x' }));
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });
});

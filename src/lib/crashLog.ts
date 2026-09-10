import { invoke } from '@tauri-apps/api/core';

/**
 * Persist a frontend error to the app's crash log (`log_frontend_error`).
 *
 * The app has no other logging, and a release build has no reachable console —
 * so without this an uncaught error leaves nothing to attach to a bug report
 * (#379). Best-effort by contract: it must never throw or reject in the middle
 * of handling a crash, so the invoke is fired and its failure swallowed.
 */
export function logFrontendError(message: string): void {
  try {
    void invoke('log_frontend_error', { message }).catch(() => {});
  } catch {
    // invoke itself can throw synchronously outside a Tauri webview (tests, a
    // plain browser); logging a crash must not become a second crash.
  }
}

/** Render an Error (or unknown thrown value) as message + stack for the log. */
function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`;
  }
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Route otherwise-uncaught frontend errors into the crash log.
 *
 * Covers the two escapes an error boundary cannot: a synchronous `error` event
 * and an `unhandledrejection`. Errors a React boundary catches are logged by
 * the boundary itself (they never reach `window`). Returns a cleanup function
 * so tests can detach the listeners.
 */
export function installCrashHandlers(target: EventTarget = window): () => void {
  const onError = (e: Event) => {
    const ev = e as ErrorEvent;
    logFrontendError(`window.onerror: ${describe(ev.error ?? ev.message)}`);
  };
  const onRejection = (e: Event) => {
    const ev = e as PromiseRejectionEvent;
    logFrontendError(`unhandledrejection: ${describe(ev.reason)}`);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

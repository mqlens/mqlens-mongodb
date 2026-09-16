// Fake Tauri backend for the end-to-end tests (#396).
//
// Every `invoke` from the app lands in `handle`. Commands are answered by
// handlers registered per feature area (see ./handlers). A command with no
// handler is recorded and rejected with a clear message, so a missing mock
// shows up as a test failure instead of the app silently receiving `undefined`.
import type { E2EState } from './state';

export type InvokeArgs = Record<string, unknown> | undefined;
export type Handler = (args: Record<string, unknown>, backend: Backend) => unknown | Promise<unknown>;

export interface CallRecord {
  cmd: string;
  args: InvokeArgs;
  /** Set when the call was rejected (injected failure or missing handler). */
  error?: string;
}

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export class Backend {
  readonly calls: CallRecord[] = [];
  readonly unhandled = new Set<string>();
  private readonly handlers = new Map<string, Handler>();
  private readonly failures = new Map<string, string[]>();
  /** Gates the next calls to a command wait on, oldest first, and the functions that open them. */
  private readonly holds = new Map<string, Array<Promise<void>>>();
  private readonly releases = new Map<string, Array<() => void>>();

  constructor(readonly state: E2EState) {}

  register(handlers: Record<string, Handler>): this {
    for (const [cmd, handler] of Object.entries(handlers)) this.handlers.set(cmd, handler);
    return this;
  }

  /** Make the next call to `cmd` reject with `message`, as a failing Rust command would. */
  failNext(cmd: string, message: string): void {
    const queue = this.failures.get(cmd) ?? [];
    queue.push(message);
    this.failures.set(cmd, queue);
  }

  /**
   * Hold the next call to `cmd` until `release(cmd)`: it is recorded when it
   * arrives, then waits, then answers as it otherwise would. A reply that is
   * still coming lets a test act while the app waits for it.
   */
  holdNext(cmd: string): void {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.holds.set(cmd, [...(this.holds.get(cmd) ?? []), gate]);
    this.releases.set(cmd, [...(this.releases.get(cmd) ?? []), open]);
  }

  /** Let the oldest held call to `cmd` go on; one released before it arrives isn't held at all. */
  release(cmd: string): void {
    this.releases.get(cmd)?.shift()?.();
  }

  /** Deliver a Tauri event to the app's `listen` handlers, as the backend's `emit` would. */
  emit(event: string, payload: unknown): Promise<unknown> {
    const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
    return internals.invoke('plugin:event|emit', { event, payload });
  }

  async handle(cmd: string, args: InvokeArgs): Promise<unknown> {
    const record: CallRecord = { cmd, args };
    this.calls.push(record);

    const gate = this.holds.get(cmd)?.shift();
    if (gate) await gate;

    const injected = this.failures.get(cmd)?.shift();
    if (injected !== undefined) {
      record.error = injected;
      // Tauri rejects `invoke` with the command's error value, a plain string here.
      throw injected;
    }

    const handler = this.handlers.get(cmd);
    if (!handler) {
      this.unhandled.add(cmd);
      record.error = `e2e fake backend has no handler for "${cmd}"`;
      throw record.error;
    }
    try {
      return await handler(args ?? {}, this);
    } catch (error) {
      record.error = String(error);
      throw error;
    }
  }
}

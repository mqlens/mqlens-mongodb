// Background tasks in the fake backend (#396).
//
// A fake task does all its work before its start command returns. The command
// still returns the task as just started, as the backend does, while the task
// list already holds it finished: the app's next poll sees it complete, the way
// a fast real task looks.
import type { E2EState } from './state';

export interface TaskOutcome {
  kind: string;
  label: string;
  /** What the task says while it runs, in the start command's reply. */
  startMessage: string;
  /** What it says once done. */
  message: string;
  /** Set when the task failed, with the error it failed with. */
  error?: string;
  processed: number;
  total?: number | null;
  path?: string | null;
  subLabel?: string | null;
  summary?: Record<string, unknown> | null;
}

let serial = 0;

/** Record a finished task and return it as it looked when it started. */
export function recordTask(state: E2EState, outcome: TaskOutcome): Record<string, unknown> {
  serial += 1;
  const now = Date.now();
  const started: Record<string, unknown> = {
    id: `${outcome.kind}-${serial}`,
    kind: outcome.kind,
    label: outcome.label,
    status: 'running',
    processed: 0,
    total: outcome.total ?? null,
    message: outcome.startMessage,
    path: outcome.path ?? null,
    error: null,
    createdAtMs: now,
    finishedAtMs: null,
    ...(outcome.subLabel ? { subLabel: outcome.subLabel } : {}),
  };
  // Newest first, as `list_export_tasks` returns them.
  state.tasks.unshift({
    ...started,
    status: outcome.error ? 'failed' : 'completed',
    processed: outcome.processed,
    message: outcome.message,
    error: outcome.error ?? null,
    finishedAtMs: now,
    ...(outcome.summary ? { summary: outcome.summary } : {}),
  });
  return started;
}

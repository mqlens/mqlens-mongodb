/**
 * Writes MQLens's own agent has asked for, held outside any component.
 *
 * Two reasons this cannot live in the panel. `App` unmounts `AIChatPanel` when the
 * user switches tabs, while `startChatRequest` deliberately keeps the backend call
 * alive — so a request arriving while the tab is inactive had no listener at all
 * and always timed out unanswered. And the backend gives up after two minutes,
 * while a queue inside the panel kept showing the dead prompt and hid every live
 * request behind it.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  subscribeMcpWriteRequest,
  subscribeMcpWriteSettled,
  type McpWriteRequest,
} from '../workspace/workspaceStore';

/** Matches the backend's `WRITE_CONFIRM_TIMEOUT`; see `mcp::confirm_write`. */
export const WRITE_REQUEST_TTL_MS = 120_000;

interface Held extends McpWriteRequest {
  receivedAt: number;
}

let held: Held[] = [];
const listeners = new Set<() => void>();
let started = false;

function notify() {
  listeners.forEach((fn) => fn());
}

/** Drop anything the backend has already given up on. */
function expire(now: number) {
  const before = held.length;
  held = held.filter((r) => now - r.receivedAt < WRITE_REQUEST_TTL_MS);
  return held.length !== before;
}

function start() {
  if (started) return;
  started = true;
  void subscribeMcpWriteRequest((request) => {
    held = [...held, { ...request, receivedAt: Date.now() }];
    notify();
  }).catch(() => {
    // Without the subscription nothing can be approved, which is the safe
    // direction: the backend refuses on silence.
  });
  // The request reaches every webview and is answered in one of them, so the
  // rest have to be told. Without this they went on offering a prompt that was
  // already decided, and because only the oldest is shown that stale entry hid
  // live requests behind it for the full two minutes.
  void subscribeMcpWriteSettled((id) => {
    const before = held.length;
    held = held.filter((r) => r.id !== id);
    if (held.length !== before) notify();
  }).catch(() => {
    // Only costs the stale prompt the sweep below would clear anyway.
  });
  // Swept rather than timed per entry: one interval is enough at this cadence,
  // and a prompt that lingers a few seconds past its deadline is harmless — the
  // backend has already refused it.
  setInterval(() => {
    if (expire(Date.now())) notify();
  }, 5_000);
}

/**
 * Which conversation each live run belongs to, kept out of the tree for the same
 * reason the requests are: `AIChatPanel` is unmounted when the user switches tabs
 * while its run continues, and a component-local map came back empty on remount —
 * so the panel could not recognise its own run and filtered its own write out
 * until the backend gave up.
 */
const runs = new Map<string, string>();

/** Record a run this app started, and the conversation that asked. */
export function beginRun(runId: string, askedIn: string): void {
  runs.set(runId, askedIn);
  notify();
}

/** Forget it once the run is over; nothing more can arrive for it. */
export function endRun(runId: string): void {
  if (runs.delete(runId)) notify();
}

/** The conversation a run was asked in, or `undefined` if it is not ours. */
export function conversationForRun(runId: string): string | undefined {
  return runs.get(runId);
}

/**
 * Begin listening, before anything is on screen to ask.
 *
 * Called by `App`, which is mounted for the lifetime of the webview, because the
 * subscription cannot belong to the confirmation UI: an external MCP client's
 * write is confirmed on every route now, and it does not originate from a panel.
 * With the listener started lazily by the panel, a write arriving before any
 * panel had ever mounted was broadcast to nobody, could not be recovered by
 * opening the chat afterwards, and could only fail when the backend gave up.
 */
export function startWriteRequests(): void {
  start();
}

/**
 * Live requests this caller may answer, oldest first.
 *
 * The caller decides: a panel accepts its own runs and unaddressed requests, and
 * a run it started but whose conversation the user has since left is refused by
 * showing it to nobody — the answer would be filed under a chat that is no longer
 * on screen.
 */
export function writeRequestsWhere(
  accepts: (requester: string | null) => boolean
): McpWriteRequest[] {
  start();
  expire(Date.now());
  return held.filter((r) => accepts(r.requester));
}

export function subscribeWriteRequests(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Carry the user's answer back, and stop showing the request either way. */
export function answerWriteRequest(id: string, approved: boolean): void {
  held = held.filter((r) => r.id !== id);
  notify();
  // The backend refuses on silence, so a failure here costs a refusal rather
  // than an unintended write.
  void invoke('mcp_resolve_write', { id, approved }).catch(() => {});
}

/** Test seam: forget everything and re-subscribe on next use. */
export function resetWriteRequestsForTests(): void {
  held = [];
  runs.clear();
  listeners.clear();
  started = false;
}

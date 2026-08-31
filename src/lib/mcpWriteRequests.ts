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
import { subscribeMcpWriteRequest, type McpWriteRequest } from '../workspace/workspaceStore';

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
  // Swept rather than timed per entry: one interval is enough at this cadence,
  // and a prompt that lingers a few seconds past its deadline is harmless — the
  // backend has already refused it.
  setInterval(() => {
    if (expire(Date.now())) notify();
  }, 5_000);
}

/** Live requests addressed to `requester`, oldest first. */
export function writeRequestsFor(requester: string): McpWriteRequest[] {
  start();
  expire(Date.now());
  return held.filter((r) => r.requester === requester);
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
  listeners.clear();
  started = false;
}

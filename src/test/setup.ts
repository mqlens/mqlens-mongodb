import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// `waitFor` defaults to a 1s budget (see @testing-library/dom's config), which
// is too tight for this suite on a busy machine: 102 test files under jsdom,
// each `waitFor` waiting on React effects plus promise chains. CI has failed
// intermittently on assertions *inside* `waitFor` — App's cross-window
// connection coherence, MongoShell's session survival, App's session restore —
// each of which passes in isolation and on the next run.
//
// Two call sites had already been patched one at a time with `{ timeout: 2000 }`
// and `{ timeout: 5000 }`, which is the same problem showing through. Raising
// the default treats the whole class instead.
//
// This cannot mask a real failure: `waitFor` polls until the condition holds or
// the budget runs out, so a longer budget changes only how long a genuinely
// broken expectation takes to report — not whether it reports. It is kept well
// under vitest's own `testTimeout` so a failure still surfaces as the
// assertion error rather than as "test timed out".
configure({ asyncUtilTimeout: 3000 });

// Mock ResizeObserver for jsdom testing environment
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = MockResizeObserver;

// Radix Select/DropdownMenu call the Pointer Capture API on their triggers.
// jsdom implements none of it, so the component throws before it can open and
// its items are never rendered — which is why these menus looked undriveable in
// tests. Same category as the ResizeObserver and scrollIntoView stubs below.
//
// Capture state is tracked rather than hard-coded to `false`: a constant would
// mean any component that captures a pointer and then reads the state back sees
// an answer that is simply wrong, and the real behaviour is masked instead of
// stubbed. Per element, keyed by pointer id, which is what the DOM does.
if (!Element.prototype.hasPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.hasPointerCapture = function hasPointerCapture(pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
  Element.prototype.setPointerCapture = function setPointerCapture(pointerId: number) {
    const ids = captured.get(this) ?? new Set<number>();
    ids.add(pointerId);
    captured.set(this, ids);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(pointerId: number) {
    captured.get(this)?.delete(pointerId);
  };
}

// cmdk and Radix scroll areas call scrollIntoView; jsdom does not implement it.
Element.prototype.scrollIntoView = function scrollIntoView() {};

// jsdom does not implement DragEvent (https://github.com/jsdom/jsdom/issues/2913),
// so @testing-library/dom's fireEvent.dragOver/drop/dragStart fall back to the
// base Event constructor and silently drop clientX/clientY/dataTransfer from the
// event init. Polyfill it as a MouseEvent subclass so drag-and-drop tests observe
// real coordinates on the synthetic event.
if (typeof globalThis.DragEvent === 'undefined') {
  class DragEventPolyfill extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, eventInitDict: MouseEventInit & { dataTransfer?: DataTransfer | null } = {}) {
      super(type, eventInitDict);
      this.dataTransfer = eventInitDict.dataTransfer ?? null;
    }
  }
  globalThis.DragEvent = DragEventPolyfill;
}

import { initI18n } from '@/lib/i18n';

// Tests render components directly, without I18nProvider. Initialise i18next
// once up front so useTranslation() resolves real English copy rather than
// throwing or emitting raw keys.
await initI18n('en');

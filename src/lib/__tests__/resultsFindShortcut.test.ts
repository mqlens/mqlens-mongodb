import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RESULTS_FIND_INPUT_ATTR,
  registerResultsFindTarget,
  resetResultsFindShortcutForTests,
} from '../resultsFindShortcut';

function pane(): { el: HTMLElement; open: ReturnType<typeof vi.fn>; dispose: () => void } {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const open = vi.fn();
  const dispose = registerResultsFindTarget({ element: () => el, open });
  return { el, open, dispose };
}

function pressFind(target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('results find shortcut', () => {
  beforeEach(() => resetResultsFindShortcutForTests());
  afterEach(() => {
    resetResultsFindShortcutForTests();
    document.body.innerHTML = '';
  });

  it('opens the only mounted pane and claims the key', () => {
    const p = pane();
    const event = pressFind();
    expect(p.open).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Monaco to its own find widget', () => {
    const p = pane();
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const inner = document.createElement('div');
    editor.appendChild(inner);
    document.body.appendChild(editor);

    const event = pressFind(inner);
    expect(p.open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('routes from the event target even when focus was moved away', () => {
    // Sidebar has its own window-level Cmd/Ctrl+F that focuses the connection
    // filter, so `document.activeElement` can already have left the pane by the
    // time this runs. The event's target cannot be rewritten that way.
    const a = pane();
    const b = pane();
    const row = document.createElement('div');
    b.el.appendChild(row);

    const stealer = document.createElement('button');
    document.body.appendChild(stealer);
    stealer.focus();

    const event = pressFind(row);
    expect(b.open).toHaveBeenCalledTimes(1);
    expect(a.open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the key alone when it comes from outside every pane', () => {
    // A keypress aimed at another region — the sidebar tree, say — is that
    // region's business, so the shortcut must not claim it even though a pane
    // was pointed at earlier.
    const p = pane();
    const inside = document.createElement('div');
    p.el.appendChild(inside);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    // Point at the pane first, so only the target rule can rule it out.
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    outside.focus();

    const event = pressFind(outside);
    expect(p.open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('claims the key ahead of a window listener registered earlier', () => {
    // Sidebar's handler is registered during app mount, long before any pane
    // exists, and stands down on defaultPrevented — so this one has to see the
    // event first. Capture phase beats any bubble-phase listener.
    const seen: boolean[] = [];
    const earlier = (e: Event) => seen.push(e.defaultPrevented);
    window.addEventListener('keydown', earlier);
    try {
      const p = pane();
      const row = document.createElement('div');
      p.el.appendChild(row);

      pressFind(row);
      expect(p.open).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([true]);
    } finally {
      window.removeEventListener('keydown', earlier);
    }
  });

  it('still falls back to the pointed pane when nothing is focused', () => {
    // Clicking a grid row focuses nothing, so the keypress targets the body and
    // the pointer history is the only signal left.
    const a = pane();
    const b = pane();
    b.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    const event = pressFind();
    expect(b.open).toHaveBeenCalledTimes(1);
    expect(a.open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('routes back to the pane from the find bar’s own input', () => {
    // The find input is a text field, so the blanket suppression swallowed the
    // second press — the one that reselects the query — and the browser's find
    // opened instead.
    const p = pane();
    const input = document.createElement('input');
    input.setAttribute(RESULTS_FIND_INPUT_ATTR, 'true');
    p.el.appendChild(input);

    const event = pressFind(input);
    expect(p.open).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('still suppresses an ordinary input that happens to sit in the pane', () => {
    const p = pane();
    const other = document.createElement('input');
    p.el.appendChild(other);

    const event = pressFind(other);
    expect(p.open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves text fields alone', () => {
    const p = pane();
    for (const tag of ['input', 'textarea', 'select']) {
      const field = document.createElement(tag);
      document.body.appendChild(field);
      pressFind(field);
    }
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    pressFind(editable);

    expect(p.open).not.toHaveBeenCalled();
  });

  it('ignores keys that are not the find chord', () => {
    const p = pane();
    for (const init of [
      { key: 'f' }, // no modifier
      { key: 'g', metaKey: true },
      { key: 'f', metaKey: true, altKey: true },
    ]) {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      );
    }
    expect(p.open).not.toHaveBeenCalled();
  });

  it('routes to the pane that holds focus', () => {
    const a = pane();
    const b = pane();
    const input = document.createElement('button');
    b.el.appendChild(input);
    input.focus();

    pressFind(input);
    expect(b.open).toHaveBeenCalledTimes(1);
    expect(a.open).not.toHaveBeenCalled();
  });

  it('falls back to the pane last pointed at', () => {
    const a = pane();
    const b = pane();
    b.el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    pressFind();
    expect(b.open).toHaveBeenCalledTimes(1);
    expect(a.open).not.toHaveBeenCalled();
  });

  it('opens nothing when several panes are mounted and none is indicated', () => {
    // Better than opening a find bar in a pane the user was not looking at.
    const a = pane();
    const b = pane();
    const event = pressFind();
    expect(a.open).not.toHaveBeenCalled();
    expect(b.open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops listening once the last pane unregisters', () => {
    const p = pane();
    p.dispose();
    const event = pressFind();
    expect(p.open).not.toHaveBeenCalled();
    // The browser's own find is left available again.
    expect(event.defaultPrevented).toBe(false);
  });

  it('forgets a disposed pane that had been pointed at', () => {
    const a = pane();
    const b = pane();
    b.el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    b.dispose();

    pressFind();
    // `a` is now the only pane, so it is unambiguous.
    expect(a.open).toHaveBeenCalledTimes(1);
  });
});

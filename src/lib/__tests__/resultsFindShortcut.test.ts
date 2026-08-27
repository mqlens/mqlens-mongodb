import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
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

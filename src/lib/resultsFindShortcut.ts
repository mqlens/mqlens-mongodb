/**
 * Cmd/Ctrl+F routing for the results pane (#279).
 *
 * The app embeds Monaco in several places — the query bar, the aggregation
 * builder, the document dialog — and Monaco binds Cmd+F to its own find widget.
 * A plain `window` listener would steal that, so the key is only claimed when
 * the event did not come from an editor or a text field.
 *
 * Several results panes can be mounted at once (the workspace splits into
 * panes), so instances register here and exactly one is chosen: the pane
 * containing focus, else the pane the user last pointed at, else the only one.
 * Without that, every pane would open its own find bar on one keypress.
 */

/**
 * Marks the find bar's own input as belonging to the results pane.
 *
 * The suppression below deliberately leaves text fields alone, and the find
 * input is a text field — so pressing the shortcut a second time, with the caret
 * already in it, fell through to the browser's find. That is the common path:
 * open the bar, press again to reselect. This attribute is the exception, and
 * the constant is shared so the bar and this module cannot disagree on its name.
 */
export const RESULTS_FIND_INPUT_ATTR = "data-results-find-input";

/** A registered results pane. */
interface Pane {
  /** Its root element, used to decide which pane the user means. */
  element: () => HTMLElement | null;
  /** Called when this pane should open its find bar. */
  open: () => void;
}

const panes = new Map<number, Pane>();
let nextId = 1;
let lastPointedId: number | null = null;
let listening = false;

/** Editors and text fields keep their own find/typing behaviour. */
function eventBelongsToAnEditor(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // The find bar's own input is a text field but is not somebody else's: the
  // shortcut pressed inside it means "search here again", not "leave me alone".
  if (target.closest(`[${RESULTS_FIND_INPUT_ATTR}]`)) return false;
  if (target.closest(".monaco-editor")) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[contenteditable="true"]') !== null;
}

/** The registered pane containing `node`, if any. */
function paneContaining(node: EventTarget | null): Pane | undefined {
  if (!(node instanceof Node)) return undefined;
  for (const pane of panes.values()) {
    const el = pane.element();
    if (el && el.contains(node)) return pane;
  }
  return undefined;
}

/**
 * The pane the keypress is meant for.
 *
 * The event's own target comes first, and reading focus second is not a
 * preference but a necessity: `Sidebar` has its own window-level Cmd/Ctrl+F that
 * focuses the connection filter, so by the time another listener reads
 * `document.activeElement` it can already have been moved out of every pane,
 * leaving a real keypress from inside a pane unroutable. The target is the one
 * signal no other handler can rewrite.
 *
 * The pointer fallback then applies only when the keypress came from nothing in
 * particular — the body, meaning no focused control — because clicking a grid row
 * focuses nothing. Restricting it that way is what lets the sidebar keep the key
 * while the user is working in the sidebar: that keypress targets a sidebar
 * element, matches no pane, and this returns undefined, so the shortcut is never
 * claimed and the sidebar's own handler runs.
 *
 * With several panes and no signal at all, nothing opens rather than all of them.
 */
function targetPane(event: KeyboardEvent): Pane | undefined {
  const fromTarget = paneContaining(event.target);
  if (fromTarget) return fromTarget;

  const fromFocus = paneContaining(document.activeElement);
  if (fromFocus) return fromFocus;

  // Anything else focused belongs to another region, and the key is its business.
  const unfocused =
    event.target === null ||
    event.target === document.body ||
    event.target === document ||
    event.target === window;
  if (!unfocused) return undefined;

  if (lastPointedId !== null) {
    const pane = panes.get(lastPointedId);
    if (pane?.element()) return pane;
  }
  return panes.size === 1 ? [...panes.values()][0] : undefined;
}

function onKeyDown(event: KeyboardEvent): void {
  // Someone ahead of us already claimed it.
  if (event.defaultPrevented) return;
  if (event.key !== "f" && event.key !== "F") return;
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  if (eventBelongsToAnEditor(event.target)) return;

  const pane = targetPane(event);
  if (!pane) return;
  // Only now: leaving the key to the browser — and to Sidebar's own Cmd/Ctrl+F,
  // which stands down on defaultPrevented — when no pane claims it.
  event.preventDefault();
  pane.open();
}

function onPointerDown(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  for (const [id, pane] of panes) {
    const el = pane.element();
    if (el && el.contains(target)) {
      lastPointedId = id;
      return;
    }
  }
}

/**
 * Register a results pane. Returns a function that unregisters it.
 *
 * The listeners are installed with the first pane and removed with the last, so
 * nothing is bound while no results are on screen.
 */
export function registerResultsFindTarget(pane: Pane): () => void {
  const id = nextId++;
  panes.set(id, pane);
  if (!listening && typeof window !== "undefined") {
    // Capture: `Sidebar` registers its Cmd/Ctrl+F on window during app mount,
    // long before any pane exists, so a bubble-phase listener here would always
    // run second — after the sidebar had claimed the key and moved focus. In the
    // capture phase this runs first, and the sidebar defers to defaultPrevented.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    listening = true;
  }
  return () => {
    panes.delete(id);
    if (lastPointedId === id) lastPointedId = null;
    if (panes.size === 0 && listening && typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      listening = false;
    }
  };
}

/** Reset module state between tests. */
export function resetResultsFindShortcutForTests(): void {
  if (listening && typeof window !== "undefined") {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
  }
  panes.clear();
  lastPointedId = null;
  listening = false;
  nextId = 1;
}

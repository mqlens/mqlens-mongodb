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
  /**
   * Whether the find bar is reachable in this pane right now.
   *
   * Separate from being registered, because the two questions are different:
   * "which pane is the user in" is true of every pane always, while "can this
   * one open a find bar" is only true while its results tab is showing. A pane
   * that unregistered itself on the explain tab was invisible here, so the
   * user's click landed on no pane and the next question — which pane owns a
   * copy — was answered with somebody else's (#330 review).
   */
  canOpenFind?: () => boolean;
}

const panes = new Map<number, Pane>();
let nextId = 1;
let lastPointedId: number | null = null;
let listening = false;

/**
 * Anywhere the user types: an editor, a text field, a contenteditable.
 *
 * No exceptions — including the find bar's own input, which is a text field
 * like any other. Every results-pane shortcut owes these the same deference,
 * because inside one the key means something about its content: Cmd/Ctrl+A in
 * a query editor means "select this query", and a pane that took it would be
 * answering for something it does not own.
 */
export function isTextEntryContext(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".monaco-editor")) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[contenteditable="true"]') !== null;
}

/**
 * Text entry, as the FIND shortcut sees it — one exception to the above.
 *
 * The find bar's own input is a text field but is not somebody else's: Ctrl+F
 * pressed with the caret already in it means "search here again", not "leave me
 * alone". That exception belongs to find alone. Select-all in that input means
 * "select the search text" like in any other field, so it uses the plain
 * predicate instead (#328 review).
 */
function eventBelongsToAnEditor(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest(`[${RESULTS_FIND_INPUT_ATTR}]`)) return false;
  return isTextEntryContext(target);
}

/** The registered pane containing `node`, if any. */
/**
 * A pane that is registered but not on screen.
 *
 * Inactive tabs stay mounted now, hidden with `hidden`/`display: none` (#240),
 * so several panes can be registered while only one is visible. A hidden one
 * must not answer for a shortcut: it cannot be pointed at or focused, and
 * opening its find bar would do nothing the user could see.
 *
 * Tested by walking to a `[hidden]` ancestor rather than by measuring, because
 * measuring is exactly what a hidden element cannot do — and because jsdom has
 * no layout, so `offsetParent` would call every pane hidden and route nothing.
 */
function isHidden(el: HTMLElement): boolean {
  return el.closest('[hidden]') !== null;
}

/** Registered panes that are actually on screen, in registration order. */
function visiblePanes(): Map<number, Pane> {
  const shown = new Map<number, Pane>();
  for (const [id, pane] of panes) {
    const el = pane.element();
    if (el && !isHidden(el)) shown.set(id, pane);
  }
  return shown;
}

function paneContaining(node: EventTarget | null): Pane | undefined {
  if (!(node instanceof Node)) return undefined;
  for (const pane of visiblePanes().values()) {
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
function paneForEventTarget(target: EventTarget | null): Pane | undefined {
  const fromTarget = paneContaining(target);
  if (fromTarget) return fromTarget;

  const fromFocus = paneContaining(document.activeElement);
  if (fromFocus) return fromFocus;

  // Anything else focused belongs to another region, and the key is its business.
  const unfocused =
    target === null ||
    target === document.body ||
    target === document ||
    target === window;
  if (!unfocused) return undefined;

  if (lastPointedId !== null) {
    // Visible only: the tab last pointed at may since have been switched away
    // from and is now mounted but hidden.
    const pane = visiblePanes().get(lastPointedId);
    if (pane?.element()) return pane;
  }
  return undefined;
}

/**
 * Find is more generous than that: with a single pane on screen and nothing
 * else indicating one, Cmd/Ctrl+F opens it.
 *
 * That generosity suits opening a find bar, which is harmless and obviously
 * what the user meant. It does not suit a key that replaces the selection:
 * pressing Cmd/Ctrl+A while working in the sidebar would select results the
 * user was not looking at. So it stays here, with find, rather than in the
 * shared resolver (#328 review).
 */
function targetPane(event: KeyboardEvent): Pane | undefined {
  const pane = paneForEventTarget(event.target);
  if (pane) return pane;
  const unfocused =
    event.target === null ||
    event.target === document.body ||
    event.target === document ||
    event.target === window;
  // Counted over visible panes: with inactive tabs kept mounted there is
  // almost always more than one registered, and the single-pane generosity
  // this serves is about what the user can actually see (#240).
  const shown = visiblePanes();
  return unfocused && shown.size === 1 ? [...shown.values()][0] : undefined;
}

function onKeyDown(event: KeyboardEvent): void {
  // Someone ahead of us already claimed it.
  if (event.defaultPrevented) return;
  if (event.key !== "f" && event.key !== "F") return;
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  if (eventBelongsToAnEditor(event.target)) return;

  const pane = targetPane(event);
  // A pane with no find bar to open leaves the key alone rather than claiming
  // it and doing nothing — the browser's own find is the better fallback.
  if (!pane || pane.canOpenFind?.() === false) return;
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
  // Pointing somewhere else means the user has left: a pane the user pointed at
  // ten minutes ago is not where they are now.
  //
  // This matters because most of the app is not focusable. Clicking a sidebar
  // row moves focus nowhere, so the next keypress targets <body> and reads as
  // "from nothing in particular" — and a remembered pane would answer for it,
  // selecting results the user had already navigated away from (#328 review).
  lastPointedId = null;
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

/**
 * The results pane an event is for, by exactly the reckoning the find shortcut
 * uses — including its most important part, the event's own target.
 *
 * Exposed because "which pane is this for" is not a question about find. A copy
 * has to answer it too, and so does select-all: several JSON views hear the same
 * document-level event, and one of them has to be the one that responds (#330).
 * Keeping a second notion of the active pane in the grid meant the two could
 * disagree, and they did.
 *
 * Taking the target rather than only reading focus is what keeps a pane from
 * answering for the rest of the app. An event from somewhere else that happens
 * to be focused belongs to that somewhere else; only an event from nothing in
 * particular falls back to the pane last pointed at (#328 review).
 *
 * `null` when nothing indicates a pane, which is the honest answer — the caller
 * decides what to do without a preference.
 */
export function resultsPaneElementForEvent(target: EventTarget | null): HTMLElement | null {
  return paneForEventTarget(target)?.element() ?? null;
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

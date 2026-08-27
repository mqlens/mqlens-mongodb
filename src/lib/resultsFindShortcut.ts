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
  if (target.closest(".monaco-editor")) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[contenteditable="true"]') !== null;
}

/**
 * The pane the keypress is meant for.
 *
 * Focus is the strongest signal; a pointer press is the next best, because
 * clicking a row is the usual thing to do before searching it. With neither, a
 * single mounted pane is unambiguous — but several are not, so nothing opens
 * rather than all of them.
 */
function targetPane(): Pane | undefined {
  const active = document.activeElement;
  if (active) {
    for (const pane of panes.values()) {
      const el = pane.element();
      if (el && el.contains(active)) return pane;
    }
  }
  if (lastPointedId !== null) {
    const pane = panes.get(lastPointedId);
    if (pane?.element()) return pane;
  }
  return panes.size === 1 ? [...panes.values()][0] : undefined;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "f" && event.key !== "F") return;
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  if (eventBelongsToAnEditor(event.target)) return;

  const pane = targetPane();
  if (!pane) return;
  // Only now: leaving the browser's own find available when no pane claims it.
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
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    listening = true;
  }
  return () => {
    panes.delete(id);
    if (lastPointedId === id) lastPointedId = null;
    if (panes.size === 0 && listening && typeof window !== "undefined") {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      listening = false;
    }
  };
}

/** Reset module state between tests. */
export function resetResultsFindShortcutForTests(): void {
  if (listening && typeof window !== "undefined") {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pointerdown", onPointerDown, true);
  }
  panes.clear();
  lastPointedId = null;
  listening = false;
  nextId = 1;
}

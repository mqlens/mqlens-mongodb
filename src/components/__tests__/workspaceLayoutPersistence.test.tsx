import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useDefaultLayout, type Layout } from 'react-resizable-panels';

/**
 * Guards the layout-persistence contract DocumentViewer relies on.
 *
 * Switching tabs unmounts DocumentViewer, so the ResizablePanelGroup used to
 * fall back to its fixed 70/30 default every time and the user's drag was lost
 * — the AI helper panel snapped back to its default width on every tab switch.
 *
 * Note the id and panelIds below MUST match DocumentViewer's. The two open
 * right-hand panels are keyed separately on purpose: the query builder and the
 * AI helper each remember their own width rather than sharing one entry.
 *
 * This covers the persistence round trip. Whether DocumentViewer actually wires
 * `onLayoutChanged` onto the Group is NOT covered here — its own suite replaces
 * `@/components/ui/resizable` with plain divs, which drops those props.
 */
const GROUP_ID = 'document-viewer-workspace';
const AI_PANELS = ['document-main', 'ai-helper'];
const BUILDER_PANELS = ['document-main', 'query-builder'];

function Probe({ panelIds, save }: { panelIds: string[]; save?: Layout }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: GROUP_ID,
    panelIds,
    storage: localStorage,
  });
  if (save) onLayoutChanged(save);
  return <span data-testid="layout">{JSON.stringify(defaultLayout ?? null)}</span>;
}

// Scoped to this render's own container — repeated render() calls share
// document.body, so a global query would match every probe mounted so far.
const readBack = (panelIds: string[]) => {
  const { container } = render(<Probe panelIds={panelIds} />);
  const text = container.querySelector('[data-testid="layout"]')?.textContent;
  return JSON.parse(text || 'null') as Layout | null;
};

describe('workspace layout persistence', () => {
  beforeEach(() => localStorage.clear());

  it('restores a dragged layout on the next mount', () => {
    expect(readBack(AI_PANELS)).toBeNull();

    render(<Probe panelIds={AI_PANELS} save={{ 'document-main': 55, 'ai-helper': 45 }} />);

    expect(readBack(AI_PANELS)).toEqual({ 'document-main': 55, 'ai-helper': 45 });
  });

  it('keeps the query builder and the AI helper widths separate', () => {
    render(<Probe panelIds={AI_PANELS} save={{ 'document-main': 55, 'ai-helper': 45 }} />);
    render(
      <Probe panelIds={BUILDER_PANELS} save={{ 'document-main': 80, 'query-builder': 20 }} />,
    );

    expect(readBack(AI_PANELS)).toEqual({ 'document-main': 55, 'ai-helper': 45 });
    expect(readBack(BUILDER_PANELS)).toEqual({ 'document-main': 80, 'query-builder': 20 });
  });
});

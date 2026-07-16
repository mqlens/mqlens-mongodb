import React, { useState, useCallback } from 'react';
import { WorkspaceTabBar, type WorkspaceTab } from '../components/layout/WorkspaceTabBar';
import type { PaneNode, WorkspaceAction, SplitDir, SplitSide } from './model';

export const TAB_DRAG_MIME = 'application/x-mqlens-tab';

type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

const EDGE = 0.2; // outer 20% of each axis is an edge zone

function zoneFor(e: React.DragEvent, el: HTMLElement): DropZone {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (x < EDGE) return 'left';
  if (x > 1 - EDGE) return 'right';
  if (y < EDGE) return 'top';
  if (y > 1 - EDGE) return 'bottom';
  return 'center';
}

const ZONE_SPLIT: Record<Exclude<DropZone, 'center'>, { dir: SplitDir; side: SplitSide }> = {
  left: { dir: 'row', side: 'start' },
  right: { dir: 'row', side: 'end' },
  top: { dir: 'col', side: 'start' },
  bottom: { dir: 'col', side: 'end' },
};

export interface PaneViewProps {
  pane: PaneNode;
  focused: boolean;
  multiPane: boolean;
  tabs: WorkspaceTab[];
  dispatch: (action: WorkspaceAction) => void;
  renderTabContent: (tabId: string) => React.ReactNode;
  renderEmptyPane: () => React.ReactNode;
}

export function PaneView({
  pane, focused, multiPane, tabs, dispatch, renderTabContent, renderEmptyPane,
}: PaneViewProps) {
  const [zone, setZone] = useState<DropZone | null>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    setZone(zoneFor(e, e.currentTarget as HTMLElement));
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    const tabId = e.dataTransfer.getData(TAB_DRAG_MIME);
    setZone(null);
    if (!tabId) return;
    e.preventDefault();
    const z = zoneFor(e, e.currentTarget as HTMLElement);
    if (z === 'center') {
      dispatch({ type: 'move_tab', tabId, targetPaneId: pane.id });
    } else {
      const { dir, side } = ZONE_SPLIT[z];
      dispatch({ type: 'split_pane', paneId: pane.id, dir, side, moveTabId: tabId });
    }
  }, [dispatch, pane.id]);

  return (
    <div
      data-testid={`pane-${pane.id}`}
      className={`flex h-full min-h-0 flex-col ${multiPane && focused ? 'ring-1 ring-primary/40' : ''}`}
      onMouseDownCapture={() => { if (multiPane && !focused) dispatch({ type: 'focus_pane', paneId: pane.id }); }}
      onDragOver={onDragOver}
      onDragLeave={() => setZone(null)}
      onDrop={onDrop}
    >
      {tabs.length > 0 && (
        <WorkspaceTabBar
          tabs={tabs}
          activeTabId={pane.activeTabId}
          onSelectTab={id => dispatch({ type: 'set_active', paneId: pane.id, tabId: id })}
          onCloseTab={id => dispatch({ type: 'close_tab', tabId: id })}
          draggable
          onTabDragStart={(id, e) => { e.dataTransfer.setData(TAB_DRAG_MIME, id); e.dataTransfer.effectAllowed = 'move'; }}
          onTabStripDrop={e => {
            const tabId = e.dataTransfer.getData(TAB_DRAG_MIME);
            if (tabId) { e.preventDefault(); dispatch({ type: 'move_tab', tabId, targetPaneId: pane.id }); }
          }}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {pane.activeTabId ? renderTabContent(pane.activeTabId) : renderEmptyPane()}
        {zone && (
          <div
            data-testid={`drop-indicator-${zone}`}
            className={`pointer-events-none absolute z-40 bg-primary/20 border border-primary/50 ${
              zone === 'center' ? 'inset-0'
              : zone === 'left' ? 'inset-y-0 left-0 w-1/2'
              : zone === 'right' ? 'inset-y-0 right-0 w-1/2'
              : zone === 'top' ? 'inset-x-0 top-0 h-1/2'
              : 'inset-x-0 bottom-0 h-1/2'
            }`}
          />
        )}
      </div>
    </div>
  );
}

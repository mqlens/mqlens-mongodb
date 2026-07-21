import React from 'react';
import type { Layout } from 'react-resizable-panels';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../components/ui/resizable';
import { PaneView } from './PaneView';
import type { WorkspaceTab } from '../components/layout/WorkspaceTabBar';
import { allPanes, type LayoutNode, type PaneNode, type WorkspaceAction, type WorkspaceLayout } from './model';

export interface WorkspaceRootProps {
  layout: WorkspaceLayout;
  dispatch: (action: WorkspaceAction) => void;
  tabsFor: (pane: PaneNode) => WorkspaceTab[];
  renderTabContent: (tabId: string) => React.ReactNode;
  renderEmptyPane: () => React.ReactNode;
  /** Right-click on a tab (Phase 3 Task 5) — forwarded straight to
   *  PaneView/WorkspaceTabBar. Additive/optional, same as there. */
  onTabContextMenu?: (tabId: string, e: React.MouseEvent) => void;
}

function NodeView({ node, props }: { node: LayoutNode; props: WorkspaceRootProps }) {
  const { layout, dispatch, tabsFor, renderTabContent, renderEmptyPane, onTabContextMenu } = props;
  if (node.kind === 'pane') {
    return (
      <PaneView
        pane={node}
        focused={layout.focusedPaneId === node.id}
        multiPane={allPanes(layout.root).length > 1}
        tabs={tabsFor(node)}
        dispatch={dispatch}
        renderTabContent={renderTabContent}
        renderEmptyPane={renderEmptyPane}
        onTabContextMenu={onTabContextMenu}
      />
    );
  }
  const [first, second] = node.children;
  const firstSize = Math.round(node.ratio * 100);
  return (
    <ResizablePanelGroup
      key={node.id}
      id={node.id}
      orientation={node.dir === 'row' ? 'horizontal' : 'vertical'}
      onLayoutChanged={(nextLayout: Layout) => {
        const size = nextLayout[first.id];
        if (typeof size === 'number') {
          dispatch({ type: 'resize_split', splitId: node.id, ratio: size / 100 });
        }
      }}
    >
      <ResizablePanel id={first.id} defaultSize={firstSize} minSize={15}>
        <NodeView node={first} props={props} />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id={second.id} defaultSize={100 - firstSize} minSize={15}>
        <NodeView node={second} props={props} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function WorkspaceRoot(props: WorkspaceRootProps) {
  return <div className="h-full min-h-0">{<NodeView node={props.layout.root} props={props} />}</div>;
}

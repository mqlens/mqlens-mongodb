import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Custom MIME used to mark drags originating from a workspace tab (as opposed to
 *  OS file/text drags). Owned here; re-exported from workspace/PaneView.tsx. */
export const TAB_DRAG_MIME = 'application/x-mqlens-tab';

export interface WorkspaceTab {
  id: string;
  label: string;
  icon: React.ReactNode;
  pinned?: boolean;
}

interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Marks tabs draggable and sets TAB_DRAG_MIME data on drag start. */
  draggable?: boolean;
  onTabDragStart?: (id: string, e: React.DragEvent) => void;
  /** Drop on the tab strip itself = move-to-end of this pane. */
  onTabStripDrop?: (e: React.DragEvent) => void;
  /** Right-click on a tab (Phase 3 Task 5's detach/move context menu).
   *  Additive/optional — omitting it leaves right-click as a no-op, same as
   *  before this prop existed. */
  onTabContextMenu?: (id: string, e: React.MouseEvent) => void;
}

export function WorkspaceTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  draggable,
  onTabDragStart,
  onTabStripDrop,
  onTabContextMenu,
}: WorkspaceTabBarProps) {
  return (
    <TooltipProvider delayDuration={400}>
      <div
        data-testid="workspace-tab-strip"
        className="flex h-9 shrink-0 items-end gap-0 border-b border-border bg-sidebar/60 mql-chrome"
        onDragOver={(e) => {
          if (onTabStripDrop && e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onDrop={(e) => {
          if (onTabStripDrop && e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
            e.stopPropagation();
            onTabStripDrop(e);
          }
        }}
      >
        <ScrollArea className="w-full" orientation="horizontal">
          <div className="flex h-9 w-max items-end px-1">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group relative flex h-8 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-ui-xs transition-colors",
                    isActive
                      ? "border-border bg-background text-foreground"
                      : "border-transparent bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                  onClick={() => onSelectTab(tab.id)}
                  draggable={draggable}
                  onDragStart={(e) => onTabDragStart?.(tab.id, e)}
                  onContextMenu={(e) => {
                    if (!onTabContextMenu) return;
                    e.preventDefault();
                    onTabContextMenu(tab.id, e);
                  }}
                >
                  <span className="shrink-0">{tab.icon}</span>
                  <span className="truncate font-medium">{tab.label}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100",
                          isActive && "opacity-60"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                        aria-label={`Close ${tab.label}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Close tab</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}

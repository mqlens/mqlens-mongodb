import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
}

export function WorkspaceTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}: WorkspaceTabBarProps) {
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-9 shrink-0 items-end gap-0 border-b border-border bg-sidebar/60 mql-chrome">
        <ScrollArea className="w-full">
          <div className="flex h-9 items-end px-1">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group relative flex h-8 max-w-[200px] cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-ui-xs transition-colors",
                    isActive
                      ? "border-border bg-background text-foreground"
                      : "border-transparent bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                  onClick={() => onSelectTab(tab.id)}
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

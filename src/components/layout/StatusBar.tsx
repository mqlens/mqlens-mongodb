import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface StatusBarProps {
  cpu?: string;
  memory?: string;
  mongoVersion?: string;
  appVersion?: string;
  /** User UI zoom (75–150); hidden at 100%. */
  zoomPercent?: number;
  onZoomReset?: () => void;
  className?: string;
}

export function StatusBar({
  cpu,
  memory,
  mongoVersion,
  appVersion,
  zoomPercent,
  onZoomReset,
  className,
}: StatusBarProps) {
  const showZoom = zoomPercent != null && zoomPercent !== 100;

  return (
    <footer
      data-testid="bottom-bar"
      className={cn(
        "flex h-6 shrink-0 items-center gap-4 border-t border-border bg-sidebar/80 px-3 text-ui-xs text-muted-foreground mql-chrome",
        className
      )}
    >
      <span className="text-success">MQLens Engine Online</span>
      {cpu && <span>CPU {cpu}</span>}
      {memory && <span>RAM {memory}</span>}
      {mongoVersion && <span>MongoDB {mongoVersion}</span>}
      {showZoom && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="status-bar-zoom"
              className="font-mono tabular-nums transition-colors hover:text-foreground"
              onClick={onZoomReset}
            >
              {zoomPercent}%
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Reset zoom (⌘0 / Ctrl+0)
          </TooltipContent>
        </Tooltip>
      )}
      <span className="ml-auto">MQLens {appVersion ?? ""}</span>
    </footer>
  );
}

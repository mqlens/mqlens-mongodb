import { cn } from "@/lib/utils";

interface StatusBarProps {
  cpu?: string;
  memory?: string;
  mongoVersion?: string;
  appVersion?: string;
  className?: string;
}

export function StatusBar({
  cpu,
  memory,
  mongoVersion,
  appVersion,
  className,
}: StatusBarProps) {
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
      <span className="ml-auto">MQLens {appVersion ?? ""}</span>
    </footer>
  );
}

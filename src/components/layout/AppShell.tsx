interface AppShellProps {
  sidebar: React.ReactNode;
  sidebarWidth: number;
  onResizeStart: (e: React.MouseEvent) => void;
  tabBar: React.ReactNode;
  children: React.ReactNode;
  statusBar: React.ReactNode;
  overlays?: React.ReactNode;
}

export function AppShell({
  sidebar,
  sidebarWidth,
  onResizeStart,
  tabBar,
  children,
  statusBar,
  overlays,
}: AppShellProps) {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <div
          className="flex shrink-0 flex-col border-r border-border mql-chrome"
          style={{ width: sidebarWidth }}
        >
          {sidebar}
        </div>
        <div
          className="w-1 shrink-0 cursor-col-resize bg-border/50 hover:bg-primary/40 transition-colors"
          onMouseDown={onResizeStart}
          data-testid="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {tabBar}
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      </div>
      {statusBar}
      {overlays}
    </div>
  );
}

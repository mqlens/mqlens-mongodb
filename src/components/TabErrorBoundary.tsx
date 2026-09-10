import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Isolates a render crash to the tab it happened in.
 *
 * Kept-alive tabs (#240) stay mounted and share the workspace tree, and the app
 * has no other error boundary — so before this, an exception thrown while
 * rendering any tab (or on the re-render when a tab is shown/hidden) propagated
 * all the way up and React unmounted the whole tree, blanking the entire app
 * (see #379). Wrapping each tab's content means a throwing tab shows a
 * recoverable message in its own pane while every other tab, the tab strip and
 * the rest of the window keep working.
 *
 * `resetKey` lets a parent clear the error when the thing that was broken has
 * changed (e.g. the tab id it wraps). Retry is also offered in the fallback, so
 * a transient failure can be dismissed without touching anything else.
 */
interface Props {
  children: React.ReactNode;
  resetKey?: unknown;
  /** Reported for diagnostics; never used to render. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

function TabErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation('common');
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="tab-error-boundary"
      role="alert"
    >
      <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{t('errorBoundary.title')}</p>
        <p className="max-w-md text-ui-xs text-muted-foreground">{t('errorBoundary.description')}</p>
      </div>
      {error.message && (
        <pre
          className="max-h-32 max-w-md overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 px-3 py-2 text-left font-mono text-[10px] leading-relaxed text-muted-foreground"
          data-testid="tab-error-message"
        >
          {error.message}
        </pre>
      )}
      <Button variant="outline" size="sm" onClick={onRetry} data-testid="tab-error-retry">
        <RefreshCw size={12} />
        <span>{t('errorBoundary.retry')}</span>
      </Button>
    </div>
  );
}

export class TabErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the crash visible in the console for diagnosis — the fallback shows
    // the message but not the component stack.
    console.error('Tab content crashed:', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prev: Props) {
    // A changed resetKey means the parent swapped what this boundary wraps, so
    // a stale error should not keep hiding fresh, working content.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return <TabErrorFallback error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

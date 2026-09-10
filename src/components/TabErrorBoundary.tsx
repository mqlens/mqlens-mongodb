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
  /** Reported for diagnostics; never used to render. The thrown value is
   *  `unknown` because JavaScript permits throwing any value, not just Error. */
  onError?: (error: unknown, info: React.ErrorInfo) => void;
}

interface State {
  // A separate flag rather than `error: X | null`: JS lets code throw a falsy
  // value (`null`, `''`, `0`), and using the caught value as the sentinel would
  // treat "a tab threw null" as "no error" and render the crashing child again
  // (#380 review).
  hasError: boolean;
  message: string;
}

/**
 * A safe, renderable one-line message for any thrown value.
 *
 * The fallback renders this as text, so it must be a string no matter what was
 * thrown — an Error whose `.message` is itself an object would otherwise make
 * the fallback throw while rendering, which the boundary cannot catch (#380
 * review).
 */
function toDisplayMessage(error: unknown): string {
  if (error instanceof Error) return String(error.message ?? error.name);
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function TabErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
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
      {message && (
        <pre
          className="max-h-32 max-w-md overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 px-3 py-2 text-left font-mono text-[10px] leading-relaxed text-muted-foreground"
          data-testid="tab-error-message"
        >
          {message}
        </pre>
      )}
      <Button variant="outline" size="sm" onClick={onRetry} data-testid="tab-error-retry">
        <RefreshCw size={12} />
        <span>{t('errorBoundary.retry')}</span>
      </Button>
    </div>
  );
}

/**
 * Runs a render callback *inside* the boundary's subtree.
 *
 * A boundary only catches throws from its descendants' render — not throws in
 * the parent scope that computes its children. `renderTabContent(tabId)` is
 * called while PaneView renders, before the boundary mounts, so a synchronous
 * failure there (the tab renderer does lookups, IIFEs and serialization before
 * returning) would still escape to the app root. Deferring the call into this
 * child component moves that work under the boundary, where it is caught (#379
 * review).
 */
export function BoundaryContent({ render }: { render: () => React.ReactNode }) {
  return <>{render()}</>;
}

export class TabErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: toDisplayMessage(error) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // Keep the crash visible in the console for diagnosis — the fallback shows
    // the message but not the component stack.
    console.error('Tab content crashed:', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prev: Props) {
    // A changed resetKey means the parent swapped what this boundary wraps, so
    // a stale error should not keep hiding fresh, working content.
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <TabErrorFallback
          message={this.state.message}
          onRetry={() => this.setState({ hasError: false, message: '' })}
        />
      );
    }
    return this.props.children;
  }
}

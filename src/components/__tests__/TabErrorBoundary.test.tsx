import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { TabErrorBoundary } from '../TabErrorBoundary';

// The boundary logs the caught error; silence it so the suite output stays
// readable, and assert it still fires.
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

function Boom({ throwNow, message }: { throwNow: boolean; message?: string }) {
  if (throwNow) throw new Error(message ?? 'kaboom');
  return <div data-testid="ok">fine</div>;
}

describe('TabErrorBoundary (#379)', () => {
  it('renders its children when nothing throws', () => {
    render(
      <TabErrorBoundary>
        <div data-testid="child">hello</div>
      </TabErrorBoundary>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-error-boundary')).toBeNull();
  });

  it('contains a render throw instead of letting it escape, and shows the message', () => {
    // If the boundary did not catch, this render call itself would throw and
    // fail the test — which is exactly the whole-app blank the boundary exists
    // to prevent.
    render(
      <TabErrorBoundary>
        <Boom throwNow message="provider blew up" />
      </TabErrorBoundary>,
    );
    expect(screen.getByTestId('tab-error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('tab-error-message')).toHaveTextContent('provider blew up');
    // The crash was surfaced for diagnosis rather than swallowed.
    expect(errSpy).toHaveBeenCalled();
  });

  it('does not tear down siblings when one child throws', () => {
    render(
      <div>
        <div data-testid="sibling">still here</div>
        <TabErrorBoundary>
          <Boom throwNow />
        </TabErrorBoundary>
      </div>,
    );
    // The sibling outside the boundary is untouched — a crash in one tab must
    // not blank the rest of the window.
    expect(screen.getByTestId('sibling')).toBeInTheDocument();
    expect(screen.getByTestId('tab-error-boundary')).toBeInTheDocument();
  });

  it('recovers via Retry once the child stops throwing', () => {
    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <div>
          <button data-testid="fix" onClick={() => setBroken(false)}>
            fix
          </button>
          <TabErrorBoundary>
            <Boom throwNow={broken} />
          </TabErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId('tab-error-boundary')).toBeInTheDocument();

    // Make the child able to render, then retry: the boundary clears its error
    // and re-renders the now-healthy child.
    fireEvent.click(screen.getByTestId('fix'));
    fireEvent.click(screen.getByTestId('tab-error-retry'));

    expect(screen.getByTestId('ok')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-error-boundary')).toBeNull();
  });

  it('clears a stale error when resetKey changes', () => {
    // Models the pane swapping which tab a boundary wraps: the new tab must not
    // inherit the old tab's error screen.
    const { rerender } = render(
      <TabErrorBoundary resetKey="tab-a">
        <Boom throwNow />
      </TabErrorBoundary>,
    );
    expect(screen.getByTestId('tab-error-boundary')).toBeInTheDocument();

    rerender(
      <TabErrorBoundary resetKey="tab-b">
        <Boom throwNow={false} />
      </TabErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-error-boundary')).toBeNull();
  });
});

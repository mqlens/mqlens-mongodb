import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusBar } from '../StatusBar';

function renderStatusBar(props: React.ComponentProps<typeof StatusBar>) {
  return render(
    <TooltipProvider>
      <StatusBar {...props} />
    </TooltipProvider>
  );
}

describe('StatusBar', () => {
  it('hides zoom indicator at 100%', () => {
    renderStatusBar({ zoomPercent: 100 });
    expect(screen.queryByTestId('status-bar-zoom')).toBeNull();
  });

  it('shows zoom indicator when not at 100%', () => {
    renderStatusBar({ zoomPercent: 110 });
    expect(screen.getByTestId('status-bar-zoom')).toHaveTextContent('110%');
  });

  it('shows minimum zoom (75%)', () => {
    renderStatusBar({ zoomPercent: 75 });
    expect(screen.getByTestId('status-bar-zoom')).toHaveTextContent('75%');
  });

  it('shows maximum zoom (150%)', () => {
    renderStatusBar({ zoomPercent: 150 });
    expect(screen.getByTestId('status-bar-zoom')).toHaveTextContent('150%');
  });

  it('calls onZoomReset when the zoom chip is clicked', () => {
    const onZoomReset = vi.fn();
    renderStatusBar({ zoomPercent: 125, onZoomReset });
    fireEvent.click(screen.getByTestId('status-bar-zoom'));
    expect(onZoomReset).toHaveBeenCalledTimes(1);
  });
});

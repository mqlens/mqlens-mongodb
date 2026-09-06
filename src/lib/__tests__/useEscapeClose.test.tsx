import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useEscapeClose } from '../useEscapeClose';
import { TabVisibleContext } from '../../workspace/tabVisibility';

function Modal({ onClose }: { onClose: () => void }) {
  useEscapeClose(true, onClose);
  return <div>modal</div>;
}

describe('useEscapeClose', () => {
  it('closes on Escape while its tab is on screen', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while its tab is hidden, and answers again once it is shown', () => {
    // A kept-alive tab (#240) keeps its dialog open, out of sight, so it can
    // come back with the tab. Escape pressed in the tab on screen belongs to
    // that tab, not to every hidden dialog at once.
    const onClose = vi.fn();
    const view = (visible: boolean) => (
      <TabVisibleContext.Provider value={visible}>
        <Modal onClose={onClose} />
      </TabVisibleContext.Provider>
    );
    const { rerender } = render(view(false));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    rerender(view(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

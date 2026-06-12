import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useState } from 'react';
import { DialogProvider, useDialogs } from '../dialogs/DialogProvider';

// A small consumer that exercises the hook and records each promise's result.
function Harness() {
  const d = useDialogs();
  const [result, setResult] = useState<string>('pending');
  return (
    <div>
      <button onClick={async () => setResult(String(await d.confirm({ title: 'Delete?' })))}>
        go-confirm
      </button>
      <button
        onClick={async () =>
          setResult(String(await d.confirm({ title: 'Drop it', destructive: true })))
        }
      >
        go-confirm-destructive
      </button>
      <button
        onClick={async () => setResult(String(await d.prompt({ title: 'Name?', defaultValue: 'foo' })))}
      >
        go-prompt
      </button>
      <button
        onClick={async () =>
          setResult(
            String(
              await d.prompt({
                title: 'Name?',
                validate: (v) => (v.length === 0 ? 'Required' : null),
              })
            )
          )
        }
      >
        go-prompt-validate
      </button>
      <button
        onClick={async () =>
          setResult(
            String(
              await d.choose({
                title: 'Mode?',
                choices: [
                  { value: 'skip', label: 'Skip duplicates' },
                  { value: 'abort', label: 'Abort', destructive: true },
                ],
              })
            )
          )
        }
      >
        go-choose
      </button>
      <button onClick={() => d.toast('Saved!', 'success')}>go-toast-success</button>
      <button onClick={() => d.toast('Boom', 'error')}>go-toast-error</button>
      <div data-testid="result">{result}</div>
    </div>
  );
}

function renderHarness() {
  return render(
    <DialogProvider>
      <Harness />
    </DialogProvider>
  );
}

describe('DialogProvider — confirm', () => {
  it('resolves true when the confirm button is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-confirm'));
    fireEvent.click(await screen.findByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
  });

  it('resolves false when cancelled', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-confirm'));
    fireEvent.click(await screen.findByTestId('dialog-cancel'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
  });

  it('resolves false on Escape', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-confirm'));
    const overlay = await screen.findByTestId('dialog-overlay');
    fireEvent.keyDown(overlay, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
  });

  it('stays open on backdrop click (dismiss only via buttons or Escape)', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-confirm'));
    const overlay = await screen.findByTestId('dialog-overlay');
    fireEvent.click(overlay);
    expect(screen.getByTestId('dialog-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('result')).toHaveTextContent('pending');
  });

  it('marks the confirm button destructive when requested', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-confirm-destructive'));
    const btn = await screen.findByTestId('dialog-confirm');
    expect(btn.className).toMatch(/destructive/);
  });
});

describe('DialogProvider — prompt', () => {
  it('pre-fills the default value and resolves the trimmed input', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-prompt'));
    const input = (await screen.findByTestId('dialog-input')) as HTMLInputElement;
    expect(input.value).toBe('foo');
    fireEvent.change(input, { target: { value: '  bar  ' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('bar'));
  });

  it('resolves null when cancelled', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-prompt'));
    fireEvent.click(await screen.findByTestId('dialog-cancel'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('null'));
  });

  it('blocks submit and shows the validation error, then allows after fix', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-prompt-validate'));
    const input = (await screen.findByTestId('dialog-input')) as HTMLInputElement;
    // empty -> blocked
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    expect(await screen.findByTestId('dialog-error')).toHaveTextContent('Required');
    expect(screen.getByTestId('result')).toHaveTextContent('pending');
    // fix -> allowed
    fireEvent.change(input, { target: { value: 'ok' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('ok'));
  });

  it('submits on Enter', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-prompt'));
    const input = (await screen.findByTestId('dialog-input')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'viaenter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('viaenter'));
  });
});

describe('DialogProvider — choose', () => {
  it('resolves the chosen value', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-choose'));
    fireEvent.click(await screen.findByText('Skip duplicates'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('skip'));
  });

  it('resolves null when cancelled', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-choose'));
    fireEvent.click(await screen.findByTestId('dialog-cancel'));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('null'));
  });
});

describe('DialogProvider — toast', () => {
  it('renders the message with its kind', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-toast-success'));
    const toast = await screen.findByText('Saved!');
    expect(toast.closest('[data-testid="dialog-toast"]')?.className).toMatch(/success/);
  });

  it('removes a toast when its close button is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-toast-error'));
    expect(await screen.findByText('Boom')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dialog-toast-close'));
    await waitFor(() => expect(screen.queryByText('Boom')).not.toBeInTheDocument());
  });

  it('stacks multiple toasts', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-toast-success'));
    fireEvent.click(screen.getByText('go-toast-error'));
    await waitFor(() => expect(screen.getAllByTestId('dialog-toast')).toHaveLength(2));
  });
});

describe('DialogProvider — auto-dismiss', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto-dismisses a success toast after its timeout', async () => {
    render(
      <DialogProvider>
        <Harness />
      </DialogProvider>
    );
    fireEvent.click(screen.getByText('go-toast-success'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });
});

describe('DialogProvider — single modal', () => {
  it('shows only one modal overlay at a time', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('go-confirm'));
    await screen.findByTestId('dialog-overlay');
    expect(screen.getAllByTestId('dialog-overlay')).toHaveLength(1);
  });
});

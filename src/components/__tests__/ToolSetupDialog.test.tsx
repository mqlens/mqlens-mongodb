import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ToolSetupDialog, type ManagedToolStatusUi } from '../ToolSetupDialog';

const statuses: ManagedToolStatusUi[] = [
  { name: 'database-tools', version: '100.9.4', installed: false, path: null },
  { name: 'mongosh', version: '2.3.1', installed: true, path: '/data/tools/mongosh/bin/mongosh' },
];

const baseProps = {
  open: true,
  onOpenChange: () => {},
  statuses,
  installTask: null,
  onInstall: vi.fn(),
};

describe('ToolSetupDialog', () => {
  it('lists both tools with versions; defaults checked to not-installed tools only', () => {
    render(<ToolSetupDialog {...baseProps} onInstall={vi.fn()} />);

    expect(screen.getByTestId('toolsetup-dialog')).toBeInTheDocument();

    expect(screen.getByTestId('toolsetup-version-database-tools')).toHaveTextContent('100.9.4');
    expect(screen.getByTestId('toolsetup-version-mongosh')).toHaveTextContent('2.3.1');

    const dbToolsCheck = screen.getByTestId('toolsetup-check-database-tools') as HTMLInputElement;
    const mongoshCheck = screen.getByTestId('toolsetup-check-mongosh') as HTMLInputElement;
    expect(dbToolsCheck.checked).toBe(true);
    expect(mongoshCheck.checked).toBe(false);

    // Installed tool shows an "Installed" indicator.
    expect(screen.getByText(/installed/i)).toBeInTheDocument();

    expect(screen.getByTestId('toolsetup-size-note')).toBeInTheDocument();
    expect(screen.getByTestId('toolsetup-license-note')).toHaveTextContent(
      'Official Apache-2.0 builds downloaded from mongodb.com'
    );
  });

  it('disables Install with zero tools checked, and fires onInstall(names, false) for a fresh install', () => {
    const onInstall = vi.fn();
    render(<ToolSetupDialog {...baseProps} onInstall={onInstall} />);

    const dbToolsCheck = screen.getByTestId('toolsetup-check-database-tools') as HTMLInputElement;
    fireEvent.click(dbToolsCheck); // uncheck the only selected tool
    expect(screen.getByTestId('toolsetup-install-btn')).toBeDisabled();

    fireEvent.click(dbToolsCheck); // re-check
    expect(screen.getByTestId('toolsetup-install-btn')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));
    expect(onInstall).toHaveBeenCalledWith(['database-tools'], false);
  });

  it('shows a reinstall note and fires force:true when any selected tool is already installed', () => {
    const onInstall = vi.fn();
    render(<ToolSetupDialog {...baseProps} onInstall={onInstall} />);

    const mongoshCheck = screen.getByTestId('toolsetup-check-mongosh') as HTMLInputElement;
    fireEvent.click(mongoshCheck); // also select the already-installed tool

    expect(screen.getByText(/will reinstall/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));
    expect(onInstall).toHaveBeenCalledWith(['database-tools', 'mongosh'], true);
  });

  it('renders stage message and a percent progress bar while running, and wires Cancel', () => {
    const onCancel = vi.fn();
    render(
      <ToolSetupDialog
        {...baseProps}
        onCancel={onCancel}
        installTask={{ status: 'running', message: 'Downloading database-tools…', processed: 40, total: 100 }}
      />
    );

    expect(screen.getByTestId('toolsetup-stage')).toHaveTextContent('Downloading database-tools…');
    const progress = screen.getByTestId('toolsetup-progress');
    expect(progress).toBeInTheDocument();
    expect(progress).toHaveAttribute('aria-valuenow', '40');

    fireEvent.click(screen.getByTestId('toolsetup-cancel-btn'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders an indeterminate progress bar when total is unknown', () => {
    render(
      <ToolSetupDialog
        {...baseProps}
        installTask={{ status: 'running', message: 'Extracting…', processed: 0, total: null }}
      />
    );
    const progress = screen.getByTestId('toolsetup-progress');
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(progress.getAttribute('data-indeterminate')).toBe('true');
  });

  it('shows the error and retries onInstall with the same args on failure', () => {
    const onInstall = vi.fn();
    const { rerender } = render(<ToolSetupDialog {...baseProps} onInstall={onInstall} installTask={null} />);

    // Select both tools (one installed) so the submitted call uses force: true.
    fireEvent.click(screen.getByTestId('toolsetup-check-mongosh'));
    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));
    expect(onInstall).toHaveBeenNthCalledWith(1, ['database-tools', 'mongosh'], true);

    rerender(
      <ToolSetupDialog
        {...baseProps}
        onInstall={onInstall}
        installTask={{ status: 'failed', message: 'Network error', processed: 0, total: null }}
      />
    );

    expect(screen.getByTestId('toolsetup-error')).toHaveTextContent('Network error');

    fireEvent.click(screen.getByTestId('toolsetup-retry-btn'));
    expect(onInstall).toHaveBeenNthCalledWith(2, ['database-tools', 'mongosh'], true);
  });

  it('treats a cancelled task as terminal: shows a Cancelled heading, retries with the same args, and dismisses', () => {
    const onInstall = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ToolSetupDialog {...baseProps} onInstall={onInstall} onOpenChange={onOpenChange} installTask={null} />
    );

    fireEvent.click(screen.getByTestId('toolsetup-install-btn'));
    expect(onInstall).toHaveBeenNthCalledWith(1, ['database-tools'], false);

    rerender(
      <ToolSetupDialog
        {...baseProps}
        onInstall={onInstall}
        onOpenChange={onOpenChange}
        installTask={{ status: 'cancelled', message: 'Install cancelled', processed: 1, total: 2 }}
      />
    );

    expect(screen.getByTestId('toolsetup-cancelled-heading')).toHaveTextContent('Cancelled');
    expect(screen.getByTestId('toolsetup-error')).toHaveTextContent('Install cancelled');

    fireEvent.click(screen.getByTestId('toolsetup-retry-btn'));
    expect(onInstall).toHaveBeenNthCalledWith(2, ['database-tools'], false);

    fireEvent.click(screen.getByTestId('toolsetup-dismiss-btn'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables Install and shows Starting… while the start call is in flight, so a double-click fires once', async () => {
    let resolveStart!: () => void;
    const onInstall = vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
    render(<ToolSetupDialog {...baseProps} onInstall={onInstall} />);

    const btn = screen.getByTestId('toolsetup-install-btn');
    fireEvent.click(btn);
    fireEvent.click(btn); // double-click must not start a second install

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Starting…');

    resolveStart();
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(btn).toHaveTextContent('Install');
  });

  it('retains a terminal install state when the task entry disappears (Clear finished), and resets on close', () => {
    const { rerender } = render(
      <ToolSetupDialog
        {...baseProps}
        installTask={{ status: 'completed', message: 'Installed database-tools', processed: 2, total: 2 }}
      />
    );
    expect(screen.getByTestId('toolsetup-done-btn')).toBeInTheDocument();

    // "Clear finished" removes the store entry — the dialog must keep showing
    // the completed screen, not silently revert to the checklist.
    rerender(<ToolSetupDialog {...baseProps} installTask={null} />);
    expect(screen.getByTestId('toolsetup-done-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('toolsetup-install-btn')).not.toBeInTheDocument();

    // Closing drops the snapshot, so reopening shows the fresh checklist.
    rerender(<ToolSetupDialog {...baseProps} open={false} installTask={null} />);
    rerender(<ToolSetupDialog {...baseProps} open installTask={null} />);
    expect(screen.getByTestId('toolsetup-install-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('toolsetup-done-btn')).not.toBeInTheDocument();
  });

  it('shows Done when completed and fires onDone', () => {
    const onDone = vi.fn();
    render(
      <ToolSetupDialog
        {...baseProps}
        onDone={onDone}
        installTask={{ status: 'completed', message: 'Done', processed: 2, total: 2 }}
      />
    );

    fireEvent.click(screen.getByTestId('toolsetup-done-btn'));
    expect(onDone).toHaveBeenCalled();
  });
});

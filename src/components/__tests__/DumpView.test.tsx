import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DumpView } from '../DumpView';

vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onChange,
    wrapperProps,
  }: {
    value: string;
    onChange?: (v: string) => void;
    wrapperProps?: Record<string, unknown>;
  }) => (
    <textarea
      data-testid={wrapperProps?.['data-testid'] as string | undefined}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

const renderDumpView = (overrides: Record<string, unknown> = {}) => {
  const props = {
    connectionName: 'conn',
    databases: [{ name: 'sales', collections: ['orders', 'users'] }],
    tools: { mongodump: { path: '/usr/bin/mongodump', version: '100.9' }, mongorestore: null },
    onPickFolder: vi.fn().mockResolvedValue('/tmp/out'),
    onPickArchiveFile: vi.fn().mockResolvedValue('/tmp/out.archive.gz'),
    onRunDump: vi.fn(),
    ...overrides,
  };
  render(<DumpView {...(props as any)} />);
  return props;
};

describe('DumpView', () => {
  it('shows guidance and disables run when mongodump tooling is missing', () => {
    const onOpenSettings = vi.fn();
    renderDumpView({
      tools: { mongodump: null, mongorestore: null },
      onOpenSettings,
    });

    expect(screen.getByTestId('dump-tools-missing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.getByTestId('dump-run-btn')).toBeDisabled();
  });

  it('omits the Install tools button when onInstallTools is not provided', () => {
    renderDumpView({ tools: { mongodump: null, mongorestore: null } });
    expect(screen.queryByTestId('dump-install-tools-btn')).not.toBeInTheDocument();
  });

  it('wires the Install tools button in the guidance card to onInstallTools', () => {
    const onInstallTools = vi.fn();
    renderDumpView({ tools: { mongodump: null, mongorestore: null }, onInstallTools });
    fireEvent.click(screen.getByTestId('dump-install-tools-btn'));
    expect(onInstallTools).toHaveBeenCalled();
  });

  it('scope selection gates the db/collection selects, query editor, and scope-limited checkboxes', () => {
    renderDumpView();

    // default: server scope
    expect(screen.queryByTestId('dump-db-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dump-coll-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dump-query-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('dump-opt-oplog')).not.toBeDisabled();
    expect(screen.getByTestId('dump-opt-usersroles')).toBeDisabled();

    fireEvent.click(screen.getByTestId('dump-scope-db'));
    expect(screen.getByTestId('dump-db-select')).toBeInTheDocument();
    expect(screen.queryByTestId('dump-coll-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dump-query-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('dump-opt-usersroles')).not.toBeDisabled();
    expect(screen.getByTestId('dump-opt-oplog')).toBeDisabled();

    fireEvent.click(screen.getByTestId('dump-scope-collection'));
    expect(screen.getByTestId('dump-db-select')).toBeInTheDocument();
    expect(screen.getByTestId('dump-coll-select')).toBeInTheDocument();
    expect(screen.getByTestId('dump-query-input')).toBeInTheDocument();
    expect(screen.getByTestId('dump-opt-usersroles')).toBeDisabled();
    expect(screen.getByTestId('dump-opt-oplog')).toBeDisabled();
  });

  it('handles folder and archive destination pickers with a computed default archive name', async () => {
    const props = renderDumpView();

    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    expect(props.onPickFolder).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('dump-dest-path')).toHaveTextContent('/tmp/out'));

    fireEvent.click(screen.getByTestId('dump-target-archive'));
    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    expect(props.onPickArchiveFile).toHaveBeenCalledWith('conn.archive.gz');
    await waitFor(() =>
      expect(screen.getByTestId('dump-dest-path')).toHaveTextContent('/tmp/out.archive.gz'));

    fireEvent.click(screen.getByTestId('dump-opt-gzip'));
    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    expect(props.onPickArchiveFile).toHaveBeenLastCalledWith('conn.archive');
  });

  it('run button gates on a destination and forwards the full options payload', async () => {
    const props = renderDumpView();

    fireEvent.click(screen.getByTestId('dump-scope-collection'));
    fireEvent.change(screen.getByTestId('dump-coll-select'), { target: { value: 'users' } });
    fireEvent.change(screen.getByTestId('dump-query-input'), {
      target: { value: '{"active":true}' },
    });
    fireEvent.click(screen.getByTestId('dump-opt-forcetablescan'));

    expect(screen.getByTestId('dump-run-btn')).toBeDisabled();

    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    await waitFor(() => expect(screen.getByTestId('dump-run-btn')).toBeEnabled());

    fireEvent.click(screen.getByTestId('dump-run-btn'));
    expect(props.onRunDump).toHaveBeenCalledWith({
      scope: { kind: 'collection', db: 'sales', coll: 'users' },
      target: { kind: 'folder', out: '/tmp/out' },
      gzip: true,
      query: '{"active":true}',
      forceTableScan: true,
      dumpUsersAndRoles: false,
      oplog: false,
    });
  });

  it('gzip compression defaults on', () => {
    renderDumpView();
    expect(screen.getByTestId('dump-opt-gzip')).toBeChecked();
  });

  it('double-clicking Run starts the dump only once and shows Starting…', async () => {
    let resolveRun!: () => void;
    const onRunDump = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRun = resolve;
      })
    );
    renderDumpView({ onRunDump });

    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    await waitFor(() => expect(screen.getByTestId('dump-run-btn')).toBeEnabled());

    fireEvent.click(screen.getByTestId('dump-run-btn'));
    fireEvent.click(screen.getByTestId('dump-run-btn'));

    expect(onRunDump).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('dump-run-btn')).toBeDisabled();
    expect(screen.getByTestId('dump-run-btn')).toHaveTextContent('Starting…');

    resolveRun();
    await waitFor(() => expect(screen.getByTestId('dump-run-btn')).toBeEnabled());
  });

  it('invalid query JSON disables Run and shows an inline error; valid JSON passes through', async () => {
    const props = renderDumpView();

    fireEvent.click(screen.getByTestId('dump-scope-collection'));
    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    await waitFor(() => expect(screen.getByTestId('dump-run-btn')).toBeEnabled());

    fireEvent.change(screen.getByTestId('dump-query-input'), {
      target: { value: '{active: true}' },
    });
    expect(screen.getByTestId('dump-query-error')).toBeInTheDocument();
    expect(screen.getByTestId('dump-run-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('dump-query-input'), {
      target: { value: '{"active": true}' },
    });
    expect(screen.queryByTestId('dump-query-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('dump-run-btn')).toBeEnabled();

    fireEvent.click(screen.getByTestId('dump-run-btn'));
    expect(props.onRunDump).toHaveBeenCalledWith(
      expect.objectContaining({ query: '{"active": true}' })
    );
  });

  it('does not request a preview while mongodump is missing', async () => {
    vi.useFakeTimers();
    const onPreviewCommand = vi.fn().mockResolvedValue('mongodump …');
    renderDumpView({ tools: { mongodump: null, mongorestore: null }, onPreviewCommand });
    await vi.advanceTimersByTimeAsync(400);
    expect(onPreviewCommand).not.toHaveBeenCalled();
    expect(screen.getByTestId('dump-preview-cmd')).toBeEmptyDOMElement();
  });

  it('ignores out-of-order preview responses and keeps the latest command', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(v: string) => void> = [];
    const onPreviewCommand = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        })
    );
    renderDumpView({ onPreviewCommand });

    await vi.advanceTimersByTimeAsync(350);
    expect(onPreviewCommand).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('dump-opt-forcetablescan'));
    await vi.advanceTimersByTimeAsync(350);
    expect(onPreviewCommand).toHaveBeenCalledTimes(2);

    // The newer request resolves first, then the stale one arrives late.
    resolvers[1]('fresh command');
    await vi.advanceTimersByTimeAsync(0);
    resolvers[0]('stale command');
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId('dump-preview-cmd')).toHaveTextContent('fresh command');
  });

  it('shows a disabled db placeholder when no databases are available', async () => {
    renderDumpView({ databases: [] });

    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    await waitFor(() => expect(screen.getByTestId('dump-dest-path')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('dump-scope-db'));
    const dbSelect = screen.getByTestId('dump-db-select') as HTMLSelectElement;
    expect(dbSelect.value).toBe('');
    expect(screen.getByText('Select database…')).toBeInTheDocument();
    expect(screen.getByTestId('dump-run-btn')).toBeDisabled();
  });

  it('shows a disabled collection placeholder when the database has no collections', async () => {
    renderDumpView({ databases: [{ name: 'empty', collections: [] }] });

    fireEvent.click(screen.getByTestId('dump-pick-dest-btn'));
    await waitFor(() => expect(screen.getByTestId('dump-dest-path')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('dump-scope-collection'));
    const collSelect = screen.getByTestId('dump-coll-select') as HTMLSelectElement;
    expect(collSelect.value).toBe('');
    expect(screen.getByText('Select collection…')).toBeInTheDocument();
    expect(screen.getByTestId('dump-run-btn')).toBeDisabled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

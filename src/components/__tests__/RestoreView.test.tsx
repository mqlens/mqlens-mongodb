import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RestoreView, type DumpTreeUi } from '../RestoreView';

const treeFixture: DumpTreeUi = {
  dbs: [
    {
      name: 'sales',
      collections: [
        { name: 'orders', hasMetadata: true, gzip: false },
        { name: 'users', hasMetadata: true, gzip: true },
      ],
    },
    {
      name: 'inventory',
      collections: [{ name: 'items', hasMetadata: true, gzip: false }],
    },
  ],
};

const renderRestoreView = (overrides: Record<string, unknown> = {}) => {
  const props = {
    connectionName: 'conn',
    tools: { mongodump: null, mongorestore: { path: '/usr/bin/mongorestore', version: '100.9' } },
    onOpenSettings: vi.fn(),
    onPickFolder: vi.fn().mockResolvedValue('/tmp/dump'),
    onPickArchiveFile: vi.fn().mockResolvedValue('/tmp/dump.archive.gz'),
    onBrowseFolder: vi.fn().mockResolvedValue(treeFixture),
    onPreviewCommand: vi.fn().mockResolvedValue('mongorestore --dir=/tmp/dump'),
    onRunRestore: vi.fn(),
    onOpenTasks: vi.fn(),
    ...overrides,
  };
  render(<RestoreView {...(props as any)} />);
  return props;
};

const browseFolder = async (props: ReturnType<typeof renderRestoreView>) => {
  fireEvent.click(screen.getByTestId('restore-pick-source-btn'));
  await waitFor(() => expect(screen.getByTestId('restore-tree')).toBeInTheDocument());
  return props;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('RestoreView tool detection', () => {
  it('shows guidance and disables Run when mongorestore is missing', () => {
    const props = renderRestoreView({ tools: { mongodump: null, mongorestore: null } });
    expect(screen.getByTestId('restore-tools-missing')).toBeInTheDocument();
    expect(screen.getByTestId('restore-run-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('restore-open-settings-btn'));
    expect(props.onOpenSettings).toHaveBeenCalled();
  });

  it('omits the Install tools button when onInstallTools is not provided', () => {
    renderRestoreView({ tools: { mongodump: null, mongorestore: null } });
    expect(screen.queryByTestId('restore-install-tools-btn')).not.toBeInTheDocument();
  });

  it('wires the Install tools button in the guidance card to onInstallTools', () => {
    const onInstallTools = vi.fn();
    renderRestoreView({ tools: { mongodump: null, mongorestore: null }, onInstallTools });
    fireEvent.click(screen.getByTestId('restore-install-tools-btn'));
    expect(onInstallTools).toHaveBeenCalled();
  });
});

describe('RestoreView folder browsing', () => {
  it('browses a folder and auto-sets gzip when any collection is gzipped', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    expect(props.onBrowseFolder).toHaveBeenCalledWith('/tmp/dump');
    expect(screen.getByTestId('restore-tree-db-sales')).toBeInTheDocument();
    expect(screen.getByTestId('restore-tree-db-inventory')).toBeInTheDocument();
    expect(screen.getByTestId('restore-tree-coll-sales.orders')).toBeInTheDocument();
    expect((screen.getByTestId('restore-opt-gzip') as HTMLInputElement).checked).toBe(true);
    // every collection starts checked
    expect((screen.getByTestId('restore-tree-coll-sales.orders') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('restore-tree-coll-sales.users') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('restore-tree-coll-inventory.items') as HTMLInputElement).checked).toBe(true);
  });
});

describe('RestoreView folder browse failure', () => {
  it('shows a browse error and keeps Run disabled when onBrowseFolder rejects', async () => {
    const onBrowseFolder = vi.fn().mockRejectedValue(new Error('permission denied'));
    renderRestoreView({ onBrowseFolder });
    fireEvent.click(screen.getByTestId('restore-pick-source-btn'));
    await waitFor(() => expect(screen.getByTestId('restore-browse-error')).toBeInTheDocument());
    expect(screen.getByTestId('restore-browse-error')).toHaveTextContent('permission denied');
    expect(screen.queryByTestId('restore-tree')).not.toBeInTheDocument();
    expect(screen.getByTestId('restore-run-btn')).toBeDisabled();
  });

  it('resets gzip to false when re-browsing a folder with no gzipped collections', async () => {
    const nonGzipTree: DumpTreeUi = {
      dbs: [{ name: 'sales', collections: [{ name: 'orders', hasMetadata: true, gzip: false }] }],
    };
    const onBrowseFolder = vi.fn().mockResolvedValueOnce(treeFixture).mockResolvedValueOnce(nonGzipTree);
    const props = renderRestoreView({ onBrowseFolder });
    await browseFolder(props);
    expect((screen.getByTestId('restore-opt-gzip') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByTestId('restore-pick-source-btn'));
    await waitFor(() => expect(onBrowseFolder).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId('restore-opt-gzip') as HTMLInputElement).checked).toBe(false);
  });
});

describe('RestoreView selection semantics', () => {
  it('sends selections: [] when everything is checked with no renames', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    expect(props.onRunRestore).toHaveBeenCalledWith(expect.objectContaining({ selections: [] }));
  });

  it('excludes an unchecked collection from selections', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    fireEvent.click(screen.getByTestId('restore-tree-coll-sales.orders'));
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    expect(props.onRunRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [
          { db: 'sales', coll: 'users' },
          { db: 'inventory', coll: 'items' },
        ],
      })
    );
  });

  it('adds renameTo and still enumerates every collection when all are checked but one is renamed', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    fireEvent.change(screen.getByTestId('restore-rename-sales.users'), {
      target: { value: 'usersRenamed' },
    });
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    expect(props.onRunRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [
          { db: 'sales', coll: 'orders' },
          { db: 'sales', coll: 'users', renameTo: 'usersRenamed' },
          { db: 'inventory', coll: 'items' },
        ],
      })
    );
  });
});

describe('RestoreView empty selection guard', () => {
  it('unchecking every collection disables Run and shows a hint', async () => {
    const props = renderRestoreView();
    await browseFolder(props);

    fireEvent.click(screen.getByTestId('restore-tree-coll-sales.orders'));
    fireEvent.click(screen.getByTestId('restore-tree-coll-sales.users'));
    expect(screen.queryByTestId('restore-empty-selection-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('restore-run-btn')).toBeEnabled();

    fireEvent.click(screen.getByTestId('restore-tree-coll-inventory.items'));
    expect(screen.getByTestId('restore-empty-selection-hint')).toBeInTheDocument();
    expect(screen.getByTestId('restore-run-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    expect(props.onRunRestore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('restore-tree-coll-sales.orders'));
    expect(screen.queryByTestId('restore-empty-selection-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('restore-run-btn')).toBeEnabled();
  });
});

describe('RestoreView rename contract', () => {
  it('labels the rename input with the db.name contract', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    const input = screen.getByTestId('restore-rename-sales.users');
    expect(input).toHaveAttribute('placeholder', 'new name (or db.name)');
    expect(input.getAttribute('title')).toMatch(/same database/i);
  });
});

describe('RestoreView double-submit guard', () => {
  it('double-clicking Restore starts only one run and shows Starting…', async () => {
    let resolveRun!: () => void;
    const onRunRestore = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRun = resolve;
      })
    );
    const props = renderRestoreView({ onRunRestore });
    await browseFolder(props);

    fireEvent.click(screen.getByTestId('restore-run-btn'));
    fireEvent.click(screen.getByTestId('restore-run-btn'));

    expect(onRunRestore).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('restore-run-btn')).toBeDisabled();
    expect(screen.getByTestId('restore-run-btn')).toHaveTextContent('Starting…');

    resolveRun();
    await waitFor(() => expect(screen.getByTestId('restore-run-btn')).toBeEnabled());
  });

  it('confirming a drop restore keeps further clicks from starting a second run', async () => {
    const onRunRestore = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const props = renderRestoreView({ onRunRestore });
    await browseFolder(props);

    fireEvent.click(screen.getByTestId('restore-opt-drop'));
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    fireEvent.click(screen.getByTestId('restore-drop-confirm-btn'));

    expect(onRunRestore).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('restore-run-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    expect(onRunRestore).toHaveBeenCalledTimes(1);
  });
});

describe('RestoreView archive mode', () => {
  it('hides the tree and shows filter inputs plus a note', () => {
    renderRestoreView();
    fireEvent.click(screen.getByTestId('restore-source-archive'));
    expect(screen.queryByTestId('restore-tree')).not.toBeInTheDocument();
    expect(screen.getByTestId('restore-archive-filter-db')).toBeInTheDocument();
    expect(screen.getByTestId('restore-archive-filter-coll')).toBeInTheDocument();
    expect(screen.getByTestId('restore-archive-note')).toBeInTheDocument();
  });

  it('auto-sets gzip when the picked archive file ends with .gz', async () => {
    const onPickArchiveFile = vi.fn().mockResolvedValue('/tmp/dump.archive.GZ');
    renderRestoreView({ onPickArchiveFile });
    fireEvent.click(screen.getByTestId('restore-source-archive'));
    fireEvent.click(screen.getByTestId('restore-pick-source-btn'));
    await waitFor(() => expect(screen.getByTestId('restore-source-path')).toHaveTextContent('.GZ'));
    expect((screen.getByTestId('restore-opt-gzip') as HTMLInputElement).checked).toBe(true);
  });
});

describe('RestoreView oplog replay narrowing', () => {
  it('disables oplogReplay whenever narrowing is active', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    expect(screen.getByTestId('restore-opt-oplogreplay')).toBeEnabled();

    fireEvent.click(screen.getByTestId('restore-tree-coll-sales.orders'));
    expect(screen.getByTestId('restore-opt-oplogreplay')).toBeDisabled();

    fireEvent.click(screen.getByTestId('restore-tree-coll-sales.orders'));
    expect(screen.getByTestId('restore-opt-oplogreplay')).toBeEnabled();

    fireEvent.change(screen.getByTestId('restore-rename-sales.users'), {
      target: { value: 'usersRenamed' },
    });
    expect(screen.getByTestId('restore-opt-oplogreplay')).toBeDisabled();

    fireEvent.change(screen.getByTestId('restore-rename-sales.users'), { target: { value: '' } });
    expect(screen.getByTestId('restore-opt-oplogreplay')).toBeEnabled();

    fireEvent.click(screen.getByTestId('restore-source-archive'));
    expect(screen.getByTestId('restore-opt-oplogreplay')).toBeEnabled();
    fireEvent.change(screen.getByTestId('restore-archive-filter-db'), { target: { value: 'sales' } });
    expect(screen.getByTestId('restore-opt-oplogreplay')).toBeDisabled();
  });
});

describe('RestoreView drop confirmation', () => {
  it('requires an inline confirm before running when drop is enabled', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    fireEvent.click(screen.getByTestId('restore-opt-drop'));
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    expect(props.onRunRestore).not.toHaveBeenCalled();
    const confirm = screen.getByTestId('restore-drop-confirm');
    expect(confirm).toHaveTextContent('sales.orders');
    expect(confirm).toHaveTextContent('sales.users');
    expect(confirm).toHaveTextContent('inventory.items');
    fireEvent.click(screen.getByTestId('restore-drop-confirm-btn'));
    expect(props.onRunRestore).toHaveBeenCalledWith(expect.objectContaining({ drop: true }));
  });

  it('runs immediately without drop', async () => {
    const props = renderRestoreView();
    await browseFolder(props);
    fireEvent.click(screen.getByTestId('restore-run-btn'));
    expect(screen.queryByTestId('restore-drop-confirm')).not.toBeInTheDocument();
    expect(props.onRunRestore).toHaveBeenCalledTimes(1);
  });
});

describe('RestoreView command preview', () => {
  it('debounces onPreviewCommand by 300ms and renders the result', async () => {
    vi.useFakeTimers();
    const onPreviewCommand = vi.fn().mockResolvedValue('mongorestore --drop /tmp/dump');
    renderRestoreView({ onPreviewCommand });
    fireEvent.click(screen.getByTestId('restore-pick-source-btn'));
    await vi.waitFor(() => expect(screen.getByTestId('restore-source-path')).toBeInTheDocument());
    expect(onPreviewCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(onPreviewCommand).toHaveBeenCalled();
    vi.useRealTimers();
    await waitFor(() =>
      expect(screen.getByTestId('restore-preview-cmd')).toHaveTextContent('mongorestore --drop /tmp/dump')
    );
  });
});

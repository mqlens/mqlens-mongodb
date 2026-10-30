import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { IndexViewer } from '../IndexViewer';
import { DialogProvider } from '../dialogs/DialogProvider';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

// IndexViewer uses the in-app confirm dialog, so render inside the provider.
const render = (ui: ReactElement) => rtlRender(<DialogProvider>{ui}</DialogProvider>);

describe('IndexViewer (T2)', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseProps = {
    connectionId: 'c1',
    databaseName: 'shop',
    collectionName: 'products',
    indexName: 'city_1',
  };

  const CITY_INDEX = { name: 'city_1', keys: '{"city":1}', unique: true, sparse: false };

  // Routes invoke calls by command name so list_indexes and index_stats can
  // each return their own shape (a single mockResolvedValue would make
  // index_stats resolve with the list_indexes payload and vice versa).
  const mockInvokeByCommand = (handlers: Record<string, any>) => {
    mockInvoke.mockImplementation((cmd: string) => {
      const handler = handlers[cmd];
      if (handler === undefined) return Promise.resolve([]);
      if (handler instanceof Error || handler === 'reject') return Promise.reject(handler);
      return Promise.resolve(handler);
    });
  };

  it('renders the REAL index spec from list_indexes (C3/H4)', async () => {
    mockInvokeByCommand({ list_indexes: [CITY_INDEX], index_stats: [] });
    render(<IndexViewer {...baseProps} />);

    // Real key field + unique/sparse flags (not guessed from the name).
    expect(await screen.findByText('city')).toBeInTheDocument();
    expect(screen.getAllByText('Unique').length).toBeGreaterThan(0);
    expect(screen.getByText(/Non-sparse/)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('list_indexes', {
      id: 'c1',
      db: 'shop',
      collection: 'products',
    });
  });

  it('shows an error state when the index cannot be loaded', async () => {
    mockInvoke.mockRejectedValue('boom');
    render(<IndexViewer {...baseProps} />);
    expect(await screen.findByTestId('index-viewer-error')).toBeInTheDocument();
  });

  it('delegates index deletion to the shared app handler', async () => {
    mockInvokeByCommand({ list_indexes: [{ ...CITY_INDEX, unique: false }], index_stats: [] });
    const onDeleteIndex = vi.fn();
    render(<IndexViewer {...baseProps} onDeleteIndex={onDeleteIndex} />);

    fireEvent.click(await screen.findByTestId('delete-index-btn'));

    await waitFor(() => expect(onDeleteIndex).toHaveBeenCalledWith('city_1'));
  });

  it('fetches index_stats and renders Size + Usage cards for the matching index', async () => {
    mockInvokeByCommand({
      list_indexes: [CITY_INDEX],
      index_stats: [
        { name: 'city_1', sizeBytes: 16_384, ops: 4_200, sinceMs: 1_749_427_200_000 },
        { name: 'other_1', sizeBytes: 999, ops: 1, sinceMs: 1_749_427_200_000 },
      ],
    });
    render(<IndexViewer {...baseProps} />);

    expect(mockInvoke).toHaveBeenCalledWith('index_stats', {
      id: 'c1',
      db: 'shop',
      collection: 'products',
    });

    const sizeCard = await screen.findByTestId('index-size-card');
    expect(sizeCard).toHaveTextContent('16 KB');

    const usageCard = await screen.findByTestId('index-usage-card');
    expect(usageCard).toHaveTextContent('4,200');
    expect(usageCard).not.toHaveTextContent(/unused/i);
  });

  it('shows an "unused" badge when the matching index has zero ops', async () => {
    mockInvokeByCommand({
      list_indexes: [CITY_INDEX],
      index_stats: [{ name: 'city_1', sizeBytes: 8_192, ops: 0, sinceMs: 0 }],
    });
    render(<IndexViewer {...baseProps} />);

    const usageCard = await screen.findByTestId('index-usage-card');
    expect(usageCard).toHaveTextContent('0');
    expect(usageCard).toHaveTextContent(/unused/i);
  });

  it('still renders the definition when index_stats fails', async () => {
    mockInvokeByCommand({ list_indexes: [CITY_INDEX], index_stats: new Error('stats down') });
    render(<IndexViewer {...baseProps} />);

    expect(await screen.findByText('city')).toBeInTheDocument();
    expect(screen.queryByTestId('index-size-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('index-usage-card')).not.toBeInTheDocument();
  });

  it('shows the TTL, hidden flag and partial filter of the index', async () => {
    const TTL_INDEX = {
      name: 'city_1', keys: '{"city":1}', unique: false, sparse: false,
      expireAfterSeconds: 3600, hidden: true, partialFilterExpression: '{"active":true}',
    };
    mockInvokeByCommand({ list_indexes: [TTL_INDEX], index_stats: [] });
    const onEditIndex = vi.fn();
    render(<IndexViewer {...baseProps} onEditIndex={onEditIndex} />);

    expect(await screen.findByTestId('index-ttl')).toHaveTextContent('TTL 1 hour (3600 s)');
    expect(screen.getByTestId('index-hidden')).toBeInTheDocument();
    expect(screen.getByTestId('index-partial-filter')).toHaveTextContent('{"active":true}');
    // The raw definition carries them as MongoDB writes them.
    expect(screen.getByText(/"expireAfterSeconds"/)).toBeInTheDocument();
    expect(screen.getByText(/"partialFilterExpression"/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('edit-index-btn'));
    expect(onEditIndex).toHaveBeenCalledWith({
      key: { city: 1 }, name: 'city_1', expireAfterSeconds: 3600, hidden: true, partialFilterExpression: { active: true },
    });
  });

  it('says an index has no TTL', async () => {
    mockInvokeByCommand({ list_indexes: [CITY_INDEX], index_stats: [] });
    render(<IndexViewer {...baseProps} />);
    expect(await screen.findByTestId('index-ttl')).toHaveTextContent('None');
    expect(screen.queryByTestId('index-hidden')).not.toBeInTheDocument();
    expect(screen.queryByTestId('index-partial-filter')).not.toBeInTheDocument();
  });
  // An expiry changed in place keeps the tab open; the app bumps the key.
  it('refetches when the refresh key changes', async () => {
    let expireAfterSeconds = 3600;
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'list_indexes' ? [{ ...CITY_INDEX, expireAfterSeconds }] : [])
    );
    const { rerender } = render(<IndexViewer {...baseProps} refreshKey={0} />);
    expect(await screen.findByTestId('index-ttl')).toHaveTextContent('3600 s');

    expireAfterSeconds = 86400;
    rerender(
      <DialogProvider>
        <IndexViewer {...baseProps} refreshKey={1} />
      </DialogProvider>
    );
    await waitFor(() => expect(screen.getByTestId('index-ttl')).toHaveTextContent('86400 s'));
  });

  describe('the whole document', () => {
    const listed = (document: Record<string, unknown>) => ({
      name: document.name, keys: JSON.stringify(document.key), unique: Boolean(document.unique), sparse: false,
      hidden: Boolean(document.hidden), spec: JSON.stringify(document),
    });
    const show = async (document: Record<string, unknown>, props: Record<string, unknown> = {}) => {
      mockInvokeByCommand({ list_indexes: [listed(document)], index_stats: [] });
      render(<IndexViewer {...baseProps} indexName={String(document.name)} {...props} />);
      await screen.findByTestId('index-kind');
      return screen.getByTestId('index-viewer');
    };

    it('shows the document as MongoDB lists it', async () => {
      const viewer = await show({ v: 2, key: { a: 1 }, name: 'a_1', storageEngine: { wiredTiger: {} } });
      expect(viewer).toHaveTextContent('"storageEngine"');
      expect(viewer).toHaveTextContent('"wiredTiger"');
    });

    it('gives every other option a row', async () => {
      await show({
        v: 2, key: { a: 1 }, name: 'a_1', collation: { locale: 'de' }, prepareUnique: true, bits: 20,
      });
      expect(screen.getByTestId('index-option-collation')).toHaveTextContent('{"locale":"de"}');
      expect(screen.getByTestId('index-option-prepareUnique')).toHaveTextContent('true');
      expect(screen.getByTestId('index-option-bits')).toHaveTextContent('20');
      expect(screen.queryByTestId('index-option-v')).not.toBeInTheDocument();
      expect(screen.queryByTestId('index-option-name')).not.toBeInTheDocument();
    });

    it.each([
      [{ _fts: 'text', _ftsx: 1 }, { weights: { bio: 1 } }, 'Text'],
      [{ loc: '2dsphere' }, {}, '2dsphere'],
      [{ loc: '2d' }, {}, '2d'],
      [{ a: 'hashed' }, {}, 'Hashed'],
      [{ '$**': 1 }, {}, 'Wildcard'],
      [{ a: 1, b: 1 }, {}, 'Compound'],
      [{ a: 1 }, {}, 'Single Field'],
    ])('names the kind of %j', async (key, extra, label) => {
      await show({ key, name: 'i', ...extra });
      expect(screen.getByTestId('index-kind')).toHaveTextContent(label);
    });

    it('names the fields of a text index', async () => {
      const viewer = await show({ key: { _fts: 'text', _ftsx: 1 }, name: 'i', weights: { bio: 1, title: 5 } });
      expect(viewer).toHaveTextContent('2 fields');
      expect(screen.getByText('bio')).toBeInTheDocument();
      expect(screen.getByText('title')).toBeInTheDocument();
    });

    it('hides and shows an index', async () => {
      const onSetIndexOption = vi.fn();
      await show({ key: { a: 1 }, name: 'a_1' }, { onSetIndexOption });
      fireEvent.click(screen.getByTestId('hide-index-btn'));
      expect(onSetIndexOption).toHaveBeenCalledWith('hidden', true);
    });

    it('offers to show a hidden index', async () => {
      const onSetIndexOption = vi.fn();
      await show({ key: { a: 1 }, name: 'a_1', hidden: true }, { onSetIndexOption });
      expect(screen.getByTestId('hide-index-btn')).toHaveTextContent('Unhide');
      fireEvent.click(screen.getByTestId('hide-index-btn'));
      expect(onSetIndexOption).toHaveBeenCalledWith('hidden', false);
    });

    it('offers to make a plain index unique', async () => {
      const onConvertToUnique = vi.fn();
      await show({ key: { a: 1 }, name: 'a_1' }, { onConvertToUnique });
      fireEvent.click(screen.getByTestId('convert-unique-btn'));
      expect(onConvertToUnique).toHaveBeenCalled();
    });

    it.each([
      [{ key: { a: 1 }, name: 'a_1', unique: true }],
      [{ key: { a: 'hashed' }, name: 'a_1' }],
      [{ key: { '$**': 1 }, name: 'a_1' }],
      [{ key: { _fts: 'text', _ftsx: 1 }, name: 'a_1', weights: { a: 1 } }],
    ])('does not offer unique on %j', async (document) => {
      await show(document, { onConvertToUnique: vi.fn() });
      expect(screen.queryByTestId('convert-unique-btn')).not.toBeInTheDocument();
    });

    it('offers to stop preparing an index that did not turn unique', async () => {
      const onSetIndexOption = vi.fn();
      await show({ key: { a: 1 }, name: 'a_1', prepareUnique: true }, { onSetIndexOption });
      fireEvent.click(screen.getByTestId('stop-prepare-unique-btn'));
      expect(onSetIndexOption).toHaveBeenCalledWith('prepareUnique', false);
    });

    it('has no such actions on _id_, or where the connection cannot run them', async () => {
      await show({ key: { _id: 1 }, name: '_id_' }, { onSetIndexOption: vi.fn(), onConvertToUnique: vi.fn() });
      expect(screen.queryByTestId('hide-index-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('convert-unique-btn')).not.toBeInTheDocument();
    });

    it('offers no edit for a special index without its document', async () => {
      mockInvokeByCommand({
        list_indexes: [{ name: 'a_hashed', keys: '{"a":"hashed"}', unique: false, sparse: false }],
        index_stats: [],
      });
      render(<IndexViewer {...baseProps} indexName="a_hashed" onEditIndex={vi.fn()} onDeleteIndex={vi.fn()} />);
      await screen.findByTestId('index-kind');
      expect(screen.queryByTestId('edit-index-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('delete-index-btn')).toBeInTheDocument();
    });

    it('has no such actions without their handlers', async () => {
      await show({ key: { a: 1 }, name: 'a_1' });
      expect(screen.queryByTestId('hide-index-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('convert-unique-btn')).not.toBeInTheDocument();
    });
  });
});

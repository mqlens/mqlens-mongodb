import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CollectionIndexes } from '../CollectionIndexes';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const ID = { name: '_id_', keys: '{"_id":1}', unique: false, sparse: false };
const EMAIL = { name: 'email_1', keys: '{"email":1}', unique: true, sparse: false };
const LOC = { name: 'loc_2dsphere', keys: '{"loc":"2dsphere"}', unique: false, sparse: true };
const COMPOUND = { name: 'tier_1_age_-1', keys: '{"tier":1,"age":-1}', unique: false, sparse: false };

const STATS = [
  { name: '_id_', sizeBytes: 4_096, ops: 10, sinceMs: 1_749_427_200_000 },
  { name: 'email_1', sizeBytes: 16_384, ops: 4_200, sinceMs: 1_749_427_200_000 },
  { name: 'loc_2dsphere', sizeBytes: 8_192, ops: 0, sinceMs: 1_749_427_200_000 },
  { name: 'tier_1_age_-1', sizeBytes: 32_768, ops: 7, sinceMs: 1_749_427_200_000 },
];

// Routes invoke calls by command name, as in IndexViewer.test.tsx.
const mockInvokeByCommand = (handlers: Record<string, any>) => {
  mockInvoke.mockImplementation((cmd: string) => {
    const handler = handlers[cmd];
    if (handler === undefined) return Promise.resolve([]);
    if (handler instanceof Error) return Promise.reject(handler);
    return Promise.resolve(typeof handler === 'function' ? handler() : handler);
  });
};

const baseProps = {
  connectionId: 'c1',
  databaseName: 'shop',
  collectionName: 'users',
  onOpenIndex: vi.fn(),
};

const rowNames = () =>
  screen.getAllByTestId(/^index-row-/).map((row) => row.getAttribute('data-index-name'));

describe('CollectionIndexes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists every index with keys, type, size, usage and properties', async () => {
    mockInvokeByCommand({ list_indexes: [ID, EMAIL, LOC, COMPOUND], index_stats: STATS });
    render(<CollectionIndexes {...baseProps} />);

    const email = await screen.findByTestId('index-row-email_1');
    expect(email).toHaveTextContent('email ↑');
    expect(email).toHaveTextContent('Regular');
    expect(email).toHaveTextContent('16 KB');
    expect(email).toHaveTextContent('4,200');
    expect(email).toHaveTextContent('UNIQUE');

    const loc = screen.getByTestId('index-row-loc_2dsphere');
    expect(loc).toHaveTextContent('loc 2dsphere');
    expect(loc).toHaveTextContent('2dsphere');
    expect(loc).toHaveTextContent('SPARSE');

    const compound = screen.getByTestId('index-row-tier_1_age_-1');
    expect(compound).toHaveTextContent('tier ↑');
    expect(compound).toHaveTextContent('age ↓');
    expect(compound).toHaveTextContent('Compound');

    expect(screen.getByTestId('index-row-_id_')).toHaveTextContent('DEFAULT');
    expect(mockInvoke).toHaveBeenCalledWith('list_indexes', { id: 'c1', db: 'shop', collection: 'users' });
    expect(mockInvoke).toHaveBeenCalledWith('index_stats', { id: 'c1', db: 'shop', collection: 'users' });
  });

  it('derives text, hashed and wildcard types from the keys', async () => {
    mockInvokeByCommand({
      list_indexes: [
        { name: 'bio_text', keys: '{"_fts":"text","_ftsx":1}', unique: false, sparse: false },
        { name: 'uid_hashed', keys: '{"uid":"hashed"}', unique: false, sparse: false },
        { name: '$**_1', keys: '{"$**":1}', unique: false, sparse: false },
      ],
      index_stats: [],
    });
    render(<CollectionIndexes {...baseProps} />);

    expect(await screen.findByTestId('index-row-bio_text')).toHaveTextContent('Text');
    expect(screen.getByTestId('index-row-uid_hashed')).toHaveTextContent('Hashed');
    expect(screen.getByTestId('index-row-$**_1')).toHaveTextContent('Wildcard');
  });

  it('merges stats by index name and shows a dash for an index without stats', async () => {
    mockInvokeByCommand({
      list_indexes: [EMAIL, LOC],
      index_stats: [{ name: 'email_1', sizeBytes: 16_384, ops: 4_200, sinceMs: 1_749_427_200_000 }],
    });
    render(<CollectionIndexes {...baseProps} />);

    expect(await screen.findByTestId('index-row-email_1')).toHaveTextContent('16 KB');
    const loc = screen.getByTestId('index-row-loc_2dsphere');
    expect(within(loc).getByTestId('index-size')).toHaveTextContent('—');
    expect(within(loc).getByTestId('index-usage')).toHaveTextContent('—');
  });

  it('shows usage as unavailable, not 0, when index stats cannot be read', async () => {
    mockInvokeByCommand({ list_indexes: [EMAIL], index_stats: new Error('not authorized to run $indexStats') });
    render(<CollectionIndexes {...baseProps} />);

    const row = await screen.findByTestId('index-row-email_1');
    expect(within(row).getByTestId('index-usage')).toHaveTextContent('—');
    expect(within(row).getByTestId('index-usage')).not.toHaveTextContent('0');
    expect(await screen.findByTestId('index-stats-unavailable')).toHaveTextContent('not authorized to run $indexStats');
  });

  it('shows the list_indexes error in the view', async () => {
    mockInvokeByCommand({ list_indexes: new Error('not authorized on shop to execute listIndexes') });
    render(<CollectionIndexes {...baseProps} />);

    expect(await screen.findByTestId('collection-indexes-error')).toHaveTextContent(
      'not authorized on shop to execute listIndexes'
    );
  });

  it('shows an empty state when the collection has no indexes', async () => {
    mockInvokeByCommand({ list_indexes: [], index_stats: [] });
    render(<CollectionIndexes {...baseProps} />);

    expect(await screen.findByTestId('collection-indexes-empty')).toBeInTheDocument();
  });

  it('sorts by name, size and usage', async () => {
    mockInvokeByCommand({ list_indexes: [EMAIL, ID, COMPOUND, LOC], index_stats: STATS });
    render(<CollectionIndexes {...baseProps} />);
    await screen.findByTestId('index-row-email_1');

    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(rowNames()).toEqual(['_id_', 'email_1', 'loc_2dsphere', 'tier_1_age_-1']);
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(rowNames()).toEqual(['tier_1_age_-1', 'loc_2dsphere', 'email_1', '_id_']);

    // Numbers start largest first: the question is "which index is biggest".
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(rowNames()).toEqual(['tier_1_age_-1', 'email_1', 'loc_2dsphere', '_id_']);

    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
    expect(rowNames()).toEqual(['email_1', '_id_', 'tier_1_age_-1', 'loc_2dsphere']);
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
    expect(rowNames()).toEqual(['loc_2dsphere', 'tier_1_age_-1', '_id_', 'email_1']);
  });

  it('opens the index viewer when a row is clicked', async () => {
    mockInvokeByCommand({ list_indexes: [ID, EMAIL], index_stats: STATS });
    const onOpenIndex = vi.fn();
    render(<CollectionIndexes {...baseProps} onOpenIndex={onOpenIndex} />);

    fireEvent.click(await screen.findByTestId('index-row-email_1'));
    expect(onOpenIndex).toHaveBeenCalledWith('email_1');
  });

  it('drops and edits through the shared handlers, with no drop on _id_', async () => {
    mockInvokeByCommand({ list_indexes: [ID, EMAIL, COMPOUND], index_stats: STATS });
    const onOpenIndex = vi.fn();
    const onDeleteIndex = vi.fn();
    const onEditIndex = vi.fn();
    render(
      <CollectionIndexes
        {...baseProps}
        onOpenIndex={onOpenIndex}
        onDeleteIndex={onDeleteIndex}
        onEditIndex={onEditIndex}
      />
    );
    await screen.findByTestId('index-row-email_1');

    expect(screen.queryByTestId('drop-index-_id_')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edit-index-_id_')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('drop-index-email_1'));
    expect(onDeleteIndex).toHaveBeenCalledWith('email_1');

    fireEvent.click(screen.getByTestId('edit-index-tier_1_age_-1'));
    expect(onEditIndex).toHaveBeenCalledWith('tier_1_age_-1', { tier: 1, age: -1 }, false, false);

    // Actions do not also open the row.
    expect(onOpenIndex).not.toHaveBeenCalled();
  });

  it('offers no edit for an index whose keys the editor cannot keep (2dsphere, text, hashed)', async () => {
    // Editing drops and re-creates the index from ±1 keys, so a special
    // type would come back as a plain ascending index.
    mockInvokeByCommand({
      list_indexes: [
        EMAIL,
        LOC,
        { name: 'bio_text', keys: '{"_fts":"text","_ftsx":1}', unique: false, sparse: false },
        { name: 'uid_hashed', keys: '{"uid":"hashed"}', unique: false, sparse: false },
      ],
      index_stats: [],
    });
    render(<CollectionIndexes {...baseProps} onEditIndex={vi.fn()} onDeleteIndex={vi.fn()} />);
    await screen.findByTestId('index-row-email_1');

    expect(screen.getByTestId('edit-index-email_1')).toBeInTheDocument();
    for (const name of ['loc_2dsphere', 'bio_text', 'uid_hashed']) {
      expect(screen.queryByTestId(`edit-index-${name}`)).not.toBeInTheDocument();
      expect(screen.getByTestId(`drop-index-${name}`)).toBeInTheDocument();
    }
  });

  it('hides write actions when no handler is given (blocked connection)', async () => {
    mockInvokeByCommand({ list_indexes: [EMAIL], index_stats: STATS });
    render(<CollectionIndexes {...baseProps} />);
    await screen.findByTestId('index-row-email_1');

    expect(screen.queryByTestId('drop-index-email_1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edit-index-email_1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('indexes-create-btn')).not.toBeInTheDocument();
  });

  it('opens the create modal through the shared handler', async () => {
    mockInvokeByCommand({ list_indexes: [EMAIL], index_stats: STATS });
    const onCreateIndex = vi.fn();
    render(<CollectionIndexes {...baseProps} onCreateIndex={onCreateIndex} />);

    fireEvent.click(await screen.findByTestId('indexes-create-btn'));
    expect(onCreateIndex).toHaveBeenCalled();
  });

  it('refetches when the refresh key changes', async () => {
    let list = [ID, EMAIL];
    mockInvokeByCommand({ list_indexes: () => list, index_stats: STATS });
    const { rerender } = render(<CollectionIndexes {...baseProps} refreshKey={0} />);
    await screen.findByTestId('index-row-email_1');

    list = [ID];
    rerender(<CollectionIndexes {...baseProps} refreshKey={1} />);
    await waitFor(() => expect(screen.queryByTestId('index-row-email_1')).not.toBeInTheDocument());
    expect(screen.getByTestId('index-row-_id_')).toBeInTheDocument();
  });
});

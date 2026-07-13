import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => mockInvoke(...a) }));

import { DbStatsCard, CollStatsCard, IndexStatsCard } from '../StatsCards';

const DB_STATS = {
  collections: 4,
  views: 1,
  objects: 12345,
  avgObjSize: 512.5,
  dataSize: 6324712,
  storageSize: 2502656,
  indexes: 9,
  totalIndexSize: 1105920,
};

const COLL_STATS = {
  count: 42123,
  avgObjSize: 256,
  size: 10_768_000,
  storageSize: 4_194_304,
  nindexes: 3,
  totalIndexSize: 98_304,
  capped: false,
};

const CAPPED_COLL_STATS = { ...COLL_STATS, capped: true };

const INDEX_STATS = [
  { name: '_id_', sizeBytes: 36_864, ops: 10_500, sinceMs: 1_749_427_200_000 },
  { name: 'email_1', sizeBytes: 20_480, ops: 42, sinceMs: 1_749_427_200_000 },
  { name: 'unused_1', sizeBytes: 8_192, ops: 0, sinceMs: 0 },
];

beforeEach(() => mockInvoke.mockReset());

describe('DbStatsCard', () => {
  it('renders labeled values with human sizes', async () => {
    mockInvoke.mockResolvedValue(DB_STATS);
    render(<DbStatsCard connectionId="conn-1" db="sales_db" />);
    const card = await screen.findByTestId('db-stats-card');
    expect(mockInvoke).toHaveBeenCalledWith('db_stats', { id: 'conn-1', db: 'sales_db' });

    expect(card).toHaveTextContent('Database:');
    expect(card).toHaveTextContent('sales_db');
    expect(card).toHaveTextContent('12,345');
    expect(card).toHaveTextContent('6 MB'); // dataSize
    expect(card).toHaveTextContent('9'); // indexes
  });

  it('refetches when Refresh is clicked', async () => {
    mockInvoke.mockResolvedValue(DB_STATS);
    render(<DbStatsCard connectionId="conn-1" db="sales_db" />);
    await screen.findByTestId('db-stats-card');
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    screen.getByTestId('stats-refresh').click();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'db_stats', { id: 'conn-1', db: 'sales_db' });
  });

  it('renders the error text quietly', async () => {
    mockInvoke.mockRejectedValueOnce('dbStats failed: not authorized');
    render(<DbStatsCard connectionId="conn-1" db="sales_db" />);
    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();
  });
});

describe('CollStatsCard', () => {
  it('renders the document count with locale formatting and hides Capped when false', async () => {
    mockInvoke.mockResolvedValue(COLL_STATS);
    render(<CollStatsCard connectionId="conn-1" db="sales_db" collection="orders" />);
    const card = await screen.findByTestId('coll-stats-card');
    expect(mockInvoke).toHaveBeenCalledWith('coll_stats', { id: 'conn-1', db: 'sales_db', collection: 'orders' });

    expect(card).toHaveTextContent('Collection:');
    expect(card).toHaveTextContent('sales_db.orders');
    expect(card).toHaveTextContent('42,123');
    expect(card.textContent).not.toMatch(/Capped/);
  });

  it('shows Capped: yes when the collection is capped', async () => {
    mockInvoke.mockResolvedValue(CAPPED_COLL_STATS);
    render(<CollStatsCard connectionId="conn-1" db="sales_db" collection="logs" />);
    const card = await screen.findByTestId('coll-stats-card');
    expect(card).toHaveTextContent('Capped: yes');
  });
});

describe('IndexStatsCard', () => {
  it('picks the matching index from the array and renders usage + since', async () => {
    mockInvoke.mockResolvedValue(INDEX_STATS);
    render(<IndexStatsCard connectionId="conn-1" db="sales_db" collection="orders" indexName="email_1" />);
    const card = await screen.findByTestId('index-stats-card');
    expect(mockInvoke).toHaveBeenCalledWith('index_stats', { id: 'conn-1', db: 'sales_db', collection: 'orders' });

    expect(card).toHaveTextContent('Index:');
    expect(card).toHaveTextContent('email_1 on sales_db.orders');
    expect(card).toHaveTextContent('20 KB');
    expect(card).toHaveTextContent('42 ops');
    expect(card).toHaveTextContent(new Date(1_749_427_200_000).toLocaleDateString());
  });

  it('shows the no-data-since-restart line when ops and sinceMs are both zero', async () => {
    mockInvoke.mockResolvedValue(INDEX_STATS);
    render(<IndexStatsCard connectionId="conn-1" db="sales_db" collection="orders" indexName="unused_1" />);
    const card = await screen.findByTestId('index-stats-card');
    expect(card).toHaveTextContent('Usage: n/a (no data since restart)');
    expect(card.textContent).not.toMatch(/Since:/);
  });

  it('shows a fallback message when the index is missing from the response', async () => {
    mockInvoke.mockResolvedValue(INDEX_STATS);
    render(<IndexStatsCard connectionId="conn-1" db="sales_db" collection="orders" indexName="ghost_1" />);
    const card = await screen.findByTestId('index-stats-card');
    expect(card).toHaveTextContent('No stats for this index.');
  });
});

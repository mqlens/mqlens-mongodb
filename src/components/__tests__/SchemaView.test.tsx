import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SchemaView } from '../SchemaView';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
const mockSave = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: any[]) => mockSave(...args),
}));
const mockWriteTextFile = vi.fn();
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...args: any[]) => mockWriteTextFile(...args),
}));

describe('SchemaView (M6)', () => {
  beforeEach(() => vi.clearAllMocks());

  const report = {
    sampled: 100,
    fields: [
      { path: '_id', types: [{ type: 'objectId', count: 100 }], presence: 100, coverage: 1 },
      {
        path: 'price',
        types: [
          { type: 'double', count: 98 },
          { type: 'int', count: 2 },
        ],
        presence: 100,
        coverage: 1,
      },
      { path: 'address.city', types: [{ type: 'string', count: 74 }], presence: 74, coverage: 0.74 },
    ],
  };

  it('renders the field table from analyze_schema', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify(report));
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);

    expect(await screen.findByText('address.city')).toBeInTheDocument();
    expect(screen.getByText('_id')).toBeInTheDocument();
    expect(screen.getByText('price')).toBeInTheDocument();
    // Sample size shown in the header.
    expect(screen.getByText(/sampled 100/i)).toBeInTheDocument();
    // Coverage percent rendered.
    expect(screen.getByText('74%')).toBeInTheDocument();
    // Mixed-type field shows both types.
    const priceTypes = screen.getByTestId('schema-types-price');
    expect(priceTypes).toHaveTextContent('double');
    expect(priceTypes).toHaveTextContent('int');

    expect(mockInvoke).toHaveBeenCalledWith('analyze_schema', {
      id: 'c1',
      database: 'shop',
      collection: 'products',
      sampleSize: 1000,
      first: false,
    });
  });

  it('re-samples with the chosen size and mode', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify(report));
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);
    fireEvent.change(await screen.findByTestId('schema-sample-size'), { target: { value: '250' } });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenLastCalledWith('analyze_schema', expect.objectContaining({ sampleSize: 250, first: false }))
    );
    fireEvent.change(await screen.findByTestId('schema-sample-mode'), { target: { value: 'first' } });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenLastCalledWith('analyze_schema', expect.objectContaining({ sampleSize: 250, first: true }))
    );
  });

  it("shows a field's top values when its row is clicked", async () => {
    const withValues = {
      sampled: 4,
      fields: [
        {
          path: 'tier',
          types: [{ type: 'string', count: 4 }],
          presence: 4,
          coverage: 1,
          enumValues: ['Gold', 'Silver'],
          enumCounts: { Gold: 1, Silver: 3 },
        },
      ],
    };
    mockInvoke.mockResolvedValue(JSON.stringify(withValues));
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="customers" />);
    const toggle = await screen.findByRole('button', { name: 'tier' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const values = screen.getByTestId('schema-values-tier');
    expect(values).toHaveTextContent(/Silver.*3.*75%.*Gold.*1.*25%/);
    fireEvent.click(toggle);
    expect(screen.queryByTestId('schema-values-tier')).not.toBeInTheDocument();
  });

  it('exports the schema as JSON or Markdown', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify(report));
    mockSave.mockResolvedValueOnce('C:/out/products.schema.json').mockResolvedValueOnce('C:/out/products.schema.md');
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);

    fireEvent.click(await screen.findByTestId('schema-export-json'));
    await waitFor(() => expect(mockWriteTextFile).toHaveBeenCalledTimes(1));
    expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: 'shop.products.schema.json' }));
    expect(JSON.parse(mockWriteTextFile.mock.calls[0][1])).toEqual(report);
    expect(mockWriteTextFile.mock.calls[0][0]).toBe('C:/out/products.schema.json');

    fireEvent.click(screen.getByTestId('schema-export-md'));
    await waitFor(() => expect(mockWriteTextFile).toHaveBeenCalledTimes(2));
    expect(mockWriteTextFile.mock.calls[1][0]).toBe('C:/out/products.schema.md');
    expect(mockWriteTextFile.mock.calls[1][1]).toMatch(/^# Schema of shop.products/);
  });

  it('writes nothing when the export dialog is cancelled', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify(report));
    mockSave.mockResolvedValue(null);
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);
    fireEvent.click(await screen.findByTestId('schema-export-json'));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  it('shows an error state when analysis fails', async () => {
    mockInvoke.mockRejectedValue('Sampling failed: boom');
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);
    expect(await screen.findByText(/Sampling failed/)).toBeInTheDocument();
  });

  it('shows an empty state when the collection has no documents', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify({ sampled: 0, fields: [] }));
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="empty" />);
    expect(await screen.findByText(/empty/i)).toBeInTheDocument();
  });
});

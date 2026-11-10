import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SchemaView } from '../SchemaView';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

// Monaco does not render under jsdom.
vi.mock('../QueryEditor', () => ({
  QueryEditor: ({
    value,
    onChange,
    'data-testid': testId,
  }: {
    value: string;
    onChange: (v: string) => void;
    'data-testid'?: string;
  }) => <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />,
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
    });
  });

  it('shows an error state when analysis fails', async () => {
    mockInvoke.mockRejectedValue('Sampling failed: boom');
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);
    expect(await screen.findByText(/Sampling failed/)).toBeInTheDocument();
  });

  it('shows the validation rules editor in the Validation Rules tab', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'get_collection_options'
        ? Promise.resolve({ validator: '{}', validationLevel: '', validationAction: '' })
        : Promise.resolve(JSON.stringify(report))
    );
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);

    fireEvent.mouseDown(await screen.findByTestId('schema-tab-validation'), { button: 0 });

    expect(await screen.findByTestId('validation-rules-view')).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('get_collection_options', {
      id: 'c1',
      database: 'shop',
      collection: 'products',
    });
  });

  it('keeps a validator draft across a switch to Field Analysis and back', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'get_collection_options'
        ? Promise.resolve({ validator: '{}', validationLevel: '', validationAction: '' })
        : Promise.resolve(JSON.stringify(report))
    );
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="products" />);
    fireEvent.mouseDown(await screen.findByTestId('schema-tab-validation'), { button: 0 });
    const editor = (await screen.findByTestId('validation-editor')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '{"draft":1}' } });

    fireEvent.mouseDown(screen.getByTestId('schema-tab-fields'), { button: 0 });
    fireEvent.mouseDown(screen.getByTestId('schema-tab-validation'), { button: 0 });

    expect((screen.getByTestId('validation-editor') as HTMLTextAreaElement).value).toBe('{"draft":1}');
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === 'get_collection_options')).toHaveLength(1);
  });

  it('shows an empty state when the collection has no documents', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify({ sampled: 0, fields: [] }));
    render(<SchemaView connectionId="c1" databaseName="shop" collectionName="empty" />);
    expect(await screen.findByText(/empty/i)).toBeInTheDocument();
  });
});

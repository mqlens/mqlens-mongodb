import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render-with-providers';
import { ValidationRulesView } from '../ValidationRulesView';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

vi.mock('../QueryEditor', () => ({
  QueryEditor: ({
    value,
    onChange,
    'data-testid': testId,
  }: {
    value: string;
    onChange: (v: string) => void;
    'data-testid'?: string;
  }) => (
    <textarea
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

describe('ValidationRulesView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads existing rules on mount', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_collection_options') {
        return Promise.resolve({
          validator: '{"$jsonSchema":{"bsonType":"object"}}',
          validationLevel: 'moderate',
          validationAction: 'warn',
        });
      }
      return Promise.reject(new Error(`unhandled ${cmd}`));
    });

    renderWithProviders(
      <ValidationRulesView
        connectionId="c1"
        databaseName="shop"
        collectionName="customers"
        onApplied={() => {}}
      />
    );

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('get_collection_options', {
        id: 'c1',
        database: 'shop',
        collection: 'customers',
      })
    );

    const editor = await screen.findByTestId('validation-editor');
    expect(editor).toHaveValue('{"$jsonSchema":{"bsonType":"object"}}');
    expect(screen.getByTestId('validation-level-select')).toHaveTextContent('moderate');
    expect(screen.getByTestId('validation-action-select')).toHaveTextContent('warn');
  });

  it('rejects invalid validator JSON before calling set_validator', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_collection_options') {
        return Promise.resolve({ validator: '{}', validationLevel: '', validationAction: '' });
      }
      return Promise.resolve();
    });

    renderWithProviders(
      <ValidationRulesView
        connectionId="c1"
        databaseName="shop"
        collectionName="customers"
        onApplied={() => {}}
      />
    );

    const editor = await screen.findByTestId('validation-editor');
    fireEvent.change(editor, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByTestId('validation-apply-btn'));

    expect(await screen.findByTestId('validation-error')).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith('set_validator', expect.anything());
  });

  it('applies rules via set_validator with the exact payload and calls onApplied', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_collection_options') {
        return Promise.resolve({ validator: '{}', validationLevel: '', validationAction: '' });
      }
      if (cmd === 'set_validator') return Promise.resolve();
      return Promise.reject(new Error(`unhandled ${cmd}`));
    });

    const onApplied = vi.fn();
    renderWithProviders(
      <ValidationRulesView
        connectionId="c1"
        databaseName="shop"
        collectionName="customers"
        onApplied={onApplied}
      />
    );

    const editor = await screen.findByTestId('validation-editor');
    fireEvent.change(editor, {
      target: { value: '{"$jsonSchema":{"bsonType":"object"}}' },
    });

    fireEvent.click(screen.getByTestId('validation-level-select'));
    fireEvent.click(screen.getByRole('option', { name: 'strict' }));
    fireEvent.click(screen.getByTestId('validation-action-select'));
    fireEvent.click(screen.getByRole('option', { name: 'error' }));

    fireEvent.click(screen.getByTestId('validation-apply-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('set_validator', {
        id: 'c1',
        database: 'shop',
        collection: 'customers',
        validator: '{"$jsonSchema":{"bsonType":"object"}}',
        validationLevel: 'strict',
        validationAction: 'error',
      })
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalled());

    expect(await screen.findByTestId('validation-success')).toBeInTheDocument();

    fireEvent.change(editor, {
      target: { value: '{"$jsonSchema":{"bsonType":"object","required":["email"]}}' },
    });

    expect(screen.queryByTestId('validation-success')).not.toBeInTheDocument();
  });

  it('applies an empty validator to clear validation rules', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_collection_options') {
        return Promise.resolve({
          validator: '{"$jsonSchema":{"bsonType":"object"}}',
          validationLevel: 'strict',
          validationAction: 'error',
        });
      }
      if (cmd === 'set_validator') return Promise.resolve();
      return Promise.reject(new Error(`unhandled ${cmd}`));
    });

    const onApplied = vi.fn();
    renderWithProviders(
      <ValidationRulesView
        connectionId="c1"
        databaseName="shop"
        collectionName="customers"
        onApplied={onApplied}
      />
    );

    const editor = await screen.findByTestId('validation-editor');
    fireEvent.change(editor, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('validation-apply-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('set_validator', {
        id: 'c1',
        database: 'shop',
        collection: 'customers',
        validator: '',
        validationLevel: 'strict',
        validationAction: 'error',
      })
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });
});

describe('ValidationRulesView validator tools', () => {
  beforeEach(() => vi.clearAllMocks());

  const renderView = () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_collection_options') {
        return Promise.resolve({ validator: '{}', validationLevel: '', validationAction: '' });
      }
      if (cmd === 'analyze_schema') {
        return Promise.resolve(
          JSON.stringify({
            sampled: 2,
            fields: [
              { path: '_id', types: [{ type: 'objectId', count: 2 }], presence: 2, coverage: 1 },
              { path: 'name', types: [{ type: 'string', count: 1 }], presence: 1, coverage: 0.5 },
            ],
          })
        );
      }
      return Promise.reject(new Error(`unhandled ${cmd}`));
    });
    renderWithProviders(
      <ValidationRulesView connectionId="c1" databaseName="shop" collectionName="customers" onApplied={() => {}} />
    );
    return screen.findByTestId('validation-editor') as Promise<HTMLTextAreaElement>;
  };

  it('Validate JSON reports a syntax error without applying', async () => {
    const editor = await renderView();
    fireEvent.change(editor, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByTestId('validation-check-btn'));

    expect(await screen.findByTestId('validation-error')).toHaveTextContent(/Invalid validator JSON/);
    expect(mockInvoke).not.toHaveBeenCalledWith('set_validator', expect.anything());
  });

  it('Validate JSON confirms a valid validator without applying', async () => {
    const editor = await renderView();
    fireEvent.change(editor, { target: { value: '{"$jsonSchema":{"bsonType":"object"}}' } });
    fireEvent.click(screen.getByTestId('validation-check-btn'));

    expect(await screen.findByTestId('validation-valid')).toBeInTheDocument();
    expect(screen.queryByTestId('validation-error')).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith('set_validator', expect.anything());
  });

  it('generates a $jsonSchema validator from a schema sample', async () => {
    const editor = await renderView();
    fireEvent.click(screen.getByTestId('validation-generate-btn'));

    await waitFor(() =>
      expect(JSON.parse(editor.value)).toEqual({
        $jsonSchema: {
          bsonType: 'object',
          required: ['_id'],
          properties: { _id: { bsonType: 'objectId' }, name: { bsonType: 'string' } },
        },
      })
    );
    expect(mockInvoke).toHaveBeenCalledWith('analyze_schema', {
      id: 'c1',
      database: 'shop',
      collection: 'customers',
      sampleSize: 1000,
    });
  });
});

describe('ValidationRulesView generate race', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not overwrite what was typed while the sample was being taken', async () => {
    let finishSample: (json: string) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_collection_options') {
        return Promise.resolve({ validator: '{}', validationLevel: '', validationAction: '' });
      }
      if (cmd === 'analyze_schema') return new Promise<string>((resolve) => { finishSample = resolve; });
      return Promise.reject(new Error(`unhandled ${cmd}`));
    });
    renderWithProviders(
      <ValidationRulesView connectionId="c1" databaseName="shop" collectionName="customers" onApplied={() => {}} />
    );
    const editor = (await screen.findByTestId('validation-editor')) as HTMLTextAreaElement;

    fireEvent.click(screen.getByTestId('validation-generate-btn'));
    fireEvent.change(editor, { target: { value: '{"typed":true}' } });
    finishSample(JSON.stringify({ sampled: 1, fields: [{ path: 'a', types: [{ type: 'int', count: 1 }], presence: 1, coverage: 1 }] }));

    await waitFor(() => expect(screen.getByTestId('validation-generate-btn')).not.toBeDisabled());
    expect(editor.value).toBe('{"typed":true}');
  });
});

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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IndexModal } from '../IndexModal';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('IndexModal Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(JSON.stringify({ sampled: 2, fields: [] }));
  });
  it('does not render when isOpen is false', () => {
    render(
      <IndexModal
        isOpen={false}
        onClose={() => {}}
        onSave={() => {}}
        availableFields={['_id', 'name', 'age']}
      />
    );
    expect(screen.queryByTestId('index-modal')).not.toBeInTheDocument();
  });

  it('renders correctly when isOpen is true in creation mode', () => {
    const handleClose = vi.fn();
    render(
      <IndexModal
        isOpen={true}
        onClose={handleClose}
        onSave={() => {}}
        availableFields={['_id', 'name', 'age']}
      />
    );

    expect(screen.getByTestId('index-modal')).toBeInTheDocument();
    expect(screen.getByText('Create New Index')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. email_1_status_-1')).toBeInTheDocument();

    // Default key builder row
    expect(screen.getByTestId('index-key-field-0')).toHaveValue('_id');
    expect(screen.getByTestId('index-key-direction-0')).toHaveValue('1');

    // Default constraints
    const uniqueCheckbox = screen.getByTestId('unique-checkbox') as HTMLInputElement;
    const sparseCheckbox = screen.getByTestId('sparse-checkbox') as HTMLInputElement;
    expect(uniqueCheckbox.checked).toBe(false);
    expect(sparseCheckbox.checked).toBe(false);

    // Close button
    const closeBtn = screen.getByLabelText('Close modal');
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('auto-generates the index name from keys until manually overridden', () => {
    render(
      <IndexModal isOpen={true} onClose={() => {}} onSave={() => {}} availableFields={['_id', 'email', 'status']} />
    );
    const nameInput = screen.getByTestId('index-name-input') as HTMLInputElement;

    // Default _id:1 key → Mongo-convention name.
    expect(nameInput.value).toBe('_id_1');

    // Changing the key field/direction regenerates the name.
    fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: 'email' } });
    expect(nameInput.value).toBe('email_1');
    fireEvent.change(screen.getByTestId('index-key-direction-0'), { target: { value: '-1' } });
    expect(nameInput.value).toBe('email_-1');

    // A manually typed name sticks…
    fireEvent.change(nameInput, { target: { value: 'my_custom_name' } });
    fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: 'status' } });
    expect(nameInput.value).toBe('my_custom_name');

    // …and clearing it resumes auto-generation.
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(nameInput.value).toBe('status_-1');
  });

  it('pre-populates data correctly in edit mode', () => {
    const initialData = {
      name: 'age_index',
      keys: { age: -1, status: 1 },
      unique: true,
      sparse: false,
    };

    render(
      <IndexModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        availableFields={['_id', 'name', 'age', 'status']}
        initialData={initialData}
      />
    );

    expect(screen.getByText('Edit Index definition')).toBeInTheDocument();
    expect(screen.getByDisplayValue('age_index')).toBeInTheDocument();

    // Verify key builder rows
    expect(screen.getByTestId('index-key-field-0')).toHaveValue('age');
    expect(screen.getByTestId('index-key-direction-0')).toHaveValue('-1');
    expect(screen.getByTestId('index-key-field-1')).toHaveValue('status');
    expect(screen.getByTestId('index-key-direction-1')).toHaveValue('1');

    // Constraints
    const uniqueCheckbox = screen.getByTestId('unique-checkbox') as HTMLInputElement;
    const sparseCheckbox = screen.getByTestId('sparse-checkbox') as HTMLInputElement;
    expect(uniqueCheckbox.checked).toBe(true);
    expect(sparseCheckbox.checked).toBe(false);
  });

  it('handles adding and removing key rows in builder mode', () => {
    render(
      <IndexModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        availableFields={['_id', 'name', 'age']}
      />
    );

    // Starts with 1 row (_id)
    expect(screen.getAllByTestId(/^index-key-field-/)).toHaveLength(1);

    // Add row
    const addBtn = screen.getByRole('button', { name: /add index key/i });
    fireEvent.click(addBtn);

    // Now has 2 rows
    expect(screen.getAllByTestId(/^index-key-field-/)).toHaveLength(2);
    // Auto-picks next field (e.g. name)
    expect(screen.getByTestId('index-key-field-1')).toHaveValue('age');

    // Remove row
    const deleteBtns = screen.getAllByTitle('Remove Key');
    fireEvent.click(deleteBtns[1]);

    // Back to 1 row
    expect(screen.getAllByTestId(/^index-key-field-/)).toHaveLength(1);
  });

  it('handles raw JSON mode toggle and validation', () => {
    const handleSave = vi.fn();
    render(
      <IndexModal
        isOpen={true}
        onClose={() => {}}
        onSave={handleSave}
        availableFields={['_id', 'name', 'age']}
      />
    );

    // Toggle to raw mode
    const toggleBtn = screen.getByText('Raw JSON');
    fireEvent.click(toggleBtn);

    expect(screen.getByPlaceholderText('{ "email": 1 }')).toBeInTheDocument();

    // Type invalid JSON
    const nameInput = screen.getByTestId('index-name-input');
    fireEvent.change(nameInput, { target: { value: 'custom_raw' } });

    const textarea = screen.getByPlaceholderText('{ "email": 1 }');
    fireEvent.change(textarea, { target: { value: 'invalid-json' } });

    // Submit
    const submitBtn = screen.getByTestId('save-index-btn');
    fireEvent.click(submitBtn);

    // Verify error is shown
    expect(screen.getByText(/is not valid JSON/i)).toBeInTheDocument();
    expect(handleSave).not.toHaveBeenCalled();

    // Type valid JSON with wrong direction
    fireEvent.change(textarea, { target: { value: '{ "email": 2 }' } });
    fireEvent.click(submitBtn);
    expect(screen.getByText(/Index direction for "email" must be 1 \(Ascending\) or -1 \(Descending\)/i)).toBeInTheDocument();
    expect(handleSave).not.toHaveBeenCalled();

    // Type valid JSON and submit
    fireEvent.change(textarea, { target: { value: '{ "email": 1, "age": -1 }' } });
    fireEvent.click(submitBtn);
    expect(handleSave).toHaveBeenCalledWith(
      'custom_raw',
      '{"email":1,"age":-1}',
      false,
      false
    );
  });

  it('loads collection schema fields into the key field list', async () => {
    mockInvoke.mockResolvedValue(
      JSON.stringify({
        sampled: 10,
        fields: [
          { path: 'email', types: [{ type: 'string', count: 10 }] },
          { path: 'profile.city', types: [{ type: 'string', count: 8 }] },
        ],
      })
    );

    render(
      <IndexModal
        isOpen={true}
        onClose={() => {}}
        onSave={() => {}}
        connectionId="conn-1"
        databaseName="testdb"
        collectionName="users"
      />
    );

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('analyze_schema', expect.objectContaining({
        id: 'conn-1',
        database: 'testdb',
        collection: 'users',
      }));
    });

    const fieldSelect = screen.getByTestId('index-key-field-0') as HTMLSelectElement;
    const optionValues = Array.from(fieldSelect.options).map((o) => o.value);
    expect(optionValues).toContain('email');
    expect(optionValues).toContain('profile.city');
    expect(optionValues[0]).toBe('_id');
  });

  it('submits form with builder data on Save', () => {
    const handleSave = vi.fn();
    render(
      <IndexModal
        isOpen={true}
        onClose={() => {}}
        onSave={handleSave}
        availableFields={['_id', 'name', 'age']}
      />
    );

    const nameInput = screen.getByTestId('index-name-input');
    fireEvent.change(nameInput, { target: { value: 'name_asc' } });

    const fieldInput = screen.getByTestId('index-key-field-0');
    fireEvent.change(fieldInput, { target: { value: 'name' } });

    const uniqueCheckbox = screen.getByTestId('unique-checkbox');
    fireEvent.click(uniqueCheckbox);

    const submitBtn = screen.getByTestId('save-index-btn');
    fireEvent.click(submitBtn);

    expect(handleSave).toHaveBeenCalledWith(
      'name_asc',
      '{"name":1}',
      true,
      false
    );
  });
});

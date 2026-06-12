import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IndexModal } from '../IndexModal';

describe('IndexModal Component', () => {
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
    expect(screen.getByDisplayValue('_id')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ascending (1)')).toBeInTheDocument();

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
      <IndexModal isOpen={true} onClose={() => {}} onSave={() => {}} availableFields={['_id', 'email']} />
    );
    const nameInput = screen.getByTestId('index-name-input') as HTMLInputElement;

    // Default _id:1 key → Mongo-convention name.
    expect(nameInput.value).toBe('_id_1');

    // Changing the key field/direction regenerates the name.
    fireEvent.change(screen.getByPlaceholderText('Field name'), { target: { value: 'email' } });
    expect(nameInput.value).toBe('email_1');
    fireEvent.change(screen.getByDisplayValue('Ascending (1)'), { target: { value: '-1' } });
    expect(nameInput.value).toBe('email_-1');

    // A manually typed name sticks…
    fireEvent.change(nameInput, { target: { value: 'my_custom_name' } });
    fireEvent.change(screen.getByDisplayValue('email'), { target: { value: 'status' } });
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
    expect(screen.getByDisplayValue('age')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Descending (-1)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('status')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ascending (1)')).toBeInTheDocument();

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
    expect(screen.getAllByPlaceholderText('Field name')).toHaveLength(1);

    // Add row
    const addBtn = screen.getByRole('button', { name: /add index key/i });
    fireEvent.click(addBtn);

    // Now has 2 rows
    expect(screen.getAllByPlaceholderText('Field name')).toHaveLength(2);
    // Auto-picks next field (e.g. name)
    expect(screen.getByDisplayValue('name')).toBeInTheDocument();

    // Remove row
    const deleteBtns = screen.getAllByTitle('Remove Key');
    fireEvent.click(deleteBtns[1]);

    // Back to 1 row
    expect(screen.getAllByPlaceholderText('Field name')).toHaveLength(1);
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

    const fieldInput = screen.getByPlaceholderText('Field name');
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

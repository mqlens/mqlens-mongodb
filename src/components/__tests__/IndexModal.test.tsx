import type React from 'react';
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
      key: { age: -1, status: 1 },
      unique: true,
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
    expect(screen.getByText('Index type for "email" must be 1, -1, "text", "2dsphere", "2d" or "hashed"')).toBeInTheDocument();
    expect(handleSave).not.toHaveBeenCalled();

    // Type valid JSON and submit
    fireEvent.change(textarea, { target: { value: '{ "email": 1, "age": -1 }' } });
    fireEvent.click(submitBtn);
    expect(handleSave).toHaveBeenCalledWith({ key: { email: 1, age: -1 }, name: 'custom_raw' }, null);
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

    // Waited on the options themselves, not just on the call being made. The
    // call having been issued says nothing about its promise having resolved
    // and the state having been committed, so reading the list straight after
    // was a race the test lost whenever CI was loaded enough.
    const optionsNow = () => {
      const select = screen.getByTestId('index-key-field-0') as HTMLSelectElement;
      return Array.from(select.options).map((o) => o.value);
    };
    await waitFor(() => expect(optionsNow()).toContain('email'));

    const optionValues = optionsNow();
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

    expect(handleSave).toHaveBeenCalledWith({ key: { name: 1 }, name: 'name_asc', unique: true }, null);
  });

  describe('TTL', () => {
    const renderCreate = (onSave = vi.fn()) => {
      render(
        <IndexModal isOpen={true} onClose={() => {}} onSave={onSave} availableFields={['_id', 'createdAt', 'status']} />
      );
      return onSave;
    };
    const enableTtl = (seconds: string) => {
      fireEvent.click(screen.getByTestId('ttl-checkbox'));
      fireEvent.change(screen.getByTestId('ttl-seconds-input'), { target: { value: seconds } });
    };

    it('is off by default and saves no expiry', () => {
      const onSave = renderCreate();
      expect((screen.getByTestId('ttl-checkbox') as HTMLInputElement).checked).toBe(false);
      expect(screen.getByTestId('ttl-seconds-input')).toBeDisabled();
      fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: 'createdAt' } });
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave).toHaveBeenCalledWith({ key: { createdAt: 1 }, name: 'createdAt_1' }, null);
    });

    it('saves the expiry of a single-field index', () => {
      const onSave = renderCreate();
      fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: 'createdAt' } });
      enableTtl('86400');
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave).toHaveBeenCalledWith({ key: { createdAt: 1 }, name: 'createdAt_1', expireAfterSeconds: 86400 }, null);
    });

    it('refuses a compound index, _id, and an expiry out of range', () => {
      const onSave = renderCreate();
      enableTtl('60');
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(screen.getByText('A TTL index cannot be on _id')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: 'createdAt' } });
      fireEvent.click(screen.getByText('Add Index Key'));
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(screen.getByText('A TTL index must have exactly one key field')).toBeInTheDocument();
      fireEvent.click(screen.getAllByTitle('Remove Key')[1]);

      for (const bad of ['-1', '1.5', '2147483648', '']) {
        fireEvent.change(screen.getByTestId('ttl-seconds-input'), { target: { value: bad } });
        fireEvent.click(screen.getByTestId('save-index-btn'));
        expect(screen.getByText('Expire after seconds must be a whole number from 0 to 2147483647')).toBeInTheDocument();
      }
      expect(onSave).not.toHaveBeenCalled();

      fireEvent.change(screen.getByTestId('ttl-seconds-input'), { target: { value: '2147483647' } });
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave).toHaveBeenCalledWith({ key: { createdAt: 1 }, name: 'createdAt_1', expireAfterSeconds: 2147483647 }, null);
    });

    it('starts from the expiry of the index it edits', () => {
      render(
        <IndexModal
          isOpen={true}
          onClose={() => {}}
          onSave={() => {}}
          initialData={{ name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 3600 }}
        />
      );
      expect((screen.getByTestId('ttl-checkbox') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByTestId('ttl-seconds-input')).toHaveValue(3600);
    });
  });

  describe('key types', () => {
    const open = (onSave = vi.fn()) => {
      render(<IndexModal isOpen={true} onClose={() => {}} onSave={onSave} availableFields={['_id', 'title', 'loc']} />);
      fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: 'title' } });
      return onSave;
    };
    const type = (value: string) =>
      fireEvent.change(screen.getByTestId('index-key-direction-0'), { target: { value } });

    it('offers every key type', () => {
      open();
      const select = screen.getByTestId('index-key-direction-0') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['1', '-1', 'text', '2dsphere', '2d', 'hashed']);
    });

    it.each(['text', '2dsphere', '2d', 'hashed'])('saves a %s key under its own name', (value) => {
      const onSave = open();
      type(value);
      expect(screen.getByTestId('index-name-input')).toHaveValue(`title_${value}`);
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave).toHaveBeenCalledWith({ key: { title: value }, name: `title_${value}` }, null);
    });

    it('takes a wildcard from the field list', () => {
      const onSave = open();
      fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: '$**' } });
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave).toHaveBeenCalledWith({ key: { '$**': 1 }, name: '$**_1' }, null);
    });

    it('takes a path wildcard typed by hand, and keeps it through raw JSON', () => {
      const onSave = open();
      fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: '__custom__' } });
      fireEvent.change(screen.getByTestId('index-key-field-0'), { target: { value: 'tags.$**' } });
      fireEvent.click(screen.getByText('Raw JSON'));
      fireEvent.click(screen.getByText('Key Builder'));
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave).toHaveBeenCalledWith({ key: { 'tags.$**': 1 }, name: 'tags.$**_1' }, null);
    });

    it('takes every type in raw JSON and back', () => {
      const onSave = open();
      fireEvent.click(screen.getByText('Raw JSON'));
      fireEvent.change(screen.getByPlaceholderText('{ "email": 1 }'), {
        target: { value: '{ "a": 1, "b": -1, "t": "text", "l": "2dsphere" }' },
      });
      fireEvent.click(screen.getByText('Key Builder'));
      expect(screen.getByTestId('index-key-direction-2')).toHaveValue('text');
      expect(screen.getByTestId('index-key-direction-3')).toHaveValue('2dsphere');
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave.mock.calls[0][0].key).toEqual({ a: 1, b: -1, t: 'text', l: '2dsphere' });
    });
  });

  describe('options', () => {
    const open = (keys: Record<string, unknown>, props: Partial<React.ComponentProps<typeof IndexModal>> = {}) => {
      const onSave = vi.fn();
      render(
        <IndexModal
          isOpen={true}
          onClose={() => {}}
          onSave={onSave}
          prefill={{ name: 'i', keys: keys as Record<string, number> }}
          {...props}
        />
      );
      return onSave;
    };
    const fill = (option: string, value: string) =>
      fireEvent.change(screen.getByTestId(`index-option-${option}`), { target: { value } });
    const save = () => fireEvent.click(screen.getByTestId('save-index-btn'));

    it('shows the options of a type only with that type', () => {
      open({ a: 1 });
      for (const option of ['partialFilterExpression', 'collation', 'storageEngine']) {
        expect(screen.getByTestId(`index-option-${option}`)).toBeInTheDocument();
      }
      for (const option of ['weights', 'defaultLanguage', 'languageOverride', 'textIndexVersion', 'sphereIndexVersion', 'bits', 'min', 'max', 'wildcardProjection']) {
        expect(screen.queryByTestId(`index-option-${option}`)).not.toBeInTheDocument();
      }
      fireEvent.change(screen.getByTestId('index-key-direction-0'), { target: { value: 'text' } });
      expect(screen.getByTestId('index-option-weights')).toBeInTheDocument();
      expect(screen.getByTestId('index-option-defaultLanguage')).toBeInTheDocument();
      fireEvent.change(screen.getByTestId('index-key-direction-0'), { target: { value: '2d' } });
      expect(screen.queryByTestId('index-option-weights')).not.toBeInTheDocument();
      expect(screen.getByTestId('index-option-bits')).toBeInTheDocument();
      fireEvent.change(screen.getByTestId('index-key-direction-0'), { target: { value: '2dsphere' } });
      expect(screen.getByTestId('index-option-sphereIndexVersion')).toBeInTheDocument();
    });

    it('saves the general options', () => {
      const onSave = open({ a: 1 });
      fireEvent.click(screen.getByTestId('hidden-checkbox'));
      fill('partialFilterExpression', '{ "a": { "$gt": 1 } }');
      fill('collation', '{ "locale": "de" }');
      fill('storageEngine', '{ "wiredTiger": {} }');
      save();
      expect(onSave).toHaveBeenCalledWith(
        {
          key: { a: 1 },
          name: 'i',
          hidden: true,
          partialFilterExpression: { a: { $gt: 1 } },
          collation: { locale: 'de' },
          storageEngine: { wiredTiger: {} },
        },
        null
      );
    });

    it('saves the options of a text index', () => {
      const onSave = open({ a: 'text' });
      fill('weights', '{ "a": 5 }');
      fill('defaultLanguage', 'german');
      fill('languageOverride', 'lang');
      fill('textIndexVersion', '3');
      save();
      expect(onSave.mock.calls[0][0]).toEqual({
        key: { a: 'text' }, name: 'i', weights: { a: 5 }, default_language: 'german',
        language_override: 'lang', textIndexVersion: 3,
      });
    });

    it('saves the options of geo and wildcard indexes', () => {
      const onSave = open({ a: '2d' });
      fill('bits', '20');
      fill('min', '-10');
      fill('max', '100');
      save();
      expect(onSave.mock.calls[0][0]).toEqual({ key: { a: '2d' }, name: 'i', bits: 20, min: -10, max: 100 });
    });

    it('saves a wildcard projection', () => {
      const onSave = open({ '$**': 1 });
      fill('wildcardProjection', '{ "a": 1 }');
      save();
      expect(onSave.mock.calls[0][0]).toEqual({ key: { '$**': 1 }, name: 'i', wildcardProjection: { a: 1 } });
    });

    it('says what is wrong, and saves nothing', () => {
      const onSave = open({ a: 1 });
      fill('collation', 'nope');
      save();
      expect(screen.getByText('collation must be a JSON object')).toBeInTheDocument();
      fill('collation', '');
      fireEvent.click(screen.getByTestId('sparse-checkbox'));
      fill('partialFilterExpression', '{ "a": 1 }');
      save();
      expect(screen.getByText('A partial filter cannot be used with sparse')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('sparse-checkbox'));
      fill('partialFilterExpression', '{ "a": { "$ne": 1 } }');
      save();
      expect(screen.getByText('A partial filter cannot use $ne')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it.each([
      [{ a: 'hashed', b: 'hashed' }, {}, 'A hashed index can hash only one field'],
      [{ a: 'hashed' }, { unique: true }, 'A hashed index cannot be unique'],
      [{ '$**': 1 }, { unique: true }, 'A wildcard index cannot be unique'],
      [{ '$**': 1 }, { sparse: true }, 'A wildcard index cannot be sparse'],
      [{ 'a.$**': 1 }, { ttl: true }, 'A wildcard index cannot have a TTL'],
      [{ b: 1, '$**': 1 }, {}, 'A compound wildcard index on all fields needs a wildcard projection'],
      [{ a: 'text' }, { collation: true }, 'Text and 2d indexes cannot have a collation'],
    ])('refuses %j %j', (keys, flags: { unique?: boolean; sparse?: boolean; ttl?: boolean; collation?: boolean }, message) => {
      const onSave = open(keys);
      if (flags.unique) fireEvent.click(screen.getByTestId('unique-checkbox'));
      if (flags.sparse) fireEvent.click(screen.getByTestId('sparse-checkbox'));
      if (flags.ttl) {
        fireEvent.click(screen.getByTestId('ttl-checkbox'));
        fireEvent.change(screen.getByTestId('ttl-seconds-input'), { target: { value: '60' } });
      }
      if (flags.collation) fill('collation', '{ "locale": "en" }');
      save();
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('refuses a number that is not one, a projection on a path, and $exists: false', () => {
      const onSave = open({ a: '2d' });
      fill('bits', 'many');
      save();
      expect(screen.getByText('bits must be a number')).toBeInTheDocument();
      fill('bits', '');
      fill('partialFilterExpression', '{ "a": { "$exists": false } }');
      save();
      expect(screen.getByText('A partial filter can only use $exists: true')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('sends a commit quorum where the connection can', () => {
      const onSave = open({ a: 1 }, { allowCommitQuorum: true });
      fireEvent.change(screen.getByTestId('index-commit-quorum'), { target: { value: ' majority ' } });
      save();
      expect(onSave).toHaveBeenCalledWith({ key: { a: 1 }, name: 'i' }, 'majority');
    });

    it('does not offer a commit quorum where the connection cannot', () => {
      open({ a: 1 }, { allowCommitQuorum: false });
      expect(screen.queryByTestId('index-commit-quorum')).not.toBeInTheDocument();
    });

    it('starts an edit from the document, keeping what it has no field for', () => {
      const onSave = vi.fn();
      render(
        <IndexModal
          isOpen={true}
          onClose={() => {}}
          onSave={onSave}
          initialData={{
            v: 2, key: { b: 1, _fts: 'text', _ftsx: 1 }, name: 'txt', weights: { t: 5, z: 1 },
            default_language: 'german', textIndexVersion: 3, hidden: true, future: { x: 1 },
          }}
        />
      );
      expect(screen.getByTestId('index-key-field-1')).toHaveValue('t');
      expect(screen.getByTestId('index-key-direction-1')).toHaveValue('text');
      expect(screen.getByTestId('index-key-direction-2')).toHaveValue('text');
      expect(screen.getByTestId('index-option-defaultLanguage')).toHaveValue('german');
      expect(screen.getByTestId('hidden-checkbox')).toBeChecked();
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(onSave).toHaveBeenCalledWith(
        {
          key: { b: 1, t: 'text', z: 'text' }, name: 'txt', weights: { t: 5, z: 1 },
          default_language: 'german', textIndexVersion: 3, hidden: true, future: { x: 1 },
        },
        null
      );
    });

    it('says when a text weight names a field the keys no longer have', () => {
      const onSave = vi.fn();
      render(
        <IndexModal
          isOpen={true}
          onClose={() => {}}
          onSave={onSave}
          initialData={{ key: { _fts: 'text', _ftsx: 1 }, name: 'i', weights: { body: 1, title: 1 } }}
        />
      );
      fireEvent.click(screen.getAllByTitle('Remove Key')[0]);
      fireEvent.click(screen.getByTestId('save-index-btn'));
      expect(screen.getByText('Text weights name body, which is not a text key')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('cannot save twice while a save runs', () => {
      render(<IndexModal isOpen={true} onClose={() => {}} onSave={() => {}} saving={true} />);
      expect(screen.getByTestId('save-index-btn')).toBeDisabled();
    });

    it('says an edit rebuilds the index', () => {
      const { rerender } = render(<IndexModal isOpen={true} onClose={() => {}} onSave={() => {}} />);
      expect(screen.queryByTestId('index-rebuild-hint')).not.toBeInTheDocument();
      rerender(<IndexModal isOpen={true} onClose={() => {}} onSave={() => {}} initialData={{ key: { a: 1 }, name: 'a_1' }} />);
      expect(screen.getByTestId('index-rebuild-hint')).toBeInTheDocument();
    });
  });
});

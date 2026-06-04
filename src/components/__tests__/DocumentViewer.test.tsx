import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { DocumentViewer, builderStateToQuery } from '../DocumentViewer';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

// Monaco does not render a usable DOM under jsdom. The aggregation stage editor
// (QueryEditor) wraps @monaco-editor/react, so mock it with a plain <textarea>
// that round-trips value/onChange — this keeps the existing stage tests, which
// drive `pipeline-stage-N textarea`, working against the real component shape.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

describe('DocumentViewer Component', () => {
  const mockOnExecute = vi.fn();
  const mockOnExecuteAggregate = vi.fn();
  const mockOnExplain = vi.fn();
  const mockOnExplainAggregate = vi.fn().mockResolvedValue('{}');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders breadcrumbs and query inputs correctly', () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    // Verify breadcrumbs
    expect(screen.getByText('cmi-dev-devesh')).toBeInTheDocument();
    expect(screen.getByText(/test-conn/)).toBeInTheDocument();
    expect(screen.getByText('test-db')).toBeInTheDocument();
    expect(screen.getByText('test-coll')).toBeInTheDocument();

    // Verify labels
    expect(screen.getByText('Query')).toBeInTheDocument();
    expect(screen.getByText('Projection')).toBeInTheDocument();
    expect(screen.getByText('Sort')).toBeInTheDocument();
    expect(screen.getByText('Skip')).toBeInTheDocument();
    expect(screen.getByText('Limit')).toBeInTheDocument();
  });

  it('renders Export/Import in the top toolbar and fires their handlers', () => {
    const onOpenExport = vi.fn();
    const onImport = vi.fn();
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        onOpenExport={onOpenExport}
        onImport={onImport}
        loading={false}
      />
    );

    fireEvent.click(screen.getByTestId('export-btn'));
    expect(onOpenExport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('import-btn'));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('performs JSON validation on typing', async () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    const filterInput = screen.getByTestId('query-filter-input');
    
    // Type invalid JSON
    fireEvent.change(filterInput, { target: { value: '{invalid' } });
    await waitFor(() => {
      expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
    });

    // Fix to valid JSON
    fireEvent.change(filterInput, { target: { value: '{"key": "value"}' } });
    await waitFor(() => {
      expect(screen.queryByText('Invalid JSON')).not.toBeInTheDocument();
    });
  });

  it('submits valid queries on clicking Run button', () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    // Click execute
    const runBtn = screen.getByRole('button', { name: 'Run' });
    fireEvent.click(runBtn);

    expect(mockOnExecute).toHaveBeenCalledWith({
      filter: '{}',
      sort: '{}',
      projection: '{}',
      limit: 50,
      skip: 0
    });
  });

  it('opens the current find query in mongosh', () => {
    const mockOnOpenShell = vi.fn();
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        onOpenShell={mockOnOpenShell}
        loading={false}
      />
    );

    fireEvent.change(screen.getByTestId('query-filter-input'), { target: { value: '{"age":{"$gt":21}}' } });
    fireEvent.change(screen.getByTestId('sort-query-input'), { target: { value: '{"age":-1}' } });

    fireEvent.click(screen.getByRole('button', { name: /open query in/i }));
    fireEvent.click(screen.getByText('Open in mongosh'));

    expect(mockOnOpenShell).toHaveBeenCalledWith(
      'db.getCollection("test-coll").find({"age":{"$gt":21}}).sort({"age":-1}).skip(0).limit(50)'
    );
  });

  it('triggers clear icons to reset fields', async () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    const filterInput = screen.getByTestId('query-filter-input');
    fireEvent.change(filterInput, { target: { value: '{"a": 1}' } });
    
    const clearBtn = screen.getByTitle('Clear Filter');
    fireEvent.click(clearBtn);

    expect(filterInput).toHaveValue('{}');
    expect(screen.getByText('Cleared filter parameters')).toBeInTheDocument();
  });

  it('toggles visual query builder panel', () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    expect(screen.queryByTestId('query-builder-panel')).not.toBeInTheDocument();

    const toggleBtn = screen.getByTestId('toggle-query-builder');
    fireEvent.click(toggleBtn);

    expect(screen.getByTestId('query-builder-panel')).toBeInTheDocument();

    // Click close/X button in the panel
    const closeBtn = screen.getByTitle('Close Panel');
    fireEvent.click(closeBtn);
    expect(screen.queryByTestId('query-builder-panel')).not.toBeInTheDocument();
  });

  it('adds, updates, and deletes rules compiling in real-time', async () => {
    const { container } = render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    // Toggle builder open
    fireEvent.click(screen.getByTestId('toggle-query-builder'));

    // Check first rule field select is initialized to _id
    const fieldSelect = container.querySelector('select[data-testid^="rule-field-"]') as HTMLSelectElement;
    expect(fieldSelect).toBeInTheDocument();
    expect(fieldSelect.value).toBe('_id');

    // Change field to 'age'
    fireEvent.change(fieldSelect, { target: { value: 'age' } });

    // Change operator to '$gt'
    const opSelect = container.querySelector('select[data-testid^="rule-operator-"]') as HTMLSelectElement;
    fireEvent.change(opSelect, { target: { value: '$gt' } });

    // Type value '21'
    const valInput = container.querySelector('input[data-testid^="rule-value-"]') as HTMLInputElement;
    fireEvent.change(valInput, { target: { value: '21' } });

    // Verify filter input got updated
    const filterInput = screen.getByTestId('query-filter-input') as HTMLInputElement;
    await waitFor(() => {
      const query = JSON.parse(filterInput.value);
      expect(query).toEqual({ age: { $gt: 21 } });
    });

    // Add another rule
    const addRuleBtn = screen.getByRole('button', { name: 'Add Rule' });
    fireEvent.click(addRuleBtn);

    // Get all rules field selects
    const fieldSelects = container.querySelectorAll('select[data-testid^="rule-field-"]');
    expect(fieldSelects).toHaveLength(2);

    // Change second rule to custom field 'metadata.user'
    fireEvent.change(fieldSelects[1], { target: { value: '__custom__' } });
    const customFieldInput = container.querySelector('input[data-testid^="rule-field-custom-"]') as HTMLInputElement;
    expect(customFieldInput).toBeInTheDocument();
    fireEvent.change(customFieldInput, { target: { value: 'metadata.user' } });

    // Type second rule value 'admin'
    const valInputs = container.querySelectorAll('input[data-testid^="rule-value-"]');
    fireEvent.change(valInputs[1], { target: { value: '"admin"' } }); // quoted string

    await waitFor(() => {
      const query = JSON.parse(filterInput.value);
      expect(query).toEqual({ 
        age: { $gt: 21 },
        'metadata.user': 'admin'
      });
    });

    // Delete first rule
    const deleteBtns = screen.getAllByTitle('Remove Rule');
    fireEvent.click(deleteBtns[0]);

    await waitFor(() => {
      const query = JSON.parse(filterInput.value);
      expect(query).toEqual({ 
        'metadata.user': 'admin'
      });
    });
  });

  it('synchronizes query input changes back to builder rules (bidirectional sync)', async () => {
    const { container } = render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    // Start with a query in the filter input
    const filterInput = screen.getByTestId('query-filter-input') as HTMLInputElement;
    fireEvent.change(filterInput, { target: { value: '{"age": {"$gte": 18}}' } });

    // Open query builder
    fireEvent.click(screen.getByTestId('toggle-query-builder'));

    // Verify rules match the query
    const fieldSelect = container.querySelector('select[data-testid^="rule-field-"]') as HTMLSelectElement;
    const opSelect = container.querySelector('select[data-testid^="rule-operator-"]') as HTMLSelectElement;
    const valInput = container.querySelector('input[data-testid^="rule-value-"]') as HTMLInputElement;

    expect(fieldSelect.value).toBe('age');
    expect(opSelect.value).toBe('$gte');
    expect(valInput.value).toBe('18');

    // Change query input directly
    fireEvent.change(filterInput, { target: { value: '{"name": "Alice"}' } });

    // Verify builder rules synchronized
    await waitFor(() => {
      const currentFieldSelect = container.querySelector('select[data-testid^="rule-field-"]') as HTMLSelectElement;
      const currentOpSelect = container.querySelector('select[data-testid^="rule-operator-"]') as HTMLSelectElement;
      const currentValInput = container.querySelector('input[data-testid^="rule-value-"]') as HTMLInputElement;

      expect(currentFieldSelect.value).toBe('name');
      expect(currentOpSelect.value).toBe('$eq');
      expect(currentValInput.value).toBe('Alice');
    });

    // Enter invalid JSON in input
    fireEvent.change(filterInput, { target: { value: '{invalid' } });

    // Verify rules NOT affected
    await waitFor(() => {
      const currentFieldSelect = container.querySelector('select[data-testid^="rule-field-"]') as HTMLSelectElement;
      expect(currentFieldSelect.value).toBe('name');
    });
  });

  it('supports projection rules compilation and bidirectional sync', async () => {
    const { container } = render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    // Start with a projection in the input
    const projectionInput = screen.getByTestId('projection-query-input') as HTMLInputElement;
    fireEvent.change(projectionInput, { target: { value: '{"name": 1}' } });

    // Open query builder
    fireEvent.click(screen.getByTestId('toggle-query-builder'));

    // Verify projection rules match
    const projFieldSelect = container.querySelector('select[data-testid^="projection-field-"]') as HTMLSelectElement;
    const projIncludeSelect = container.querySelector('select[data-testid^="projection-include-"]') as HTMLSelectElement;

    expect(projFieldSelect.value).toBe('name');
    expect(projIncludeSelect.value).toBe('1');

    // Change visual rule field to 'age' and include to Exclude (0)
    fireEvent.change(projFieldSelect, { target: { value: 'age' } });
    fireEvent.change(projIncludeSelect, { target: { value: '0' } });

    // Verify input updated
    await waitFor(() => {
      expect(JSON.parse(projectionInput.value)).toEqual({ age: 0 });
    });

    // Change input query directly
    fireEvent.change(projectionInput, { target: { value: '{"name": 0, "_id": 1}' } });

    // Verify rules synchronized
    await waitFor(() => {
      const rulesRows = container.querySelectorAll('div[data-testid^="projection-rule-"]');
      expect(rulesRows).toHaveLength(2);
    });
  });

  it('supports sort rules compilation and bidirectional sync', async () => {
    const { container } = render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    // Open query builder
    fireEvent.click(screen.getByTestId('toggle-query-builder'));

    // Add a sort rule
    const sortDropzone = screen.getByTestId('sort-dropzone');
    fireEvent.click(sortDropzone);

    const sortFieldSelect = container.querySelector('select[data-testid^="sort-field-"]') as HTMLSelectElement;
    const sortDirSelect = container.querySelector('select[data-testid^="sort-direction-"]') as HTMLSelectElement;

    // Default is _id: 1
    expect(sortFieldSelect.value).toBe('_id');
    expect(sortDirSelect.value).toBe('1');

    // Change to age: -1
    fireEvent.change(sortFieldSelect, { target: { value: 'age' } });
    fireEvent.change(sortDirSelect, { target: { value: '-1' } });

    const sortInput = screen.getByTestId('sort-query-input') as HTMLInputElement;
    await waitFor(() => {
      expect(JSON.parse(sortInput.value)).toEqual({ age: -1 });
    });

    // Sync from input back to sort builder rules
    fireEvent.change(sortInput, { target: { value: '{"name": 1}' } });
    await waitFor(() => {
      const currentSortFieldSelect = container.querySelector('select[data-testid^="sort-field-"]') as HTMLSelectElement;
      const currentSortDirSelect = container.querySelector('select[data-testid^="sort-direction-"]') as HTMLSelectElement;
      expect(currentSortFieldSelect.value).toBe('name');
      expect(currentSortDirSelect.value).toBe('1');
    });
  });

  it('allows disabling and enabling cards via checkboxes clearing and compiling queries', async () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    const filterInput = screen.getByTestId('query-filter-input') as HTMLInputElement;
    const projectionInput = screen.getByTestId('projection-query-input') as HTMLInputElement;
    const sortInput = screen.getByTestId('sort-query-input') as HTMLInputElement;

    // Start with values
    fireEvent.change(filterInput, { target: { value: '{"age": 30}' } });
    fireEvent.change(projectionInput, { target: { value: '{"name": 1}' } });
    fireEvent.change(sortInput, { target: { value: '{"_id": -1}' } });

    // Open query builder
    fireEvent.click(screen.getByTestId('toggle-query-builder'));

    // Get checkboxes
    const queryCheckbox = screen.getByTestId('query-enable-checkbox') as HTMLInputElement;
    const projectionCheckbox = screen.getByTestId('projection-enable-checkbox') as HTMLInputElement;
    const sortCheckbox = screen.getByTestId('sort-enable-checkbox') as HTMLInputElement;

    expect(queryCheckbox.checked).toBe(true);
    expect(projectionCheckbox.checked).toBe(true);
    expect(sortCheckbox.checked).toBe(true);

    // Uncheck projection
    fireEvent.click(projectionCheckbox);
    expect(projectionCheckbox.checked).toBe(false);
    expect(projectionInput.value).toBe('{}');

    // Uncheck sort
    fireEvent.click(sortCheckbox);
    expect(sortCheckbox.checked).toBe(false);
    expect(sortInput.value).toBe('{}');

    // Check projection back
    fireEvent.click(projectionCheckbox);
    expect(projectionCheckbox.checked).toBe(true);
    // Compiles rules back
    await waitFor(() => {
      expect(JSON.parse(projectionInput.value)).toEqual({ name: 1 });
    });
  });

  it('compiles match types with $or and $and correctly', async () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    // Start with a query
    const filterInput = screen.getByTestId('query-filter-input') as HTMLInputElement;
    fireEvent.change(filterInput, { target: { value: '{"$or": [{"age": 21}, {"name": "Bob"}]}' } });

    // Open query builder
    fireEvent.click(screen.getByTestId('toggle-query-builder'));

    // Check match type select has value 'or'
    const matchTypeSelect = screen.getByTestId('query-match-type') as HTMLSelectElement;
    expect(matchTypeSelect.value).toBe('or');

    // Add a rule to the $or list
    const addRuleBtn = screen.getByTestId('query-add-rule-btn');
    fireEvent.click(addRuleBtn);

    // Change the match type back to 'and'
    fireEvent.change(matchTypeSelect, { target: { value: 'and' } });

    await waitFor(() => {
      const compiled = JSON.parse(filterInput.value);
      expect(compiled).not.toHaveProperty('$or');
    });
  });

  it('resizes the right visual query builder panel via drag handle', () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['_id', 'age', 'name']}
      />
    );

    // Open query builder
    fireEvent.click(screen.getByTestId('toggle-query-builder'));

    const panel = screen.getByTestId('query-builder-panel');
    const resizer = screen.getByTestId('query-builder-resizer');

    expect(panel).toHaveStyle('width: 340px');

    // Simulate drag start
    fireEvent.mouseDown(resizer);

    // Simulate mouse move
    fireEvent(window, new MouseEvent('mousemove', { clientX: window.innerWidth - 400 }));

    expect(panel).toHaveStyle('width: 400px');

    // Simulate mouse up
    fireEvent(window, new MouseEvent('mouseup'));
  });

  it('automatically triggers explain query when the Explain Plan tab is clicked', async () => {
    const { DataGrid } = await import('../DataGrid');
    mockOnExplain.mockResolvedValue('{"queryPlanner": {}}');

    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
      >
        <DataGrid documents={[]} explainResult={null} />
      </DocumentViewer>
    );

    // Get the Explain Plan tab and click it
    const explainTab = screen.getByTestId('explain-plan-tab');
    expect(explainTab).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(explainTab);
    });

    // Verify it automatically triggers onExplain with the filter query (default '{}')
    expect(mockOnExplain).toHaveBeenCalledWith('{}');
  });

  it('toggles aggregation pipeline editor mode and adds/moves/deletes stages', async () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExecuteAggregate={mockOnExecuteAggregate}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    // Switch to Aggregation mode
    const aggTab = screen.getByTestId('mode-aggregate-tab');
    fireEvent.click(aggTab);

    // Expect aggregation editor to be visible
    expect(screen.getByTestId('aggregation-pipeline-editor')).toBeInTheDocument();
    expect(screen.getByText('1 stage')).toBeInTheDocument();

    // Add stage
    const addBtn = screen.getByRole('button', { name: /add stage/i });
    fireEvent.click(addBtn);
    expect(screen.getByText('2 stages')).toBeInTheDocument();

    // Verify stage textareas
    const stage0 = screen.getByTestId('pipeline-stage-0');
    const stage1 = screen.getByTestId('pipeline-stage-1');
    expect(stage0).toBeInTheDocument();
    expect(stage1).toBeInTheDocument();

    // Run query in aggregate mode: the full pipeline is sent (every stage runs),
    // not collapsed into a find().
    const runBtn = screen.getByRole('button', { name: 'Run' });
    fireEvent.click(runBtn);
    expect(mockOnExecuteAggregate).toHaveBeenCalledWith([
      { $match: {} },
      { $match: {} },
    ]);
    expect(mockOnExecute).not.toHaveBeenCalled();
  });

  it('sends a $count pipeline through the aggregate executor', () => {
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExecuteAggregate={mockOnExecuteAggregate}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    fireEvent.click(screen.getByTestId('mode-aggregate-tab'));

    // Stage 0: $match (default operator) with a filter.
    const stage0 = screen.getByTestId('pipeline-stage-0');
    fireEvent.change(stage0.querySelector('textarea')!, {
      target: { value: '{ "majorVersion": 4 }' },
    });

    // Stage 1: $count.
    fireEvent.click(screen.getByRole('button', { name: /add stage/i }));
    const stage1 = screen.getByTestId('pipeline-stage-1');
    fireEvent.change(stage1.querySelector('select')!, { target: { value: '$count' } });
    fireEvent.change(stage1.querySelector('textarea')!, { target: { value: '"count"' } });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(mockOnExecuteAggregate).toHaveBeenCalledWith([
      { $match: { majorVersion: 4 } },
      { $count: 'count' },
    ]);
  });

  it('explains the FULL aggregation pipeline, not a collapsed $match (M1)', async () => {
    const { DataGrid } = await import('../DataGrid');
    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExecuteAggregate={mockOnExecuteAggregate}
        onExplain={mockOnExplain}
        onExplainAggregate={mockOnExplainAggregate}
        loading={false}
      >
        <DataGrid documents={[]} explainResult={null} />
      </DocumentViewer>
    );

    fireEvent.click(screen.getByTestId('mode-aggregate-tab'));

    // Stage 0: $match; Stage 1: $group.
    const stage0 = screen.getByTestId('pipeline-stage-0');
    fireEvent.change(stage0.querySelector('textarea')!, {
      target: { value: '{ "category": "Electronics" }' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add stage/i }));
    const stage1 = screen.getByTestId('pipeline-stage-1');
    fireEvent.change(stage1.querySelector('select')!, { target: { value: '$group' } });
    fireEvent.change(stage1.querySelector('textarea')!, {
      target: { value: '{ "_id": "$category", "n": { "$sum": 1 } }' },
    });

    // Trigger Explain via the explain tab.
    await act(async () => {
      fireEvent.click(screen.getByTestId('explain-plan-tab'));
    });

    // The whole pipeline is explained — find-explain is not used in aggregate mode.
    expect(mockOnExplainAggregate).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockOnExplainAggregate.mock.calls[0][0]);
    expect(sent).toEqual([
      { $match: { category: 'Electronics' } },
      { $group: { _id: '$category', n: { $sum: 1 } } },
    ]);
    expect(mockOnExplain).not.toHaveBeenCalled();
  });

  it('chats with the backend, shows explanation + query card, and inserts a find query (C5)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_mql_query') {
        return Promise.resolve(
          '{"explanation":"Finds users older than 25, newest first.","queryType":"find","filter":{"age":{"$gt":25}},"sort":{"age":-1},"pipeline":[]}'
        );
      }
      return Promise.resolve(undefined);
    });

    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
        availableFields={['age', 'name']}
      />
    );

    fireEvent.click(screen.getByTestId('toggle-ai-helper'));
    expect(screen.getByTestId('ai-helper-panel')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Find users older than 25 sorted by age' },
    });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    // It called the backend command with the prompt + an (empty, first-turn) history.
    await waitFor(() => {
      const call = mockInvoke.mock.calls.find((c) => c[0] === 'generate_mql_query');
      expect(call).toBeTruthy();
      expect(call![1]).toMatchObject({
        prompt: 'Find users older than 25 sorted by age',
        collection: 'test-coll',
        history: [],
      });
    });

    // The explanation renders as the assistant message, and a query card appears.
    expect(await screen.findByText(/Finds users older than 25/)).toBeInTheDocument();
    expect(screen.getByTestId('chat-query-card')).toBeInTheDocument();

    // Insert applies the find query to the editor; panel stays open.
    fireEvent.click(screen.getByTestId('chat-insert-btn'));
    expect(screen.getByTestId('ai-helper-panel')).toBeInTheDocument();
    expect((screen.getByTestId('query-filter-input') as HTMLInputElement).value.replace(/\s+/g, '')).toBe('{"age":{"$gt":25}}');
    expect((screen.getByTestId('sort-query-input') as HTMLInputElement).value.replace(/\s+/g, '')).toBe('{"age":-1}');

    // Insert & run applies the query AND executes it immediately.
    fireEvent.click(screen.getByTestId('chat-insert-run-btn'));
    expect(mockOnExecute).toHaveBeenCalled();
  });

  it('auto-switches to aggregation mode when the chat returns a pipeline (C5)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_mql_query') {
        return Promise.resolve(
          '{"explanation":"Average order total per customer.","queryType":"aggregate","filter":{},"sort":{},"pipeline":[{"$group":{"_id":"$customer","avg":{"$avg":"$total"}}}]}'
        );
      }
      return Promise.resolve(undefined);
    });

    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="orders"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    fireEvent.click(screen.getByTestId('toggle-ai-helper'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'average order total per customer' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    expect(await screen.findByTestId('chat-query-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-insert-btn'));

    // Inserting a pipeline switches the editor to aggregation mode and fills a stage.
    const stage = await screen.findByTestId('pipeline-stage-0');
    expect(stage).toBeInTheDocument();
    // The stage's operator select is set to $group.
    expect(stage.querySelector('select')).toHaveValue('$group');
  });

  it('multi-turn: sends prior conversation as history on the second message (C5)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'generate_mql_query') {
        return Promise.resolve(
          '{"explanation":"ok","queryType":"find","filter":{"a":1},"sort":{},"pipeline":[]}'
        );
      }
      return Promise.resolve(undefined);
    });

    render(
      <DocumentViewer
        connectionName="c" databaseName="d" collectionName="coll"
        onExecute={mockOnExecute} onExplain={mockOnExplain} loading={false}
      />
    );

    fireEvent.click(screen.getByTestId('toggle-ai-helper'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'find a=1' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await screen.findByTestId('chat-query-card');

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'now also sort by b' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => {
      const calls = mockInvoke.mock.calls.filter((c) => c[0] === 'generate_mql_query');
      expect(calls.length).toBe(2);
      // Second call carries the first turn (user + assistant) as history.
      const history = calls[1][1].history;
      expect(history.length).toBe(2);
      expect(history[0]).toMatchObject({ role: 'user', content: 'find a=1' });
      expect(history[1].role).toBe('assistant');
    });
  });

  it('shows an error message in the chat when generation fails (C5)', async () => {
    mockInvoke.mockImplementation(() =>
      Promise.reject('No Anthropic API key set. Add one in Settings to use the query assistant.')
    );

    render(
      <DocumentViewer
        connectionName="test-conn"
        databaseName="test-db"
        collectionName="test-coll"
        onExecute={mockOnExecute}
        onExplain={mockOnExplain}
        loading={false}
      />
    );

    fireEvent.click(screen.getByTestId('toggle-ai-helper'));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'active users' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    expect(await screen.findByText(/API key/i)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-query-card')).not.toBeInTheDocument();
  });
});

describe('builderStateToQuery', () => {
  it('serializes find-mode builder state', () => {
    const q = builderStateToQuery({
      queryMode: 'find',
      filterQuery: '{"age":{"$gt":30}}',
      sortQuery: '{"age":-1}',
      projectionQuery: '{"name":1}',
      limit: '25',
      skip: '5',
      stages: [],
    });
    expect(q).toEqual({
      queryType: 'find',
      filter: { age: { $gt: 30 } },
      sort: { age: -1 },
      projection: { name: 1 },
      limit: 25,
      skip: 5,
    });
  });

  it('serializes aggregate-mode builder state, dropping empty stages', () => {
    const q = builderStateToQuery({
      queryMode: 'aggregate',
      filterQuery: '{}',
      sortQuery: '{}',
      projectionQuery: '{}',
      limit: '50',
      skip: '0',
      stages: [
        { id: 's1', operator: '$match', content: '{"active":true}' },
        { id: 's2', operator: '$count', content: '"n"' },
        { id: 's3', operator: '$sort', content: '   ' },
      ],
    });
    expect(q).toEqual({
      queryType: 'aggregate',
      pipeline: [{ $match: { active: true } }, { $count: 'n' }],
    });
  });

  it('treats invalid JSON as empty objects in find mode', () => {
    const q = builderStateToQuery({
      queryMode: 'find',
      filterQuery: 'not json',
      sortQuery: '',
      projectionQuery: '{}',
      limit: 'x',
      skip: '',
      stages: [],
    });
    expect(q).toEqual({
      queryType: 'find',
      filter: {},
      sort: {},
      projection: {},
      limit: 50,
      skip: 0,
    });
  });
});

describe('DocumentViewer query persistence (H1)', () => {
  const onExecute = vi.fn();
  const onExecuteAggregate = vi.fn();
  const onExplain = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the current query via save_query (H1)', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({ saved: [], history: [], default: null });
      }
      return Promise.resolve(undefined);
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('My adults query');

    render(
      <DocumentViewer
        connectionName="Local"
        databaseName="sales_db"
        collectionName="customers"
        onExecute={onExecute}
        onExecuteAggregate={onExecuteAggregate}
        onExplain={onExplain}
        loading={false}
      />
    );

    fireEvent.click(screen.getByTestId('toggle-query-builder'));
    fireEvent.change(screen.getByTestId('query-filter-input'), {
      target: { value: '{"age":{"$gt":30}}' },
    });
    fireEvent.click(screen.getByText('Save query'));
    fireEvent.click(screen.getByTestId('save-query-item'));

    await waitFor(() => {
      const save = calls.find((c) => c.cmd === 'save_query');
      expect(save).toBeTruthy();
      expect(save.args).toMatchObject({
        connectionName: 'Local',
        db: 'sales_db',
        collection: 'customers',
      });
      expect(save.args.saved.name).toBe('My adults query');
      expect(save.args.saved.query).toEqual({
        queryType: 'find',
        filter: { age: { $gt: 30 } },
        sort: {},
        projection: {},
        limit: 50,
        skip: 0,
      });
    });
    promptSpy.mockRestore();
  });

  it('lists saved queries and applies one on click (H1)', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_collection_queries') {
        return Promise.resolve({
          saved: [
            {
              id: 'sq1',
              name: 'Adults',
              query: { queryType: 'find', filter: { age: { $gt: 30 } }, sort: {}, projection: {} },
              createdAt: '2026-05-30T00:00:00Z',
            },
          ],
          history: [],
          default: null,
        });
      }
      return Promise.resolve(undefined);
    });

    render(
      <DocumentViewer
        connectionName="Local"
        databaseName="sales_db"
        collectionName="customers"
        onExecute={onExecute}
        onExecuteAggregate={onExecuteAggregate}
        onExplain={onExplain}
        loading={false}
      />
    );

    fireEvent.click(screen.getByText('Load query'));
    expect(await screen.findByTestId('saved-query-sq1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Adults'));

    fireEvent.click(screen.getByTestId('toggle-query-builder'));
    await waitFor(() => {
      const input = screen.getByTestId('query-filter-input') as HTMLTextAreaElement;
      expect(input.value).toContain('"age"');
    });
  });
});

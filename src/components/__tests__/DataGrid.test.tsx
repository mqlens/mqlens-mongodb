import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Monaco renders the Query Code panel; mock it as a plain textarea (same shape
// as the other component tests) so assertions can read the generated code.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, wrapperProps }: { value: string; wrapperProps?: Record<string, unknown> }) => (
    <textarea data-testid={wrapperProps?.['data-testid'] as string | undefined} value={value} readOnly />
  ),
}));

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    config: {
      presetId: 'mqlens-dark',
      mode: 'dark',
      fonts: { sans: 'Inter', mono: 'JetBrains Mono' },
      fontSize: 13,
      spacingDensity: 'cozy',
      overrides: {},
    },
    resolvedMode: 'dark' as const,
  }),
  useThemeOptional: () => ({
    config: {
      presetId: 'mqlens-dark',
      mode: 'dark',
      fonts: { sans: 'Inter', mono: 'JetBrains Mono' },
      fontSize: 13,
      spacingDensity: 'cozy',
      overrides: {},
    },
    resolvedMode: 'dark' as const,
  }),
}));

import { DataGrid, getExplainTree } from '../DataGrid';

// Collect every node name in the tree (depth-first) for assertions.
const collectNames = (node: any): string[] => [
  node.name,
  ...(node.children || []).flatMap(collectNames),
];

describe('getExplainTree (M1)', () => {
  it('parses the find explain shape (queryPlanner.winningPlan)', () => {
    const findExplain = JSON.stringify({
      queryPlanner: {
        namespace: 'shop.products',
        winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'price_1' } },
      },
    });
    const names = collectNames(getExplainTree(findExplain));
    expect(names).toContain('Fetch documents');
    expect(names).toContain('Index scan');
  });

  it('parses the aggregate explain shape ($cursor winningPlan + pipeline stages)', () => {
    const aggExplain = JSON.stringify({
      stages: [
        {
          $cursor: {
            queryPlanner: {
              namespace: 'shop.products',
              winningPlan: { stage: 'IXSCAN', indexName: 'category_1' },
            },
          },
        },
        { $group: { _id: '$category', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ],
    });
    const names = collectNames(getExplainTree(aggExplain));
    // Pipeline stages appear as nodes...
    expect(names).toContain('$group');
    expect(names).toContain('$sort');
    expect(names).toContain('$cursor');
    // ...and the cursor's real plan (index scan) is at the leaf.
    expect(names).toContain('Index scan');
  });
});

const mockDocuments = [
  { _id: { $oid: "603d779f4f102e3a185c3220" }, name: "Alice Smith", category: "Electronics", price: 1299.99 },
  { _id: { $oid: "603d779f4f102e3a185c3221" }, name: "Bob Johnson", category: "Electronics", price: 199.99 },
  { _id: { $oid: "603d779f4f102e3a185c3222" }, name: "Charlie Brown", category: "Office", price: 349.50 },
];

describe('DataGrid Component', () => {
  it('renders the JSON view by default', () => {
    render(<DataGrid documents={mockDocuments} />);
    // JSON view is the default — line-numbered code panel, not table headers.
    expect(screen.getByTestId('json-view')).toBeInTheDocument();
    expect(screen.getByText(/"Alice Smith"/)).toBeInTheDocument();
  });

  it('switches to Table view and extracts columns correctly', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    // Check that column headers are inferred and rendered
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('category')).toBeInTheDocument();
    expect(screen.getByText('price')).toBeInTheDocument();

    // Check that values are rendered
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Johnson')).toBeInTheDocument();
    expect(screen.getByText('Charlie Brown')).toBeInTheDocument();
  });

  it('switches to JSON view and displays pretty-printed JSON documents', () => {
    render(<DataGrid documents={mockDocuments} />);

    // Find the view selector buttons and click 'JSON'
    const jsonButton = screen.getByRole('button', { name: /json/i });
    fireEvent.click(jsonButton);

    // Verify pretty-printed JSON contents are visible. The list is virtualized,
    // so only on-screen rows (the first document here) are in the DOM.
    expect(screen.getAllByText(/"name"/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/"Alice Smith"/i)).toBeInTheDocument();
  });

  it('renders the JSON view as a line-numbered, collapsible code panel', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /json/i }));

    // The continuous, line-numbered code panel (not per-document boxes).
    const jsonView = screen.getByTestId('json-view');
    expect(jsonView).toBeInTheDocument();
    // Line-number gutter starts at 1. The number is exposed via data-num and
    // rendered through a ::before pseudo-element (not a text node) so that
    // selecting and copying JSON never picks up the gutter numbers.
    const firstGutter = jsonView.querySelector('.json-view-gutter');
    expect(firstGutter).toHaveAttribute('data-num', '1');
    expect(firstGutter).toBeEmptyDOMElement();

    // Foldable: each object/array opens a collapse toggle.
    const folds = screen.getAllByTestId('json-fold-btn');
    expect(folds.length).toBeGreaterThan(0);

    // Collapsing the first document hides its nested content.
    expect(screen.getByText(/"Alice Smith"/)).toBeInTheDocument();
    fireEvent.click(folds[0]);
    expect(screen.queryByText(/"Alice Smith"/)).not.toBeInTheDocument();
  });

  it('keeps oversized multiline strings escaped and fully available in one JSON row', () => {
    const huge = `first line\n${'x'.repeat(2500)}\nlast line`;
    render(<DataGrid documents={[{ _id: 1, notes: huge }]} />);

    const view = screen.getByTestId('json-view');
    expect(view.textContent).toContain('first line\\n');
    expect(view.textContent).toContain('\\nlast line');
    expect(view.textContent).not.toContain('chars)"');
    expect(view.textContent).not.toContain('first line\n');
  });

  it('switches to the tree-table view (Key | Value | Type)', () => {
    render(<DataGrid documents={mockDocuments} />);

    const treeButton = screen.getByRole('button', { name: /tree/i });
    fireEvent.click(treeButton);

    // Tree-table renders columnar headers and key/value/type cells.
    expect(screen.getByTestId('tree-view')).toBeInTheDocument();
    expect(screen.getByText('Key')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    // Field key (no trailing colon) + its value, plus an inferred type.
    expect(screen.getAllByText('name').length).toBeGreaterThan(0);
    expect(screen.getByText(/"Alice Smith"/)).toBeInTheDocument();
    expect(screen.getAllByText('String').length).toBeGreaterThan(0);
    // Expandable container rows expose a fold toggle.
    expect(screen.getAllByTestId('tree-fold-btn').length).toBeGreaterThan(0);
  });

  it('renders BSON types (like ObjectId and ISODate) using shell constructors in JSON and Tree views', () => {
    const bsonDocs = [
      {
        _id: { $oid: "603d779f4f102e3a185c3220" },
        created_at: { $date: "2025-05-18T14:32:00Z" },
        price: { $numberDecimal: "1299.99" }
      }
    ];
    render(<DataGrid documents={bsonDocs} />);

    // Switch to JSON view
    const jsonButton = screen.getByRole('button', { name: /json/i });
    fireEvent.click(jsonButton);

    // Verify shell constructors are printed
    expect(screen.getByText('ObjectId')).toBeInTheDocument();
    expect(screen.getByText('"603d779f4f102e3a185c3220"')).toBeInTheDocument();
    expect(screen.getByText('ISODate')).toBeInTheDocument();
    expect(screen.getByText('"2025-05-18T14:32:00.000Z"')).toBeInTheDocument();
    expect(screen.getByText('NumberDecimal')).toBeInTheDocument();
    expect(screen.getByText('"1299.99"')).toBeInTheDocument();

    // Switch to Tree view
    const treeButton = screen.getByRole('button', { name: /tree/i });
    fireEvent.click(treeButton);

    // Verify shell constructors are printed in Tree view
    expect(screen.getAllByText('ObjectId').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ISODate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('NumberDecimal').length).toBeGreaterThan(0);
  });

  it('switches back to results tab automatically when documents list changes', () => {
    const { rerender } = render(<DataGrid documents={mockDocuments} explainResult='{"queryPlanner": {}}' />);

    // Explain result is provided, so it should auto-switch to explain tab
    expect(screen.getByTestId('explain-panel')).toBeInTheDocument();

    // Now simulate running a new query which updates the documents list
    const newDocs = [
      { _id: { $oid: "603d779f4f102e3a185c3223" }, name: "David Miller", category: "Office", price: 49.99 }
    ];
    rerender(<DataGrid documents={newDocs} explainResult='{"queryPlanner": {}}' />);

    // It should switch back to results tab and display the new document
    expect(screen.queryByTestId('explain-panel')).not.toBeInTheDocument();
    expect(screen.getByText(/"David Miller"/)).toBeInTheDocument();
  });

  it('shows a COLLSCAN suggestion banner in the explain panel and fires onCreateSuggestedIndex', () => {
    const collscanExplain = JSON.stringify({
      queryPlanner: {
        namespace: 'shop.orders',
        parsedQuery: { status: { $eq: 'open' } },
        winningPlan: { stage: 'COLLSCAN' },
      },
    });
    const onCreateSuggestedIndex = vi.fn();
    render(
      <DataGrid
        documents={mockDocuments}
        explainResult={collscanExplain}
        onCreateSuggestedIndex={onCreateSuggestedIndex}
      />
    );

    const btn = screen.getByTestId('create-suggested-index-btn');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);

    expect(onCreateSuggestedIndex).toHaveBeenCalledTimes(1);
    const suggestion = onCreateSuggestedIndex.mock.calls[0][0];
    expect(suggestion.namespace).toBe('shop.orders');
    expect(suggestion.keys).toEqual({ status: 1 });
  });

  it('does not show a suggestion banner when the plan already uses an index', () => {
    const ixscanExplain = JSON.stringify({
      queryPlanner: {
        namespace: 'shop.orders',
        winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'status_1' } },
      },
    });
    render(<DataGrid documents={mockDocuments} explainResult={ixscanExplain} />);
    expect(screen.queryByTestId('create-suggested-index-btn')).not.toBeInTheDocument();
  });

  it('shows a Query Code tab rendering the query spec in the selected language', () => {
    const spec = {
      db: 'shop',
      collection: 'products',
      query: { queryType: 'aggregate' as const, pipeline: [{ $count: 'n' }] },
    };
    render(<DataGrid documents={mockDocuments} querySpec={spec} />);

    // The tab appears and opens with the mongosh command by default.
    fireEvent.click(screen.getByTestId('query-code-tab'));
    expect(screen.getByTestId('query-code-panel')).toBeInTheDocument();
    const content = () => (screen.getByTestId('query-code-content') as HTMLTextAreaElement).value;
    expect(content()).toContain('db.products.aggregate(');
    expect(content()).toContain('$count');

    // Switching the language regenerates the code.
    fireEvent.change(screen.getByTestId('query-code-lang'), { target: { value: 'Python' } });
    expect(content()).toContain('from pymongo import MongoClient');
    fireEvent.change(screen.getByTestId('query-code-lang'), { target: { value: 'mongosh' } });
  });

  it('hides the Query Code tab when no query spec is provided', () => {
    render(<DataGrid documents={mockDocuments} />);
    expect(screen.queryByTestId('query-code-tab')).toBeNull();
  });

  it('renders a pager footer and fires page callbacks', () => {
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    render(
      <DataGrid
        documents={[{ _id: 1 }, { _id: 2 }]}
        totalCount={1312}
        estimated={false}
        skip={100}
        limit={50}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    expect(screen.getByTestId('pager')).toBeInTheDocument();
    // Page 3 of 27 (skip 100 / limit 50 => page 3; ceil(1312/50)=27)
    expect(screen.getByTestId('pager-page')).toHaveTextContent('3');
    expect(screen.getByTestId('pager-page')).toHaveTextContent('27');
    expect(screen.getByTestId('pager-total')).toHaveTextContent('1312');

    fireEvent.click(screen.getByTestId('pager-next'));
    expect(onPageChange).toHaveBeenCalledWith(150); // skip + limit

    fireEvent.click(screen.getByTestId('pager-prev'));
    expect(onPageChange).toHaveBeenCalledWith(50); // skip - limit

    fireEvent.change(screen.getByTestId('pager-size'), { target: { value: '100' } });
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });

  it('shows ~ for an estimated count and hides pager when no pagination props', () => {
    const { rerender } = render(
      <DataGrid documents={[{ _id: 1 }]} totalCount={9} estimated skip={0} limit={50} onPageChange={() => {}} onPageSizeChange={() => {}} />,
    );
    expect(screen.getByTestId('pager-total')).toHaveTextContent('~9');
    rerender(<DataGrid documents={[{ _id: 1 }]} />);
    expect(screen.queryByTestId('pager')).not.toBeInTheDocument();
  });

  it('switches to the chart view when the Chart toggle is clicked', () => {
    render(<DataGrid documents={[{ region: 'NA', seats: 3 }, { region: 'EU', seats: 4 }]} />);
    fireEvent.click(screen.getByLabelText('Chart'));
    expect(screen.getByTestId('chart-view')).toBeTruthy();
  });

  it('opens a context menu on right-click and fires document actions', () => {
    const onEditDocument = vi.fn();
    render(<DataGrid documents={mockDocuments} onEditDocument={onEditDocument} onDeleteDocument={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    expect(screen.getByText('Delete document').closest('button')).toHaveClass('is-danger');
    fireEvent.click(screen.getByText('Edit document'));
    expect(onEditDocument).toHaveBeenCalledWith(mockDocuments[0]);
  });

  it('copies a cell value via the context menu', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DataGrid documents={mockDocuments} onEditDocument={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('Copy value'));
    expect(writeText).toHaveBeenCalledWith('Alice Smith');
  });

  it('shows the same context menu in the JSON view', () => {
    render(<DataGrid documents={mockDocuments} onEditDocument={() => {}} onDeleteDocument={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /json/i }));
    fireEvent.contextMenu(screen.getByText(/"Alice Smith"/));
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    expect(screen.getByText('Edit document')).toBeInTheDocument();
    expect(screen.getByText('Compare with…')).toBeInTheDocument();
  });

  it('copies a document as pretty-printed JSON via the copy button and shows a confirmation', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // No edit/delete handlers: the copy control must still be present on every document.
    render(<DataGrid documents={mockDocuments} />);
    // Table view renders one row (and one copy control) per document.
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    const copyButtons = screen.getAllByTestId('copy-doc-btn');
    expect(copyButtons).toHaveLength(mockDocuments.length);

    fireEvent.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(mockDocuments[0], null, 2));
    // The control flips to a "Copied" confirmation state.
    expect(screen.getAllByLabelText('Copied').length).toBeGreaterThan(0);
  });
});

describe('DataGrid — connectionMode (#188 Task 6: disable write UI on read_only)', () => {
  const writeHandlers = {
    onInsertDocument: () => {},
    onUpdateMany: () => {},
    onDeleteMany: () => {},
    onEditDocument: () => {},
    onDuplicateDocument: () => {},
    onDeleteDocument: () => {},
  };

  it('read_only: disables the Insert / Update Many / Delete Many toolbar buttons with a tooltip', () => {
    render(<DataGrid documents={mockDocuments} {...writeHandlers} connectionMode="read_only" />);
    for (const testId of ['insert-doc-btn', 'update-many-btn', 'delete-many-btn']) {
      const btn = screen.getByTestId(testId);
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Connection is read-only');
    }
  });

  it('read_only: disables the inline row Edit/Delete buttons (with tooltip) but leaves Copy enabled', () => {
    render(<DataGrid documents={mockDocuments} {...writeHandlers} connectionMode="read_only" />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    const editBtn = screen.getAllByTestId('edit-doc-btn')[0];
    const deleteBtn = screen.getAllByTestId('delete-doc-btn')[0];
    const copyBtn = screen.getAllByTestId('copy-doc-btn')[0];
    expect(editBtn).toBeDisabled();
    expect(editBtn).toHaveAttribute('title', 'Connection is read-only');
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn).toHaveAttribute('title', 'Connection is read-only');
    expect(copyBtn).not.toBeDisabled();
  });

  it('read_only: disables the Edit/Duplicate/Delete context-menu items (with tooltip) but leaves Copy/Compare enabled', () => {
    render(<DataGrid documents={mockDocuments} {...writeHandlers} connectionMode="read_only" />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    const editItem = screen.getByText('Edit document').closest('button')!;
    const dupItem = screen.getByText('Duplicate document').closest('button')!;
    const delItem = screen.getByText('Delete document').closest('button')!;
    const copyItem = screen.getByText('Copy document (JSON)').closest('button')!;
    const compareItem = screen.getByText('Compare with…').closest('button')!;
    expect(editItem).toBeDisabled();
    expect(editItem).toHaveAttribute('title', 'Connection is read-only');
    expect(dupItem).toBeDisabled();
    expect(delItem).toBeDisabled();
    expect(copyItem).not.toBeDisabled();
    expect(compareItem).not.toBeDisabled();
  });

  it('read_only: clicking a disabled context-menu item does not fire its handler', () => {
    const onEditDocument = vi.fn();
    render(<DataGrid documents={mockDocuments} {...writeHandlers} onEditDocument={onEditDocument} connectionMode="read_only" />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('Edit document'));
    expect(onEditDocument).not.toHaveBeenCalled();
  });

  it('confirm_destructive: leaves every write control ENABLED (regression guard — only read_only disables)', () => {
    render(<DataGrid documents={mockDocuments} {...writeHandlers} connectionMode="confirm_destructive" />);
    for (const testId of ['insert-doc-btn', 'update-many-btn', 'delete-many-btn']) {
      expect(screen.getByTestId(testId)).not.toBeDisabled();
    }
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    expect(screen.getAllByTestId('edit-doc-btn')[0]).not.toBeDisabled();
    expect(screen.getAllByTestId('delete-doc-btn')[0]).not.toBeDisabled();
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    expect(screen.getByText('Edit document').closest('button')).not.toBeDisabled();
    expect(screen.getByText('Duplicate document').closest('button')).not.toBeDisabled();
    expect(screen.getByText('Delete document').closest('button')).not.toBeDisabled();
  });

  it('normal (and unset connectionMode): leaves every write control ENABLED', () => {
    const { rerender } = render(<DataGrid documents={mockDocuments} {...writeHandlers} connectionMode="normal" />);
    for (const testId of ['insert-doc-btn', 'update-many-btn', 'delete-many-btn']) {
      expect(screen.getByTestId(testId)).not.toBeDisabled();
    }
    rerender(<DataGrid documents={mockDocuments} {...writeHandlers} />);
    for (const testId of ['insert-doc-btn', 'update-many-btn', 'delete-many-btn']) {
      expect(screen.getByTestId(testId)).not.toBeDisabled();
    }
  });

  // The COLLSCAN "Create Index" suggestion button is a real write
  // (create_index, backend-guarded on read_only) even though it lives in the
  // Explain tab rather than the toolbar — same clickable-then-errors UX this
  // task exists to prevent, so it gets the same disabled+tooltip treatment.
  const collscanExplain = JSON.stringify({
    queryPlanner: {
      namespace: 'shop.orders',
      parsedQuery: { status: { $eq: 'open' } },
      winningPlan: { stage: 'COLLSCAN' },
    },
  });

  it('read_only: disables the Create Index suggestion button with a tooltip', () => {
    render(
      <DataGrid
        documents={mockDocuments}
        explainResult={collscanExplain}
        onCreateSuggestedIndex={() => {}}
        connectionMode="read_only"
      />
    );
    const btn = screen.getByTestId('create-suggested-index-btn');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Connection is read-only');
  });

  it('confirm_destructive: leaves the Create Index suggestion button ENABLED (non-destructive)', () => {
    render(
      <DataGrid
        documents={mockDocuments}
        explainResult={collscanExplain}
        onCreateSuggestedIndex={() => {}}
        connectionMode="confirm_destructive"
      />
    );
    expect(screen.getByTestId('create-suggested-index-btn')).not.toBeDisabled();
  });
});

describe('DataGrid — Compare documents', () => {
  const docs = [
    { _id: { $oid: '603d779f4f102e3a185c3220' }, name: 'Alice', city: 'NYC' },
    { _id: { $oid: '603d779f4f102e3a185c3221' }, name: 'Bob', country: 'UK' },
    { _id: { $oid: '603d779f4f102e3a185c3222' }, name: 'Carol', country: 'FR' },
  ];

  // The JSON view is virtualized and (in JSDOM, with no real layout height)
  // only renders the first document's lines, so the two-step flow — which
  // needs to right-click several distinct rows — exercises Table view
  // instead, where react-window renders every row of this small fixture.
  const openMenuForRow = (name: string) => {
    fireEvent.contextMenu(screen.getByText(name));
  };

  const renderInTableView = () => {
    render(<DataGrid documents={docs} onEditDocument={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
  };

  it('two-step compare: first pick arms, second pick opens the diff modal', () => {
    renderInTableView();

    // First doc: open menu, choose "Compare with…".
    openMenuForRow('Alice');
    fireEvent.click(screen.getByText('Compare with…'));
    // No modal yet — we are armed, waiting for the second pick.
    expect(screen.queryByTestId('document-diff-modal')).not.toBeInTheDocument();

    // Second doc: the menu now offers "Compare with selected".
    openMenuForRow('Bob');
    fireEvent.click(screen.getByText('Compare with selected'));

    const modal = screen.getByTestId('document-diff-modal');
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByTestId('diff-left')).toHaveTextContent(/"Alice"/);
    expect(within(modal).getByTestId('diff-right')).toHaveTextContent(/"Bob"/);
  });

  it('armed source can be canceled from its own context menu', () => {
    renderInTableView();

    openMenuForRow('Alice');
    fireEvent.click(screen.getByText('Compare with…'));

    // Re-opening Alice's own menu offers a cancel action, not "compare with selected".
    openMenuForRow('Alice');
    expect(screen.queryByText('Compare with selected')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel compare selection'));

    // Armed state cleared: Alice's menu offers "Compare with…" again, and no
    // modal ever opened.
    openMenuForRow('Alice');
    expect(screen.getByText('Compare with…')).toBeInTheDocument();
    expect(screen.queryByTestId('document-diff-modal')).not.toBeInTheDocument();
  });

  it('re-arming with a different document replaces the pending compare source', () => {
    renderInTableView();

    openMenuForRow('Alice');
    fireEvent.click(screen.getByText('Compare with…'));

    // Arm Bob instead of finishing the compare with Alice — this should
    // replace Alice as the pending source.
    openMenuForRow('Bob');
    fireEvent.click(screen.getByText('Compare with… (replace selection)'));

    // Finishing the compare now pairs Bob with Carol, not Alice.
    openMenuForRow('Carol');
    fireEvent.click(screen.getByText('Compare with selected'));

    const modal = screen.getByTestId('document-diff-modal');
    expect(within(modal).getByTestId('diff-left')).toHaveTextContent(/"Bob"/);
    expect(within(modal).getByTestId('diff-right')).toHaveTextContent(/"Carol"/);
    expect(within(modal).queryByText(/"Alice"/)).not.toBeInTheDocument();
  });

  it('clears an armed compare source when the documents array is replaced (query re-run)', () => {
    const { rerender } = render(<DataGrid documents={docs} onEditDocument={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    // Arm Alice as the compare source.
    openMenuForRow('Alice');
    fireEvent.click(screen.getByText('Compare with…'));

    // Query re-run / paging / sorting replaces the documents array (same
    // instance, but a fresh reference — content can even be identical).
    const freshDocs = docs.map((d) => ({ ...d }));
    rerender(<DataGrid documents={freshDocs} onEditDocument={() => {}} />);

    // Bob's menu should offer only the plain arm action, not "Compare with
    // selected" — the old armed source must not survive the new result set.
    openMenuForRow('Bob');
    expect(screen.getByText('Compare with…')).toBeInTheDocument();
    expect(screen.queryByText('Compare with selected')).not.toBeInTheDocument();
  });
});

describe('DataGrid column resize', () => {
  it('renders a resize handle per table column and resizes with the keyboard', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    const handle = screen.getByLabelText('Resize name column');
    const headerCell = handle.parentElement as HTMLElement;
    expect(headerCell.style.width).toBe('180px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(headerCell.style.width).toBe('196px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(headerCell.style.width).toBe('164px');
  });

  it('resizes the tree view key column with the keyboard', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /tree/i }));
    const handle = screen.getByLabelText('Resize key column');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    const tree = screen.getByTestId('tree-view');
    expect(tree.style.getPropertyValue('--treetable-keyw')).toBe('336px');
  });

  it('resizes a table column by mouse drag', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    const handle = screen.getByLabelText('Resize name column');
    const headerCell = handle.parentElement as HTMLElement;
    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 360 });
    fireEvent.mouseUp(window);
    expect(headerCell.style.width).toBe('240px');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { resetResultsFindShortcutForTests } from '@/lib/resultsFindShortcut';

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

  it('copies an ObjectId cell as the raw hex, not the EJSON wrapper (#220)', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DataGrid documents={mockDocuments} onEditDocument={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    // The _id cell renders as the bare hex string; right-click it and copy.
    fireEvent.contextMenu(screen.getByText('603d779f4f102e3a185c3220'));
    fireEvent.click(screen.getByText('Copy value'));
    expect(writeText).toHaveBeenCalledWith('603d779f4f102e3a185c3220');
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

describe('DataGrid table header/body scroll sync (#219)', () => {
  it('keeps the header aligned by mirroring the body\'s horizontal scroll', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    const header = screen.getByTestId('table-header');
    const body = screen.getByTestId('table-body-scroll');

    // jsdom has no layout: fake the overflow that makes a box scrollable, since
    // only a horizontally-scrollable element is allowed to drive the header.
    const overflowing = (el: HTMLElement) => {
      Object.defineProperty(el, 'clientWidth', { value: 500, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: 1400, configurable: true });
    };
    overflowing(body);

    body.scrollLeft = 240;
    fireEvent.scroll(body);
    expect(header.scrollLeft).toBe(240);

    body.scrollLeft = 0;
    fireEvent.scroll(body);
    expect(header.scrollLeft).toBe(0);
  });

  it('syncs from the virtualized list\'s inner scroller too (scroll does not bubble)', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    const header = screen.getByTestId('table-header');
    const body = screen.getByTestId('table-body-scroll');
    // react-window renders its own overflow:auto element inside the wrapper; a
    // scroll there must still reach the header, which only works via capture.
    const inner = body.firstElementChild as HTMLElement;
    expect(inner).toBeTruthy();
    Object.defineProperty(inner, 'clientWidth', { value: 500, configurable: true });
    Object.defineProperty(inner, 'scrollWidth', { value: 1400, configurable: true });

    inner.scrollLeft = 310;
    fireEvent.scroll(inner);
    expect(header.scrollLeft).toBe(310);
  });

  it('ignores a purely vertical scroller so it cannot reset the header', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    const header = screen.getByTestId('table-header');
    const body = screen.getByTestId('table-body-scroll');
    Object.defineProperty(body, 'clientWidth', { value: 500, configurable: true });
    Object.defineProperty(body, 'scrollWidth', { value: 1400, configurable: true });
    body.scrollLeft = 200;
    fireEvent.scroll(body);
    expect(header.scrollLeft).toBe(200);

    // A sibling box that only scrolls vertically (scrollWidth == clientWidth)
    // must not drag the header back to 0.
    const inner = body.firstElementChild as HTMLElement;
    Object.defineProperty(inner, 'clientWidth', { value: 500, configurable: true });
    Object.defineProperty(inner, 'scrollWidth', { value: 500, configurable: true });
    inner.scrollLeft = 0;
    fireEvent.scroll(inner);
    expect(header.scrollLeft).toBe(200);
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

describe('view mode persistence (#218)', () => {
  const docs = [{ _id: '1', name: 'Alice' }];

  it('renders the view mode it is given instead of always defaulting to JSON', () => {
    // The results pane is `{tab.loading ? <spinner/> : <DataGrid/>}`, so the
    // grid unmounts on every run and its local viewMode reset to 'json'.
    // Given a viewMode it must honour it, which is what survives the remount.
    render(<DataGrid documents={docs} viewMode="table" onViewModeChange={() => {}} />);

    const table = screen.getByRole('button', { name: /table/i });
    expect(table.className).toContain('bg-accent');
  });

  it('reports a view mode change upward so the owner can store it on the tab', () => {
    const onViewModeChange = vi.fn();
    render(<DataGrid documents={docs} viewMode="json" onViewModeChange={onViewModeChange} />);

    fireEvent.click(screen.getByRole('button', { name: /tree/i }));

    expect(onViewModeChange).toHaveBeenCalledWith('tree');
  });

  it('still switches views on its own when no owner is managing it', () => {
    // MongoShell renders <DataGrid documents={...}/> with no view-mode props;
    // that path has to keep working uncontrolled.
    render(<DataGrid documents={docs} />);

    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    expect(screen.getByRole('button', { name: /table/i }).className).toContain('bg-accent');
  });
});

describe('local find over the loaded results (#279)', () => {
  // `fireEvent` wraps the dispatch in act(), so the state update flushes before
  // the assertion. A raw dispatchEvent does not.
  const pressFind = () => fireEvent.keyDown(document.body, { key: 'f', metaKey: true });

  it('is closed until Cmd/Ctrl+F asks for it', () => {
    render(<DataGrid documents={mockDocuments} />);
    expect(screen.queryByTestId('results-find-bar')).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'f' });
    expect(screen.queryByTestId('results-find-bar')).not.toBeInTheDocument();
  });

  it('opens on the shortcut and reports how many rows match', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();

    const input = screen.getByTestId('results-find-input');
    fireEvent.change(input, { target: { value: 'Electronics' } });
    // Two documents are in Electronics, one line each in the JSON view.
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 2');
  });

  it('says so when nothing matches', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    fireEvent.change(screen.getByTestId('results-find-input'), {
      target: { value: 'nothing-here' },
    });
    expect(screen.getByTestId('results-find-status')).toHaveTextContent(/no matches/i);
  });

  it('steps through matches with the buttons, wrapping at the end', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    fireEvent.change(screen.getByTestId('results-find-input'), {
      target: { value: 'Electronics' },
    });

    fireEvent.click(screen.getByTestId('results-find-next'));
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('2 of 2');
    fireEvent.click(screen.getByTestId('results-find-next'));
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByTestId('results-find-prev'));
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('2 of 2');
  });

  it('steps with Enter and Shift+Enter from the input', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    const input = screen.getByTestId('results-find-input');
    fireEvent.change(input, { target: { value: 'Electronics' } });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('2 of 2');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 2');
  });

  it('closes on Escape and forgets the query', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    const input = screen.getByTestId('results-find-input');
    fireEvent.change(input, { target: { value: 'Electronics' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('results-find-bar')).not.toBeInTheDocument();
    pressFind();
    expect(screen.getByTestId('results-find-input')).toHaveValue('');
  });

  it('closes on the close button', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    fireEvent.click(screen.getByTestId('results-find-close'));
    expect(screen.queryByTestId('results-find-bar')).not.toBeInTheDocument();
  });

  it('searches keys as well as values', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    fireEvent.change(screen.getByTestId('results-find-input'), { target: { value: 'category' } });
    // The key appears once per document.
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 3');
  });

  it('finds an ObjectId by its hex, as the grid displays it', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    fireEvent.change(screen.getByTestId('results-find-input'), {
      target: { value: '603d779f4f102e3a185c3221' },
    });
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
  });

  it('searches the table view too', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    pressFind();
    fireEvent.change(screen.getByTestId('results-find-input'), {
      target: { value: 'Electronics' },
    });
    // One cell per matching document, in the category column.
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 2');
  });

  it('searches the tree view too', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /tree/i }));
    pressFind();
    fireEvent.change(screen.getByTestId('results-find-input'), {
      target: { value: 'Electronics' },
    });
    expect(screen.getByTestId('results-find-status')).toHaveTextContent(/of 2/);
  });

  it('recounts when the view changes, since each view has its own rows', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    fireEvent.change(screen.getByTestId('results-find-input'), { target: { value: 'price' } });
    const inJson = screen.getByTestId('results-find-status').textContent;

    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    // The table has one `price` cell per row plus no key text, so the count is
    // allowed to differ — what matters is that it is recomputed, not stale.
    expect(screen.getByTestId('results-find-status').textContent).toBeTruthy();
    expect(inJson).toBeTruthy();
  });
});

describe('find indexes what each view actually displays (#280 review)', () => {
  beforeEach(() => resetResultsFindShortcutForTests());

  const pressFind = () => fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
  const search = (value: string) =>
    fireEvent.change(screen.getByTestId('results-find-input'), { target: { value } });

  it('finds the constructor name the JSON view renders, not just the scalar', () => {
    // The grid shows ObjectId("603d…"); "copy value" would yield the bare hex.
    // Searching the copy text made a visible `ObjectId` unfindable.
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    search('ObjectId');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 3');
  });

  it('finds a quoted string, since the JSON view renders the quotes', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    search('"Alice Smith"');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
  });

  it('finds an escape sequence as the two characters on screen', () => {
    render(<DataGrid documents={[{ note: 'first\nsecond' }]} />);
    pressFind();
    search('\\n');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
  });

  it('finds a table column heading exactly once, not once per row', () => {
    // Two defects met here: the heading was first counted in every cell (three
    // matches for one visible occurrence), then not indexed at all (no matches
    // for text plainly on screen). It is one cell, because it is one heading.
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    pressFind();
    search('category');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
  });

  it('lists a heading match ahead of the rows it labels', () => {
    // `name` is a heading and appears in no value, so a heading-only match must
    // not depend on any row matching. Stepping stays within the single match.
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    pressFind();
    search('name');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
    fireEvent.click(screen.getByTestId('results-find-next'));
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
  });

  it('highlights the matched heading in the header band', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    pressFind();
    search('category');

    const header = screen.getByTestId('table-header');
    const matched = Array.from(header.querySelectorAll('div')).filter((el) =>
      el.className.includes('bg-warning')
    );
    expect(matched.length).toBe(1);
    expect(matched[0].textContent).toContain('category');
  });

  it('does not crash stepping to a heading, which addresses no row', () => {
    // The header band is not a row in the virtualized list, and `scrollToRow`
    // throws on an out-of-range index.
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    pressFind();
    search('price');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
    expect(screen.getByTestId('results-find-bar')).toBeInTheDocument();
  });

  it('finds the table view’s ObjectId by the bare hex it displays', () => {
    // The table renders the backend's {$oid} as plain hex, so unlike the JSON
    // view a search for `ObjectId` finds nothing there — each view is indexed
    // as it is drawn.
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));
    pressFind();
    search('603d779f4f102e3a185c3221');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
    search('ObjectId');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent(/no matches/i);
  });

  it('searches the tree view’s type column', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /tree/i }));
    pressFind();
    search('ObjectId');
    // The key, the rendered value and the type label are all on screen.
    expect(screen.getByTestId('results-find-status')).not.toHaveTextContent(/no matches/i);
  });
});

describe('find shortcut routing across panes (#280 review)', () => {
  beforeEach(() => resetResultsFindShortcutForTests());

  it('routes to the pane whose toolbar was clicked', () => {
    // The registered root used to start below the toolbar, so selecting a pane
    // by its view-mode control pointed at no pane at all: with two mounted, the
    // keypress went nowhere or to the wrong one.
    const { container: paneA } = render(<DataGrid documents={mockDocuments} />);
    const { container: paneB } = render(<DataGrid documents={mockDocuments} />);

    const bTableButton = within(paneB).getAllByRole('button', { name: /table/i })[0];
    fireEvent.pointerDown(bTableButton);
    fireEvent.keyDown(document.body, { key: 'f', metaKey: true });

    expect(within(paneB).queryByTestId('results-find-bar')).toBeInTheDocument();
    expect(within(paneA).queryByTestId('results-find-bar')).not.toBeInTheDocument();
  });

  it('opens nothing when two panes are mounted and neither was selected', () => {
    const { container: paneA } = render(<DataGrid documents={mockDocuments} />);
    const { container: paneB } = render(<DataGrid documents={mockDocuments} />);

    fireEvent.keyDown(document.body, { key: 'f', metaKey: true });

    expect(within(paneA).queryByTestId('results-find-bar')).not.toBeInTheDocument();
    expect(within(paneB).queryByTestId('results-find-bar')).not.toBeInTheDocument();
  });

  it('closes and clears the bar when the pane leaves the results tab', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByTestId('results-find-input'), {
      target: { value: 'Electronics' },
    });

    fireEvent.click(screen.getByRole('button', { name: /explain/i }));
    expect(screen.queryByTestId('results-find-bar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /results/i }));
    expect(screen.queryByTestId('results-find-bar')).not.toBeInTheDocument();
  });
});

describe('find scrolls the matched table column into view (#280 review)', () => {
  beforeEach(() => resetResultsFindShortcutForTests());

  it('scrolls horizontally so the highlighted cell is on screen', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    // jsdom has no layout, so the overflow the real table has is stubbed: the
    // body is 1000px of content in a 300px viewport.
    const body = screen.getByTestId('table-body-scroll');
    let scrollLeft = 0;
    Object.defineProperty(body, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(body, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(body, 'scrollLeft', {
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
      configurable: true,
    });

    fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByTestId('results-find-input'), { target: { value: '349.5' } });

    // `price` is the 4th column: 48px gutter + 3 × 180px = 588, ending at 768.
    // Bringing its right edge into a 300px viewport means scrolling to 468.
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 1');
    expect(scrollLeft).toBe(468);
  });

  it('leaves the scroll alone for a column already on screen', () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /table/i }));

    const body = screen.getByTestId('table-body-scroll');
    let scrollLeft = 0;
    Object.defineProperty(body, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(body, 'clientWidth', { value: 900, configurable: true });
    Object.defineProperty(body, 'scrollLeft', {
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
      configurable: true,
    });

    fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByTestId('results-find-input'), { target: { value: '349.5' } });

    expect(scrollLeft).toBe(0);
  });
});

describe('find bar focus and type/value agreement (#280 review round 2)', () => {
  beforeEach(() => resetResultsFindShortcutForTests());

  const pressFind = () => fireEvent.keyDown(document.body, { key: 'f', metaKey: true });

  it('brings focus back to the field when the bar is already open', () => {
    // `setFindOpen(true)` is a no-op the second time, so focusing only on mount
    // left the caret on whatever the user had clicked and the typing went there.
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    const input = screen.getByTestId('results-find-input');
    expect(input).toHaveFocus();

    const elsewhere = screen.getByRole('button', { name: /table/i });
    elsewhere.focus();
    expect(input).not.toHaveFocus();

    pressFind();
    expect(screen.getByTestId('results-find-input')).toHaveFocus();
  });

  it('selects the existing query when the shortcut is pressed from the field', () => {
    // Dispatched from the input, which is where the event really comes from once
    // the bar has focus. Pressing from document.body passed while the real path
    // was suppressed as an ordinary text field.
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    const input = screen.getByTestId('results-find-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Electronics' } });

    fireEvent.keyDown(input, { key: 'f', metaKey: true });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Electronics'.length);
  });

  it('keeps the bar open and the query intact when pressed from the field', () => {
    render(<DataGrid documents={mockDocuments} />);
    pressFind();
    const input = screen.getByTestId('results-find-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Electronics' } });

    fireEvent.keyDown(input, { key: 'f', metaKey: true });
    expect(screen.getByTestId('results-find-bar')).toBeInTheDocument();
    expect(screen.getByTestId('results-find-input')).toHaveValue('Electronics');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 2');
  });

  it('labels a Timestamp consistently in the value and type columns', () => {
    // The value column renders from bsonDisplay's ordered table and the Type
    // column used to have its own order, so one row read `Timestamp(…)` in Value
    // and `Int64` in Type. The grid parses extended JSON, so the input is the
    // `$timestamp` shape the backend actually sends.
    render(<DataGrid documents={[{ ts: { $timestamp: { t: 1, i: 2 } } }]} />);
    fireEvent.click(screen.getByRole('button', { name: /tree/i }));

    expect(screen.getAllByText('Timestamp').length).toBeGreaterThan(0);
    expect(screen.queryByText('Int64')).not.toBeInTheDocument();
  });
});

describe('find does not leak folds from a stale active index (#280 review round 5)', () => {
  beforeEach(() => resetResultsFindShortcutForTests());

  // Folds at depth >= 2 start collapsed, so these three containers are closed
  // until a match inside one of them is revealed.
  const nested = [
    {
      g: {
        a: { akey: 'xx-one', az: 'zz-one' },
        b: { bkey: 'xx-two' },
        c: { cz: 'zz-two' },
      },
    },
  ];

  const pressFind = () => fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
  const search = (value: string) =>
    fireEvent.change(screen.getByTestId('results-find-input'), { target: { value } });

  // Read the fold's own state rather than looking for its children. The lists
  // are virtualized, so a descendant can be missing because it fell outside the
  // rendered window — an absence that says nothing about whether the fold is
  // open. The toggle's label does say it.
  const foldState = (keyName: string): 'open' | 'closed' => {
    const row = screen.getByTitle(keyName).closest('[data-doc-even]');
    if (!row) throw new Error(`row for ${keyName} is not rendered`);
    const button = row.querySelector('[data-testid="tree-fold-btn"]');
    if (!button) throw new Error(`${keyName} has no fold toggle`);
    const label = button.getAttribute('aria-label') ?? '';
    if (/expand/i.test(label)) return 'closed';
    if (/collapse/i.test(label)) return 'open';
    throw new Error(`unrecognised fold label: ${label}`);
  };

  it('starts with the nested folds closed, so a reveal is observable', () => {
    render(<DataGrid documents={nested} />);
    fireEvent.click(screen.getByRole('button', { name: /tree/i }));
    expect(foldState('a')).toBe('closed');
    expect(foldState('b')).toBe('closed');
  });

  it('opens the fold holding the active match', () => {
    render(<DataGrid documents={nested} />);
    fireEvent.click(screen.getByRole('button', { name: /tree/i }));
    pressFind();
    search('xx');
    expect(foldState('a')).toBe('open');
    expect(screen.getByText('akey')).toBeInTheDocument();
  });

  it('does not open the fold at the previous index when the query changes', () => {
    // `xx` matches inside a and b; stepping selects the second (b). `zz` then
    // matches inside a and c, so index 1 of the new list is inside c. Resetting
    // the index in an effect let the reveal run once with that stale index, and
    // c stayed open for the rest of the session.
    render(<DataGrid documents={nested} />);
    fireEvent.click(screen.getByRole('button', { name: /tree/i }));
    pressFind();

    search('xx');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByTestId('results-find-next'));
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('2 of 2');

    search('zz');
    expect(screen.getByTestId('results-find-status')).toHaveTextContent('1 of 2');
    // The first match is inside a, so a opens...
    expect(foldState('a')).toBe('open');
    // ...and c, which only the stale index pointed at, stays closed.
    expect(foldState('c')).toBe('closed');
  });
});

// #311: the JSON view is virtualized, so dragging a selection downwards
// unmounts the rows it started on. The browser's selection lives in the DOM, so
// by the time Cmd+C runs only the last screenful is left — and it copies
// silently, which is the worst part: the paste looks like a successful copy of
// the wrong thing.
describe('DataGrid — copying a JSON selection that scrolled (#311)', () => {
  const openJsonView = () => {
    render(<DataGrid documents={mockDocuments} />);
    fireEvent.click(screen.getByRole('button', { name: /json/i }));
    return screen.getByTestId('json-view');
  };

  /** A selection anchored on one rendered row and focused on another. */
  const selectionSpanning = (view: HTMLElement, from: number, to: number) =>
    ({
      isCollapsed: false,
      anchorNode: view.querySelector(`[data-json-line="${from}"]`),
      focusNode: view.querySelector(`[data-json-line="${to}"]`),
    }) as unknown as Selection;

  const copyFrom = (view: HTMLElement) => {
    const setData = vi.fn();
    fireEvent.copy(view, { clipboardData: { setData, getData: () => '' } });
    return setData;
  };

  it('rebuilds the full range from line data when rows were unmounted', () => {
    const view = openJsonView();
    expect(view.querySelectorAll('[data-json-line]').length).toBeGreaterThanOrEqual(4);
    const getSelection = vi.spyOn(document, 'getSelection');

    fireEvent.mouseDown(view);
    // The drag reached rows 0-3 while all of them were still mounted.
    getSelection.mockReturnValue(selectionSpanning(view, 0, 3));
    document.dispatchEvent(new Event('selectionchange'));
    // Scrolling has since dropped the top of that range; only 2-3 survive.
    getSelection.mockReturnValue(selectionSpanning(view, 2, 3));

    const setData = copyFrom(view);
    expect(setData).toHaveBeenCalledTimes(1);
    const [mime, text] = setData.mock.calls[0];
    expect(mime).toBe('text/plain');
    // All four lines, not just the two the DOM still had.
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('"Alice Smith"');
    getSelection.mockRestore();
  });

  it('keeps extending after the anchor row is unmounted (#319 review)', () => {
    // The sequence that actually happens, which the test below it originally
    // skipped: the drag records a range, THEN scrolling unmounts the row the
    // anchor sits on, and the drag continues. Resolving the two endpoints
    // together discarded every update from that point on, so the range froze
    // at the first screenful — the exact case this feature exists for.
    const view = openJsonView();
    const getSelection = vi.spyOn(document, 'getSelection');
    // A node the browser is left holding once its row is gone.
    const detached = document.createElement('span');

    fireEvent.mouseDown(view);
    getSelection.mockReturnValue(selectionSpanning(view, 0, 1));
    document.dispatchEvent(new Event('selectionchange'));

    // Row 0 has scrolled away; only the focus end still resolves.
    getSelection.mockReturnValue({
      isCollapsed: false,
      anchorNode: detached,
      focusNode: view.querySelector('[data-json-line="3"]'),
    } as unknown as Selection);
    document.dispatchEvent(new Event('selectionchange'));

    const setData = copyFrom(view);
    expect(setData).toHaveBeenCalledTimes(1);
    // 0 through 3 — the far end was still picked up with the anchor gone.
    expect(setData.mock.calls[0][1].split('\n')).toHaveLength(4);
    getSelection.mockRestore();
  });

  it('lets the range contract when the drag reverses (#319 review)', () => {
    // Dragging past a line and then back over it deselects it. A range that
    // could only grow kept those lines and copied them anyway — silently
    // adding text the user had explicitly removed, with every row mounted.
    const view = openJsonView();
    const getSelection = vi.spyOn(document, 'getSelection');

    fireEvent.mouseDown(view);
    getSelection.mockReturnValue(selectionSpanning(view, 0, 3));
    document.dispatchEvent(new Event('selectionchange'));
    // Reversing: the anchor stays on row 0, the focus comes back to row 1.
    getSelection.mockReturnValue(selectionSpanning(view, 0, 1));
    document.dispatchEvent(new Event('selectionchange'));

    // Nothing was lost, so the browser's own copy stands — and it is the
    // contracted one.
    expect(copyFrom(view)).not.toHaveBeenCalled();
    getSelection.mockRestore();
  });

  it('keeps the tracked range through a right-click (#319 review)', () => {
    // Right-clicking opens a menu over an existing selection rather than
    // replacing it. Resetting on any button threw the range away immediately
    // before the copy that needed it, so the fix only worked for Cmd+C.
    const view = openJsonView();
    const getSelection = vi.spyOn(document, 'getSelection');

    fireEvent.mouseDown(view, { button: 0 });
    getSelection.mockReturnValue(selectionSpanning(view, 0, 3));
    document.dispatchEvent(new Event('selectionchange'));
    getSelection.mockReturnValue(selectionSpanning(view, 2, 3));

    fireEvent.mouseDown(view, { button: 2 });

    const setData = copyFrom(view);
    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData.mock.calls[0][1].split('\n')).toHaveLength(4);
    getSelection.mockRestore();
  });

  it('leaves the browser alone when the whole selection is still mounted', () => {
    // Whole-line rebuilding cannot honour a partial line at either end, so it
    // must not take over a copy the browser can do exactly.
    const view = openJsonView();
    const getSelection = vi.spyOn(document, 'getSelection');

    fireEvent.mouseDown(view);
    getSelection.mockReturnValue(selectionSpanning(view, 1, 2));
    document.dispatchEvent(new Event('selectionchange'));

    expect(copyFrom(view)).not.toHaveBeenCalled();
    getSelection.mockRestore();
  });

  it('starts a fresh extent on the next drag', () => {
    // Without the mousedown reset the range would only ever grow, so an
    // unrelated later selection would copy everything since the first one.
    const view = openJsonView();
    const getSelection = vi.spyOn(document, 'getSelection');

    fireEvent.mouseDown(view);
    getSelection.mockReturnValue(selectionSpanning(view, 0, 4));
    document.dispatchEvent(new Event('selectionchange'));

    fireEvent.mouseDown(view);
    getSelection.mockReturnValue(selectionSpanning(view, 3, 4));
    document.dispatchEvent(new Event('selectionchange'));

    expect(copyFrom(view)).not.toHaveBeenCalled();
    getSelection.mockRestore();
  });

  it('ignores a selection that is not in the JSON view', () => {
    const view = openJsonView();
    const getSelection = vi.spyOn(document, 'getSelection');
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    fireEvent.mouseDown(view);
    getSelection.mockReturnValue({
      isCollapsed: false,
      anchorNode: outside,
      focusNode: outside,
    } as unknown as Selection);
    document.dispatchEvent(new Event('selectionchange'));

    expect(copyFrom(view)).not.toHaveBeenCalled();
    outside.remove();
    getSelection.mockRestore();
  });
});

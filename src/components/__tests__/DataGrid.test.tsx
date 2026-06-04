import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(screen.getByTestId('json-view')).toBeInTheDocument();
    // Line-number gutter starts at 1.
    expect(screen.getByText('1')).toBeInTheDocument();

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

  it('shows a Query Code tab with the formatted runnable command when queryCode is provided', () => {
    const code = 'db.products.aggregate([\n  {\n    "$count": "n"\n  }\n])';
    render(<DataGrid documents={mockDocuments} queryCode={code} />);

    // The tab appears and opens the formatted query code.
    fireEvent.click(screen.getByTestId('query-code-tab'));
    expect(screen.getByTestId('query-code-panel')).toBeInTheDocument();
    expect(screen.getByTestId('query-code-content').textContent).toBe(code);
  });

  it('hides the Query Code tab when no queryCode is provided', () => {
    render(<DataGrid documents={mockDocuments} />);
    expect(screen.queryByTestId('query-code-tab')).toBeNull();
  });

  it('opens the export workspace from the toolbar', () => {
    const onOpenExport = vi.fn();
    render(<DataGrid documents={mockDocuments} onOpenExport={onOpenExport} />);

    fireEvent.click(screen.getByTestId('export-btn'));
    expect(onOpenExport).toHaveBeenCalledTimes(1);
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
});

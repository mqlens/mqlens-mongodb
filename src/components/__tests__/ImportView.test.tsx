import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportView, detectImportFormat } from '../ImportView';

const renderImportView = (overrides: Record<string, unknown> = {}) => {
  const props = {
    connectionName: 'conn', databaseName: 'db', collectionName: 'coll',
    onPickFile: vi.fn().mockResolvedValue('/tmp/data.csv'),
    onRunImport: vi.fn(),
    ...overrides,
  };
  render(<ImportView {...(props as any)} />);
  return props;
};

describe('ImportView sources and options', () => {
  it('detects format from the picked file and allows override', async () => {
    renderImportView();
    fireEvent.click(screen.getByTestId('import-pick-file-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('import-file-path')).toHaveTextContent('/tmp/data.csv'));
    expect((screen.getByTestId('import-format-select') as HTMLSelectElement).value).toBe('csv');
    fireEvent.change(screen.getByTestId('import-format-select'), { target: { value: 'ndjson' } });
    expect(screen.queryByTestId('import-csv-delimiter')).not.toBeInTheDocument();
  });

  it('paste source disables BSON and enforces the 2MB cap note', () => {
    renderImportView();
    fireEvent.click(screen.getByTestId('import-source-paste'));
    const bson = screen.getByTestId('import-format-select').querySelector('option[value="bson"]');
    expect(bson).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('import-paste-textarea'), { target: { value: 'x'.repeat(10) } });
    expect(screen.queryByTestId('import-paste-cap-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('import-run-btn')).toBeEnabled();
    fireEvent.change(screen.getByTestId('import-paste-textarea'), {
      target: { value: 'x'.repeat(2_000_001) },
    });
    expect(screen.getByTestId('import-paste-cap-note')).toHaveTextContent('save it as a file');
    expect(screen.getByTestId('import-run-btn')).toBeDisabled();
  });

  it('run button gates on a chosen source and calls onRunImport with options and mode', async () => {
    const props = renderImportView();
    expect(screen.getByTestId('import-run-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('import-pick-file-btn'));
    await waitFor(() => expect(screen.getByTestId('import-run-btn')).toBeEnabled());
    fireEvent.change(screen.getByTestId('import-csv-delimiter'), { target: { value: ';' } });
    fireEvent.click(screen.getByTestId('import-mode-update'));
    fireEvent.click(screen.getByTestId('import-run-btn'));
    expect(props.onRunImport).toHaveBeenCalledWith(
      { path: '/tmp/data.csv' }, 'csv',
      expect.objectContaining({ delimiter: ';' }), 'update');
  });

  it('detectImportFormat maps extensions', () => {
    expect(detectImportFormat('/a/b.bson')).toBe('bson');
    expect(detectImportFormat('/a/b.CSV')).toBe('csv');
    expect(detectImportFormat('/a/b.jsonl')).toBe('ndjson');
    expect(detectImportFormat('/a/b.json')).toBe('json');
  });
});

describe('ImportView preview', () => {
  const csvPreview = {
    docs: ['{"a":"1","b":"x"}'], columns: ['a', 'b'], totalHint: null, error: null,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces and renders a CSV grid with type selects', async () => {
    vi.useFakeTimers();
    const onPreview = vi.fn().mockResolvedValue(csvPreview);
    renderImportView({ onPreview });
    fireEvent.click(screen.getByTestId('import-pick-file-btn'));
    await vi.waitFor(() => expect(screen.getByTestId('import-file-path')).toBeInTheDocument());
    expect(onPreview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(onPreview).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByTestId('import-preview-grid')).toBeInTheDocument());
    expect(screen.getByTestId('import-coltype-a')).toBeInTheDocument();
  });

  it('type select changes flow into onRunImport payload', async () => {
    const onPreview = vi.fn().mockResolvedValue(csvPreview);
    const props = renderImportView({ onPreview });
    fireEvent.click(screen.getByTestId('import-pick-file-btn'));
    await waitFor(() => expect(screen.queryByTestId('import-coltype-a')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('import-coltype-a'), { target: { value: 'number' } });
    fireEvent.click(screen.getByTestId('import-run-btn'));
    expect(props.onRunImport).toHaveBeenCalledWith(
      expect.anything(), 'csv',
      expect.objectContaining({ columnTypes: { a: 'number' } }),
      'skip');
  });

  it('ignores a stale preview response that resolves after a newer one', async () => {
    vi.useFakeTimers();
    let resolveA!: (value: typeof csvPreview) => void;
    let resolveB!: (value: typeof csvPreview) => void;
    const pA = new Promise<typeof csvPreview>((r) => {
      resolveA = r;
    });
    const pB = new Promise<typeof csvPreview>((r) => {
      resolveB = r;
    });
    const onPreview = vi.fn().mockReturnValueOnce(pA).mockReturnValueOnce(pB);
    renderImportView({ onPreview });

    // Request A: pick the file, let the debounce fire.
    fireEvent.click(screen.getByTestId('import-pick-file-btn'));
    await vi.waitFor(() => expect(screen.getByTestId('import-file-path')).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(350);
    expect(onPreview).toHaveBeenCalledTimes(1);

    // Request B: change the delimiter, let the debounce fire again.
    fireEvent.change(screen.getByTestId('import-csv-delimiter'), { target: { value: ';' } });
    await vi.advanceTimersByTimeAsync(350);
    expect(onPreview).toHaveBeenCalledTimes(2);

    vi.useRealTimers();

    // B resolves first, with the fresh content.
    resolveB({ docs: ['{"fresh":true}'], columns: [], totalHint: null, error: null });
    await waitFor(() =>
      expect(screen.getByTestId('import-preview-docs')).toHaveTextContent('fresh'));

    // A resolves late, with stale content — it must not overwrite B's result.
    resolveA({ docs: ['{"stale":true}'], columns: [], totalHint: null, error: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('import-preview-docs')).toHaveTextContent('fresh');
    expect(screen.getByTestId('import-preview-docs')).not.toHaveTextContent('stale');
  });

  it('renders parse errors inline and non-csv docs as a list', async () => {
    const onPreview = vi.fn().mockResolvedValue({
      docs: ['{"n":1}'], columns: [], totalHint: null, error: 'NDJSON line 2: Invalid JSON',
    });
    renderImportView({ onPreview, onPickFile: vi.fn().mockResolvedValue('/tmp/x.jsonl') });
    fireEvent.click(screen.getByTestId('import-pick-file-btn'));
    await waitFor(() => expect(screen.getByTestId('import-preview-error')).toHaveTextContent('line 2'));
    expect(screen.getByTestId('import-preview-docs')).toHaveTextContent('"n"');
  });
});

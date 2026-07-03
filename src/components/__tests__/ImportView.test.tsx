import { describe, it, expect, vi } from 'vitest';
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

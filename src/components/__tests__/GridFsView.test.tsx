import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GridFsView } from '../GridFsView';

const mockInvoke = vi.fn();
const mockSave = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: any[]) => mockSave(...args),
}));

// GridFsView consumes the in-app dialog system for toasts.
vi.mock('../dialogs/DialogProvider', () => ({
  useDialogs: () => ({ toast: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), choose: vi.fn() }),
}));

describe('GridFsView (M7 — GridFS browsing)', () => {
  beforeEach(() => vi.clearAllMocks());

  const files = [
    { id: '{"$oid":"aaa"}', filename: 'report.pdf', length: 2048, chunk_size_bytes: 261120, upload_date: '2026-01-02T10:00:00Z', content_type: 'application/pdf' },
    { id: '{"$oid":"bbb"}', filename: 'photo.jpg', length: 1048576, chunk_size_bytes: 261120, upload_date: '2026-01-03T10:00:00Z', content_type: 'image/jpeg' },
  ];

  it('lists files with formatted sizes', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify(files));
    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);

    expect(await screen.findByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('photo.jpg')).toBeInTheDocument();
    // 1048576 bytes -> "1 MB" (formatBytes); 2048 -> "2 KB"
    expect(screen.getByText(/1 MB/)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('list_gridfs_files', {
      id: 'c1',
      database: 'shop',
      bucket: 'uploads',
    });
  });

  it('downloads a file via the save dialog and the backend', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'list_gridfs_files' ? Promise.resolve(JSON.stringify(files)) : Promise.resolve(2048)
    );
    mockSave.mockResolvedValue('/home/me/report.pdf');
    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);

    await screen.findByText('report.pdf');
    fireEvent.click(screen.getAllByTestId('gridfs-download-btn')[0]);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('download_gridfs_file', {
        id: 'c1',
        database: 'shop',
        bucket: 'uploads',
        fileId: '{"$oid":"aaa"}',
        destPath: '/home/me/report.pdf',
      })
    );
  });

  it('does not download when the save dialog is cancelled', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify(files));
    mockSave.mockResolvedValue(null);
    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);

    await screen.findByText('report.pdf');
    fireEvent.click(screen.getAllByTestId('gridfs-download-btn')[0]);

    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalledWith('download_gridfs_file', expect.anything());
  });

  it('shows an error state when listing fails', async () => {
    mockInvoke.mockRejectedValue('GridFS is not supported on mock connections');
    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);
    expect(await screen.findByText(/not supported on mock/)).toBeInTheDocument();
  });
});

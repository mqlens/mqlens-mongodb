import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GridFsView } from '../GridFsView';

const mockInvoke = vi.fn();
const mockSave = vi.fn();
const mockOpen = vi.fn();
const mockConfirm = vi.fn();
const mockPrompt = vi.fn();
const mockChoose = vi.fn();
const mockToast = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  Channel: class {
    onmessage: ((update: any) => void) | null = null;
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: any[]) => mockSave(...args),
  open: (...args: any[]) => mockOpen(...args),
}));

vi.mock('../dialogs/DialogProvider', () => ({
  useDialogs: () => ({
    toast: mockToast,
    confirm: mockConfirm,
    prompt: mockPrompt,
    choose: mockChoose,
  }),
}));

describe('GridFsView (M7 — GridFS browsing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    mockChoose.mockResolvedValue('skip');
    mockPrompt.mockImplementation(async ({ defaultValue }: { defaultValue?: string }) => defaultValue ?? 'file.bin');
  });

  const files = [
    { id: '{"$oid":"aaa"}', filename: 'report.pdf', length: 2048, chunk_size_bytes: 261120, upload_date: '2026-01-02T10:00:00Z', content_type: 'application/pdf' },
    { id: '{"$oid":"bbb"}', filename: 'photo.jpg', length: 1048576, chunk_size_bytes: 261120, upload_date: '2026-01-03T10:00:00Z', content_type: 'image/jpeg' },
  ];

  it('lists files with formatted sizes', async () => {
    mockInvoke.mockResolvedValue(JSON.stringify(files));
    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);

    expect(await screen.findByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('photo.jpg')).toBeInTheDocument();
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
      expect(mockInvoke).toHaveBeenCalledWith('download_gridfs_file', expect.objectContaining({
        id: 'c1',
        database: 'shop',
        bucket: 'uploads',
        fileId: '{"$oid":"aaa"}',
        destPath: '/home/me/report.pdf',
        totalBytes: 2048,
        onProgress: expect.any(Object),
      }))
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

  it('uploads a file selected from the open dialog', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_gridfs_files') return Promise.resolve(JSON.stringify(files));
      if (cmd === 'upload_gridfs_file') return Promise.resolve('{"$oid":"new"}');
      return Promise.resolve(undefined);
    });
    mockOpen.mockResolvedValue('/tmp/report.pdf');

    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);
    await screen.findByText('report.pdf');
    fireEvent.click(screen.getByTestId('gridfs-upload-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('upload_gridfs_file', expect.objectContaining({
        id: 'c1',
        database: 'shop',
        bucket: 'uploads',
        sourcePath: '/tmp/report.pdf',
        filename: 'report.pdf',
        metadataJson: null,
        contentType: null,
        onProgress: expect.any(Object),
      }))
    );
    expect(mockToast).toHaveBeenCalledWith('Uploaded report.pdf', 'success');
  });

  it('uploads with optional metadata JSON', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_gridfs_files') return Promise.resolve(JSON.stringify(files));
      if (cmd === 'upload_gridfs_file') return Promise.resolve('{"$oid":"new"}');
      return Promise.resolve(undefined);
    });
    mockOpen.mockResolvedValue('/tmp/report.pdf');
    mockChoose.mockResolvedValue('add');
    mockPrompt
      .mockResolvedValueOnce('report.pdf')
      .mockResolvedValueOnce('{"source":"manual"}');

    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);
    await screen.findByText('report.pdf');
    fireEvent.click(screen.getByTestId('gridfs-upload-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('upload_gridfs_file', expect.objectContaining({
        metadataJson: '{"source":"manual"}',
      }))
    );
  });

  it('deletes a file after confirmation', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_gridfs_files') return Promise.resolve(JSON.stringify(files));
      if (cmd === 'delete_gridfs_file') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);
    await screen.findByText('report.pdf');
    fireEvent.click(screen.getAllByTestId('gridfs-delete-btn')[0]);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('delete_gridfs_file', {
        id: 'c1',
        database: 'shop',
        bucket: 'uploads',
        fileId: '{"$oid":"aaa"}',
      })
    );
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith('Deleted report.pdf', 'success');
  });

  it('does not delete when confirmation is cancelled', async () => {
    mockConfirm.mockResolvedValue(false);
    mockInvoke.mockResolvedValue(JSON.stringify(files));
    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);

    await screen.findByText('report.pdf');
    fireEvent.click(screen.getAllByTestId('gridfs-delete-btn')[0]);

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalledWith('delete_gridfs_file', expect.anything());
  });

  it('shows an error state when listing fails', async () => {
    mockInvoke.mockRejectedValue('GridFS is not supported on mock connections');
    render(<GridFsView connectionId="c1" databaseName="shop" bucket="uploads" />);
    expect(await screen.findByText(/not supported on mock/)).toBeInTheDocument();
  });
});

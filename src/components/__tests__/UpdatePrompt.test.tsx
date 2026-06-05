import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockCheck = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => mockCheck() }));
const mockRelaunch = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => mockRelaunch() }));

import { UpdatePrompt, CHECK_UPDATE_EVENT } from '../UpdatePrompt';

const triggerManualCheck = () => fireEvent(window, new Event(CHECK_UPDATE_EVENT));

beforeEach(() => {
  mockCheck.mockReset();
  mockRelaunch.mockClear();
});

describe('UpdatePrompt', () => {
  it('shows "latest version" on a manual check when up to date', async () => {
    mockCheck.mockResolvedValue(null);
    render(<UpdatePrompt />);
    triggerManualCheck();
    expect(await screen.findByTestId('update-toast')).toHaveTextContent(/latest version/i);
  });

  it('prompts for approval and installs only after clicking Update now', async () => {
    const downloadAndInstall = vi.fn(async (cb: (e: any) => void) => {
      cb({ event: 'Started', data: { contentLength: 100 } });
      cb({ event: 'Progress', data: { chunkLength: 100 } });
      cb({ event: 'Finished' });
    });
    mockCheck.mockResolvedValue({ version: '0.3.0', currentVersion: '0.2.0', body: 'New stuff', downloadAndInstall });

    render(<UpdatePrompt />);
    triggerManualCheck();

    const dialog = await screen.findByTestId('update-dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('update-version')).toHaveTextContent('0.3.0');
    // Nothing installed until approval.
    expect(downloadAndInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('update-now'));
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalled());
    await waitFor(() => expect(mockRelaunch).toHaveBeenCalled());
  });

  it('dismisses with Later without installing', async () => {
    const downloadAndInstall = vi.fn();
    mockCheck.mockResolvedValue({ version: '0.3.0', currentVersion: '0.2.0', body: '', downloadAndInstall });
    render(<UpdatePrompt />);
    triggerManualCheck();
    fireEvent.click(await screen.findByTestId('update-later'));
    expect(screen.queryByTestId('update-dialog')).toBeNull();
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });
});

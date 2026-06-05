import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
const mockRelaunch = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => mockRelaunch() }));

import { UpdatePrompt, CHECK_UPDATE_EVENT } from '../UpdatePrompt';

const triggerManualCheck = () => fireEvent(window, new Event(CHECK_UPDATE_EVENT));

// Route invoke() by command name; load_app_settings always returns a stable channel.
function routeInvoke(map: Record<string, unknown>) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'load_app_settings') return Promise.resolve({ update_channel: 'stable' });
    if (cmd in map) {
      const v = map[cmd];
      return typeof v === 'function' ? (v as () => unknown)() : Promise.resolve(v);
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  mockRelaunch.mockClear();
});

describe('UpdatePrompt', () => {
  it('shows "latest version" on a manual check when up to date', async () => {
    routeInvoke({ update_check: null });
    render(<UpdatePrompt />);
    triggerManualCheck();
    expect(await screen.findByTestId('update-toast')).toHaveTextContent(/latest version/i);
  });

  it('prompts for approval and installs only after clicking Update now', async () => {
    const installFn = vi.fn(() => Promise.resolve());
    routeInvoke({
      update_check: { version: '0.3.0', current_version: '0.2.0', notes: 'New stuff', date: null },
      update_install: installFn,
    });

    render(<UpdatePrompt />);
    triggerManualCheck();

    const dialog = await screen.findByTestId('update-dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('update-version')).toHaveTextContent('0.3.0');
    // Nothing installed until approval.
    expect(installFn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('update-now'));
    await waitFor(() => expect(installFn).toHaveBeenCalled());
    await waitFor(() => expect(mockRelaunch).toHaveBeenCalled());
  });

  it('dismisses with Later without installing', async () => {
    const installFn = vi.fn(() => Promise.resolve());
    routeInvoke({
      update_check: { version: '0.3.0', current_version: '0.2.0', notes: '', date: null },
      update_install: installFn,
    });
    render(<UpdatePrompt />);
    triggerManualCheck();
    fireEvent.click(await screen.findByTestId('update-later'));
    expect(screen.queryByTestId('update-dialog')).toBeNull();
    expect(installFn).not.toHaveBeenCalled();
  });
});

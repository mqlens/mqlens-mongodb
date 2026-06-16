import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readUpdateCheckSnapshot } from '../../lib/updateCheckState';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
const mockRelaunch = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => mockRelaunch() }));
const mockOpenUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => mockOpenUrl(url) }));

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
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
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

  it('renders release-note markdown as headings, bullets, and links', async () => {
    routeInvoke({
      update_check: {
        version: '0.3.0',
        current_version: '0.2.0',
        notes: '### Features\n- add **user management** (`createUser`)\n- tree view\n\n### Fixes\n- dialog polish ([#109](https://github.com/mqlens/mqlens-mongodb/pull/109))',
        date: null,
      },
    });
    render(<UpdatePrompt />);
    triggerManualCheck();

    const notes = await screen.findByTestId('update-notes');
    // No raw markdown markers survive…
    expect(notes.textContent).not.toMatch(/###|\*\*|\[#109\]\(/);
    // …structure does: headings, list items, bold, code, and a link.
    expect(notes.querySelectorAll('h4')).toHaveLength(2);
    expect(notes.querySelectorAll('li')).toHaveLength(3);
    expect(notes.querySelector('strong')).toHaveTextContent('user management');
    expect(notes.querySelector('code')).toHaveTextContent('createUser');
    const link = notes.querySelector('a')!;
    expect(link).toHaveTextContent('#109');
    fireEvent.click(link);
    expect(mockOpenUrl).toHaveBeenCalledWith('https://github.com/mqlens/mqlens-mongodb/pull/109');
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

  it('shows an offline message on manual check when navigator is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    routeInvoke({ update_check: null });
    render(<UpdatePrompt />);
    triggerManualCheck();
    expect(await screen.findByTestId('update-toast')).toHaveTextContent(/offline/i);
    expect(readUpdateCheckSnapshot()?.result).toBe('offline');
  });

  it('shows a server error message on manual check failure', async () => {
    routeInvoke({ update_check: () => Promise.reject(new Error('invalid signature')) });
    render(<UpdatePrompt />);
    triggerManualCheck();
    expect(await screen.findByText(/update server/i)).toBeInTheDocument();
    await waitFor(() => expect(readUpdateCheckSnapshot()?.result).toBe('check-failed'));
  });

  it('records offline on startup without showing a toast', async () => {
    vi.useFakeTimers();
    routeInvoke({ update_check: () => Promise.reject(new Error('network timeout')) });
    render(<UpdatePrompt />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(readUpdateCheckSnapshot()?.result).toBe('offline');
    expect(screen.queryByTestId('update-toast')).toBeNull();
  });
});

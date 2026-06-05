import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuickStart } from '../QuickStart';
import type { ConnectionProfile } from '../../lib/connection';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/path', () => ({ appConfigDir: () => Promise.resolve('/tmp/MQLens') }));

const profiles: ConnectionProfile[] = [
  { id: 'b', name: 'beta', uri: 'mongodb://localhost:27017' },
  { id: 'a', name: 'alpha', uri: 'mongodb+srv://a.x9k2.mongodb.net/db' },
];

function setup(over: Partial<React.ComponentProps<typeof QuickStart>> = {}) {
  return render(
    <QuickStart
      onConnect={vi.fn()}
      onOpenSettings={vi.fn()}
      onQuickConnect={vi.fn()}
      onLoadSampleData={vi.fn()}
      activeConnections={[]}
      profilesRefreshKey={0}
      {...over}
    />
  );
}

describe('QuickStart', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the empty state and Load Sample Data when there are no profiles', async () => {
    invokeMock.mockResolvedValueOnce([]);
    setup();
    expect(await screen.findByText('No saved connections yet')).toBeInTheDocument();
    expect(screen.getByTestId('qs-load-sample')).toBeInTheDocument();
  });

  it('renders one card per profile, sorted by name, and hides Load Sample Data', async () => {
    invokeMock.mockResolvedValueOnce(profiles);
    setup();
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.queryByTestId('qs-load-sample')).not.toBeInTheDocument();
    const names = screen.getAllByTestId(/conn-card-/).map((n) => n.querySelector('.mql-qs-card-name')?.textContent);
    expect(names[0]).toContain('alpha'); // alphabetical
  });

  it('calls onQuickConnect with the clicked profile', async () => {
    invokeMock.mockResolvedValueOnce(profiles);
    const onQuickConnect = vi.fn();
    setup({ onQuickConnect });
    fireEvent.click(await screen.findByTestId('conn-card-a'));
    expect(onQuickConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('marks a profile Connected when it is active', async () => {
    invokeMock.mockResolvedValueOnce(profiles);
    setup({ activeConnections: [{ profileId: 'a' }] });
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('fires onLoadSampleData from the empty state', async () => {
    invokeMock.mockResolvedValueOnce([]);
    const onLoadSampleData = vi.fn();
    setup({ onLoadSampleData });
    fireEvent.click(await screen.findByTestId('qs-load-sample'));
    expect(onLoadSampleData).toHaveBeenCalled();
  });
});

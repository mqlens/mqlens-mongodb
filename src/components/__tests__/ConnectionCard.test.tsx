import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionCard } from '../ConnectionCard';
import type { ConnectionProfile } from '../../lib/connection';

const base: ConnectionProfile = { id: 'p1', name: 'prod-east', uri: 'mongodb+srv://prod.x9k2.mongodb.net/db' };

describe('ConnectionCard', () => {
  it('renders name and parsed host', () => {
    render(<ConnectionCard profile={base} connected={false} connecting={false} onConnect={vi.fn()} />);
    expect(screen.getByText('prod-east')).toBeInTheDocument();
    expect(screen.getByText('prod.x9k2.mongodb.net')).toBeInTheDocument();
  });

  it('shows SRV badge for srv uris', () => {
    render(<ConnectionCard profile={base} connected={false} connecting={false} onConnect={vi.fn()} />);
    expect(screen.getByText('SRV')).toBeInTheDocument();
  });

  it('shows SSH badge when ssh is enabled', () => {
    const p = { ...base, ssh: { enabled: true, host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 'x' } } } as ConnectionProfile;
    render(<ConnectionCard profile={p} connected={false} connecting={false} onConnect={vi.fn()} />);
    expect(screen.getByText('SSH')).toBeInTheDocument();
  });

  it('calls onConnect with the profile when clicked and not connected', () => {
    const onConnect = vi.fn();
    render(<ConnectionCard profile={base} connected={false} connecting={false} onConnect={onConnect} />);
    fireEvent.click(screen.getByTestId('conn-card-p1'));
    expect(onConnect).toHaveBeenCalledWith(base);
  });

  it('shows Connected and does not call onConnect when already connected', () => {
    const onConnect = vi.fn();
    render(<ConnectionCard profile={base} connected={true} connecting={false} onConnect={onConnect} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('conn-card-p1'));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('disables the button while connecting', () => {
    render(<ConnectionCard profile={base} connected={false} connecting={true} onConnect={vi.fn()} />);
    expect(screen.getByTestId('conn-card-p1')).toBeDisabled();
  });
});

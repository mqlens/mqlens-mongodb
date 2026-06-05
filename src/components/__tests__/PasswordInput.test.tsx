import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PasswordInput } from '../PasswordInput';

describe('PasswordInput', () => {
  it('masks by default and toggles visibility', () => {
    render(<PasswordInput data-testid="pw" value="secret" onChange={() => {}} />);
    const input = screen.getByTestId('pw') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: /show password/i }));
    expect(input.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: /hide password/i }));
    expect(input.type).toBe('password');
  });

  it('forwards value and onChange', () => {
    const onChange = vi.fn();
    render(<PasswordInput data-testid="pw" value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('pw'), { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalled();
  });
});

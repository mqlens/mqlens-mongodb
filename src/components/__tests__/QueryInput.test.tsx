import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryInput } from '../QueryInput';

function setup(value = '') {
  const onChange = vi.fn();
  render(
    <QueryInput surface="filter" value={value} onChange={onChange} fields={['region', 'plan']} data-testid="q" />,
  );
  return { onChange, input: screen.getByTestId('q') as HTMLInputElement };
}

describe('QueryInput', () => {
  it('shows field suggestions while typing a key', () => {
    const { input } = setup('{ ');
    fireEvent.change(input, { target: { value: '{ reg' } });
    expect(screen.getByText('region')).toBeTruthy();
  });

  it('accepts a suggestion with Enter, replacing the token', () => {
    const { input, onChange } = setup('{ ');
    fireEvent.change(input, { target: { value: '{ reg' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last).toContain('region');
  });

  it('dismisses the dropdown on Escape', () => {
    const { input } = setup('{ ');
    fireEvent.change(input, { target: { value: '{ reg' } });
    expect(screen.queryByText('region')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('region')).toBeNull();
  });
});

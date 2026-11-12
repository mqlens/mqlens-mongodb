import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The editor wraps @monaco-editor/react; mock it with a plain <textarea> that
// shows whichever value the editor was given and reports changes back.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, defaultValue, onChange, wrapperProps }: any) => (
    <textarea
      data-testid={wrapperProps?.['data-testid']}
      value={value ?? defaultValue}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

import { UpdateManyModal } from '../UpdateManyModal';

const props = {
  isOpen: true,
  filter: '{"tier":"pro"}',
  count: 3,
  onClose: () => {},
  onSubmit: () => {},
};

describe('UpdateManyModal', () => {
  it('shows the filter and the number of documents it will update', () => {
    render(<UpdateManyModal {...props} />);
    const target = screen.getByTestId('update-many-target');
    expect(target).toHaveTextContent('3');
    expect(target).toHaveTextContent('{"tier":"pro"}');
  });

  it('does not cover the app with a scrim', () => {
    const { baseElement } = render(<UpdateManyModal {...props} />);
    expect(baseElement.querySelector('.fixed.inset-0')).toBeNull();
    expect(screen.getByTestId('update-many-modal')).toBeInTheDocument();
  });

  it('takes a multi-line update in shell syntax and submits it as Extended JSON', () => {
    const onSubmit = vi.fn();
    render(<UpdateManyModal {...props} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('update-many-editor'), {
      target: { value: '{\n  $set: {\n    lastSeen: ISODate("2024-01-01"),\n    tier: "gold"\n  }\n}' },
    });
    fireEvent.click(screen.getByTestId('update-many-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({
      $set: { lastSeen: { $date: '2024-01-01T00:00:00Z' }, tier: 'gold' },
    });
  });

  it('refuses an update that does not use operators', () => {
    const onSubmit = vi.fn();
    render(<UpdateManyModal {...props} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('update-many-editor'), { target: { value: '{ tier: "gold" }' } });
    expect(screen.getByTestId('update-many-error')).toHaveTextContent('Update must use operators like $set');
    expect(screen.getByTestId('update-many-submit')).toBeDisabled();
    fireEvent.click(screen.getByTestId('update-many-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('scrolls a long filter in a bounded area, so the editor keeps its room', () => {
    const filter = JSON.stringify({ _id: { $in: Array.from({ length: 400 }, (_, i) => i) } });
    render(<UpdateManyModal {...props} filter={filter} />);
    const target = screen.getByTestId('update-many-target');
    expect(target.className).toMatch(/\bmax-h-\S+/);
    expect(target).toHaveClass('overflow-y-auto');
  });

  it('keeps the draft while hidden and shows it again', () => {
    const { rerender } = render(<UpdateManyModal {...props} />);
    fireEvent.change(screen.getByTestId('update-many-editor'), { target: { value: '{ $set: { tier: "Gold" } }' } });
    rerender(<UpdateManyModal {...props} isOpen={false} />);
    expect(screen.queryByTestId('update-many-modal')).toBeNull();
    rerender(<UpdateManyModal {...props} />);
    expect(screen.getByTestId('update-many-editor')).toHaveValue('{ $set: { tier: "Gold" } }');
  });

  it('warns when an empty filter means every document', () => {
    render(<UpdateManyModal {...props} filter="{}" count={1} />);
    expect(screen.getByTestId('update-many-target')).toHaveTextContent('This affects the only document in the collection');
  });
});

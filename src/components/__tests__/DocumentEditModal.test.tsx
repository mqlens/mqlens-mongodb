import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The modal's JSON editor wraps @monaco-editor/react; mock it with a plain
// <textarea> that exposes the test id via wrapperProps and round-trips value.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, wrapperProps }: any) => (
    <textarea
      data-testid={wrapperProps?.['data-testid']}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

import { DocumentEditModal } from '../DocumentEditModal';

describe('DocumentEditModal', () => {
  it('calls onSave with the JSON text when valid', () => {
    const onSave = vi.fn();
    render(
      <DocumentEditModal
        isOpen
        mode="insert"
        initialJson="{}"
        onClose={() => {}}
        onSave={onSave}
      />
    );

    const input = screen.getByTestId('document-json-input');
    fireEvent.change(input, { target: { value: '{"name":"Ada"}' } });
    fireEvent.click(screen.getByTestId('document-save-btn'));

    expect(onSave).toHaveBeenCalledWith('{"name":"Ada"}');
  });

  it('blocks save and shows an error for invalid JSON', () => {
    const onSave = vi.fn();
    render(
      <DocumentEditModal
        isOpen
        mode="insert"
        initialJson="{}"
        onClose={() => {}}
        onSave={onSave}
      />
    );

    const input = screen.getByTestId('document-json-input');
    fireEvent.change(input, { target: { value: '{ not valid' } });
    fireEvent.click(screen.getByTestId('document-save-btn'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('document-edit-error')).toBeInTheDocument();
  });

  it('rejects non-object JSON (arrays/primitives)', () => {
    const onSave = vi.fn();
    render(
      <DocumentEditModal
        isOpen
        mode="insert"
        initialJson="{}"
        onClose={() => {}}
        onSave={onSave}
      />
    );

    const input = screen.getByTestId('document-json-input');
    fireEvent.change(input, { target: { value: '[1,2,3]' } });
    fireEvent.click(screen.getByTestId('document-save-btn'));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('document-edit-error')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <DocumentEditModal
        isOpen={false}
        mode="insert"
        initialJson="{}"
        onClose={() => {}}
        onSave={() => {}}
      />
    );
    expect(screen.queryByTestId('document-edit-modal')).not.toBeInTheDocument();
  });
});

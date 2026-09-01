import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

  it('accepts shell types and saves converted Extended JSON', () => {
    const onSave = vi.fn();
    render(<DocumentEditModal isOpen mode="insert" initialJson="{}" onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByTestId('document-json-input'), {
      target: { value: '{ "_id": ObjectId("507f1f77bcf86cd799439011") }' },
    });
    expect(screen.queryByTestId('document-edit-error')).toBeNull();
    fireEvent.click(screen.getByTestId('document-save-btn'));
    expect(onSave).toHaveBeenCalledWith('{ "_id": {"$oid":"507f1f77bcf86cd799439011"} }');
  });

  it('flags malformed input (live) and disables Save', () => {
    const onSave = vi.fn();
    render(<DocumentEditModal isOpen mode="edit" initialJson="{}" onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByTestId('document-json-input'), { target: { value: '{ "a": 1, j }' } });
    expect(screen.getByTestId('document-edit-error')).toBeInTheDocument();
    expect(screen.getByTestId('document-save-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('document-save-btn'));
    expect(onSave).not.toHaveBeenCalled();
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

// #277: the edit dialog was a modal held in one app-wide slot, so it blocked
// the whole window and one edit existed at a time. Editing a document is
// exactly when you want to glance at another tab — to compare a field or copy
// an id — and doing so cost you what you had typed.
describe('DocumentEditModal — an edit belongs to its tab (#277)', () => {
  const props = {
    isOpen: true,
    mode: 'edit' as const,
    initialJson: '{ "a": 1 }',
    onClose: vi.fn(),
    onSave: vi.fn(),
  };

  it('reports edits instead of keeping them, when the caller owns the text', () => {
    const onJsonChange = vi.fn();
    render(<DocumentEditModal {...props} json='{ "a": 1 }' onJsonChange={onJsonChange} />);
    fireEvent.change(screen.getByTestId('document-json-input'), {
      target: { value: '{ "a": 2 }' },
    });
    expect(onJsonChange).toHaveBeenCalledWith('{ "a": 2 }');
  });

  it('restores a draft rather than resetting it when it reappears', () => {
    // Leaving the tab unmounts this; coming back mounts it again. If reopening
    // reset the text to initialJson, the unsaved work would be gone — which is
    // the whole point of the change.
    const { rerender } = render(
      <DocumentEditModal {...props} isOpen={false} json='{ "a": 2 }' onJsonChange={vi.fn()} />
    );
    rerender(<DocumentEditModal {...props} isOpen json='{ "a": 2 }' onJsonChange={vi.fn()} />);
    expect(screen.getByTestId('document-json-input')).toHaveValue('{ "a": 2 }');
  });

  it('still resets its own text when nobody else owns it', () => {
    // The uncontrolled contract is unchanged: reopening starts fresh.
    const { rerender } = render(<DocumentEditModal {...props} isOpen={false} />);
    rerender(<DocumentEditModal {...props} isOpen />);
    expect(screen.getByTestId('document-json-input')).toHaveValue('{ "a": 1 }');
  });

  it('does not cover the app with a blocking scrim', () => {
    // Non-modal is what lets another tab be used while this is open. The
    // overlay is Radix's `bg-black/80` element; asserting it is *hidden* rather
    // than merely absent keeps this honest — an empty query would pass whether
    // or not the scrim were there.
    const { baseElement } = render(<DocumentEditModal {...props} />);
    // Radix omits the overlay entirely outside modal mode, so the assertion is
    // that no scrim exists at all. It fails on the modal version, where the
    // `bg-black/80` element is present and covering the app.
    expect(baseElement.querySelector('.fixed.inset-0')).toBeNull();
    expect(screen.getByTestId('document-edit-modal')).toBeInTheDocument();
  });
});

// #326 review: with two tabs each holding an edit, this component stays mounted
// as the user moves between them. `isOpen` and `initialJson` cannot tell those
// edits apart — two inserts share the same initial text — so transient state
// followed the user from one edit to the other.
describe('DocumentEditModal — transient state does not cross edits (#326 review)', () => {
  const base = {
    isOpen: true as const,
    mode: 'insert' as const,
    initialJson: '{\n  \n}',
    onClose: vi.fn(),
  };

  it('clears the saving flag after a successful save', () => {
    // It was only ever cleared on failure. Invisible while a save closed the
    // dialog, and permanent once another tab's edit keeps it mounted: the Save
    // button stayed disabled with no way back.
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DocumentEditModal {...base} onSave={onSave} json='{"a":1}' onJsonChange={vi.fn()} editKey="tab-a" />
    );
    const save = screen.getByTestId('document-save-btn');
    fireEvent.click(save);
    return waitFor(() => expect(save).not.toBeDisabled());
  });

  it('drops an error when the user moves to another tab\'s edit', () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    const { rerender } = render(
      <DocumentEditModal {...base} onSave={onSave} json='{"a":1}' onJsonChange={vi.fn()} editKey="tab-a" />
    );
    fireEvent.click(screen.getByTestId('document-save-btn'));
    return waitFor(() => expect(screen.getByTestId('document-edit-error')).toBeInTheDocument()).then(() => {
      // Same isOpen, same initialJson — only the owning tab differs.
      rerender(
        <DocumentEditModal {...base} onSave={onSave} json='{"b":2}' onJsonChange={vi.fn()} editKey="tab-b" />
      );
      expect(screen.queryByTestId('document-edit-error')).not.toBeInTheDocument();
    });
  });
});

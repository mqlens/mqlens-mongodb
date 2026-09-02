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

// #326 review: the error and the pending save are the caller's now. This
// dialog is a view of whichever tab is active — it unmounts when the user
// looks elsewhere and remounts on the way back — so state that has to outlive
// that cannot live here. Three attempts to keep it here each failed the same
// way, the last because `isOpen` and `initialJson` cannot tell a new edit from
// an old one returning to view. What this dialog still owes is showing them.
describe('DocumentEditModal — reports the save state it is given (#326 review)', () => {
  const base = {
    isOpen: true as const,
    mode: 'insert' as const,
    initialJson: '{\n  \n}',
    onClose: vi.fn(),
    onJsonChange: vi.fn(),
  };

  it('shows the failure it is handed, and drops it when the caller does', () => {
    const { rerender } = render(
      <DocumentEditModal {...base} onSave={vi.fn()} json='{"a":1}' error="boom" />
    );
    expect(screen.getByTestId('document-edit-error')).toHaveTextContent('boom');
    rerender(<DocumentEditModal {...base} onSave={vi.fn()} json='{"a":1}' error={null} />);
    expect(screen.queryByTestId('document-edit-error')).toBeNull();
  });

  it('refuses a second submit while the caller reports one in flight', () => {
    // Two inserts would write the document twice, so this is the guard that
    // matters — and it holds however the user got here, because the answer
    // comes from the edit rather than from anything this component remembers.
    const onSave = vi.fn();
    render(<DocumentEditModal {...base} onSave={onSave} json='{"a":1}' saving />);
    const save = screen.getByTestId('document-save-btn');
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('stays savable when the caller reports no save of its own', () => {
    // The sibling case: one tab mid-save must not disable another tab's Save.
    const onSave = vi.fn();
    render(<DocumentEditModal {...base} onSave={onSave} json='{"b":2}' saving={false} />);
    expect(screen.getByTestId('document-save-btn')).not.toBeDisabled();
  });

  it('freezes the edit once its tab is on the way to another window', () => {
    // #326 review: the move is fire-and-forget, so the backend can have taken
    // the tab's snapshot while this window still shows the editor. A keystroke
    // here goes to an id the destination no longer reconciles, and a save
    // started here does not travel with the edit.
    const onSave = vi.fn();
    const onJsonChange = vi.fn();
    render(
      <DocumentEditModal
        {...base}
        onSave={onSave}
        onJsonChange={onJsonChange}
        json='{"a":1}'
        frozen
      />
    );
    expect(screen.getByTestId('document-save-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('document-save-btn'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('is editable again when the freeze lifts', () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <DocumentEditModal {...base} onSave={onSave} json='{"a":1}' frozen />
    );
    rerender(<DocumentEditModal {...base} onSave={onSave} json='{"a":1}' frozen={false} />);
    expect(screen.getByTestId('document-save-btn')).not.toBeDisabled();
  });

});

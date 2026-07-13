import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentDiffModal } from '../DocumentDiffModal';

const left = { _id: 1, name: 'Ada', city: 'London' };
const right = { _id: 1, name: 'Grace', country: 'USA' };

describe('DocumentDiffModal', () => {
  it('does not render when closed', () => {
    render(<DocumentDiffModal isOpen={false} left={left} right={right} onClose={() => {}} />);
    expect(screen.queryByTestId('document-diff-modal')).not.toBeInTheDocument();
  });

  it('renders both documents side by side and a change summary', () => {
    render(<DocumentDiffModal isOpen left={left} right={right} onClose={() => {}} />);
    expect(screen.getByTestId('document-diff-modal')).toBeInTheDocument();

    // Both column values are present.
    expect(screen.getByTestId('diff-left')).toHaveTextContent(/"Ada"/);
    expect(screen.getByTestId('diff-right')).toHaveTextContent(/"Grace"/);

    // Summary counts (1 changed: name, 1 added: country, 1 removed: city).
    const summary = screen.getByTestId('diff-summary');
    expect(summary).toHaveTextContent('1 changed');
    expect(summary).toHaveTextContent('1 added');
    expect(summary).toHaveTextContent('1 removed');
  });

  it('tags changed/added/removed lines with distinct status markers', () => {
    render(<DocumentDiffModal isOpen left={left} right={right} onClose={() => {}} />);
    expect(document.querySelectorAll('.mql-diff-line.is-changed').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.mql-diff-line.is-added').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.mql-diff-line.is-removed').length).toBeGreaterThan(0);
    // Gap lines fill the opposite column so both stay aligned.
    expect(document.querySelectorAll('.mql-diff-line.is-gap').length).toBeGreaterThan(0);
  });

  it('keeps the two columns row-aligned', () => {
    render(<DocumentDiffModal isOpen left={left} right={right} onClose={() => {}} />);
    const leftRows = screen.getByTestId('diff-left').querySelectorAll('.mql-diff-line');
    const rightRows = screen.getByTestId('diff-right').querySelectorAll('.mql-diff-line');
    expect(leftRows.length).toBe(rightRows.length);
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<DocumentDiffModal isOpen left={left} right={right} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(onClose).toHaveBeenCalled();
  });
});

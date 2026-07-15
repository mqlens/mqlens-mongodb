import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentDiffModal } from '../DocumentDiffModal';

const left = { _id: 1, name: 'Ada', city: 'London' };
const right = { _id: 1, name: 'Grace', country: 'USA' };

// diffPair.a/b arrive as raw (possibly Extended-JSON) docs, same as DataGrid
// passes them — see DocumentDiffModal's toBson().
const ejsonTimestamp = (t: number, i: number) => ({ $timestamp: { t, i } });

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

  it('renders a Timestamp field as Timestamp(...), not NumberLong(...)', () => {
    // Timestamp extends Long in bson — renderScalar must check Timestamp
    // before Long or every Timestamp renders as NumberLong(...).
    const tsLeft = { _id: 1, ts: ejsonTimestamp(1700000000, 1) };
    const tsRight = { _id: 1, ts: ejsonTimestamp(1700000000, 2) };
    render(<DocumentDiffModal isOpen left={tsLeft} right={tsRight} onClose={() => {}} />);
    expect(screen.getByTestId('diff-left')).toHaveTextContent('Timestamp(1700000000, 1)');
    expect(screen.getByTestId('diff-right')).toHaveTextContent('Timestamp(1700000000, 2)');
    expect(screen.getByTestId('diff-left')).not.toHaveTextContent('NumberLong');
    expect(screen.getByTestId('diff-right')).not.toHaveTextContent('NumberLong');
  });

  it('renders a nested-object preview instead of "[object Object]" on a scalar<->container change', () => {
    const scalarLeft = { x: 1 };
    const containerRight = { x: { y: 2 } };
    render(<DocumentDiffModal isOpen left={scalarLeft} right={containerRight} onClose={() => {}} />);
    const rightCol = screen.getByTestId('diff-right');
    expect(rightCol).not.toHaveTextContent('[object Object]');
    expect(rightCol.textContent).toMatch(/"y"\s*:\s*2/);
  });

  it('shows a "too large" notice instead of columns when the diff exceeds the line cap', () => {
    // Build a doc with enough top-level keys to blow past the 4000-line cap
    // (each changed scalar key produces exactly one line per side).
    const bigLeft: Record<string, number> = {};
    const bigRight: Record<string, number> = {};
    for (let i = 0; i < 4500; i++) {
      bigLeft[`k${i}`] = i;
      bigRight[`k${i}`] = i + 1;
    }
    render(<DocumentDiffModal isOpen left={bigLeft} right={bigRight} onClose={() => {}} />);
    expect(screen.getByTestId('diff-too-large')).toHaveTextContent(/too large to display \(\d+ lines\)/);
    expect(screen.queryByTestId('diff-left')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-right')).not.toBeInTheDocument();
  });
});

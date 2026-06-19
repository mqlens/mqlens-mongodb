import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskManager, type ExportTaskInfo } from '../TaskManager';

const copyTask: ExportTaskInfo = {
  id: 't1', kind: 'collection_copy', label: 'Copy a.b → c.d',
  status: 'completed', processed: 5, total: 5, message: 'Copy complete',
  createdAtMs: 1, summary: {
    collectionsCopied: 1, documentsCopied: 5, documentsSkipped: 2,
    indexesCreated: 1, skipped: [], failed: [],
  },
};

describe('TaskManager copy tasks', () => {
  it('renders a copy summary on completion', () => {
    render(<TaskManager tasks={[copyTask]} onRefresh={() => {}} onClearFinished={() => {}} />);
    expect(screen.getByText(/5 copied/i)).toBeTruthy();
    expect(screen.getByText(/2 skipped/i)).toBeTruthy();
  });

  it('shows a Cancel button for running copy tasks and calls onCancel', () => {
    const onCancel = vi.fn();
    const running: ExportTaskInfo = { ...copyTask, status: 'running', summary: undefined };
    render(<TaskManager tasks={[running]} onRefresh={() => {}} onClearFinished={() => {}} onCancel={onCancel} />);
    screen.getByRole('button', { name: /cancel/i }).click();
    expect(onCancel).toHaveBeenCalledWith('t1');
  });

  it('renders cancelled task as muted/neutral, not as success', () => {
    const cancelled: ExportTaskInfo = {
      ...copyTask, status: 'cancelled', processed: 3, total: 5, message: 'Copy cancelled', summary: undefined,
    };
    const { container } = render(
      <TaskManager tasks={[cancelled]} onRefresh={() => {}} onClearFinished={() => {}} />
    );
    // The icon wrapper div (aria-hidden="true") must carry text-muted-foreground, NOT text-success.
    // There are multiple aria-hidden elements (SVG icons inside), so we target the div wrapper
    // by looking for the one that is a div element.
    const iconWrappers = Array.from(container.querySelectorAll('div[aria-hidden="true"]'));
    expect(iconWrappers.length).toBeGreaterThan(0);
    const iconDiv = iconWrappers[0];
    expect(iconDiv.className).toContain('text-muted-foreground');
    expect(iconDiv.className).not.toContain('text-success');
    // Progress bar fill must carry bg-muted-foreground, NOT bg-success
    const bar = container.querySelector('.bg-muted-foreground');
    expect(bar).toBeTruthy();
    expect(container.querySelector('.bg-success')).toBeNull();
    // No Cancel button shown for a cancelled task
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('shows failure tooltip on summary block when failures present', () => {
    const withFailures: ExportTaskInfo = {
      ...copyTask,
      summary: {
        collectionsCopied: 1, documentsCopied: 3, documentsSkipped: 0,
        indexesCreated: 0, skipped: [],
        failed: [{ collection: 'orders', error: 'timeout' }],
      },
    };
    const { container } = render(
      <TaskManager tasks={[withFailures]} onRefresh={() => {}} onClearFinished={() => {}} />
    );
    // Find all elements with title; filter out the toolbar buttons (Refresh / Clear)
    const titled = Array.from(container.querySelectorAll('[title]')).filter(
      (el) => el.tagName.toLowerCase() !== 'button' && el.tagName.toLowerCase() !== 'span'
    );
    const summaryDiv = titled.find((el) => el.getAttribute('title')?.includes('orders: timeout'));
    expect(summaryDiv).toBeTruthy();
    expect(summaryDiv?.getAttribute('title')).toContain('orders: timeout');
  });
});

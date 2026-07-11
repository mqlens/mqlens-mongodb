import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test/render-with-providers';
import { TaskManager, type ExportTaskInfo } from '../TaskManager';

const runningTask: ExportTaskInfo = {
  id: 'task-running',
  kind: 'collection_export',
  label: 'Export sales_db.customers as JSON',
  status: 'running',
  processed: 50,
  total: 100,
  message: 'Exporting documents…',
  path: '/tmp/customers.json',
  error: null,
  createdAtMs: 1,
  finishedAtMs: null,
};

const completedTask: ExportTaskInfo = {
  id: 'task-done',
  kind: 'collection_export',
  label: 'Export sales_db.orders as CSV',
  status: 'completed',
  processed: 200,
  total: 200,
  message: 'Finished',
  path: '/tmp/orders.csv',
  error: null,
  createdAtMs: 2,
  finishedAtMs: 3,
};

const failedTask: ExportTaskInfo = {
  id: 'task-failed',
  kind: 'collection_export',
  label: 'Export sales_db.users as JSON',
  status: 'failed',
  processed: 12,
  total: 100,
  message: 'Export failed',
  path: '/tmp/users.json',
  error: 'Permission denied',
  createdAtMs: 4,
  finishedAtMs: 5,
};

function renderTaskManager(
  tasks: ExportTaskInfo[] = [],
  handlers: { onRefresh?: () => void; onClearFinished?: () => void } = {}
) {
  const onRefresh = handlers.onRefresh ?? vi.fn();
  const onClearFinished = handlers.onClearFinished ?? vi.fn();
  renderWithProviders(
    <TaskManager tasks={tasks} onRefresh={onRefresh} onClearFinished={onClearFinished} />
  );
  return { onRefresh, onClearFinished };
}

describe('TaskManager', () => {
  it('shows an empty state when there are no tasks', () => {
    renderTaskManager();
    expect(screen.getByTestId('task-manager')).toBeInTheDocument();
    expect(screen.getByTestId('task-empty')).toHaveTextContent('No background tasks yet.');
  });

  it('renders running, completed, and failed tasks', () => {
    renderTaskManager([runningTask, completedTask, failedTask]);
    expect(screen.getAllByTestId('task-row')).toHaveLength(3);
    expect(screen.getByText('Export sales_db.customers as JSON')).toBeInTheDocument();
    expect(screen.getByText('Export sales_db.orders as CSV')).toBeInTheDocument();
    expect(screen.getByText('Export sales_db.users as JSON')).toBeInTheDocument();
  });

  it('shows a running-count badge and progress percentage', () => {
    renderTaskManager([runningTask]);
    expect(screen.getByText('1 running')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('50/100')).toBeInTheDocument();
  });

  it('updates displayed progress when task totals change', () => {
    const { rerender } = renderWithProviders(
      <TaskManager
        tasks={[runningTask]}
        onRefresh={vi.fn()}
        onClearFinished={vi.fn()}
      />
    );
    expect(screen.getByText('50%')).toBeInTheDocument();

    rerender(
      <TaskManager
        tasks={[{ ...runningTask, processed: 75 }]}
        onRefresh={vi.fn()}
        onClearFinished={vi.fn()}
      />
    );
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('75/100')).toBeInTheDocument();
  });

  it('shows failed task errors instead of the success message', () => {
    renderTaskManager([failedTask]);
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
  });

  it('refreshes tasks when the refresh control is clicked', () => {
    const { onRefresh } = renderTaskManager([completedTask]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('dismisses finished tasks when clear is clicked', () => {
    const { onClearFinished } = renderTaskManager([completedTask, failedTask]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished tasks' }));
    expect(onClearFinished).toHaveBeenCalledTimes(1);
  });
});

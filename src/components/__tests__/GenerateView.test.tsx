import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GenerateView } from '../GenerateView';
import type { ExportTaskInfo } from '../TaskManager';

const mockInvoke = vi.fn();
const mockConfirm = vi.fn();
const mockPrompt = vi.fn();
const mockToast = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

vi.mock('../dialogs/DialogProvider', () => ({
  useDialogs: () => ({
    toast: mockToast,
    confirm: mockConfirm,
    prompt: mockPrompt,
    choose: vi.fn(),
  }),
}));

// Monaco does not render usable DOM under jsdom — mock with a plain textarea
// that round-trips value/onChange, same pattern as DumpView/App tests.
vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onChange,
    wrapperProps,
  }: {
    value: string;
    onChange?: (v: string) => void;
    wrapperProps?: Record<string, unknown>;
  }) => (
    <textarea
      data-testid={wrapperProps?.['data-testid'] as string | undefined}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

const STARTER = {
  name: '$name',
  email: '$email',
  createdAt: { $date: { past_days: 365 } },
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'c1',
    database: 'db1',
    collection: 'orders',
    onRun: vi.fn(),
    onOpenTasks: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

async function renderReady(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  const utils = render(<GenerateView {...(props as any)} />);
  await waitFor(() => expect(screen.queryByTestId('generate-loading')).not.toBeInTheDocument());
  return { ...utils, props };
}

describe('GenerateView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    mockPrompt.mockResolvedValue(null);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'infer_generate_template') return Promise.resolve(JSON.stringify(STARTER, null, 2));
      if (cmd === 'preview_generated_documents') return Promise.resolve(['{"a":1}', '{"a":2}', '{"a":3}']);
      if (cmd === 'count_documents') return Promise.resolve(0);
      return Promise.resolve(null);
    });
  });

  it('calls infer_generate_template for a collection-scoped tab and renders builder rows', async () => {
    await renderReady();
    expect(mockInvoke).toHaveBeenCalledWith('infer_generate_template', {
      id: 'c1',
      database: 'db1',
      collection: 'orders',
    });
    expect(screen.getByDisplayValue('name')).toBeInTheDocument();
    expect(screen.getByDisplayValue('email')).toBeInTheDocument();
    expect(screen.getByDisplayValue('createdAt')).toBeInTheDocument();
  });

  it('renders the starter template with no inference call for a database-scoped tab', async () => {
    await renderReady({ collection: undefined });
    expect(mockInvoke).not.toHaveBeenCalledWith('infer_generate_template', expect.anything());
    expect(screen.getByDisplayValue('name')).toBeInTheDocument();
    expect(screen.getByTestId('generate-target-collection-input')).toBeInTheDocument();
  });

  describe('builder ⇄ raw sync', () => {
    it('round-trips a builder edit through raw and back to builder', async () => {
      await renderReady();

      // Edit the "name" row's field name via the builder.
      const nameInput = screen.getByDisplayValue('name');
      fireEvent.change(nameInput, { target: { value: 'fullName' } });

      // Switch to raw and confirm the edit landed in the JSON.
      fireEvent.click(screen.getByTestId('generate-mode-raw'));
      const raw = screen.getByTestId('generate-raw-editor') as HTMLTextAreaElement;
      await waitFor(() => expect(raw.value).toContain('"fullName": "$name"'));

      // Switching back to builder is allowed (still representable) and shows
      // the renamed row.
      fireEvent.click(screen.getByTestId('generate-mode-builder'));
      expect(screen.getByDisplayValue('fullName')).toBeInTheDocument();
    });

    it('shows the persistent notice and disables the builder toggle for an unrepresentable raw edit', async () => {
      await renderReady();
      fireEvent.click(screen.getByTestId('generate-mode-raw'));
      const raw = screen.getByTestId('generate-raw-editor') as HTMLTextAreaElement;

      fireEvent.change(raw, { target: { value: '{"a": {"$notreal": {}}}' } });

      expect(await screen.findByTestId('generate-custom-notice')).toBeInTheDocument();
      expect(screen.getByTestId('generate-mode-builder')).toBeDisabled();

      // Fixing it back to a representable shape re-enables the toggle and
      // clears the notice.
      fireEvent.change(raw, { target: { value: '{"a": "$name"}' } });
      await waitFor(() => expect(screen.queryByTestId('generate-custom-notice')).not.toBeInTheDocument());
      expect(screen.getByTestId('generate-mode-builder')).not.toBeDisabled();
    });

    it('treats invalid JSON in raw mode as unrepresentable too', async () => {
      await renderReady();
      fireEvent.click(screen.getByTestId('generate-mode-raw'));
      const raw = screen.getByTestId('generate-raw-editor') as HTMLTextAreaElement;
      fireEvent.change(raw, { target: { value: '{not json' } });
      expect(await screen.findByTestId('generate-custom-notice')).toBeInTheDocument();
    });
  });

  describe('preview', () => {
    it('debounces preview_generated_documents and renders the returned docs', async () => {
      vi.useFakeTimers();
      try {
        const props = baseProps();
        render(<GenerateView {...(props as any)} />);
        await vi.advanceTimersByTimeAsync(0); // flush infer_generate_template
        mockInvoke.mockClear();

        await vi.advanceTimersByTimeAsync(400);
        await vi.waitFor(() =>
          expect(mockInvoke).toHaveBeenCalledWith(
            'preview_generated_documents',
            expect.objectContaining({ count: 3 })
          )
        );
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => expect(screen.getAllByTestId('generate-preview-doc')).toHaveLength(3));
    });

    it('renders a preview error inline instead of swallowing it', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'infer_generate_template') return Promise.resolve(JSON.stringify(STARTER));
        if (cmd === 'preview_generated_documents') return Promise.reject(new Error('boom: bad template'));
        return Promise.resolve(null);
      });
      await renderReady();
      fireEvent.click(screen.getByTestId('generate-preview-refresh-btn'));
      expect(await screen.findByTestId('generate-preview-error')).toHaveTextContent('boom: bad template');
    });

    it('the manual refresh button re-requests a preview immediately', async () => {
      await renderReady();
      mockInvoke.mockClear();
      fireEvent.click(screen.getByTestId('generate-preview-refresh-btn'));
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith('preview_generated_documents', expect.anything())
      );
    });
  });

  describe('count validation', () => {
    it('disables Generate for an out-of-range or non-integer count', async () => {
      await renderReady();
      const countInput = screen.getByTestId('generate-count-input') as HTMLInputElement;

      fireEvent.change(countInput, { target: { value: '0' } });
      expect(screen.getByTestId('generate-count-error')).toBeInTheDocument();
      expect(screen.getByTestId('generate-run-btn')).toBeDisabled();

      fireEvent.change(countInput, { target: { value: '50001' } });
      expect(screen.getByTestId('generate-count-error')).toBeInTheDocument();
      expect(screen.getByTestId('generate-run-btn')).toBeDisabled();

      fireEvent.change(countInput, { target: { value: '250' } });
      expect(screen.queryByTestId('generate-count-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('generate-run-btn')).not.toBeDisabled();
    });

    it('disables Generate when a database-scoped tab has no target collection', async () => {
      await renderReady({ collection: undefined });
      expect(screen.getByTestId('generate-run-btn')).toBeDisabled();
      fireEvent.change(screen.getByTestId('generate-target-collection-input'), { target: { value: 'newColl' } });
      expect(screen.getByTestId('generate-run-btn')).not.toBeDisabled();
    });
  });

  describe('$pick guardrails', () => {
    it('a row freshly switched to Pick is immediately valid (non-empty default value)', async () => {
      const { container } = await renderReady();

      fireEvent.click(screen.getByTestId('generate-add-field-root'));
      const kindTriggers = container.querySelectorAll('[data-testid^="generate-row-kind-"]');
      fireEvent.click(kindTriggers[kindTriggers.length - 1]);
      fireEvent.click(screen.getByRole('option', { name: /Pick from list/ }));

      // Seeded with one placeholder value — not an empty, backend-rejected list.
      expect(screen.getByDisplayValue('value')).toBeInTheDocument();
      expect(screen.queryByTestId('generate-pick-empty')).not.toBeInTheDocument();
      expect(screen.queryByTestId('generate-footer-empty-pick')).not.toBeInTheDocument();
      expect(screen.getByTestId('generate-run-btn')).not.toBeDisabled();
    });

    it('emptying a pick row disables Generate with an inline message, on the row and in the footer', async () => {
      const { container } = await renderReady();

      fireEvent.click(screen.getByTestId('generate-add-field-root'));
      const kindTriggers = container.querySelectorAll('[data-testid^="generate-row-kind-"]');
      fireEvent.click(kindTriggers[kindTriggers.length - 1]);
      fireEvent.click(screen.getByRole('option', { name: /Pick from list/ }));

      fireEvent.click(screen.getByRole('button', { name: /Remove pick value 1/ }));

      expect(await screen.findByTestId('generate-pick-empty')).toBeInTheDocument();
      expect(screen.getByTestId('generate-footer-empty-pick')).toBeInTheDocument();
      expect(screen.getByTestId('generate-run-btn')).toBeDisabled();

      // Adding a value back re-enables it.
      fireEvent.click(screen.getByRole('button', { name: /Add value/ }));
      await waitFor(() => expect(screen.queryByTestId('generate-pick-empty')).not.toBeInTheDocument());
      expect(screen.getByTestId('generate-run-btn')).not.toBeDisabled();
    });

    it('skips the backend preview call and shows the same message when a pick row is empty', async () => {
      const { container } = await renderReady();
      mockInvoke.mockClear();

      fireEvent.click(screen.getByTestId('generate-add-field-root'));
      const kindTriggers = container.querySelectorAll('[data-testid^="generate-row-kind-"]');
      fireEvent.click(kindTriggers[kindTriggers.length - 1]);
      fireEvent.click(screen.getByRole('option', { name: /Pick from list/ }));
      fireEvent.click(screen.getByRole('button', { name: /Remove pick value 1/ }));

      fireEvent.click(screen.getByTestId('generate-preview-refresh-btn'));

      expect(await screen.findByTestId('generate-preview-error')).toHaveTextContent(/needs at least one value/);
      expect(mockInvoke).not.toHaveBeenCalledWith('preview_generated_documents', expect.anything());
    });
  });

  describe('confirm flow', () => {
    it('omits the existing-documents clause when count_documents errors', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'infer_generate_template') return Promise.resolve(JSON.stringify(STARTER));
        if (cmd === 'preview_generated_documents') return Promise.resolve([]);
        if (cmd === 'count_documents') return Promise.reject(new Error('no such collection'));
        return Promise.resolve(null);
      });
      const { props } = await renderReady();
      fireEvent.click(screen.getByTestId('generate-run-btn'));

      await waitFor(() =>
        expect(mockConfirm).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Generate documents',
            message: 'Insert 100 documents into db1.orders.',
            confirmLabel: 'Generate',
            destructive: true,
          })
        )
      );
      await waitFor(() => expect(props.onRun).toHaveBeenCalled());
    });

    it('restates the existing-document count when count_documents succeeds', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'infer_generate_template') return Promise.resolve(JSON.stringify(STARTER));
        if (cmd === 'preview_generated_documents') return Promise.resolve([]);
        if (cmd === 'count_documents') return Promise.resolve(42);
        return Promise.resolve(null);
      });
      await renderReady();
      fireEvent.click(screen.getByTestId('generate-run-btn'));

      await waitFor(() =>
        expect(mockConfirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Insert 100 documents into db1.orders. This adds to the existing 42 documents.',
          })
        )
      );
    });

    it('aborts the run when confirm is cancelled', async () => {
      mockConfirm.mockResolvedValue(false);
      const { props } = await renderReady();
      fireEvent.click(screen.getByTestId('generate-run-btn'));
      await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
      expect(props.onRun).not.toHaveBeenCalled();
    });

    it('calls onRun with the template, count, seed, and resolved collection', async () => {
      const { props } = await renderReady();
      fireEvent.change(screen.getByTestId('generate-count-input'), { target: { value: '250' } });
      fireEvent.change(screen.getByTestId('generate-seed-input'), { target: { value: '7' } });
      fireEvent.click(screen.getByTestId('generate-run-btn'));

      await waitFor(() => expect(props.onRun).toHaveBeenCalled());
      const [template, count, seed, collection] = (props.onRun as any).mock.calls[0];
      expect(JSON.parse(template)).toEqual(STARTER);
      expect(count).toBe(250);
      expect(seed).toBe(7);
      expect(collection).toBe('orders');
    });

    it('requires the exact typed count for a run above 1000, and aborts on cancel', async () => {
      const { props } = await renderReady();
      fireEvent.change(screen.getByTestId('generate-count-input'), { target: { value: '1500' } });
      fireEvent.click(screen.getByTestId('generate-run-btn'));

      await waitFor(() =>
        expect(mockPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Confirm count' })
        )
      );
      // Exercise the validator the same way the real dialog would.
      const validate = mockPrompt.mock.calls[0][0].validate as (v: string) => string | null;
      expect(validate('1500')).toBeNull();
      expect(validate('wrong')).toMatch(/type the exact count/i);

      expect(props.onRun).not.toHaveBeenCalled();
    });

    it('proceeds after the typed count is confirmed', async () => {
      mockPrompt.mockResolvedValue('1500');
      const { props } = await renderReady();
      fireEvent.change(screen.getByTestId('generate-count-input'), { target: { value: '1500' } });
      fireEvent.click(screen.getByTestId('generate-run-btn'));

      await waitFor(() => expect(props.onRun).toHaveBeenCalled());
      expect((props.onRun as any).mock.calls[0][1]).toBe(1500);
    });
  });

  describe('progress + cancel', () => {
    const runningTask: ExportTaskInfo = {
      id: 'task-1',
      kind: 'generate',
      label: 'Generate → db1.orders',
      status: 'running',
      processed: 40,
      total: 100,
      message: 'Generating (40 written)',
      path: null,
      error: null,
      createdAtMs: 1,
      finishedAtMs: null,
    };

    it('renders an inline progress bar and wires Cancel + View in Tasks', async () => {
      const { props } = await renderReady({ task: runningTask });
      const progress = screen.getByTestId('generate-progress');
      expect(within(progress).getByText('Generating (40 written)')).toBeInTheDocument();
      expect(screen.getByTestId('generate-progress-bar')).toHaveStyle({ width: '40%' });

      fireEvent.click(screen.getByTestId('generate-cancel-btn'));
      expect(props.onCancel).toHaveBeenCalledWith('task-1');

      fireEvent.click(screen.getByTestId('generate-view-tasks-btn'));
      expect(props.onOpenTasks).toHaveBeenCalled();
    });

    it('renders a completed task message without a Cancel button', async () => {
      await renderReady({ task: { ...runningTask, status: 'completed', message: 'Inserted 100 documents' } });
      expect(screen.getByTestId('generate-task-message')).toHaveTextContent('Inserted 100 documents');
      expect(screen.queryByTestId('generate-cancel-btn')).not.toBeInTheDocument();
    });

    it('renders a failed task message via its error field', async () => {
      await renderReady({
        task: { ...runningTask, status: 'failed', error: 'insert failed: duplicate key' },
      });
      expect(screen.getByTestId('generate-task-message')).toHaveTextContent('insert failed: duplicate key');
    });
  });
});

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIChatPanel } from '../AIChatPanel';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

vi.mock('@/components/ui/dropdown-menu', () => {
  const Ctx = React.createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null);
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
    }: {
      children: React.ReactNode;
      onOpenChange?: (open: boolean) => void;
    }) => {
      const [open, setOpen] = React.useState(false);
      const setOpenNotify = (v: boolean) => {
        setOpen(v);
        onOpenChange?.(v);
      };
      return <Ctx.Provider value={{ open, setOpen: setOpenNotify }}>{children}</Ctx.Provider>;
    },
    DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactElement; asChild?: boolean }) => {
      const ctx = React.useContext(Ctx);
      if (!asChild) return children;
      return React.cloneElement(children, {
        onClick: (e: React.MouseEvent) => {
          (children.props as { onClick?: (e: React.MouseEvent) => void }).onClick?.(e);
          ctx?.setOpen(!ctx.open);
        },
      } as React.HTMLAttributes<HTMLElement>);
    },
    DropdownMenuContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
      const ctx = React.useContext(Ctx);
      if (!ctx?.open) return null;
      return (
        <div role="menu" {...props}>
          {children}
        </div>
      );
    },
    DropdownMenuItem: ({
      children,
      onClick,
      onSelect,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { onSelect?: (e: Event) => void }) => (
      <div
        role="menuitem"
        onClick={(e) => {
          onSelect?.(e as unknown as Event);
          onClick?.(e);
        }}
        {...props}
      >
        {children}
      </div>
    ),
    DropdownMenuSeparator: () => <hr />,
  };
});

const USERS_SESSION = 'editor::Local::test-db::users';
const ORDERS_SESSION = 'editor::Local::test-db::orders';

describe('AIChatPanel', () => {
  const onInsertQuery = vi.fn();
  const onInsertAndRunQuery = vi.fn();
  const onClose = vi.fn();

  const renderPanel = (
    variant: 'editor' | 'shell' = 'shell',
    opts?: { collectionName?: string; sessionKey?: string }
  ) =>
    render(
      <AIChatPanel
        connectionId="c1"
        connectionName="Local"
        databaseName="test-db"
        collectionName={opts?.collectionName ?? 'users'}
        fields={['name', 'age']}
        variant={variant}
        isOpen
        onClose={onClose}
        onInsertQuery={onInsertQuery}
        onInsertAndRunQuery={onInsertAndRunQuery}
        sessionKey={opts?.sessionKey ?? (variant === 'shell' ? 'shell::Local::test-db::users' : USERS_SESSION)}
      />
    );

  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    onInsertQuery.mockReset();
    onInsertAndRunQuery.mockReset();
  });

  it('sends a prompt, shows explanation + runnable command, and wires Insert / Insert & run', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({
        explanation: 'Finds adults.',
        queryType: 'find',
        filter: { age: { $gt: 30 } },
        sort: {},
      })
    );

    renderPanel();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'adults' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-query-card')).toBeInTheDocument());
    expect(screen.getByText('Finds adults.')).toBeInTheDocument();
    // Runnable mongosh command is shown.
    expect(screen.getByTestId('chat-runnable-cmd').textContent).toBe('db.users.find({"age":{"$gt":30}})');

    fireEvent.click(screen.getByTestId('chat-insert-btn'));
    expect(onInsertQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryType: 'find', filter: { age: { $gt: 30 } } })
    );
    expect(onInsertAndRunQuery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('chat-insert-run-btn'));
    expect(onInsertAndRunQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryType: 'find', filter: { age: { $gt: 30 } } })
    );
  });

  it('editor variant shows the JSON query (no runnable command, no Copy)', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({
        explanation: 'Adults.',
        queryType: 'find',
        filter: { age: { $gt: 30 } },
        sort: {},
      })
    );

    renderPanel('editor');

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'adults' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-query-card')).toBeInTheDocument());
    // No runnable mongosh command and no Copy in the editor variant.
    expect(screen.queryByTestId('chat-runnable-cmd')).toBeNull();
    expect(screen.queryByTestId('chat-copy-btn')).toBeNull();
    // The raw query JSON is shown instead.
    expect(screen.getByTestId('chat-query-json').textContent).toContain('"age"');
    // Both actions still present.
    expect(screen.getByTestId('chat-insert-btn')).toBeInTheDocument();
    expect(screen.getByTestId('chat-insert-run-btn')).toBeInTheDocument();
  });

  it('shell variant requests target shell and renders a generated script', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({
        explanation: 'Activates all users.',
        queryType: 'script',
        script: 'db.users.updateMany({}, { $set: { active: true } });',
      })
    );

    renderPanel('shell');

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'activate everyone' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-query-card')).toBeInTheDocument());
    // target: 'shell' is sent to the backend.
    expect(invokeMock).toHaveBeenCalledWith(
      'generate_mql_query',
      expect.objectContaining({ target: 'shell' })
    );
    // The script is shown verbatim as the runnable command.
    expect(screen.getByTestId('chat-runnable-cmd').textContent).toBe(
      'db.users.updateMany({}, { $set: { active: true } });'
    );

    // Insert & run hands back the script query.
    fireEvent.click(screen.getByTestId('chat-insert-run-btn'));
    expect(onInsertAndRunQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryType: 'script',
        script: 'db.users.updateMany({}, { $set: { active: true } });',
      })
    );
  });

  it('editor variant requests target editor', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({ explanation: 'x', queryType: 'find', filter: {}, sort: {} })
    );

    renderPanel('editor');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'all' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'generate_mql_query',
        expect.objectContaining({ target: 'editor' })
      )
    );
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <AIChatPanel
        connectionId="c1"
        databaseName="db"
        collectionName="users"
        variant="editor"
        isOpen={false}
        onClose={onClose}
        onInsertQuery={onInsertQuery}
        onInsertAndRunQuery={onInsertAndRunQuery}
        sessionKey={USERS_SESSION}
      />
    );
    expect(container.querySelector('[data-testid="ai-helper-panel"]')).toBeNull();
  });

  it('records sends in History and restores a prompt into the input', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({ explanation: 'ok', queryType: 'find', filter: {}, sort: {} })
    );

    renderPanel('editor');

    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    await waitFor(() =>
      expect(screen.getByText('No prompts sent yet for this collection')).toBeInTheDocument()
    );
    // Close the mock menu (toggle).
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'active users' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    await waitFor(() => expect(screen.getByTestId('ai-chat-history-item-0')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-chat-history-item-0'));
    expect(screen.getByTestId('chat-input')).toHaveValue('active users');
  });

  it('keeps History isolated per collection session', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({ explanation: 'ok', queryType: 'find', filter: {}, sort: {} })
    );

    const { unmount } = renderPanel('editor', { collectionName: 'users', sessionKey: USERS_SESSION });
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'users prompt' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument());
    unmount();

    renderPanel('editor', { collectionName: 'orders', sessionKey: ORDERS_SESSION });
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    await waitFor(() =>
      expect(screen.getByText('No prompts sent yet for this collection')).toBeInTheDocument()
    );
    expect(screen.queryByText('users prompt')).toBeNull();
  });

  it('seeds the conversation from initialMessages', () => {
    render(
      <AIChatPanel
        collectionName="users"
        variant="editor"
        isOpen
        onClose={onClose}
        onInsertQuery={onInsertQuery}
        onInsertAndRunQuery={onInsertAndRunQuery}
        sessionKey={USERS_SESSION}
        initialMessages={[
          { id: 'm0', role: 'user', text: 'prior prompt' },
          { id: 'm1', role: 'assistant', text: 'prior answer' },
        ]}
      />
    );
    expect(screen.getByText('prior prompt')).toBeInTheDocument();
    expect(screen.getByText('prior answer')).toBeInTheDocument();
  });
});

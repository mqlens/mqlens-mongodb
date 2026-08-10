import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIChatPanel } from '../AIChatPanel';
import { resetChatRequests } from '../../lib/aiChatRequest';
import { resetOpenChats } from '../../lib/aiChatStore';

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
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      onCheckedChange,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
    }) => (
      <div
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
        {...props}
      >
        {children}
      </div>
    ),
  };
});

/** Stands in for the backend's chats.json and its open-chat claims. */
let chatStore: any[] = [];
let chatClaims: Record<string, string> = {};
const chatBackend = (cmd: string, args: any): unknown | undefined => {
  if (cmd === 'claim_chat') {
    const holder = chatClaims[args.chatId];
    if (holder && holder !== args.owner) return false;
    chatClaims[args.chatId] = args.owner;
    return true;
  }
  if (cmd === 'release_chat') {
    if (chatClaims[args.chatId] === args.owner) delete chatClaims[args.chatId];
    return undefined;
  }
  if (cmd === 'list_chats') {
    const scope = args?.scope;
    return chatStore
      .filter(
        (c) =>
          !scope ||
          (c.connectionName === scope.connectionName &&
            c.database === scope.database &&
            c.collection === scope.collection &&
            c.variant === scope.variant)
      )
      .map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
  if (cmd === 'load_chat') return chatStore.find((c) => c.id === args.id) ?? null;
  if (cmd === 'save_chat') {
    chatStore = [args.chat, ...chatStore.filter((c) => c.id !== args.chat.id)];
    return undefined;
  }
  if (cmd === 'delete_chat') {
    chatStore = chatStore.filter((c) => c.id !== args.id);
    return undefined;
  }
  if (cmd === 'clear_chats') {
    chatStore = [];
    return undefined;
  }
  return undefined;
};

/** Route the chat-store commands, and answer everything else with `generate`.
 *  Every test needs the store to work — the panel lists chats on open — so no
 *  test may replace the implementation without keeping this. */
const mockBackend = (generate?: unknown) =>
  invokeMock.mockImplementation((cmd: string, args: any) =>
    cmd.endsWith('_chat') || cmd.endsWith('_chats')
      ? Promise.resolve(chatBackend(cmd, args))
      : Promise.resolve(generate)
  );

describe('AIChatPanel', () => {
  const onInsertQuery = vi.fn();
  const onInsertAndRunQuery = vi.fn();
  const onClose = vi.fn();

  const renderPanel = (
    variant: 'editor' | 'shell' = 'shell',
    opts?: { collectionName?: string; chatId?: string }
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
        sessionKey={`tab-${variant}-${opts?.collectionName ?? 'users'}`}
        chatId={opts?.chatId}
      />
    );

  beforeEach(() => {
    resetChatRequests();
    resetOpenChats();
    chatStore = [];
    chatClaims = {};
    localStorage.clear();
    invokeMock.mockReset();
    mockBackend();
    onInsertQuery.mockReset();
    onInsertAndRunQuery.mockReset();
  });

  it('sends a prompt, shows explanation + runnable command, and wires Insert / Insert & run', async () => {
    mockBackend(
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
    mockBackend(
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
    mockBackend(
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
    mockBackend(
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
        sessionKey="tab-closed"
      />
    );
    expect(container.querySelector('[data-testid="ai-helper-panel"]')).toBeNull();
  });

  it('lists past conversations and opens the one you pick', async () => {
    chatStore = [
      {
        id: 'chat-old',
        title: 'active users over 30',
        messages: [
          { id: 'm0', role: 'user', text: 'active users over 30' },
          { id: 'm1', role: 'assistant', text: 'here they are' },
        ],
        connectionName: 'Local',
        database: 'test-db',
        collection: 'users',
        variant: 'editor',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    renderPanel('editor', { chatId: 'held-by-this-tab' });

    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    await waitFor(() => expect(screen.getByTestId('ai-chat-history-item-0')).toBeInTheDocument());
    expect(screen.getByTestId('ai-chat-history-item-0')).toHaveTextContent('active users over 30');

    fireEvent.click(screen.getByTestId('ai-chat-history-item-0'));

    expect(await screen.findByText('here they are')).toBeInTheDocument();
  });

  it('narrows the list to this collection, and widens it on request', async () => {
    const base = {
      messages: [{ id: 'm0', role: 'user', text: 'x' }],
      connectionName: 'Local',
      database: 'test-db',
      variant: 'editor',
      createdAt: '2026-01-01T00:00:00Z',
    };
    chatStore = [
      { ...base, id: 'c-users', title: 'about users', collection: 'users', updatedAt: '2026-01-02T00:00:00Z' },
      { ...base, id: 'c-orders', title: 'about orders', collection: 'orders', updatedAt: '2026-01-01T00:00:00Z' },
    ];

    renderPanel('editor', { collectionName: 'users', chatId: 'held' });
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));

    await waitFor(() => expect(screen.getByText('about users')).toBeInTheDocument());
    expect(screen.queryByText('about orders')).toBeNull();

    // Unticking "This collection only" shows every conversation.
    fireEvent.click(screen.getByTestId('ai-chat-history-scope-toggle'));

    expect(await screen.findByText('about orders')).toBeInTheDocument();
    expect(screen.getByText('about users')).toBeInTheDocument();
  });

  it('starts an empty conversation on New chat', async () => {
    mockBackend(JSON.stringify({ explanation: 'ok', queryType: 'find', filter: {}, sort: {} }));

    renderPanel('editor', { chatId: 'chat-1' });
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'first question' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));

    expect(screen.queryByText('first question')).toBeNull();
    expect(screen.queryByText('ok')).toBeNull();
    // ...and the old conversation is still in the history, not lost — exactly
    // once. A save queued for the old transcript can execute after New chat has
    // swapped the active id, which stored the same messages a second time under
    // the new one; asserting on the store says so directly, where a DOM query
    // only reports "multiple elements".
    await waitFor(() =>
      expect(chatStore.filter((c) => c.title === 'first question')).toHaveLength(1)
    );
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    await waitFor(() => expect(screen.getByText('first question')).toBeInTheDocument());
  });

  it('files a reply with the conversation it was asked in, not the one now open', async () => {
    // New chat (and opening a history item, and deleting) move the panel on
    // while a request is still running. The answer must not appear in — and be
    // saved under — whichever conversation happens to be open when it lands.
    let resolveGenerate: (v: string) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : new Promise<string>((res) => {
            resolveGenerate = res;
          })
    );

    renderPanel('editor', { chatId: 'chat-one' });
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'the question' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await screen.findByText('the question');
    // The panel cannot persist anything until its scope lookup resolves, and
    // this test is about where a reply is FILED, not about racing that lookup.
    // Waiting for the question to be stored keeps the two apart; without it
    // the switch below can beat the first save on a slow machine and the
    // conversation is never written at all.
    await waitFor(() => expect(chatStore.find((c) => c.id === 'chat-one')).toBeTruthy());

    // Switch away mid-request.
    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));
    expect(screen.queryByText('the question')).toBeNull();

    resolveGenerate(
      JSON.stringify({ explanation: 'the answer', queryType: 'find', filter: {}, sort: {} })
    );

    // Not shown in the new, empty conversation...
    await waitFor(() => expect(chatStore.find((c) => c.id === 'chat-one')).toBeTruthy());
    expect(screen.queryByText('the answer')).toBeNull();
    // ...and stored with the question instead.
    const asked = chatStore.find((c) => c.id === 'chat-one');
    expect(asked.messages.map((m: any) => m.text)).toEqual(['the question', 'the answer']);
  });

  it('refuses to open a conversation another panel is holding', async () => {
    // Switching to it anyway means two panels editing one transcript, each
    // saving a complete snapshot over the other's.
    chatStore = [
      {
        id: 'chat-busy',
        title: 'someone else has this',
        messages: [{ id: 'm0', role: 'user', text: 'someone else has this' }],
        connectionName: 'Local',
        database: 'test-db',
        collection: 'users',
        variant: 'editor',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    chatClaims['chat-busy'] = 'some-other-panel';

    renderPanel('editor', { chatId: 'mine' });
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    await waitFor(() => expect(screen.getByTestId('ai-chat-history-item-0')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-chat-history-item-0'));

    // Not switched to, and the panel says why rather than doing nothing.
    await screen.findByTestId('ai-chat-history-busy');
    expect(screen.queryByTestId('chat-msg-user')).toBeNull();
  });

  it('starts its own conversation rather than adopting the collection\'s last one', async () => {
    // The panel used to adopt the most recent chat for the collection when a
    // tab had none of its own. Two tabs then silently landed on one transcript
    // and saved over each other, and every guard added around that guessing
    // needed another guard. A tab starts fresh; the history is an explicit
    // choice.
    chatStore = [
      {
        id: 'chat-earlier',
        title: 'an earlier conversation',
        messages: [{ id: 'm0', role: 'user', text: 'an earlier conversation' }],
        connectionName: 'Local',
        database: 'test-db',
        collection: 'users',
        variant: 'editor',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    renderPanel('editor');

    await waitFor(() => expect(screen.getByTestId('ai-chat-messages')).toBeInTheDocument());
    expect(screen.queryByText('an earlier conversation')).toBeNull();
    // ...and it is still one click away.
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    await waitFor(() => expect(screen.getByText('an earlier conversation')).toBeInTheDocument());
  });

  it('tells the tab which conversation it minted, so a remount does not fork it', async () => {
    // Without this the tab still has no id after the first message: the next
    // mount mints another, saves the same transcript again as a second
    // conversation, and abandons the first claim — once per tab switch.
    const onChatIdChange = vi.fn();
    render(
      <AIChatPanel
        connectionId="c1"
        connectionName="Local"
        databaseName="test-db"
        collectionName="users"
        variant="editor"
        isOpen
        onClose={onClose}
        onInsertQuery={onInsertQuery}
        onInsertAndRunQuery={onInsertAndRunQuery}
        sessionKey="tab-1"
        onChatIdChange={onChatIdChange}
      />
    );

    await waitFor(() => expect(onChatIdChange).toHaveBeenCalled());
    expect(onChatIdChange.mock.calls[0][0]).toEqual(expect.any(String));
  });

  it('remembers a foreign conversation is foreign after a tab switch', async () => {
    // `openScope` is component state and switching tabs unmounts the panel, so
    // it has to be recovered from the chat itself — otherwise the conversation
    // comes back looking local and the persistence effect moves it here.
    chatStore = [
      {
        id: 'chat-orders',
        title: 'about orders',
        messages: [{ id: 'm0', role: 'user', text: 'about orders' }],
        connectionName: 'Local',
        database: 'test-db',
        collection: 'orders',
        variant: 'editor',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    // Mounted fresh with that chat already selected, as a remount would be.
    renderPanel('editor', { collectionName: 'users', chatId: 'chat-orders' });

    await screen.findByTestId('ai-chat-foreign-banner');
    expect(screen.getByTestId('chat-input')).toBeDisabled();
    // ...and it is still an orders conversation.
    await waitFor(() =>
      expect(chatStore.find((c) => c.id === 'chat-orders').collection).toBe('orders')
    );
  });

  it('refuses to continue a foreign conversation rather than answering for the wrong collection', async () => {
    // The composer would generate against THIS collection and save the answer
    // under the other one's scope, leaving a query that runs somewhere it was
    // never written for.
    chatStore = [
      {
        id: 'chat-orders',
        title: 'about orders',
        messages: [{ id: 'm0', role: 'user', text: 'about orders' }],
        connectionName: 'Local',
        database: 'test-db',
        collection: 'orders',
        variant: 'editor',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    renderPanel('editor', { collectionName: 'users', chatId: 'chat-orders' });
    await screen.findByTestId('ai-chat-foreign-banner');

    expect(screen.getByTestId('chat-send-btn')).toBeDisabled();
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === 'generate_mql_query')
    ).toHaveLength(0);
  });

  it('keeps a conversation from another collection read-only and stored where it belongs', async () => {
    // The history can be widened past this collection. A chat picked from there
    // must not be rewritten under the namespace that happens to be showing it,
    // and its query cards were written against a different collection.
    chatStore = [
      {
        id: 'chat-elsewhere',
        title: 'about orders',
        messages: [
          { id: 'm0', role: 'user', text: 'about orders' },
          {
            id: 'm1',
            role: 'assistant',
            text: 'here',
            query: { queryType: 'find', filter: {}, sort: {}, pipeline: [], script: '' },
          },
        ],
        connectionName: 'Local',
        database: 'test-db',
        collection: 'orders',
        variant: 'editor',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    renderPanel('editor', { collectionName: 'users' });
    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    // Widen past this collection.
    fireEvent.click(screen.getByTestId('ai-chat-history-scope-toggle'));
    await waitFor(() => expect(screen.getByTestId('ai-chat-history-item-0')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-chat-history-item-0'));

    expect(await screen.findByText('about orders')).toBeInTheDocument();
    await screen.findByTestId('ai-chat-foreign-banner');
    // Its query cannot be fired at the collection this tab is showing.
    expect(screen.getByTestId('chat-insert-run-btn')).toBeDisabled();
    expect(screen.getByTestId('chat-insert-btn')).toBeDisabled();
    // And it stays an orders conversation.
    await waitFor(() =>
      expect(chatStore.find((c) => c.id === 'chat-elsewhere').collection).toBe('orders')
    );
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
        initialMessages={[
          { id: 'm0', role: 'user', text: 'prior prompt' },
          { id: 'm1', role: 'assistant', text: 'prior answer' },
        ]}
      />
    );
    expect(screen.getByText('prior prompt')).toBeInTheDocument();
    expect(screen.getByText('prior answer')).toBeInTheDocument();
  });

  it('seeds from initialMessages and reports changes via onMessagesChange', async () => {
    const onMessagesChange = vi.fn();
    const initial = [
      { id: 'm0', role: 'user' as const, text: 'list adults' },
      { id: 'm1', role: 'assistant' as const, text: 'Here you go.' },
    ];
    mockBackend(
JSON.stringify({ explanation: 'Again.', queryType: 'find', filter: {}, sort: {} })
    );

    render(
      <AIChatPanel
        connectionId="c1"
        databaseName="test-db"
        collectionName="users"
        fields={['name']}
        variant="editor"
        isOpen
        onClose={onClose}
        onInsertQuery={onInsertQuery}
        onInsertAndRunQuery={onInsertAndRunQuery}
        initialMessages={initial}
        onMessagesChange={onMessagesChange}
      />
    );

    expect(screen.getByText('list adults')).toBeInTheDocument();
    expect(screen.getByText('Here you go.')).toBeInTheDocument();
    expect(onMessagesChange).toHaveBeenCalledWith(initial);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'again' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    await waitFor(() => expect(screen.getByText('Again.')).toBeInTheDocument());
    // Waited on the report, not just on the reply being on screen. The reply is
    // painted by the commit that sets it, while `onMessagesChange` runs from a
    // passive effect a macrotask later — so reading the mock the moment the text
    // appears can still see the call before it. Locally the gap closes on its
    // own; under CI's coverage run it does not.
    let lastCall: Array<{ id: string; text: string }> = [];
    await waitFor(() => {
      const calls = onMessagesChange.mock.calls;
      lastCall = calls[calls.length - 1][0] as Array<{ id: string; text: string }>;
      expect(lastCall.map((m) => m.text)).toEqual([
        'list adults',
        'Here you go.',
        'again',
        'Again.',
      ]);
    });
    // Ids continue past the restored m0/m1 range.
    expect(lastCall[2].id).toBe('m2');
    expect(lastCall[3].id).toBe('m3');
  });

  it('keeps an in-flight reply when the tab is switched away mid-request (#221 follow-up)', async () => {
    // Switching tabs unmounts the panel (PaneView renders only the active tab).
    // The request used to die with it: the user's question was cached, the
    // assistant's answer was silently dropped, and the tab came back showing a
    // question with no reply, no spinner and no error.
    let resolveInvoke: (v: string) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : new Promise<string>((res) => {
            resolveInvoke = res;
          })
    );

    const first = render(
      <AIChatPanel
        connectionId="c1" databaseName="test-db" collectionName="users" fields={[]}
        variant="editor" isOpen sessionKey="tab-1"
        onClose={onClose} onInsertQuery={onInsertQuery} onInsertAndRunQuery={onInsertAndRunQuery}
      />
    );
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'adults please' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-thinking')).toBeInTheDocument());

    first.unmount();                                   // user switches tab
    resolveInvoke(JSON.stringify({ explanation: 'Finds adults.', queryType: 'find', filter: {} }));
    await new Promise((r) => setTimeout(r, 0));

    render(                                            // user switches back
      <AIChatPanel
        connectionId="c1" databaseName="test-db" collectionName="users" fields={[]}
        variant="editor" isOpen sessionKey="tab-1"
        initialMessages={[{ id: 'm0', role: 'user', text: 'adults please' }]}
        onClose={onClose} onInsertQuery={onInsertQuery} onInsertAndRunQuery={onInsertAndRunQuery}
      />
    );
    expect(await screen.findByText('Finds adults.')).toBeInTheDocument();
  });

  it('shows the spinner again when returning while the request is still running', async () => {
    let resolveInvoke: (v: string) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : new Promise<string>((res) => {
            resolveInvoke = res;
          })
    );

    const first = render(
      <AIChatPanel
        connectionId="c1" databaseName="test-db" collectionName="users" fields={[]}
        variant="editor" isOpen sessionKey="tab-2"
        onClose={onClose} onInsertQuery={onInsertQuery} onInsertAndRunQuery={onInsertAndRunQuery}
      />
    );
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'still running' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-thinking')).toBeInTheDocument());
    first.unmount();

    render(                                            // back while still pending
      <AIChatPanel
        connectionId="c1" databaseName="test-db" collectionName="users" fields={[]}
        variant="editor" isOpen sessionKey="tab-2"
        initialMessages={[{ id: 'm0', role: 'user', text: 'still running' }]}
        onClose={onClose} onInsertQuery={onInsertQuery} onInsertAndRunQuery={onInsertAndRunQuery}
      />
    );
    expect(screen.getByTestId('chat-thinking')).toBeInTheDocument();

    resolveInvoke(JSON.stringify({ explanation: 'Late but delivered.', queryType: 'find', filter: {} }));
    expect(await screen.findByText('Late but delivered.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('chat-thinking')).not.toBeInTheDocument());
  });

  it('remembers the panel width across remounts', async () => {
    localStorage.setItem('mqlens-ai-helper-width', '420');
    renderPanel('editor');
    expect(screen.getByTestId('ai-helper-panel')).toHaveStyle({ width: '420px' });
  });

  it('delivers the reply under StrictMode, which double-invokes effects', async () => {
    // The mounted guard was cleanup-only, so StrictMode's mount/cleanup/mount
    // left it false and every reply was dropped — messages sent, nothing back,
    // not even a spinner.
    mockBackend(
JSON.stringify({ explanation: 'Here are the results.', queryType: 'find', filter: {} })
    );

    render(
      <React.StrictMode>
        <AIChatPanel
          connectionId="c1" databaseName="test-db" collectionName="users" fields={[]}
          variant="editor" isOpen sessionKey="strict-tab"
          onClose={onClose} onInsertQuery={onInsertQuery} onInsertAndRunQuery={onInsertAndRunQuery}
        />
      </React.StrictMode>
    );

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'show me users' } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));

    expect(await screen.findByText('Here are the results.')).toBeInTheDocument();
  });
});

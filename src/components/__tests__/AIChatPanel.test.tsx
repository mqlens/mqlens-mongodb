import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCEPTED_IMAGE_TYPES, AIChatPanel } from '../AIChatPanel';
import { resetChatRequests } from '../../lib/aiChatRequest';
import { resetOpenChats } from '../../lib/aiChatStore';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
// The panel re-reads its provider list on the backend's `ai-providers-changed`
// broadcast. Captured here so a test can fire it, and so the real `listen` is
// not reached in jsdom.
const providerListeners: Array<() => void> = [];
vi.mock('../../workspace/workspaceStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/workspaceStore')>()),
  subscribeAiProvidersChanged: (fn: () => void) => {
    providerListeners.push(fn);
    return Promise.resolve(() => {
      const i = providerListeners.indexOf(fn);
      if (i >= 0) providerListeners.splice(i, 1);
    });
  },
}));

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
      // Picker support: no providers configured unless a test says otherwise.
      : cmd === 'ai_provider_options' || cmd === 'list_ai_models_for'
      ? Promise.resolve([])
      // The backend now returns { query, thoughts?, notes? }; tests still hand in
      // the bare query JSON, so wrap it the way the real command would.
      : Promise.resolve(typeof generate === 'string' ? { query: generate } : generate)
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
    let resolveGenerate: (v: { query: string }) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : cmd === 'ai_provider_options' || cmd === 'list_ai_models_for'
        ? Promise.resolve([])
        : new Promise<{ query: string }>((res) => {
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

    resolveGenerate({ query: JSON.stringify({ explanation: 'the answer', queryType: 'find', filter: {}, sort: {} }) });

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
    let resolveInvoke: (v: { query: string }) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : cmd === 'ai_provider_options' || cmd === 'list_ai_models_for'
        ? Promise.resolve([])
        : new Promise<{ query: string }>((res) => {
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
    resolveInvoke({ query: JSON.stringify({ explanation: 'Finds adults.', queryType: 'find', filter: {} }) });
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
    let resolveInvoke: (v: { query: string }) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : cmd === 'ai_provider_options' || cmd === 'list_ai_models_for'
        ? Promise.resolve([])
        : new Promise<{ query: string }>((res) => {
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

    resolveInvoke({ query: JSON.stringify({ explanation: 'Late but delivered.', queryType: 'find', filter: {} }) });
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

  // ── thoughts, images, per-chat provider (#283 follow-up) ──────────────────

  const OPTIONS = [
    { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic-compatible', model: 'claude-opus-4-8', isDefault: true, usesModel: true, canListModels: true },
    { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', model: 'deepseek-chat', isDefault: false, usesModel: true, canListModels: true },
    // A built-in agent whose command has no {model}: the panel must not offer one.
    // Its `models_command` is always empty, so listing can never work either.
    { id: 'claude-code', name: 'Claude Code (local)', kind: 'local-cli', model: '', isDefault: false, usesModel: false, canListModels: false },
    // A CLI whose template does slot the model in, and which has a listing command.
    { id: 'my-ollama', name: 'My Ollama', kind: 'local-cli', model: 'llama3', isDefault: false, usesModel: true, canListModels: true },
    // ...and one that does not: `models_command` left blank, so no Load button.
    { id: 'bare-cli', name: 'Bare CLI', kind: 'local-cli', model: 'm', isDefault: false, usesModel: true, canListModels: false },
  ];
  /** Like mockBackend, but with providers to pick from and a reply to return. */
  const mockPickerBackend = (reply: unknown, models: string[] = []) =>
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : cmd === 'ai_provider_options'
          ? Promise.resolve(OPTIONS)
          : cmd === 'list_ai_models_for'
            ? Promise.resolve(models)
            : Promise.resolve(reply)
    );
  const pasteImage = (el: HTMLElement, type = 'image/png', size = 3) => {
    const file = new File([new Uint8Array(size)], 'shot.png', { type });
    fireEvent.paste(el, {
      clipboardData: { items: [{ kind: 'file', type, getAsFile: () => file }] },
    });
  };
  const send = (text: string) => {
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('chat-send-btn'));
  };
  // Radix Select opens on pointerdown and renders its items in a portal.
  const pickFrom = async (triggerId: string, optionText: string) => {
    // Keyboard rather than pointer: Radix opens on Enter/Space without needing
    // the layout jsdom cannot provide.
    fireEvent.keyDown(screen.getByTestId(triggerId), { key: 'Enter' });
    const option = await screen.findByRole('option', { name: optionText });
    fireEvent.click(option);
  };
  const pickProvider = (name: string) => pickFrom('ai-chat-provider-select', name);
  const pickModel = (name: string) => pickFrom('ai-chat-model-select', name);

  const lastGenerateArgs = () =>
    invokeMock.mock.calls.filter((c) => c[0] === 'generate_mql_query').at(-1)![1];

  it('shows the model\'s thoughts collapsed under the reply, native reasoning first', async () => {
    mockPickerBackend({
      query: JSON.stringify({ explanation: 'Adults.', queryType: 'find', filter: {} }),
      thoughts: 'age is numeric here',
      notes: 'so a range filter works',
    });
    renderPanel('editor');
    send('adults');
    const details = await screen.findByTestId('chat-thoughts');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('age is numeric here');
    expect(details).toHaveTextContent('so a range filter works');
    expect(details.textContent!.indexOf('age is numeric')).toBeLessThan(details.textContent!.indexOf('range filter'));
  });

  it('shows no thoughts block when the model produced none', async () => {
    mockPickerBackend({ query: JSON.stringify({ explanation: 'Adults.', queryType: 'find', filter: {} }) });
    renderPanel('editor');
    send('adults');
    await screen.findByText('Adults.');
    expect(screen.queryByTestId('chat-thoughts')).not.toBeInTheDocument();
  });

  it('sends a pasted image with the request and keeps only its shape in the transcript', async () => {
    mockPickerBackend({ query: JSON.stringify({ explanation: 'From the screenshot.', queryType: 'find', filter: {} }) });
    renderPanel('editor');
    // Wait for the options: until they arrive the panel does not know whether the
    // provider takes images, and attaching is deliberately refused.
    await screen.findByTestId('ai-chat-provider-select');
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');

    send('what query matches this');
    await screen.findByText('From the screenshot.');

    const args = lastGenerateArgs();
    expect(args.images).toHaveLength(1);
    expect(args.images[0]).toMatchObject({ media_type: 'image/png' });
    expect(typeof args.images[0].data).toBe('string');
    expect(args.images[0].data.length).toBeGreaterThan(0);

    // The transcript records that an image went with the question — not the bytes.
    expect(screen.getByTestId('chat-attachments')).toHaveTextContent('Image, 3 B');
    const saved = invokeMock.mock.calls.filter((c) => c[0] === 'save_chat').at(-1)![1].chat;
    const userTurn = saved.messages.find((m: any) => m.role === 'user');
    expect(userTurn.attachments).toEqual([{ mediaType: 'image/png', bytes: 3 }]);
    expect(JSON.stringify(saved)).not.toContain('"data"');
    // and the composer is clear for the next question
    expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
  });

  it('attaches an image through the paperclip as well as by paste', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    const file = new File([new Uint8Array(5)], 'shot.png', { type: 'image/png' });
    const input = screen.getByTestId('chat-attach-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByTestId('chat-pending-images');
    // The picker is cleared so the same file can be chosen again later.
    expect(input.value).toBe('');
  });

  it('disables the paperclip for a local command provider', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    expect(screen.getByTestId('chat-attach-btn')).not.toBeDisabled();
    await pickProvider('Claude Code (local)');
    expect(screen.getByTestId('chat-attach-btn')).toBeDisabled();
  });

  it('lets a pasted image be removed before sending', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');
    fireEvent.click(screen.getByTestId('chat-pending-image-remove-0'));
    expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
  });

  it('refuses images for a local command provider and says why', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('Claude Code (local)');

    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-image-note');
    expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/cannot receive images/);
    expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
  });

  it('does not read a second batch into slots the first batch already claimed', async () => {
    // The per-batch cap looked only at `pendingImages`, which excludes a batch
    // still being read — so a second paste saw the same empty allowance and read
    // four more files. Rapid pastes therefore defeated the cap outright.
    const read: string[] = [];
    const pending: Array<() => void> = [];
    const RealFileReader = globalThis.FileReader;
    class HeldReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL(file: File) {
        read.push(file.name);
        pending.push(() => this.onload?.());
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = HeldReader;
    try {
      mockPickerBackend({ query: '{}' });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');
      const input = screen.getByTestId('chat-input');
      const pasteMany = (tag: string, n: number) =>
        fireEvent.paste(input, {
          clipboardData: {
            items: Array.from({ length: n }, (_, i) => {
              const file = new File([new Uint8Array(3)], `${tag}${i}.png`, { type: 'image/png' });
              return { kind: 'file', type: 'image/png', getAsFile: () => file };
            }),
          },
        });

      pasteMany('a', 3); // three of the four slots are now claimed
      expect(read).toHaveLength(3);
      pasteMany('b', 3); // ...so only one more may be read, not three
      expect(read).toHaveLength(4);
      expect(read.filter((n) => n.startsWith('b'))).toHaveLength(1);

      await act(async () => {
        pending.forEach((fire) => fire());
      });
      // And the cap still holds in state.
      const chips = screen.getByTestId('chat-pending-images').querySelectorAll('img');
      expect(chips.length).toBeLessThanOrEqual(4);
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('ignores a CLI model list that arrives after the provider changed', async () => {
    // The command can run for a while. Its result used to be applied whatever the
    // selection had become, repopulating the picker with the previous provider's
    // models — one of which could then be sent to the new provider.
    let releaseList: (v: string[]) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'ai_provider_options') return Promise.resolve(OPTIONS);
      if (cmd === 'list_ai_models_for') {
        return args?.providerId === 'my-ollama'
          ? new Promise<string[]>((res) => { releaseList = res; })
          : Promise.resolve([]);
      }
      if (cmd.endsWith('_chat') || cmd.endsWith('_chats')) return Promise.resolve(chatBackend(cmd, args));
      return Promise.resolve({ query: '{}' });
    });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('My Ollama');

    // Ask for the CLI's models, then switch away before the command answers.
    fireEvent.click(await screen.findByTestId('ai-chat-models-load'));
    await pickProvider('DeepSeek');
    await act(async () => {
      releaseList(['llama3:latest', 'mistral:7b']);
    });

    // Ollama's models must not be offered for DeepSeek.
    expect(screen.queryByTestId('ai-chat-model-select')).not.toBeInTheDocument();
  });

  it('drops attachments when the provider falls back to a CLI on its own', async () => {
    // Deleting the selected provider in Settings makes the panel fall back to the
    // default. If that default is a local CLI, the switch never went through the
    // click handler, so the images stayed attached and the epoch was never bumped.
    let options = OPTIONS;
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd === 'ai_provider_options'
        ? Promise.resolve(options)
        : cmd.endsWith('_chat') || cmd.endsWith('_chats')
          ? Promise.resolve(chatBackend(cmd, args))
          : cmd === 'list_ai_models_for'
            ? Promise.resolve([])
            : Promise.resolve({ query: '{}' }),
    );
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('DeepSeek');
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');

    // DeepSeek is deleted and only the CLI remains as a default.
    options = OPTIONS.filter((o) => o.kind === 'local-cli').map((o, i) => ({ ...o, isDefault: i === 0 }));
    await act(async () => {
      providerListeners.forEach((fn) => fn());
    });

    await waitFor(() =>
      expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/cannot receive images/);
  });

  it('keeps the images it could read when one file fails', async () => {
    // `Promise.all` rejected the whole batch on one unreadable file, discarding
    // images that had been read fine — and the paste task had no catch, so the
    // rejection went to the console and the composer said nothing.
    const RealFileReader = globalThis.FileReader;
    class FlakyReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL(file: File) {
        // The middle file of the batch is unreadable.
        if (file.name === 'shot1.png') setTimeout(() => this.onerror?.(), 0);
        else setTimeout(() => this.onload?.(), 0);
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = FlakyReader;
    try {
      mockPickerBackend({ query: '{}' });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');

      fireEvent.paste(screen.getByTestId('chat-input'), {
        clipboardData: {
          items: Array.from({ length: 3 }, (_, i) => {
            const file = new File([new Uint8Array(3)], `shot${i}.png`, { type: 'image/png' });
            return { kind: 'file', type: 'image/png', getAsFile: () => file };
          }),
        },
      });

      // The two that read fine are attached...
      const chips = await screen.findByTestId('chat-pending-images');
      await waitFor(() => expect(chips.querySelectorAll('img')).toHaveLength(2));
      // ...and the failure is reported rather than swallowed.
      expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/could not be read/);
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('does not let an abandoned batch release slots a later batch reserved', async () => {
    // `dropPendingImages` clears the whole reservation counter. An abandoned batch
    // that then ran its own release subtracted from whichever batch had reserved
    // since, so a third paste could read four more files while the second was
    // still in flight — the cap the reservation exists to enforce, defeated.
    const read: string[] = [];
    const pending: Array<() => void> = [];
    const RealFileReader = globalThis.FileReader;
    class HeldReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL(file: File) {
        read.push(file.name);
        pending.push(() => this.onload?.());
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = HeldReader;
    try {
      mockPickerBackend({ query: '{}' });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');
      const input = screen.getByTestId('chat-input');
      const pasteMany = (tag: string, n: number) =>
        fireEvent.paste(input, {
          clipboardData: {
            items: Array.from({ length: n }, (_, i) => {
              const file = new File([new Uint8Array(3)], `${tag}${i}.png`, { type: 'image/png' });
              return { kind: 'file', type: 'image/png', getAsFile: () => file };
            }),
          },
        });

      pasteMany('a', 4); // all four slots reserved, none settled
      expect(read).toHaveLength(4);

      // New chat abandons that batch and clears the counter wholesale.
      fireEvent.click(screen.getByTestId('ai-chat-new-btn'));
      pasteMany('b', 4); // the new conversation may claim all four
      expect(read.filter((n) => n.startsWith('b'))).toHaveLength(4);

      // Only the ABANDONED batch finishes — b is still in flight, so its four
      // reserved slots must stay reserved. Firing b's readers too would put its
      // images in state and make the next assertion hold for the wrong reason.
      const abandoned = pending.slice(0, 4);
      await act(async () => {
        abandoned.forEach((fire) => fire());
      });
      pasteMany('c', 4);
      expect(read.filter((n) => n.startsWith('c'))).toHaveLength(0);
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('clears the CLI warning when a provider that takes images is chosen again', async () => {
    // Nothing cleared the note, so it stood over a composer whose attach button
    // had started working again.
    mockPickerBackend({ query: '{}' }, ['deepseek-chat']);
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');

    await pickProvider('Claude Code (local)');
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-image-note');
    expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/cannot receive images/);

    await pickProvider('DeepSeek');
    await waitFor(() =>
      expect(screen.queryByTestId('chat-image-note')).not.toBeInTheDocument(),
    );
  });

  it('refuses attachments until it knows whether the provider takes them', async () => {
    // While `ai_provider_options` is in flight the panel has no capability to go
    // on. Assuming images were fine meant a user whose default is a local CLI
    // could attach and send in that window — the backend refused, but the
    // composer had already been cleared and the bytes dropped.
    let releaseOptions: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'ai_provider_options') return new Promise((res) => { releaseOptions = res; });
      if (cmd.endsWith('_chat') || cmd.endsWith('_chats')) return Promise.resolve(chatBackend(cmd, args));
      return Promise.resolve({ query: '{}' });
    });
    renderPanel('editor');
    await screen.findByTestId('chat-input');

    // The attach control is disabled, and a paste attaches nothing.
    expect(screen.getByTestId('chat-attach-btn')).toBeDisabled();
    // The paste is also left alone rather than swallowed: suppressing it and only
    // then finding out images are not accepted lost it in silence.
    const notOurs = new Event('paste', { bubbles: true, cancelable: true }) as any;
    const held = new File([new Uint8Array(3)], 'shot.png', { type: 'image/png' });
    notOurs.clipboardData = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => held }],
    };
    fireEvent(screen.getByTestId('chat-input'), notOurs);
    expect(notOurs.defaultPrevented).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
    // ...and no note either: the user was not offered anything to be refused.
    expect(screen.queryByTestId('chat-image-note')).not.toBeInTheDocument();

    // Once the capability is known for an HTTP provider, attaching works.
    await act(async () => {
      releaseOptions(OPTIONS);
    });
    await waitFor(() => expect(screen.getByTestId('chat-attach-btn')).not.toBeDisabled());
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');
  });

  it('offers no Load models button for a CLI that cannot list them', async () => {
    // A CLI with no listing command — every built-in agent, and any custom one
    // that left the optional field blank — used to get an enabled button whose
    // click ran an empty command, failed, and said nothing.
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');

    await pickProvider('Bare CLI');
    await screen.findByTestId('ai-chat-model-input');
    expect(screen.queryByTestId('ai-chat-models-load')).not.toBeInTheDocument();

    // The one that can list them still offers it.
    await pickProvider('My Ollama');
    await screen.findByTestId('ai-chat-models-load');
  });

  it('says so when a CLI model list command fails', async () => {
    // The click was silent on failure, which read as broken rather than as a
    // command that did not work.
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'ai_provider_options') return Promise.resolve(OPTIONS);
      if (cmd === 'list_ai_models_for') return Promise.reject(new Error('ollama: not found'));
      if (cmd.endsWith('_chat') || cmd.endsWith('_chats')) return Promise.resolve(chatBackend(cmd, args));
      return Promise.resolve({ query: '{}' });
    });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('My Ollama');

    fireEvent.click(await screen.findByTestId('ai-chat-models-load'));
    await screen.findByTestId('ai-chat-models-failed');
  });

  it('does not let an abandoned read block or unblock the next conversation', async () => {
    // A read belonging to the chat the user just left kept Send disabled until it
    // settled, and zeroing the count without scoping its decrement would then let
    // that stale cleanup rob a newer read's count.
    const pending: Array<() => void> = [];
    const RealFileReader = globalThis.FileReader;
    class HeldReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL() {
        pending.push(() => this.onload?.());
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = HeldReader;
    try {
      mockPickerBackend({ query: '{}' });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');

      pasteImage(screen.getByTestId('chat-input')); // read held, Send gated
      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'blocked' } });
      await waitFor(() => expect(screen.getByTestId('chat-send-btn')).toBeDisabled());

      // The conversation moves on; that read is no longer anyone's business.
      fireEvent.click(screen.getByTestId('ai-chat-new-btn'));
      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'a text-only prompt' } });
      await waitFor(() => expect(screen.getByTestId('chat-send-btn')).not.toBeDisabled());

      // A NEW read starts in this conversation, gating Send again...
      pasteImage(screen.getByTestId('chat-input'));
      await waitFor(() => expect(screen.getByTestId('chat-send-btn')).toBeDisabled());

      // ...and only now does the abandoned one settle. Order matters: its cleanup
      // has to land *after* the new read incremented, or an unscoped decrement
      // just hits the floor at zero and the bug stays hidden.
      const abandoned = pending[0];
      await act(async () => {
        abandoned();
      });
      // The new read is still outstanding, so Send stays held.
      expect(screen.getByTestId('chat-send-btn')).toBeDisabled();
      // And when it does land, Send opens up — the count was not driven negative.
      await act(async () => {
        pending[1]();
      });
      await waitFor(() => expect(screen.getByTestId('chat-send-btn')).not.toBeDisabled());
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('will not send while an image is still being read', async () => {
    // Send captured only what was already in state, so an image pasted and sent
    // before its read finished went out missing from the prompt — and then
    // attached itself to the *next* prompt's composer, one turn late.
    const pending: Array<() => void> = [];
    const RealFileReader = globalThis.FileReader;
    class HeldReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL() {
        pending.push(() => this.onload?.());
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = HeldReader;
    try {
      mockPickerBackend({ query: JSON.stringify({ queryType: 'find', filter: {} }) });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');

      pasteImage(screen.getByTestId('chat-input'));
      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'what is this' } });
      // The read has not settled, so Send is held.
      await waitFor(() => expect(screen.getByTestId('chat-send-btn')).toBeDisabled());
      fireEvent.click(screen.getByTestId('chat-send-btn'));
      expect(invokeMock.mock.calls.filter(([c]) => c === 'generate_mql_query')).toHaveLength(0);

      // Once it lands, the image is attached and Send opens up.
      await act(async () => {
        pending.forEach((fire) => fire());
      });
      await screen.findByTestId('chat-pending-images');
      await waitFor(() => expect(screen.getByTestId('chat-send-btn')).not.toBeDisabled());
      fireEvent.click(screen.getByTestId('chat-send-btn'));
      await waitFor(() =>
        expect(invokeMock.mock.calls.filter(([c]) => c === 'generate_mql_query')).toHaveLength(1),
      );
      // ...and it went WITH the prompt, not after it.
      const args = invokeMock.mock.calls.filter(([c]) => c === 'generate_mql_query').at(-1)![1] as any;
      expect(args.images).toHaveLength(1);
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('keeps an image pasted while a reply is still pending', async () => {
    // The composer stays usable during generation, so a user can prepare the next
    // prompt's attachment. Clearing everything on success deleted it unsent.
    let releaseReply: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'ai_provider_options') return Promise.resolve(OPTIONS);
      if (cmd === 'list_ai_models_for') return Promise.resolve([]);
      if (cmd.endsWith('_chat') || cmd.endsWith('_chats')) return Promise.resolve(chatBackend(cmd, args));
      if (cmd === 'generate_mql_query') return new Promise((res) => { releaseReply = res; });
      return Promise.resolve(null);
    });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');

    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');
    send('what query matches this');

    // A second image is prepared while the first request is still running.
    pasteImage(screen.getByTestId('chat-input'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-pending-images').querySelectorAll('img')).toHaveLength(1),
    );

    await act(async () => {
      releaseReply({ query: JSON.stringify({ queryType: 'find', filter: {} }) });
    });

    // The sent one is gone; the one pasted since is still there for the next turn.
    await waitFor(() =>
      expect(screen.getByTestId('chat-pending-images').querySelectorAll('img')).toHaveLength(1),
    );
  });

  it('keeps the attachment when the send fails, and drops it when it succeeds', async () => {
    // Whether a given HTTP model accepts an image is not knowable — no
    // OpenAI-compatible endpoint advertises vision support — so a text-only model
    // rejecting the payload is a real outcome. Clearing the composer first meant
    // the bytes were gone and the screenshot had to be found and pasted again.
    let fail = true;
    invokeMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'ai_provider_options') return Promise.resolve(OPTIONS);
      if (cmd === 'list_ai_models_for') return Promise.resolve([]);
      if (cmd.endsWith('_chat') || cmd.endsWith('_chats')) return Promise.resolve(chatBackend(cmd, args));
      if (cmd === 'generate_mql_query') {
        return fail
          ? Promise.reject(new Error('this model does not support images'))
          : Promise.resolve({ query: JSON.stringify({ queryType: 'find', filter: {} }) });
      }
      return Promise.resolve(null);
    });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');

    send('what query matches this');
    // The provider refused it — the image is still attached, ready to retry.
    await waitFor(() => expect(screen.getByText(/does not support images/)).toBeInTheDocument());
    expect(screen.getByTestId('chat-pending-images')).toBeInTheDocument();

    // Retried against a provider that accepts it: now the bytes are done.
    fail = false;
    send('try again');
    await waitFor(() =>
      expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument(),
    );
  });

  it('re-reads its provider list when settings change elsewhere', async () => {
    // Settings can be open in another pane or window. The list was fetched once,
    // so deleting the selected provider there left its id selected here and the
    // next request failed with "Unknown AI provider" until the panel remounted.
    let options = OPTIONS;
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd === 'ai_provider_options'
        ? Promise.resolve(options)
        : cmd.endsWith('_chat') || cmd.endsWith('_chats')
          ? Promise.resolve(chatBackend(cmd, args))
          : cmd === 'list_ai_models_for'
            ? Promise.resolve([])
            : Promise.resolve({ query: '{}' }),
    );
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('DeepSeek');
    await waitFor(() =>
      expect(screen.getByTestId('ai-chat-provider-select')).toHaveTextContent('DeepSeek'),
    );

    // DeepSeek is deleted in Settings, which broadcasts.
    options = OPTIONS.filter((o) => o.name !== 'DeepSeek');
    expect(providerListeners).not.toHaveLength(0);
    await act(async () => {
      providerListeners.forEach((fn) => fn());
    });

    // The selection falls back to the default rather than naming a provider the
    // backend no longer knows.
    await waitFor(() =>
      expect(screen.getByTestId('ai-chat-provider-select')).not.toHaveTextContent('DeepSeek'),
    );
  });

  it('reads only as many images as can be attached, and still says why', async () => {
    // Reading is what allocates: base64-encoding a multi-select of files near the
    // 5 MiB cap could run to hundreds of megabytes only for four to be kept.
    const read: string[] = [];
    const RealFileReader = globalThis.FileReader;
    class CountingReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL(file: File) {
        read.push(file.name);
        // Resolve on a later task, as a real reader does.
        setTimeout(() => this.onload?.(), 0);
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = CountingReader;
    try {
      mockPickerBackend({ query: '{}' });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');

      const items = Array.from({ length: 7 }, (_, i) => {
        const file = new File([new Uint8Array(3)], `shot${i}.png`, { type: 'image/png' });
        return { kind: 'file', type: 'image/png', getAsFile: () => file };
      });
      fireEvent.paste(screen.getByTestId('chat-input'), { clipboardData: { items } });

      // Four is the allowance; the other three are never read at all.
      expect(read).toHaveLength(4);
      // ...and the user is told the count is what stopped them.
      await waitFor(() => expect(screen.getByTestId('chat-image-note')).toBeInTheDocument());
      expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/at most|4/);
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('drops an image still being read when a local CLI provider is picked', async () => {
    // Switching to a CLI cleared only the images already in state. A read still
    // in flight is not in state, so nothing invalidated it and its callback —
    // holding the previous render's "this provider takes images" — attached the
    // image after the CLI was selected, where it could never be sent.
    const readers: { onload: (() => void) | null; result: string }[] = [];
    const RealFileReader = globalThis.FileReader;
    class DeferredReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL() {
        readers.push(this);
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = DeferredReader;
    try {
      mockPickerBackend({ query: '{}' });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');

      pasteImage(screen.getByTestId('chat-input'));
      expect(readers).toHaveLength(1); // in flight, and not yet in state
      await pickProvider('Claude Code (local)');

      await act(async () => {
        readers.forEach((r) => r.onload?.());
      });
      expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
      // ...and the user is told why the image they chose is gone.
      expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/cannot receive images/);
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('starts on the settings default and sends the picked provider and model', async () => {
    mockPickerBackend({ query: JSON.stringify({ explanation: 'ok', queryType: 'find', filter: {} }) }, ['deepseek-chat', 'deepseek-reasoner']);
    renderPanel('editor');
    const trigger = await screen.findByTestId('ai-chat-provider-select');
    expect(trigger).toHaveTextContent('Anthropic');

    await pickProvider('DeepSeek');
    // The provider's models arrive and the model field becomes a dropdown.
    await screen.findByTestId('ai-chat-model-select');
    await pickModel('deepseek-reasoner');

    send('anything');
    await screen.findByText('ok');
    expect(lastGenerateArgs()).toMatchObject({ providerId: 'deepseek', model: 'deepseek-reasoner' });
    // and the conversation remembers the choice
    const saved = invokeMock.mock.calls.filter((c) => c[0] === 'save_chat').at(-1)![1].chat;
    expect(saved).toMatchObject({ providerId: 'deepseek', model: 'deepseek-reasoner' });
  });

  it('falls back to a text box when the provider lists no models', async () => {
    mockPickerBackend({ query: '{}' }, []);
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    expect(screen.getByTestId('ai-chat-model-input')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-model-select')).not.toBeInTheDocument();
  });

  it('opens on an existing chat with the provider that chat used', async () => {
    chatStore = [{
      id: 'c9', title: 'old', messages: [{ id: 'm1', role: 'user', text: 'hi' }],
      connectionName: 'Local', database: 'test-db', collection: 'users', variant: 'editor',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      providerId: 'deepseek', model: 'deepseek-chat',
    }];
    mockPickerBackend({ query: '{}' });
    renderPanel('editor', { chatId: 'c9' });
    const trigger = await screen.findByTestId('ai-chat-provider-select');
    await waitFor(() => expect(trigger).toHaveTextContent('DeepSeek'));
  });

  it('opens a legacy conversation on the default provider, not the one last used', async () => {
    // Chats saved before providers existed have no providerId; absence means
    // "the default", and must not inherit whatever this panel was just using.
    chatStore = [{
      id: 'legacy', title: 'old', messages: [{ id: 'm1', role: 'user', text: 'hi' }],
      connectionName: 'Local', database: 'test-db', collection: 'users', variant: 'editor',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    mockPickerBackend({ query: '{}' });
    renderPanel('editor', { chatId: 'legacy' });
    const trigger = await screen.findByTestId('ai-chat-provider-select');
    await waitFor(() => expect(trigger).toHaveTextContent('Anthropic'));
  });

  it('prevents the default paste before reading images, so no stray text lands in the prompt', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    const file = new File([new Uint8Array(3)], 'shot.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as any;
    event.clipboardData = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }, { kind: 'string', type: 'text/plain' }] };
    screen.getByTestId('chat-input').dispatchEvent(event);
    // Synchronously — before any FileReader work has had a chance to run.
    expect(event.defaultPrevented).toBe(true);
    await screen.findByTestId('chat-pending-images');
  });

  it('treats an empty reply object as an error rather than a match-all query', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    send('adults');
    await screen.findByText(/returned no query/);
    expect(screen.queryByTestId('chat-query-card')).not.toBeInTheDocument();
  });

  it('works without a picker when the provider list cannot be read', async () => {
    invokeMock.mockImplementation((cmd: string, args: any) =>
      cmd.endsWith('_chat') || cmd.endsWith('_chats')
        ? Promise.resolve(chatBackend(cmd, args))
        : cmd === 'ai_provider_options'
          ? Promise.reject('locked')
          : Promise.resolve({ query: JSON.stringify({ explanation: 'still fine', queryType: 'find', filter: {} }) })
    );
    renderPanel('editor');
    send('adults');
    await screen.findByText('still fine');
    expect(screen.queryByTestId('ai-chat-provider-picker')).not.toBeInTheDocument();
    // No override is sent, so the backend uses the settings default.
    expect(lastGenerateArgs().providerId).toBeUndefined();
  });

  it('offers no model for a built-in agent whose command does not use one', async () => {
    // `claude -p {prompt}` has no {model}; a field here would look like a
    // setting and change nothing about the request.
    mockPickerBackend({ query: '{}' }, ['ignored']);
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('Claude Code (local)');
    await waitFor(() => {
      expect(screen.queryByTestId('ai-chat-model-select')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ai-chat-model-input')).not.toBeInTheDocument();
    });
  });

  it('offers a model for a local CLI, but only lists them when asked', async () => {
    // Listing a CLI provider's models *runs its saved command*. Selecting the
    // provider must not do that on its own, or opening the panel executes an
    // arbitrary local program; Settings applies the same rule.
    mockPickerBackend({ query: '{}' }, ['llama3:latest', 'mistral:7b']);
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('My Ollama');

    // The model can be typed, and nothing has been run.
    await screen.findByTestId('ai-chat-model-input');
    expect(screen.queryByTestId('ai-chat-model-select')).not.toBeInTheDocument();
    // Scoped to this provider: the non-CLI default was listed on mount, which is
    // fine — it makes an HTTP request, not a local process.
    const cliListings = () =>
      invokeMock.mock.calls.filter(
        ([c, a]) => c === 'list_ai_models_for' && (a as { providerId?: string })?.providerId === 'my-ollama',
      );
    expect(cliListings()).toHaveLength(0);

    // Asked for explicitly, the command runs and the picker appears.
    fireEvent.click(screen.getByTestId('ai-chat-models-load'));
    await screen.findByTestId('ai-chat-model-select');
    expect(cliListings()).toHaveLength(1);
  });

  it('clears a pending image and the provider override when starting a new chat', async () => {
    mockPickerBackend({ query: '{}' }, ['deepseek-chat']);
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    await pickProvider('DeepSeek');
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');

    fireEvent.click(screen.getByTestId('ai-chat-new-btn'));

    // The attachment belonged to the previous conversation.
    expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
    // ...and so did the override; a new chat starts on the default.
    await waitFor(() =>
      expect(screen.getByTestId('ai-chat-provider-select')).toHaveTextContent('Anthropic')
    );
  });

  it('drops an image still being read when the conversation changes under it', async () => {
    // Reading a file is asynchronous. Clicking New chat while a paste is still
    // being read used to clear only what was already in state, so the read
    // resolved afterwards and attached the old image to the new conversation,
    // where it would be sent with an unrelated prompt.
    //
    // `FileReader` is stubbed rather than awaited: the point is that the read
    // completes *after* the conversation changed, and a real reader gives no way
    // to place it there. Waiting a tick instead proved nothing — jsdom had not
    // finished reading by then, so the assertion held either way.
    const readers: { onload: (() => void) | null; result: string }[] = [];
    const RealFileReader = globalThis.FileReader;
    class DeferredReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      result = 'data:image/png;base64,AAAA';
      readAsDataURL() {
        readers.push(this);
      }
    }
    (globalThis as unknown as { FileReader: unknown }).FileReader = DeferredReader;
    try {
      mockPickerBackend({ query: '{}' });
      renderPanel('editor');
      await screen.findByTestId('ai-chat-provider-select');

      pasteImage(screen.getByTestId('chat-input'));
      expect(readers).toHaveLength(1); // the read is in flight
      fireEvent.click(screen.getByTestId('ai-chat-new-btn'));

      // Only now does the read finish, with the image the user pasted into the
      // conversation they have already left.
      await act(async () => {
        readers.forEach((r) => r.onload?.());
      });
      expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealFileReader;
    }
  });

  it('clears a pending image when another conversation is opened from History', async () => {
    // The attachment belongs to the chat it was added to; it must not be sent
    // with the next prompt in a different conversation.
    chatStore = [{
      id: 'other', title: 'other chat', messages: [{ id: 'm1', role: 'user', text: 'hi' }],
      connectionName: 'Local', database: 'test-db', collection: 'users', variant: 'editor',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    pasteImage(screen.getByTestId('chat-input'));
    await screen.findByTestId('chat-pending-images');

    fireEvent.click(screen.getByTestId('ai-chat-history-btn'));
    fireEvent.click(await screen.findByText('other chat'));

    await waitFor(() =>
      expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument()
    );
  });

  it('falls back to the default when the stored provider no longer exists', async () => {
    // A conversation naming a provider the user has since deleted would send an
    // id the backend rejects, and could not continue until changed by hand.
    chatStore = [{
      id: 'c-gone', title: 'old', messages: [{ id: 'm1', role: 'user', text: 'hi' }],
      connectionName: 'Local', database: 'test-db', collection: 'users', variant: 'editor',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      providerId: 'deleted-provider', model: 'whatever',
    }];
    mockPickerBackend({ query: JSON.stringify({ explanation: 'ok', queryType: 'find', filter: {} }) });
    renderPanel('editor', { chatId: 'c-gone' });
    const trigger = await screen.findByTestId('ai-chat-provider-select');
    await waitFor(() => expect(trigger).toHaveTextContent('Anthropic'));

    send('anything');
    await screen.findByText('ok');
    expect(lastGenerateArgs().providerId).toBe('anthropic');
  });

  it('refuses an image format the backend cannot send, before anything is lost', async () => {
    // `image/*` accepted SVG and HEIC, which previewed fine and then failed
    // validation after the prompt and attachment had already been cleared.
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    pasteImage(screen.getByTestId('chat-input'), 'image/svg+xml');
    await screen.findByTestId('chat-image-note');
    expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/PNG, JPEG, WebP and GIF/);
    expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
  });

  it('accepts each format the backend allows', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    for (const type of ACCEPTED_IMAGE_TYPES) {
      pasteImage(screen.getByTestId('chat-input'), type);
    }
    await screen.findByTestId('chat-pending-images');
    // Four formats, and the cap is four.
    expect(screen.getAllByTestId(/chat-pending-image-remove-/)).toHaveLength(4);
  });

  it('refuses an oversized image without reading or sending it', async () => {
    // The backend rejected it only after the composer had been cleared, so the
    // question was lost — and the whole file had been base64-encoded first.
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'what is this' } });

    pasteImage(screen.getByTestId('chat-input'), 'image/png', 6 * 1024 * 1024);
    await screen.findByTestId('chat-image-note');
    expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/under 5 MB/);
    expect(screen.queryByTestId('chat-pending-images')).not.toBeInTheDocument();
    // The typed question is untouched.
    expect(screen.getByTestId('chat-input')).toHaveValue('what is this');
  });

  it('attaches the acceptable images from a mixed selection and explains the rest', async () => {
    mockPickerBackend({ query: '{}' });
    renderPanel('editor');
    await screen.findByTestId('ai-chat-provider-select');
    const ok = new File([new Uint8Array(4)], 'a.png', { type: 'image/png' });
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], 'b.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [ok, huge] } });

    await screen.findByTestId('chat-pending-images');
    expect(screen.getAllByTestId(/chat-pending-image-remove-/)).toHaveLength(1);
    expect(screen.getByTestId('chat-image-note')).toHaveTextContent(/under 5 MB/);
  });
});

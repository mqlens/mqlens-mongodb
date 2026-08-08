import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIChatPanel } from '../AIChatPanel';
import { resetChatRequests } from '../../lib/aiChatRequest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

describe('AIChatPanel', () => {
  const onInsertQuery = vi.fn();
  const onInsertAndRunQuery = vi.fn();
  const onClose = vi.fn();

  const renderPanel = (variant: 'editor' | 'shell' = 'shell') =>
    render(
      <AIChatPanel
        connectionId="c1"
        databaseName="test-db"
        collectionName="users"
        fields={['name', 'age']}
        variant={variant}
        isOpen
        onClose={onClose}
        onInsertQuery={onInsertQuery}
        onInsertAndRunQuery={onInsertAndRunQuery}
      />
    );

  beforeEach(() => {
    resetChatRequests();
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
      />
    );
    expect(container.querySelector('[data-testid="ai-helper-panel"]')).toBeNull();
  });

  it('seeds from initialMessages and reports changes via onMessagesChange', async () => {
    const onMessagesChange = vi.fn();
    const initial = [
      { id: 'm0', role: 'user' as const, text: 'list adults' },
      { id: 'm1', role: 'assistant' as const, text: 'Here you go.' },
    ];
    invokeMock.mockResolvedValue(
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
    const calls = onMessagesChange.mock.calls;
    const lastCall = calls[calls.length - 1][0] as Array<{ id: string; text: string }>;
    expect(lastCall.map((m) => m.text)).toEqual(['list adults', 'Here you go.', 'again', 'Again.']);
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
    invokeMock.mockImplementation(() => new Promise<string>((res) => { resolveInvoke = res; }));

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
    invokeMock.mockImplementation(() => new Promise<string>((res) => { resolveInvoke = res; }));

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
    invokeMock.mockResolvedValue(
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

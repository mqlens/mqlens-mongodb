import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const writeRequestListeners: Array<
  (r: { id: string; tool: string; summary: string; requester: string | null }) => void
> = [];
const writeSettledListeners: Array<(id: string) => void> = [];
vi.mock('../../workspace/workspaceStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/workspaceStore')>()),
  subscribeMcpWriteRequest: (fn: (r: any) => void) => {
    writeRequestListeners.push(fn);
    return Promise.resolve(() => {
      const i = writeRequestListeners.indexOf(fn);
      if (i >= 0) writeRequestListeners.splice(i, 1);
    });
  },
  subscribeMcpWriteSettled: (fn: (id: string) => void) => {
    writeSettledListeners.push(fn);
    return Promise.resolve(() => {
      const i = writeSettledListeners.indexOf(fn);
      if (i >= 0) writeSettledListeners.splice(i, 1);
    });
  },
}));

import { McpWriteConfirm } from '../McpWriteConfirm';
import { resetWriteRequestsForTests, startWriteRequests } from '../../lib/mcpWriteRequests';

const emit = async (r: {
  id: string;
  tool: string;
  summary: string;
  requester: string | null;
}) => {
  await act(async () => {
    writeRequestListeners.forEach((fn) => fn(r));
  });
};

describe('McpWriteConfirm — an external MCP write is confirmed app-wide (#352 review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWriteRequestsForTests();
    writeRequestListeners.length = 0;
    writeSettledListeners.length = 0;
    invokeMock.mockResolvedValue(undefined);
  });

  it('prompts for a write no conversation asked for, wherever the user is', async () => {
    // The panel that used to own this renders nothing while closed and is
    // unmounted on a tab switch, so an external client's write had no prompt
    // at all unless the user happened to be sitting in a chat.
    render(<McpWriteConfirm />);
    await act(async () => {});

    await emit({
      id: 'ext1',
      tool: 'delete_many',
      summary: '{ "namespace": "shop.orders" }',
      requester: null,
    });

    expect(await screen.findByTestId('mcp-write-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-write-confirm-tool')).toHaveTextContent('delete_many');
    // The operation itself, not a byte count: it is what the decision rests on.
    expect(screen.getByTestId('mcp-write-confirm-summary')).toHaveTextContent('shop.orders');
  });

  it('recovers a write that arrived before anything was on screen', async () => {
    // The store listens from app start, so a write parked in the backend before
    // any UI existed is still answerable rather than left to time out.
    startWriteRequests();
    await act(async () => {});
    expect(writeRequestListeners).not.toHaveLength(0);

    await emit({ id: 'ext2', tool: 'update_many', summary: 'from an external client', requester: null });

    render(<McpWriteConfirm />);
    expect(await screen.findByTestId('mcp-write-confirm-summary')).toHaveTextContent(
      'from an external client',
    );
  });

  it('carries an approval and a refusal back to the backend', async () => {
    render(<McpWriteConfirm />);
    await act(async () => {});

    await emit({ id: 'ext3', tool: 'insert_one', summary: 'doc', requester: null });
    fireEvent.click(await screen.findByTestId('mcp-write-confirm-allow'));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('mcp_resolve_write', { id: 'ext3', approved: true }),
    );
    // Answered, so it stops being offered.
    await waitFor(() => expect(screen.queryByTestId('mcp-write-confirm')).toBeNull());

    await emit({ id: 'ext4', tool: 'delete_many', summary: 'doc', requester: null });
    fireEvent.click(await screen.findByTestId('mcp-write-confirm-refuse'));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('mcp_resolve_write', { id: 'ext4', approved: false }),
    );
  });

  it('leaves a request addressed to a conversation to that conversation', async () => {
    // Those stay in the chat that asked, where the user can see what led to them.
    render(<McpWriteConfirm />);
    await act(async () => {});

    await emit({ id: 'chat1', tool: 'insert_one', summary: 'doc', requester: 'chat-42' });

    expect(screen.queryByTestId('mcp-write-confirm')).toBeNull();
  });

  it('stops offering a request another window has already answered', async () => {
    render(<McpWriteConfirm />);
    await act(async () => {});
    await emit({ id: 'ext5', tool: 'delete_many', summary: 'doc', requester: null });
    expect(await screen.findByTestId('mcp-write-confirm')).toBeInTheDocument();

    await act(async () => {
      writeSettledListeners.forEach((fn) => fn('ext5'));
    });

    expect(screen.queryByTestId('mcp-write-confirm')).toBeNull();
  });
});

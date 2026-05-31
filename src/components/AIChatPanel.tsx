import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, User, X } from 'lucide-react';
import { buildRunnableCommand, type GeneratedQuery } from '../lib/mongoCommand';

export type { GeneratedQuery };

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  query?: GeneratedQuery;
  error?: boolean;
}

interface AIChatPanelProps {
  connectionId?: string;
  databaseName?: string;
  collectionName: string;
  fields?: string[];
  // 'shell' shows the runnable mongosh command (with Copy); 'editor' shows the
  // raw query JSON, matching the original in-editor assistant behavior.
  variant: 'editor' | 'shell';
  isOpen: boolean;
  onClose: () => void;
  onInsertQuery: (query: GeneratedQuery) => void;
  onInsertAndRunQuery: (query: GeneratedQuery) => void;
}

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  collectionName,
  fields = [],
  variant,
  isOpen,
  onClose,
  onInsertQuery,
  onInsertAndRunQuery,
}) => {
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [aiHelperWidth, setAIHelperWidth] = useState(340);
  const [isResizingAIHelper, setIsResizingAIHelper] = useState(false);
  const chatScrollRef = React.useRef<HTMLDivElement>(null);
  const chatIdRef = React.useRef(0);
  const nextChatId = () => `m${chatIdRef.current++}`;

  const startResizingAIHelper = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingAIHelper(true);
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!isResizingAIHelper) return;
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 240 && newWidth <= 600) setAIHelperWidth(newWidth);
    };
    const up = () => setIsResizingAIHelper(false);
    if (isResizingAIHelper) {
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [isResizingAIHelper]);

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading) return;

    // History sent to the model: prior turns as plain text (assistant turns
    // include the query JSON so multi-turn refinements have context).
    const history = chatMessages.map((m) => ({
      role: m.role,
      content:
        m.role === 'assistant' && m.query
          ? `${m.text}\n${JSON.stringify(m.query)}`
          : m.text,
    }));

    const userMsg: ChatMessage = { id: nextChatId(), role: 'user', text };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setIsChatLoading(true);

    try {
      const raw = await invoke<string>('generate_mql_query', {
        prompt: text,
        collection: collectionName,
        fields,
        history,
        target: variant === 'shell' ? 'shell' : 'editor',
      });
      const parsed = JSON.parse(raw) as {
        explanation?: string;
        queryType?: 'find' | 'aggregate' | 'script';
        filter?: unknown;
        sort?: unknown;
        projection?: unknown;
        pipeline?: unknown[];
        script?: string;
      };
      const queryType: 'find' | 'aggregate' | 'script' =
        parsed.queryType === 'aggregate'
          ? 'aggregate'
          : parsed.queryType === 'script'
            ? 'script'
            : 'find';
      const query: GeneratedQuery = {
        queryType,
        filter: parsed.filter ?? {},
        sort: parsed.sort ?? {},
        projection: parsed.projection,
        pipeline: Array.isArray(parsed.pipeline) ? parsed.pipeline : [],
        script: typeof parsed.script === 'string' ? parsed.script : '',
      };
      setChatMessages((prev) => [
        ...prev,
        {
          id: nextChatId(),
          role: 'assistant',
          text: parsed.explanation ?? 'Here is a query.',
          query,
        },
      ]);
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        { id: nextChatId(), role: 'assistant', text: String(err), error: true },
      ]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // Keep the chat scrolled to the latest message.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages, isChatLoading]);

  if (!isOpen) return null;

  return (
    <>
      {/* Resize Handle */}
      <div
        className="query-builder-resizer"
        onMouseDown={startResizingAIHelper}
        data-testid="ai-helper-resizer"
      />
      <div
        className="query-builder-panel border-l border-b border-[var(--border-color)] bg-[var(--bg-panel)] flex flex-col flex-shrink-0"
        style={{ width: aiHelperWidth }}
        data-testid="ai-helper-panel"
      >
        {/* Header */}
        <div className="query-builder-header">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-main)]">
            <Sparkles size={11} className="text-[var(--accent-blue)]" />
            <span>AI Query Assistant</span>
          </div>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-[var(--bg-item-active)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition-all"
            title="Close AI Assistant"
          >
            <X size={12} />
          </button>
        </div>

        {/* Chat message list */}
        <div
          ref={chatScrollRef}
          className="flex-1 overflow-y-auto p-3 flex flex-col gap-3"
          data-testid="ai-chat-messages"
        >
          {chatMessages.length === 0 && !isChatLoading && (
            <div className="text-[var(--text-dim)]" style={{ fontSize: 11, lineHeight: 1.5 }}>
              Ask for a query in plain language — e.g. <em>“active users older than 30, sorted by age”</em> or
              <em> “average order total per customer”</em>. I’ll explain what I’m doing and you can insert the result.
            </div>
          )}

          {chatMessages.map((m) => (
            <div
              key={m.id}
              className="flex flex-col gap-1"
              style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}
              data-testid={`chat-msg-${m.role}`}
            >
              <div
                className="flex items-center gap-1 text-[var(--text-dim)]"
                style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.04em' }}
              >
                {m.role === 'user' ? <User size={9} /> : <Sparkles size={9} />}
                <span>{m.role === 'user' ? 'You' : 'Assistant'}</span>
              </div>
              <div
                style={{
                  maxWidth: '92%',
                  padding: '7px 9px',
                  borderRadius: 8,
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  background: m.role === 'user' ? 'var(--bg-item-active)' : 'var(--bg-base)',
                  border: '1px solid var(--border-color)',
                  color: m.error ? 'var(--accent-red)' : 'var(--text-main)',
                }}
              >
                {m.text}
              </div>

              {m.query && (
                <div
                  className="flex flex-col gap-1"
                  style={{ width: '92%', marginTop: 2 }}
                  data-testid="chat-query-card"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="mql-mono"
                      style={{ fontSize: 9, color: 'var(--accent-blue)', textTransform: 'uppercase' }}
                    >
                      {m.query.queryType === 'aggregate'
                        ? 'Aggregation pipeline'
                        : m.query.queryType === 'script'
                          ? 'Shell script'
                          : 'Find query'}
                    </span>
                  </div>
                  <pre
                    data-testid={variant === 'shell' ? 'chat-runnable-cmd' : 'chat-query-json'}
                    style={{
                      margin: 0,
                      padding: 6,
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 4,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      maxHeight: 220,
                      overflow: 'auto',
                      color: 'var(--text-main)',
                    }}
                  >
                    {variant === 'shell'
                      ? buildRunnableCommand(m.query, collectionName)
                      : m.query.queryType === 'aggregate'
                        ? JSON.stringify(m.query.pipeline ?? [], null, 2)
                        : JSON.stringify(
                            {
                              filter: m.query.filter ?? {},
                              sort: m.query.sort ?? {},
                              ...(m.query.projection !== undefined
                                ? { projection: m.query.projection }
                                : {}),
                            },
                            null,
                            2
                          )}
                  </pre>
                  <div className="flex gap-1">
                    {variant === 'shell' && (
                      <button
                        onClick={() =>
                          navigator.clipboard?.writeText(buildRunnableCommand(m.query!, collectionName))
                        }
                        className="mql-btn mql-btn-ghost mql-btn-outlined"
                        style={{ justifyContent: 'center', flex: 1 }}
                        data-testid="chat-copy-btn"
                      >
                        Copy
                      </button>
                    )}
                    <button
                      onClick={() => onInsertQuery(m.query!)}
                      className="mql-btn mql-btn-ghost mql-btn-outlined"
                      style={{ justifyContent: 'center', flex: 1 }}
                      data-testid="chat-insert-btn"
                    >
                      Insert
                    </button>
                    <button
                      onClick={() => onInsertAndRunQuery(m.query!)}
                      className="mql-btn mql-btn-primary"
                      style={{ justifyContent: 'center', flex: 1 }}
                      data-testid="chat-insert-run-btn"
                    >
                      Insert &amp; run
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {isChatLoading && (
            <div
              className="flex items-center gap-2 text-[var(--text-muted)]"
              data-testid="chat-thinking"
              style={{ fontSize: 11 }}
            >
              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-[var(--accent-blue)]" />
              <span>Thinking…</span>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-[var(--border-color)] p-2 flex flex-col gap-2 flex-shrink-0">
          <textarea
            className="query-builder-input"
            style={{ minHeight: '52px', padding: '6px 8px', resize: 'vertical' }}
            placeholder="Describe a query… (Enter to send, Shift+Enter for newline)"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendChat();
              }
            }}
            data-testid="chat-input"
          />
          <button
            onClick={handleSendChat}
            className="mql-btn mql-btn-primary"
            style={{ justifyContent: 'center' }}
            disabled={isChatLoading || !chatInput.trim()}
            data-testid="chat-send-btn"
          >
            <Sparkles size={11} className="mr-1.5" />
            {isChatLoading ? 'Thinking…' : 'Send'}
          </button>
        </div>
      </div>
    </>
  );
};

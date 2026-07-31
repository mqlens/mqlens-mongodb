import React, { useState, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
  variant: 'editor' | 'shell';
  isOpen: boolean;
  onClose: () => void;
  onInsertQuery: (query: GeneratedQuery) => void;
  onInsertAndRunQuery: (query: GeneratedQuery) => void;
  /** When true, render inside a parent ResizablePanel (no own width/resizer). */
  embedded?: boolean;
}

const composerClassName = cn(
  'min-h-[52px] w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs shadow-sm transition-colors',
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
);

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  collectionName,
  fields = [],
  variant,
  isOpen,
  onClose,
  onInsertQuery,
  onInsertAndRunQuery,
  embedded = false,
}) => {
  const { t } = useTranslation('shell');
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
          text: parsed.explanation ?? t('aiChatPanel.fallbackExplanation'),
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

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages, isChatLoading]);

  if (!isOpen) return null;

  const panelContent = (
    <>
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
            <Sparkles size={11} className="text-primary" />
            <span>{t('aiChatPanel.header.title')}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            title={t('aiChatPanel.header.closeTitle')}
          >
            <X size={12} />
          </Button>
        </div>

        <div ref={chatScrollRef} className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 p-3" data-testid="ai-chat-messages">
            {chatMessages.length === 0 && !isChatLoading && (
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                {/* <em> in the original copy is rendered here as <i> — both render
                    italic and neither carries interactive behavior, but only <i>
                    is in Trans's default kept-tag list; <em> would otherwise be
                    escaped to literal text. */}
                <Trans i18nKey="shell:aiChatPanel.empty.body" t={t}>
                  Ask for a query in plain language — e.g. <i>“active users older than 30, sorted by age”</i> or
                  <i> “average order total per customer”</i>. I’ll explain what I’m doing and you can insert the result.
                </Trans>
              </div>
            )}

            {chatMessages.map((m) => (
              <div
                key={m.id}
                className={cn('flex flex-col gap-1', m.role === 'user' ? 'items-end' : 'items-start')}
                data-testid={`chat-msg-${m.role}`}
              >
                <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                  {m.role === 'user' ? <User size={9} /> : <Sparkles size={9} />}
                  <span>{m.role === 'user' ? t('aiChatPanel.roles.you') : t('aiChatPanel.roles.assistant')}</span>
                </div>
                <div
                  className={cn(
                    'max-w-[92%] whitespace-pre-wrap rounded-lg border px-2.5 py-1.5 text-[11.5px] leading-relaxed',
                    m.role === 'user' ? 'border-border bg-accent' : 'border-border bg-background',
                    m.error && 'text-destructive'
                  )}
                >
                  {m.text}
                </div>

                {m.query && (
                  <div className="mt-0.5 flex w-[92%] flex-col gap-1" data-testid="chat-query-card">
                    <span className="font-mono text-[9px] uppercase text-primary">
                      {m.query.queryType === 'aggregate'
                        ? t('aiChatPanel.queryType.aggregate')
                        : m.query.queryType === 'script'
                          ? t('aiChatPanel.queryType.script')
                          : t('aiChatPanel.queryType.find')}
                    </span>
                    <pre
                      data-testid={variant === 'shell' ? 'chat-runnable-cmd' : 'chat-query-json'}
                      className="m-0 max-h-[220px] overflow-auto rounded border border-border bg-background p-1.5 font-mono text-[10.5px] text-foreground"
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
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 flex-1 text-xs"
                          onClick={() =>
                            navigator.clipboard?.writeText(buildRunnableCommand(m.query!, collectionName))
                          }
                          data-testid="chat-copy-btn"
                        >
                          {t('aiChatPanel.actions.copy')}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => onInsertQuery(m.query!)}
                        data-testid="chat-insert-btn"
                      >
                        {t('aiChatPanel.actions.insert')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => onInsertAndRunQuery(m.query!)}
                        data-testid="chat-insert-run-btn"
                      >
                        {t('aiChatPanel.actions.insertAndRun')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {isChatLoading && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="chat-thinking">
                <div className="h-3 w-3 animate-spin rounded-full border-b-2 border-primary" />
                <span>{t('aiChatPanel.thinking')}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 flex-col gap-2 border-t border-border p-2">
          <textarea
            className={composerClassName}
            placeholder={t('aiChatPanel.composer.placeholder')}
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
          <Button
            type="button"
            className="w-full"
            size="sm"
            onClick={handleSendChat}
            disabled={isChatLoading || !chatInput.trim()}
            data-testid="chat-send-btn"
          >
            <Sparkles size={11} />
            {isChatLoading ? t('aiChatPanel.thinking') : t('aiChatPanel.composer.send')}
          </Button>
        </div>
    </>
  );

  if (embedded) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col border-l border-border bg-card" data-testid="ai-helper-panel">
        {panelContent}
      </div>
    );
  }

  return (
    <>
      <div
        className="w-1 flex-shrink-0 cursor-col-resize bg-border/50 hover:bg-primary/40"
        onMouseDown={startResizingAIHelper}
        data-testid="ai-helper-resizer"
      />
      <div
        className="flex flex-shrink-0 flex-col border-b border-l border-border bg-card"
        style={{ width: aiHelperWidth }}
        data-testid="ai-helper-panel"
      >
        {panelContent}
      </div>
    </>
  );
};

import React, { useState, useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { History, Plus, Sparkles, Trash2, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { buildRunnableCommand, type GeneratedQuery } from '../lib/mongoCommand';
import {
  getPendingChatRequest,
  startChatRequest,
  takeSettledChatRequest,
  type PendingChatReply,
} from '../lib/aiChatRequest';
import {
  claimOpenChat,
  newPanelOwner,
  tabChatOwner,
  clearChats,
  deleteChat,
  releaseOpenChat,
  listChats,
  loadChat,
  newChatId,
  saveChat,
  titleFromMessages,
  type ChatScope,
  type ChatSummary,
} from '../lib/aiChatStore';

export type { GeneratedQuery };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  query?: GeneratedQuery;
  error?: boolean;
}

interface AIChatPanelProps {
  connectionId?: string;
  /** Connection display name — scopes History + session with db/collection. */
  connectionName?: string;
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
  /** This TAB's conversation, restored on remount (App's tabChatCache for the
   *  editor, the shell session registry for the shell). Authoritative for what
   *  is on screen; `historyKey` below only persists it. */
  initialMessages?: ChatMessage[];
  onMessagesChange?: (messages: ChatMessage[]) => void;
  /** Identifies this chat across unmounts so an in-flight request can be
   *  re-attached on remount (see lib/aiChatRequest). Without it a request
   *  started here is still lost when the tab is switched away. */
  sessionKey?: string;
  /**
   * Which stored conversation this tab has open, and how to tell the tab when
   * that changes (New chat, or picking one from the history).
   *
   * The transcript itself lives in the backend (`lib/aiChatStore`); the tab
   * only remembers WHICH chat it is looking at. That is what lets two tabs on
   * one collection hold different conversations while both can reach every
   * conversation the collection has ever had.
   */
  chatId?: string;
  onChatIdChange?: (chatId: string) => void;
}

/** Highest numeric suffix among `mN` message ids, or -1 if none. */
const maxChatIdNum = (messages: ChatMessage[]): number => {
  let max = -1;
  for (const m of messages) {
    const match = /^m(\d+)$/.exec(m.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
};

const AI_HELPER_WIDTH_KEY = 'mqlens-ai-helper-width';

const composerClassName = cn(
  'min-h-[52px] w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs shadow-sm transition-colors',
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
);

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  connectionName,
  databaseName,
  collectionName,
  fields = [],
  variant,
  isOpen,
  onClose,
  onInsertQuery,
  onInsertAndRunQuery,
  embedded = false,
  initialMessages = [],
  onMessagesChange,
  sessionKey,
  chatId,
  onChatIdChange,
}) => {
  const { t } = useTranslation('shell');
  const [chatInput, setChatInput] = useState('');
  // Seeded from the tab so a tab switch is instant and needs no IPC. A tab
  // with nothing of its own adopts the collection's most recent conversation
  // instead, in the effect below — that read has to be awaited, and gating the
  // first render on it would flash an empty panel.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialMessages);
  const [isChatLoading, setIsChatLoading] = useState(false);
  // Persisted, not per-tab: a panel width is a UI preference, and remounting
  // on every tab switch used to snap it back to the default. Mirrors
  // DataGrid's `mqlens-treekey-width`. Range matches the resizer clamp below.
  const [aiHelperWidth, setAIHelperWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(AI_HELPER_WIDTH_KEY));
    return saved >= 240 && saved <= 600 ? saved : 340;
  });
  useEffect(() => {
    localStorage.setItem(AI_HELPER_WIDTH_KEY, String(aiHelperWidth));
  }, [aiHelperWidth]);
  const [isResizingAIHelper, setIsResizingAIHelper] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // The history list defaults to this collection, which is what a user reaching
  // for it almost always wants; unticking widens it to every conversation.
  const [scopedOnly, setScopedOnly] = useState(true);
  const chatScrollRef = React.useRef<HTMLDivElement>(null);
  const chatIdRef = React.useRef(maxChatIdNum(initialMessages) + 1);
  // A promise continuation is not cancelled by unmount, so the instance that
  // started a request still resumes after the tab is switched away. It must not
  // consume the settled reply in that case — the next mount needs to find it.
  const mountedRef = React.useRef(true);
  // Must SET the flag, not only clear it on cleanup. StrictMode double-invokes
  // effects in development — run, clean up, run again — so a cleanup-only
  // version latched the flag to false on mount and every reply was then
  // discarded by the guard below: no answer, and no spinner either, because
  // the `finally` still cleared the loading state.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const nextChatId = () => `m${chatIdRef.current++}`;

  const scope: ChatScope = useMemo(
    () => ({
      connectionName: connectionName ?? '',
      database: databaseName ?? '',
      collection: collectionName,
      variant,
    }),
    [connectionName, databaseName, collectionName, variant]
  );

  // The chat this panel is writing to. A tab that has never had one gets an id
  // now rather than at first message, so the id is stable for the whole
  // conversation and the tab can be told about it once.
  const activeChatIdRef = React.useRef(chatId ?? newChatId());
  // The scope the OPEN conversation belongs to. Normally the panel's own, but
  // the history can be widened past this collection, and a chat picked from
  // there still belongs where it was created.
  const [openScope, setOpenScope] = useState<ChatScope | null>(null);
  // Whether the scope question has been ANSWERED, which is not the same as
  // having a scope: a chat that no longer exists resolves to "no foreign
  // scope", and must not leave persistence blocked forever.
  const [scopeResolved, setScopeResolved] = useState(!chatId);

  /** True when the open conversation belongs to another namespace, so its
   *  queries were written against a different collection. Running one here
   *  would target this collection with someone else's query. */
  const foreignChat =
    openScope !== null &&
    (openScope.connectionName !== (connectionName ?? '') ||
      openScope.database !== (databaseName ?? '') ||
      openScope.collection !== collectionName ||
      openScope.variant !== variant);

  /** The collection a stored command was written against. For a conversation
   *  from elsewhere that is not this tab's — showing or copying it with the
   *  local name would hand the user a command for the wrong collection. */
  const commandCollection = openScope?.collection ?? collectionName;


  // Identifies this TAB to the shared open-chat claim. Not the mount: an
  // inactive tab unmounts and must be able to re-take the conversation it never
  // stopped pointing at.
  const ownerRef = React.useRef(sessionKey ? tabChatOwner(sessionKey) : newPanelOwner());
  const createdAtRef = React.useRef(new Date().toISOString());
  const [activeChatId, setActiveChatIdState] = useState(activeChatIdRef.current);
  const setActiveChatId = (
    id: string,
    createdAt = new Date().toISOString(),
    // `openChat` has already taken the new id and released the old one; doing
    // it again here would release the claim it just won.
    reclaim = true
  ) => {
    if (reclaim) {
      releaseOpenChat(activeChatIdRef.current, ownerRef.current);
      void claimOpenChat(id, ownerRef.current);
    }
    activeChatIdRef.current = id;
    createdAtRef.current = createdAt;
    setActiveChatIdState(id);
    onChatIdChange?.(id);
  };

  // Claimed on mount and NOT released on unmount. An inactive tab is unmounted
  // but still points at its conversation, so releasing here would let another
  // tab take one that is still spoken for. The claim ends when the tab stops
  // pointing at the chat — New chat, opening a different one, or the tab
  // closing (App and the shell registry release it then).
  useEffect(() => {
    void claimOpenChat(activeChatIdRef.current, ownerRef.current);
  }, [activeChatId]);

  // Tell the tab which conversation it is on, including the one minted here for
  // a tab that arrived without any. Without this the tab still has no id after
  // the first message: the next mount mints another, saves the same transcript
  // again as a second conversation, and abandons the first claim — once per
  // tab switch.
  useEffect(() => {
    if (!chatId) onChatIdChange?.(activeChatIdRef.current);
    // Mount only: later changes go through `setActiveChatId`, which notifies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recover which namespace the open conversation belongs to. `openScope` is
  // component state and a tab switch unmounts the panel, so without this a
  // chat opened from the widened history comes back looking local — and the
  // persistence effect below would quietly move it to this collection.
  useEffect(() => {
    if (!chatId) return;
    let active = true;
    void loadChat(chatId).then((stored) => {
      if (!active) return;
      if (stored) {
        setOpenScope({
          connectionName: stored.connectionName,
          database: stored.database,
          collection: stored.collection,
          variant: stored.variant,
        });
      }
      setScopeResolved(true);
    });
    return () => {
      active = false;
    };
  }, [chatId]);

  useEffect(() => {
    onMessagesChange?.(chatMessages);
  }, [chatMessages, onMessagesChange]);

  // Persist the conversation. Skipped while empty so opening the panel and
  // closing it again does not litter the history with blank chats.
  useEffect(() => {
    if (chatMessages.length === 0) return;
    // Not until the recovery below has run for an incoming chat. The scope
    // lookup is asynchronous, and saving in the meantime would write a foreign
    // conversation under THIS collection — the very migration the recovery
    // exists to prevent.
    if (!scopeResolved) return;
    void saveChat({
      // Its own scope, not the panel's — rewriting a chat under the collection
      // that happens to be showing it would silently move it.
      ...(openScope ?? scope),
      // `activeChatId` the state, not the ref. A save queued for one transcript
      // can execute after New chat has already swapped the ref, and would then
      // store the old messages under the new id — two conversations with the
      // same content, one of them a ghost.
      id: activeChatId,
      title: titleFromMessages(chatMessages, t('aiChatPanel.history.untitled')),
      messages: chatMessages,
      createdAt: createdAtRef.current,
      updatedAt: new Date().toISOString(),
    });
  }, [chatMessages, activeChatId, openScope, scopeResolved, scope, t]);

  // Deliberately NO auto-adoption of the collection's most recent
  // conversation. A tab starts its own chat and the history is an explicit
  // choice, which removes the whole question of two tabs silently landing on
  // one transcript and saving over each other — the panel used to guess, and
  // every guess needed another guard around it.

  const refreshChats = async () => setChats(await listChats(scopedOnly ? scope : undefined));

  const startNewChat = () => {
    setOpenScope(null);
    setScopeResolved(true);
    setActiveChatId(newChatId());
    setChatMessages([]);
    setChatInput('');
    chatIdRef.current = 0;
  };

  const [claimFailed, setClaimFailed] = useState(false);
  const openChat = async (id: string) => {
    // Take it BEFORE switching. Another tab — or another window — may already
    // have this conversation open, and both panels editing it means each saves
    // a complete snapshot over the other's.
    if (!(await claimOpenChat(id, ownerRef.current))) {
      setClaimFailed(true);
      return;
    }
    setClaimFailed(false);
    const stored = await loadChat(id);
    if (!stored) return;
    setOpenScope({
      connectionName: stored.connectionName,
      database: stored.database,
      collection: stored.collection,
      variant: stored.variant,
    });
    setScopeResolved(true);
    releaseOpenChat(activeChatIdRef.current, ownerRef.current);
    setActiveChatId(stored.id, stored.createdAt, false);
    setChatMessages(stored.messages);
    chatIdRef.current = maxChatIdNum(stored.messages) + 1;
  };

  const removeChat = async (id: string) => {
    await deleteChat(id);
    // Deleting the open conversation leaves the panel on a fresh one rather
    // than showing a transcript that no longer exists anywhere.
    if (id === activeChatIdRef.current) startNewChat();
    await refreshChats();
  };


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

  /** Put a reply into a conversation that is no longer on screen, by way of
   *  the store — the panel's own state belongs to a different chat now. */
  const appendToStoredChat = async (id: string, reply: PendingChatReply) => {
    const stored = await loadChat(id);
    if (!stored) return;
    const message: ChatMessage = {
      id: `m${maxChatIdNum(stored.messages) + 1}`,
      role: 'assistant',
      text: reply.text,
      ...(reply.error ? { error: true } : { query: reply.query as GeneratedQuery | undefined }),
    };
    await saveChat({
      ...stored,
      messages: [...stored.messages, message],
      updatedAt: new Date().toISOString(),
    });
  };

  /** Append an assistant reply, assigning its id here because the id counter
   *  is panel-local and the reply may have been produced while unmounted. */
  const appendReply = (reply: PendingChatReply) => {
    setChatMessages((prev) => [
      ...prev,
      {
        id: nextChatId(),
        role: 'assistant',
        text: reply.text,
        ...(reply.error ? { error: true } : { query: reply.query as GeneratedQuery | undefined }),
      },
    ]);
  };

  // Re-attach to a request that was started before this panel last unmounted:
  // either it already settled while we were away, or it is still running and we
  // show the spinner and wait for it. Without this the reply is lost whenever
  // the user switches tabs mid-request.
  useEffect(() => {
    if (!sessionKey) return;
    const settled = takeSettledChatRequest(sessionKey);
    if (settled) {
      appendReply(settled);
      return;
    }
    const inFlight = getPendingChatRequest(sessionKey);
    if (!inFlight) return;
    let active = true;
    setIsChatLoading(true);
    void inFlight.then((reply) => {
      if (!active) return;
      takeSettledChatRequest(sessionKey);
      appendReply(reply);
      setIsChatLoading(false);
    });
    return () => {
      active = false;
    };
    // Runs once per mount for this session; appendReply is stable enough here
    // because it only closes over setState functions and the id ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading || foreignChat) return;

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
    // The conversation this question belongs to. New chat, opening a history
    // item, deleting or clearing all move `activeChatIdRef` on, and an answer
    // must not land in whichever conversation happens to be open when it
    // arrives — it would be shown there AND persisted under that chat's id.
    const askedIn = activeChatIdRef.current;

    const run = async (): Promise<PendingChatReply> => {
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
      // Keeps dev's translated fallback; the rest is the out-of-tree request
      // flow so a tab switch mid-request no longer discards the reply.
      return { text: parsed.explanation ?? t('aiChatPanel.fallbackExplanation'), query };
    };

    try {
      // Held outside the tree so switching tabs mid-request does not discard
      // the answer; `startChatRequest` also turns a rejection into an
      // `error: true` reply, so there is a single completion path.
      const reply = sessionKey
        ? await startChatRequest(sessionKey, run)
        : await run().catch((err): PendingChatReply => ({ text: String(err), error: true }));
      // Unmounted mid-request: leave the reply in the registry so the panel
      // picks it up when the user comes back to this tab.
      if (!mountedRef.current) return;
      if (sessionKey) takeSettledChatRequest(sessionKey);
      if (activeChatIdRef.current !== askedIn) {
        // The user moved to a different conversation while this was running.
        // File the answer with its question rather than dropping it.
        void appendToStoredChat(askedIn, reply);
        return;
      }
      appendReply(reply);
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
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={startNewChat}
              title={t('aiChatPanel.history.newChat')}
              data-testid="ai-chat-new-btn"
            >
              <Plus size={12} />
            </Button>
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) void refreshChats();
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title={t('aiChatPanel.history.title')}
                  data-testid="ai-chat-history-btn"
                >
                  <History size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[280px] max-w-[360px]"
                data-testid="ai-chat-history-dropdown"
              >
                <DropdownMenuCheckboxItem
                  checked={scopedOnly}
                  data-testid="ai-chat-history-scope-toggle"
                  onCheckedChange={(checked) => {
                    const next = Boolean(checked);
                    setScopedOnly(next);
                    void listChats(next ? scope : undefined).then(setChats);
                  }}
                >
                  {t('aiChatPanel.history.thisCollectionOnly')}
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                {claimFailed && (
                  <DropdownMenuItem disabled data-testid="ai-chat-history-busy">
                    {t('aiChatPanel.history.openElsewhere')}
                  </DropdownMenuItem>
                )}
                {chats.length === 0 ? (
                  <DropdownMenuItem disabled>{t('aiChatPanel.history.empty')}</DropdownMenuItem>
                ) : (
                  chats.map((entry, i) => (
                    <DropdownMenuItem
                      key={entry.id}
                      data-testid={`ai-chat-history-item-${i}`}
                      onClick={() => void openChat(entry.id)}
                      className="flex items-start gap-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs">{entry.title}</span>
                        {/* The scope line is what makes the unscoped list
                            readable — two chats can share a title. */}
                        <span className="truncate text-[10px] text-muted-foreground">
                          {`${entry.database}.${entry.collection}`}
                          {entry.id === activeChatId ? ` · ${t('aiChatPanel.history.current')}` : ''}
                        </span>
                      </span>
                      <button
                        type="button"
                        title={t('aiChatPanel.history.delete')}
                        data-testid={`ai-chat-history-delete-${i}`}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          // The row itself opens the chat; deleting must not.
                          e.stopPropagation();
                          void removeChat(entry.id);
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </DropdownMenuItem>
                  ))
                )}
                {chats.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      data-testid="ai-chat-history-clear"
                      onClick={() => {
                        void clearChats(scopedOnly ? scope : undefined).then(() => {
                          startNewChat();
                          return refreshChats();
                        });
                      }}
                      className="text-destructive focus:text-destructive"
                    >
                      {scopedOnly
                        ? t('aiChatPanel.history.clearScope')
                        : t('aiChatPanel.history.clearAll')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              title={t('aiChatPanel.header.closeTitle')}
              data-testid="ai-helper-close-btn"
            >
              <X size={12} />
            </Button>
          </div>
        </div>

        {foreignChat && openScope && (
          <div
            className="border-b border-border bg-muted/50 px-3 py-1.5 text-[10.5px] text-muted-foreground"
            data-testid="ai-chat-foreign-banner"
          >
            {t('aiChatPanel.history.viewingOtherScope', {
              scope: `${openScope.database}.${openScope.collection}`,
            })}
          </div>
        )}
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
                        ? buildRunnableCommand(m.query, commandCollection)
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
                            navigator.clipboard?.writeText(buildRunnableCommand(m.query!, commandCollection))
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
                        disabled={foreignChat}
                        title={foreignChat ? t('aiChatPanel.actions.foreignChat') : undefined}
                        data-testid="chat-insert-btn"
                      >
                        {t('aiChatPanel.actions.insert')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => onInsertAndRunQuery(m.query!)}
                        disabled={foreignChat}
                        title={foreignChat ? t('aiChatPanel.actions.foreignChat') : undefined}
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
            placeholder={
              foreignChat
                ? t('aiChatPanel.history.viewingOtherScopeShort')
                : t('aiChatPanel.composer.placeholder')
            }
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendChat();
              }
            }}
            disabled={foreignChat}
            data-testid="chat-input"
          />
          <Button
            type="button"
            className="w-full"
            size="sm"
            onClick={handleSendChat}
            disabled={isChatLoading || !chatInput.trim() || foreignChat}
            title={foreignChat ? t('aiChatPanel.actions.foreignChat') : undefined}
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

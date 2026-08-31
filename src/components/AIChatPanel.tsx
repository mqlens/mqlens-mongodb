import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, History, Paperclip, Plus, RefreshCw, Sparkles, Trash2, User, Wrench, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  answerWriteRequest,
  subscribeWriteRequests,
  writeRequestsWhere,
} from '../lib/mcpWriteRequests';
import {
  subscribeAiProvidersChanged,
  type McpWriteRequest,
} from '../workspace/workspaceStore';
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
  /** The model's reasoning or working notes, shown collapsed under the reply. */
  thoughts?: string;
  /** Images that went with a user turn — shape only, never the bytes. */
  attachments?: { mediaType: string; bytes: number }[];
  /** What a local agent ran to produce this answer. */
  toolCalls?: AgentToolCall[];
}

/** One tool a local agent ran, as reported by its own event stream. */
export interface AgentToolCall {
  name: string;
  input?: string;
  output?: string;
  failed?: boolean;
}

/** What `generate_mql_query` returns: the query JSON plus optional reasoning. */
interface AiReply {
  query: string;
  thoughts?: string;
  notes?: string;
  toolCalls?: AgentToolCall[];
}

/** One pickable provider from settings, keys withheld. */
interface ProviderOption {
  id: string;
  name: string;
  kind: 'openai-compatible' | 'anthropic-compatible' | 'gemini' | 'local-cli';
  model: string;
  isDefault: boolean;
  /** For a local CLI: whether its command contains `{model}`. */
  usesModel: boolean;
  /**
   * Whether asking for a model list can work at all. False for a CLI with no
   * listing command — every built-in agent, and any custom one that left the
   * optional field blank — and for Gemini, whose list this app does not fetch.
   */
  canListModels: boolean;
}

/** A pasted image waiting to be sent. Kept in memory only. */
interface PendingImage {
  mediaType: string;
  /** Base64 without the data: prefix — what the backend wants. */
  data: string;
  bytes: number;
  previewUrl: string;
}

const MAX_PENDING_IMAGES = 4;
/**
 * The formats the backend will actually send.
 *
 * Must match `ALLOWED_IMAGE_TYPES` in src-tauri/src/ai.rs — a drift test in
 * AIChatPanel.test.tsx reads that file and compares. `image/*` used to be
 * accepted here, so an SVG or HEIC previewed happily and then failed validation
 * *after* the prompt and the attachment had been cleared.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/**
 * Largest image the backend will send, in bytes.
 *
 * Must match `MAX_IMAGE_BYTES` in src-tauri/src/ai.rs — the same drift test
 * checks it. Enforced here so an oversized file is refused before it is read
 * into a base64 string and held in state: the backend used to reject it only
 * after the composer had been cleared, losing the question with it.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Header model <select> sentinels; a real model id never starts with `__`. */
const TYPE_MODEL = '__type_a_model__';
const CURRENT_MODEL = '__current_model__';

/** `123456` → `121 KB`, for attachment chips. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Images from a paste, as base64. Returns [] for a text paste, so the caller
 * can let the browser handle those normally.
 */
/**
 * Image files on the clipboard. Synchronous on purpose: the DataTransfer is
 * only valid during the event, and the caller must decide whether to prevent
 * the default paste *before* yielding — a clipboard entry carrying both an
 * image and text would otherwise have its text inserted into the prompt while
 * the image was still being read.
 */
/** Why a file cannot be attached, or null if it can. */
export function imageRejectionReason(file: File): 'type' | 'size' | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return 'type';
  if (file.size > MAX_IMAGE_BYTES) return 'size';
  return null;
}

export function imageFilesFromClipboard(items: DataTransferItemList | null): File[] {
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      // Collected regardless, then filtered by the caller — which needs to know
      // an image *was* on the clipboard in order to explain why it was refused.
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

export async function imagesFromClipboard(
  items: DataTransferItemList | null
): Promise<ReadImages> {
  return imagesFromFiles(imageFilesFromClipboard(items));
}

/** What a batch of reads produced, and how many of them failed. */
export interface ReadImages {
  images: PendingImage[];
  /** Files whose read failed — a file that became unreadable, say. */
  failed: number;
}

/**
 * Image files as base64, for the attach button and for paste alike.
 *
 * Settled independently rather than through `Promise.all`: one unreadable file
 * used to reject the batch, which both discarded every image that *had* been read
 * alongside it and left the rejection unhandled, so the user saw the attachment
 * simply not appear with nothing said.
 */
export async function imagesFromFiles(files: File[]): Promise<ReadImages> {
  const settled = await Promise.allSettled(
    files.map(
      (file) =>
        new Promise<PendingImage>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error('read failed'));
          reader.onload = () => {
            const url = String(reader.result);
            resolve({
              mediaType: file.type,
              data: url.slice(url.indexOf(',') + 1),
              bytes: file.size,
              previewUrl: url,
            });
          };
          try {
            reader.readAsDataURL(file);
          } catch (e) {
            reject(e);
          }
        })
    )
  );
  return {
    images: settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    failed: settled.filter((r) => r.status === 'rejected').length,
  };
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
  connectionId,
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
  // Per-conversation provider choice. Starts on the settings default and is
  // saved with the chat, so reopening it uses the same model; settings are
  // never rewritten from here.
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [chatProviderId, setChatProviderId] = useState<string | null>(null);
  // Read by callbacks that outlive the render they started in — a models command
  // still running when the user switches providers must not apply its result.
  const chatProviderIdRef = useRef(chatProviderId);
  chatProviderIdRef.current = chatProviderId;
  const [chatModel, setChatModel] = useState('');
  const [chatModels, setChatModels] = useState<string[]>([]);
  // Dropdown once the provider's models are known, text box otherwise — the
  // same rule as the settings form, and for the same reason: WKWebView barely
  // surfaces <datalist>. "Type a name…" returns to the text box.
  const [typingModel, setTypingModel] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  /**
   * Bumped whenever the pending attachments stop belonging to what the user is
   * composing: a new chat, a History item, a sent message, or a provider that
   * cannot take images.
   *
   * Reading a file is asynchronous, so clearing the state is not enough — a read
   * started before one of those events would still resolve afterwards and append
   * the old attachment to the new composer, where it would go out with an
   * unrelated prompt. Each read captures this counter and drops its result if it
   * has moved on.
   */
  const imageEpochRef = useRef(0);
  /**
   * Reads not yet settled.
   *
   * State rather than a ref because it gates Send: an image selected and sent
   * before its `FileReader` finished went out with the prompt missing, and the
   * read then attached it to the *next* prompt's composer — the image silently
   * moved one turn down. Also lets a switch to a CLI explain itself for an
   * attachment that was only ever mid-read.
   */
  const [readsInFlight, setReadsInFlight] = useState(0);
  /** Discard the pending attachments, and any read still in flight. */
  const dropPendingImages = () => {
    imageEpochRef.current += 1;
    // Abandoned reads will never reach state, so their slots are free now.
    reservedSlotsRef.current = 0;
    // ...and they no longer gate Send. Leaving the count up meant a read that
    // belonged to the conversation the user just left blocked the next prompt
    // until it settled, which for a slow or network-backed file is a visible
    // stall on a message that has nothing to do with it.
    setReadsInFlight(0);
    // Same array when there is nothing to clear: this is called on every switch
    // to a CLI provider, and a fresh `[]` would re-render for no change.
    setPendingImages((prev) => (prev.length === 0 ? prev : []));
  };
  const [imageNote, setImageNote] = useState<string | null>(null);
  const activeProvider = providerOptions.find((o) => o.id === chatProviderId) ?? null;
  // `null` until the options arrive; their effect then fills in the default.
  const defaultProviderId = () => providerOptions.find((o) => o.isDefault)?.id ?? providerOptions[0]?.id ?? null;
  // A conversation can name a provider the user has since deleted in Settings.
  // Sending that id fails with "Unknown AI provider" and the chat cannot
  // continue until the picker is changed by hand, so it falls back once the
  // options are known. Before they arrive nothing is dropped.
  useEffect(() => {
    if (providerOptions.length === 0) return;
    if (chatProviderId === null) {
      // Nothing chosen yet, or a restored chat that named no provider and was
      // loaded before the options arrived.
      setChatProviderId(defaultProviderId());
      return;
    }
    if (!providerOptions.some((o) => o.id === chatProviderId)) {
      setChatProviderId(defaultProviderId());
      setChatModel('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerOptions, chatProviderId]);
  /**
   * Whether the active provider accepts images — `null` until that is known.
   *
   * Defaulting to `true` while `ai_provider_options` was still in flight meant a
   * user whose default is a local CLI could attach and send in that window: the
   * backend rejected it, but `handleSendChat` had already cleared the composer and
   * dropped the bytes. Unknown is its own state, so the controls stay disabled
   * rather than promising something that may not hold.
   */
  const providerTakesImages: boolean | null = activeProvider
    ? activeProvider.kind !== 'local-cli'
    : null;

  /**
   * Drop attachments whenever the active provider cannot take them.
   *
   * Keyed on the *capability*, not on the click that changed it: the selection
   * also moves on its own — the fallback that runs when Settings deletes the
   * selected provider can land on a local CLI — and hanging this off
   * `choosePane` covered only the user-driven half. A read still in flight is not
   * in state yet, so it is counted too, and bumping the epoch is what stops its
   * closure from attaching an image after the switch.
   */
  useEffect(() => {
    // Not yet known: nothing to drop and nothing to explain.
    if (providerTakesImages === null) return;
    if (providerTakesImages) {
      // Nothing else clears this note, so switching back left "this provider
      // cannot receive images" standing over a composer whose attach button had
      // started working again. Only that note is cleared — a size or type
      // complaint about a file the user just picked is still theirs to see.
      setImageNote((note) =>
        note === t('aiChatPanel.composer.noImagesForCli') ? null : note
      );
      return;
    }
    if (pendingImages.length === 0 && readsInFlight === 0) return;
    dropPendingImages();
    setImageNote(t('aiChatPanel.composer.noImagesForCli'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerTakesImages]);
  // Whether choosing a model here changes the request at all.
  const modelApplies = activeProvider ? activeProvider.kind !== 'local-cli' || activeProvider.usesModel : true;

  // Re-read on mount and after any settings write. One-shot was not enough:
  // Settings can be open in another pane or window, and adding, removing or
  // re-defaulting a provider there left this list stale — the removed provider
  // stayed selectable and the next request failed with "Unknown AI provider"
  // until the panel remounted. The fallback effect above then reconciles the
  // selection, since it re-runs when this array changes.
  useEffect(() => {
    let live = true;
    const load = () => {
      invoke<unknown>('ai_provider_options')
        .then((raw) => {
          if (!live) return;
          // Guard the IPC boundary: a malformed reply should mean "no picker",
          // never a panel that fails to render.
          const opts = Array.isArray(raw) ? (raw as ProviderOption[]) : [];
          setProviderOptions(opts);
          // Only adopt the default when nothing has chosen one yet — a restored
          // chat may already have set its own.
          setChatProviderId((cur) => cur ?? opts.find((o) => o.isDefault)?.id ?? opts[0]?.id ?? null);
        })
        // Without the list the panel still works on the settings default: the
        // backend falls back to it whenever no providerId is sent.
        .catch(() => {});
    };
    load();
    // Unlisten immediately if this mount is already gone by the time the
    // subscription resolves, as App.tsx's listeners do under StrictMode.
    let unlisten: (() => void) | null = null;
    subscribeAiProvidersChanged(load)
      .then((off) => {
        if (live) unlisten = off;
        else off();
      })
      .catch(() => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  const applyModels = (list: unknown) => {
    const models = Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : [];
    setChatModels(models);
    if (models.length > 0) setTypingModel(false);
  };

  /**
   * Offer the chosen provider's models. A failure here only means typing the
   * model name instead, so it is not surfaced as an error.
   *
   * Never automatic for a local CLI: listing its models *runs the saved command*,
   * and merely opening the panel or selecting the provider would then execute an
   * arbitrary local program — side effects and all. The Settings manager already
   * refuses to auto-run one for exactly this reason; this is the same rule, so
   * CLI providers get the explicit button below instead.
   */
  useEffect(() => {
    if (!chatProviderId) return;
    setChatModels([]);
    setModelsFailed(false);
    if (providerOptions.find((o) => o.id === chatProviderId)?.kind === 'local-cli') return;
    let live = true;
    invoke<unknown>('list_ai_models_for', { providerId: chatProviderId })
      .then((list) => {
        if (live) applyModels(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatProviderId, providerOptions]);

  const [loadingCliModels, setLoadingCliModels] = useState(false);
  /** Run a CLI provider's models command, because the user asked for it. */
  const [modelsFailed, setModelsFailed] = useState(false);
  /**
   * Writes the agent has asked for and the user has not answered.
   *
   * A queue rather than one slot: two requests can arrive close together, and
   * replacing the first would leave its tool call parked until it times out with
   * nobody having seen what it wanted to do.
   */
  /**
   * Writes the agent has asked for, read from the store rather than held here.
   *
   * The panel is unmounted when the user switches tabs while its request keeps
   * running, and the backend gives up after two minutes — neither of which a
   * queue inside the component can survive or notice. See `mcpWriteRequests`.
   */

  const [writeRequests, setWriteRequests] = useState<McpWriteRequest[]>([]);


  const loadCliModels = async () => {
    if (!chatProviderId) return;
    setModelsFailed(false);
    // The command can take a while, and the user can switch providers while it
    // runs. Without this the result repopulated the picker with the *previous*
    // provider's models, and one of them could then be sent to the new one.
    const askedFor = chatProviderId;
    setLoadingCliModels(true);
    try {
      const list = await invoke<unknown>('list_ai_models_for', { providerId: askedFor });
      if (chatProviderIdRef.current === askedFor) applyModels(list);
    } catch {
      // Typing the model name still works, so this is not fatal — but the button
      // was clicked, so silence made it look broken rather than unavailable.
      if (chatProviderIdRef.current === askedFor) setModelsFailed(true);
    } finally {
      setLoadingCliModels(false);
    }
  };

  const choosePane = (id: string) => {
    setChatProviderId(id);
    // Each provider has its own model namespace; carrying one across would
    // send a model the new provider has never heard of.
    setChatModel(providerOptions.find((o) => o.id === id)?.model ?? '');
    // Attachments are invalidated by the effect below rather than here: the
    // selection also changes programmatically — the fallback when Settings
    // deletes the selected provider — and only this path was covered.
  };

  /**
   * Attach what fits and leave one explanation behind.
   *
   * `rejected` is why a file the caller had was not passed on. The note is
   * decided in one place because two of them fought: the caller set "wrong
   * format", then this cleared it while attaching the files that were fine.
   */
  /** Split files into what can be attached and the first reason one could not. */
  const triageImages = (files: File[]) => {
    const accepted: File[] = [];
    let reason: 'type' | 'size' | null = null;
    for (const f of files) {
      const why = imageRejectionReason(f);
      if (why) reason ??= why;
      else accepted.push(f);
    }
    return { accepted, reason };
  };  const noteFor = (reason: 'type' | 'size') =>
    reason === 'size'
      ? t('aiChatPanel.composer.imageTooLarge', { limit: MAX_IMAGE_BYTES / (1024 * 1024) })
      : t('aiChatPanel.composer.imageUnsupported');

  /**
   * The files that fit the count cap, and whether any had to be left out.
   *
   * Applied *before* reading them: reading is what allocates, and a multi-select
   * of files near the 5 MiB cap would base64 hundreds of megabytes only for
   * `addImages` to discard all but four. The cap is still enforced there as well,
   * against the current state rather than this render's.
   */
  /**
   * Slots claimed by reads that have not landed in state yet.
   *
   * Counting only `pendingImages` was not enough: a second paste arriving while
   * the first batch was still being read saw the same empty allowance and read
   * four more files, so rapid pastes defeated the cap the reservation exists to
   * enforce. Released when the batch settles — one render after its images are
   * handed to state, which is as tight as a ref outside React's queue can be, and
   * `addImages` remains the authority on the hard cap either way.
   */
  const reservedSlotsRef = useRef(0);
  const capToRoom = (files: File[]) => {
    const taken = pendingImages.length + reservedSlotsRef.current;
    const room = Math.max(0, MAX_PENDING_IMAGES - taken);
    const fits = files.slice(0, room);
    reservedSlotsRef.current += fits.length;
    // The epoch this reservation belongs to. `dropPendingImages` clears the whole
    // counter, so a batch abandoned by it must not subtract again on the way out —
    // that took slots from whichever batch had reserved them since, letting a
    // third paste read another four files while the second was still in flight.
    const reservedIn = imageEpochRef.current;
    return {
      fits,
      overCap: files.length > room,
      release: () => {
        if (imageEpochRef.current !== reservedIn) return; // already released wholesale
        reservedSlotsRef.current = Math.max(0, reservedSlotsRef.current - fits.length);
      },
    };
  };

  const addImages = (
    images: PendingImage[],
    rejected: 'type' | 'size' | null = null,
    overCap = false,
    failed = 0
  ) => {
    if (providerTakesImages !== true) {
      // Only a known CLI earns the explanation; while the capability is unknown
      // the controls are disabled, so there is nothing for the user to have done.
      if (providerTakesImages === false) {
        setImageNote(t('aiChatPanel.composer.noImagesForCli'));
      }
      return;
    }
    // The note is decided out here, not inside the updater: an updater has to be
    // pure, and React may run one during render and runs it twice under
    // StrictMode, so setting state from within it fired the note more than once.
    //
    // One note, in order of how actionable it is — the count cap the user can do
    // something about, then a read that failed, then a file that was never
    // eligible. `overCap` comes from the caller because the files it dropped
    // before reading are no longer here to be counted.
    const roomNow = Math.max(0, MAX_PENDING_IMAGES - pendingImages.length);
    if (overCap || images.length > roomNow) {
      setImageNote(t('aiChatPanel.composer.imageTooMany', { max: MAX_PENDING_IMAGES }));
    } else if (failed > 0) {
      setImageNote(t('aiChatPanel.composer.imageUnreadable'));
    } else {
      setImageNote(rejected ? noteFor(rejected) : null);
    }
    // The cap itself is still applied against `prev`, the only value guaranteed
    // to be current at the moment the append happens.
    setPendingImages((prev) => [
      ...prev,
      ...images.slice(0, Math.max(0, MAX_PENDING_IMAGES - prev.length)),
    ]);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const onClipboard = imageFilesFromClipboard(e.clipboardData?.items ?? null);
    if (onClipboard.length === 0) return; // plain text: let the textarea take it
    // Decided before `preventDefault`, not after the read. Suppressing the paste
    // and *then* discovering in the async continuation that images are not
    // accepted swallowed it in silence — nothing attached and nothing said.
    if (providerTakesImages !== true) {
      if (providerTakesImages === false) {
        // A known CLI: refusing is the answer, so take the paste and explain it.
        e.preventDefault();
        setImageNote(t('aiChatPanel.composer.noImagesForCli'));
      }
      // Capability still unknown: this paste is not ours to claim, and the attach
      // control is disabled for the same reason. Left untouched rather than eaten.
      return;
    }
    // Before the first await, or the browser pastes any accompanying text.
    e.preventDefault();
    const { accepted, reason } = triageImages(onClipboard);
    if (accepted.length === 0) {
      if (reason) setImageNote(noteFor(reason));
      return;
    }
    const { fits, overCap, release } = capToRoom(accepted);
    const epoch = imageEpochRef.current;
    setReadsInFlight((n) => n + 1);
    void (async () => {
      try {
        const { images, failed } = await imagesFromFiles(fits);
        if (imageEpochRef.current !== epoch) return; // the composer moved on
        addImages(images, reason, overCap, failed);
      } catch {
        // The batch settles per file, so reaching here means the read machinery
        // itself failed. Detached from the event, so an unhandled rejection would
        // surface only in the console — say it in the composer instead.
        if (imageEpochRef.current === epoch) {
          setImageNote(t('aiChatPanel.composer.imageUnreadable'));
        }
      } finally {
        // Scoped to its epoch, like `release`: `dropPendingImages` already zeroed
        // the count, so decrementing again would come out of a newer read's.
        if (imageEpochRef.current === epoch) {
          setReadsInFlight((n) => Math.max(0, n - 1));
        }
        release();
      }
    })();
  };



  const attachInputRef = useRef<HTMLInputElement>(null);
  const handleAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ''; // so picking the same file again still fires change
    if (picked.length === 0) return;
    const { accepted, reason } = triageImages(picked);
    if (accepted.length === 0) {
      if (reason) setImageNote(noteFor(reason));
      return;
    }
    const { fits, overCap, release } = capToRoom(accepted);
    const epoch = imageEpochRef.current;
    setReadsInFlight((n) => n + 1);
    try {
      const { images, failed } = await imagesFromFiles(fits);
      if (imageEpochRef.current !== epoch) return; // the composer moved on
      addImages(images, reason, overCap, failed);
    } catch {
      if (imageEpochRef.current === epoch) {
        setImageNote(t('aiChatPanel.composer.imageUnreadable'));
      }
    } finally {
      if (imageEpochRef.current === epoch) {
        setReadsInFlight((n) => Math.max(0, n - 1));
      }
      release();
    }
  };
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

  useEffect(() => {
    const refresh = () =>
      setWriteRequests(
        writeRequestsWhere((requester: string | null) => {
          // Nobody in particular: an external client, or two runs at once. Any
          // window may answer — it is the app asking, not a conversation.
          if (requester === null) return true;
          // Addressed by conversation, so this holds in whichever window is
          // showing that chat — including one the tab was moved to mid-run.
          return requester === activeChatIdRef.current;
        })
      );
    refresh();
    return subscribeWriteRequests(refresh);
    // Re-runs when the conversation changes, not only when the store notifies:
    // opening a History item does not touch the store, so without this the list
    // kept whatever it held and a prompt stayed answerable from a conversation it
    // did not belong to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId]);

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
        // A panel opened on an existing chat answers with that chat's provider —
        // and a chat saved with none means the default, not whatever the panel
        // happened to be using before.
        setChatProviderId(stored.providerId ?? ((cur) => defaultProviderId() ?? cur));
        setChatModel(stored.model ?? '');
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
      providerId: chatProviderId ?? undefined,
      model: chatModel.trim() || undefined,
    });
  }, [chatMessages, activeChatId, openScope, scopeResolved, scope, t, chatProviderId, chatModel]);

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
    // A new conversation starts clean: an attachment from the previous one must
    // not ride along with the next question, and the override belongs to the
    // conversation that chose it, not to the panel.
    dropPendingImages();
    setImageNote(null);
    setChatProviderId(defaultProviderId());
    setChatModel('');
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
    // The conversation remembers which provider answered it; none saved means
    // the default, not the provider the previous conversation was using.
    setChatProviderId(stored.providerId ?? ((cur) => defaultProviderId() ?? cur));
    setChatModel(stored.model ?? '');
    // Same reasoning as New chat: an attachment belongs to the conversation it
    // was added to. Opening another from History left it in the composer, ready
    // to be sent with the next prompt in a different chat.
    dropPendingImages();
    setImageNote(null);
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
      ...(reply.thoughts ? { thoughts: reply.thoughts } : {}),
      ...(reply.toolCalls?.length ? { toolCalls: reply.toolCalls } : {}),
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
        ...(reply.thoughts ? { thoughts: reply.thoughts } : {}),
        ...(reply.toolCalls?.length ? { toolCalls: reply.toolCalls } : {}),
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
    // Enter reaches here without going through the disabled button. Sending while
    // a read is in flight left the prompt without its image and moved that image
    // to the next turn, which is worse than waiting the few ms the read takes.
    if (readsInFlight > 0) return;

    const history = chatMessages.map((m) => ({
      role: m.role,
      content:
        m.role === 'assistant' && m.query
          ? `${m.text}\n${JSON.stringify(m.query)}`
          : m.text,
    }));

    const images = pendingImages;
    const userMsg: ChatMessage = {
      id: nextChatId(),
      role: 'user',
      text,
      ...(images.length > 0 && {
        attachments: images.map((i) => ({ mediaType: i.mediaType, bytes: i.bytes })),
      }),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    // Attachments are NOT dropped here. Whether a given HTTP model accepts an
    // image is not something this app can know — no OpenAI-compatible endpoint
    // advertises vision support — so a text-only model rejecting the payload is a
    // real outcome, and clearing first meant the bytes were gone and the user had
    // to find and paste the screenshot again. They are dropped once the reply
    // comes back without an error; see the end of this function.
    setImageNote(null);
    setIsChatLoading(true);
    // The conversation this question belongs to. New chat, opening a history
    // item, deleting or clearing all move `activeChatIdRef` on, and an answer
    // must not land in whichever conversation happens to be open when it
    // arrives — it would be shown there AND persisted under that chat's id.
    const askedIn = activeChatIdRef.current;
    // Identifies this run to the backend for the length of it, so its entry is
    // retired when it ends and two runs in one conversation stay distinguishable.
    // The conversation, sent alongside, is what a write is addressed to.
    const runId = `run-${Math.random().toString(36).slice(2)}-${Date.now()}`;

    const run = async (): Promise<PendingChatReply> => {
      const reply = await invoke<AiReply>('generate_mql_query', {
        prompt: text,
        collection: collectionName,
        fields,
        // The tab's namespace, so an agent with the tools inspects the collection
        // the user is actually looking at rather than one of the same name elsewhere.
        database: databaseName ?? undefined,
        connectionName: connectionName ?? undefined,
        connectionId: connectionId ?? undefined,
        requesterId: runId,
        // What a write is addressed to. The run id identifies this run to the
        // backend; the conversation is what any window showing it can recognise,
        // including one the tab is moved to while the agent is still going.
        conversationId: askedIn,
        history,
        target: variant === 'shell' ? 'shell' : 'editor',
        images: images.map((i) => ({ media_type: i.mediaType, data: i.data })),
        providerId: chatProviderId ?? undefined,
        model: chatModel.trim() || undefined,
      });
      const parsed = JSON.parse(reply.query) as {
        explanation?: string;
        queryType?: 'find' | 'aggregate' | 'script';
        filter?: unknown;
        sort?: unknown;
        projection?: unknown;
        pipeline?: unknown[];
        script?: string;
      };
      // `{}` would otherwise become a find with an empty filter — "everything".
      // A reply that names no query type and carries no query is a bad reply.
      if (
        parsed.queryType === undefined &&
        parsed.filter === undefined &&
        parsed.pipeline === undefined &&
        parsed.script === undefined
      ) {
        throw new Error(t('aiChatPanel.errors.noQuery'));
      }
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
      // Native reasoning first, then the model's own notes; one collapsible block.
      const thoughts = [reply.thoughts, reply.notes].filter((x): x is string => !!x?.trim()).join('\n\n');
      return {
        text: parsed.explanation ?? t('aiChatPanel.fallbackExplanation'),
        query,
        ...(thoughts && { thoughts }),
        ...(reply.toolCalls?.length && { toolCalls: reply.toolCalls }),
      };
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
        // File the answer with its question rather than dropping it. The
        // attachments went with that move already.
        void appendToStoredChat(askedIn, reply);
        return;
      }
      // Sent and answered, so those bytes have done their job. Only the ones
      // *this* request carried: the composer stays usable while a reply is
      // pending, so anything pasted since belongs to the next prompt and a blanket
      // clear deleted it unsent. On an error nothing is dropped — that is the
      // retry the user would otherwise reconstruct by hand.
      //
      // Not `dropPendingImages`, deliberately: bumping the epoch here would
      // invalidate a read still in flight for the *next* prompt, and the sent
      // images were already in state so no reservation is outstanding for them.
      if (!reply.error) {
        setPendingImages((prev) => prev.filter((img) => !images.includes(img)));
      }
      appendReply(reply);
    } finally {
      // The backend retires the run's own entry when the command returns, so
      // nothing more can be addressed to it. A write already waiting is refused
      // by the backend on silence.
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

                {m.attachments && m.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1" data-testid="chat-attachments">
                    {m.attachments.map((a, i) => (
                      <span
                        key={i}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 text-[9.5px] text-muted-foreground"
                      >
                        {t('aiChatPanel.attachments.image', { size: formatBytes(a.bytes) })}
                      </span>
                    ))}
                  </div>
                )}

                {m.toolCalls && m.toolCalls.length > 0 && (
                  <details className="w-[92%] text-[10.5px]" data-testid="chat-tool-calls">
                    <summary className="cursor-pointer select-none text-muted-foreground">
                      {t('aiChatPanel.toolCalls', { count: m.toolCalls.length })}
                    </summary>
                    <div className="mt-1 flex flex-col gap-1">
                      {m.toolCalls.map((call, i) => (
                        <div
                          key={i}
                          className="rounded border border-border bg-muted/40 p-1.5"
                          data-testid={`chat-tool-call-${i}`}
                        >
                          <div className="flex items-center gap-1.5">
                            <Wrench size={10} className="shrink-0 text-muted-foreground" />
                            <span className="font-mono text-[10.5px] text-foreground">{call.name}</span>
                            {call.failed && (
                              <span className="text-[9px] uppercase text-destructive">
                                {t('aiChatPanel.toolFailed')}
                              </span>
                            )}
                          </div>
                          {call.input && (
                            <pre className="mt-1 max-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-[9.5px] leading-relaxed text-muted-foreground">
                              {call.input}
                            </pre>
                          )}
                          {call.output && (
                            <pre className="mt-1 max-h-[120px] overflow-auto whitespace-pre-wrap border-t border-border pt-1 font-sans text-[9.5px] leading-relaxed text-muted-foreground">
                              {call.output}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {m.thoughts && (
                  <details className="w-[92%] text-[10.5px]" data-testid="chat-thoughts">
                    <summary className="cursor-pointer select-none text-muted-foreground">
                      {t('aiChatPanel.thoughts')}
                    </summary>
                    <pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-1.5 font-sans text-[10.5px] leading-relaxed text-muted-foreground">
                      {m.thoughts}
                    </pre>
                  </details>
                )}

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
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="chat-pending-images">
              {pendingImages.map((img, i) => (
                <div key={i} className="relative">
                  <img
                    src={img.previewUrl}
                    alt=""
                    className="h-12 w-12 rounded border border-border object-cover"
                  />
                  <button
                    type="button"
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background text-[10px] leading-none text-muted-foreground hover:text-foreground"
                    onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={t('aiChatPanel.attachments.remove')}
                    data-testid={`chat-pending-image-remove-${i}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* What the agent wants to change, described by MQLens from the call
              itself rather than by the agent — an agent that can be talked into
              a delete can be talked into describing it as something else. */}
          {writeRequests.length > 0 && (
            <div
              className="flex flex-col gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-2"
              data-testid="chat-write-request"
            >
              <div className="flex items-center gap-1.5">
                <AlertCircle size={12} className="shrink-0 text-destructive" />
                <span className="text-[11px] font-medium text-foreground">
                  {t('aiChatPanel.writeRequestTitle')}
                </span>
              </div>
              {/* The operation itself, pretty-printed. Taller than a one-line
                  summary on purpose: the filter is the thing that has to be read
                  before answering, not scrolled past. */}
              <div className="font-mono text-[10px] text-foreground">{writeRequests[0].tool}</div>
              <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">
                {writeRequests[0].summary}
              </pre>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-[10.5px]"
                  onClick={() => answerWriteRequest(writeRequests[0].id, true)}
                  data-testid="chat-write-allow"
                >
                  {t('aiChatPanel.writeRequestAllow')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10.5px]"
                  onClick={() => answerWriteRequest(writeRequests[0].id, false)}
                  data-testid="chat-write-refuse"
                >
                  {t('aiChatPanel.writeRequestRefuse')}
                </Button>
              </div>
            </div>
          )}
          {imageNote && (
            <p className="text-[10.5px] text-muted-foreground" data-testid="chat-image-note">
              {imageNote}
            </p>
          )}
          <div
            className="flex flex-col rounded-lg border border-border bg-background focus-within:ring-1 focus-within:ring-ring"
            data-testid="chat-composer"
          >
            <textarea
              className={cn(composerClassName, 'border-0 bg-transparent shadow-none focus-visible:ring-0')}
              onPaste={handlePaste}
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
            <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
              {/* Which model answers — chosen here, where the question is typed. */}
              {providerOptions.length > 0 ? (
                <div className="flex min-w-0 items-center gap-1.5" data-testid="ai-chat-provider-picker">
                  <Select value={chatProviderId ?? ''} onValueChange={choosePane}>
                    <SelectTrigger
                      className="h-6 w-auto min-w-0 max-w-[150px] gap-1 rounded-full border-border bg-muted/60 px-2.5 text-[10.5px]"
                      aria-label={t('aiChatPanel.header.provider')}
                      data-testid="ai-chat-provider-select"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent data-testid="ai-chat-provider-options">
                      {providerOptions.map((o) => (
                        <SelectItem key={o.id} value={o.id} className="text-xs">
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Hidden where it cannot take effect: a built-in agent whose
                      command has no {model} picks its model in its own config, so
                      a field here would look like a setting and do nothing. */}
                  {modelApplies &&
                    (chatModels.length > 0 && !typingModel ? (
                      <Select
                        value={chatModel && !chatModels.includes(chatModel) ? CURRENT_MODEL : chatModel}
                        onValueChange={(v) => {
                          if (v === TYPE_MODEL) setTypingModel(true);
                          else if (v !== CURRENT_MODEL) setChatModel(v);
                        }}
                      >
                        <SelectTrigger
                          className="h-6 w-auto min-w-0 max-w-[160px] gap-1 rounded-full border-border bg-muted/60 px-2.5 font-mono text-[10.5px]"
                          aria-label={t('aiChatPanel.header.model')}
                          data-testid="ai-chat-model-select"
                        >
                          <SelectValue placeholder={activeProvider?.model || t('aiChatPanel.header.modelPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent data-testid="ai-chat-model-options">
                          {chatModel && !chatModels.includes(chatModel) && (
                            <SelectItem value={CURRENT_MODEL} className="font-mono text-xs">
                              {chatModel}
                            </SelectItem>
                          )}
                          {chatModels.map((m) => (
                            <SelectItem key={m} value={m} className="font-mono text-xs">
                              {m}
                            </SelectItem>
                          ))}
                          <SelectItem value={TYPE_MODEL} className="text-xs">
                            {t('aiChatPanel.header.typeModel')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <input
                        className="h-6 w-[110px] rounded-full border border-border bg-muted/60 px-2.5 font-mono text-[10.5px] text-foreground"
                        value={chatModel}
                        onChange={(e) => setChatModel(e.target.value)}
                        placeholder={activeProvider?.model || t('aiChatPanel.header.modelPlaceholder')}
                        aria-label={t('aiChatPanel.header.model')}
                        data-testid="ai-chat-model-input"
                      />
                    ))}
                  {/* A CLI provider's model list comes from running its command,
                      so it stays behind a click — see the listing effect. Offered
                      only until a list arrives; after that the picker is there. */}
                  {modelApplies &&
                    activeProvider?.kind === 'local-cli' &&
                    activeProvider.canListModels &&
                    chatModels.length === 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 gap-1 rounded-full px-2 text-[10.5px]"
                      disabled={loadingCliModels}
                      onClick={() => void loadCliModels()}
                      title={t('aiChatPanel.header.loadModels')}
                      data-testid="ai-chat-models-load"
                    >
                      <RefreshCw size={11} className={loadingCliModels ? 'animate-spin' : ''} />
                      {t('aiChatPanel.header.loadModels')}
                    </Button>
                  )}
                  {/* The button was clicked and the command failed. Silence made
                      that look broken rather than simply unavailable. */}
                  {modelsFailed && (
                    <span
                      className="shrink-0 text-[10.5px] text-muted-foreground"
                      data-testid="ai-chat-models-failed"
                    >
                      {t('aiChatPanel.header.modelsFailed')}
                    </span>
                  )}
                </div>
              ) : (
                <span />
              )}
              <div className="flex shrink-0 items-center gap-1">
                <input
                  ref={attachInputRef}
                  type="file"
                  accept={ACCEPTED_IMAGE_TYPES.join(',')}
                  multiple
                  className="hidden"
                  onChange={(e) => void handleAttach(e)}
                  data-testid="chat-attach-input"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={foreignChat || providerTakesImages !== true}
                  onClick={() => attachInputRef.current?.click()}
                  title={
                    providerTakesImages === true
                      ? t('aiChatPanel.composer.attach')
                      : providerTakesImages === false
                        ? t('aiChatPanel.composer.noImagesForCli')
                        : t('aiChatPanel.composer.attach')
                  }
                  aria-label={t('aiChatPanel.composer.attach')}
                  data-testid="chat-attach-btn"
                >
                  <Paperclip size={12} />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-6 gap-1 px-2.5 text-[11px]"
                  onClick={handleSendChat}
                  disabled={isChatLoading || !chatInput.trim() || foreignChat || readsInFlight > 0}
                  title={foreignChat ? t('aiChatPanel.actions.foreignChat') : undefined}
                  data-testid="chat-send-btn"
                >
                  <Sparkles size={11} />
                  {isChatLoading ? t('aiChatPanel.thinking') : t('aiChatPanel.composer.send')}
                </Button>
              </div>
            </div>
          </div>
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

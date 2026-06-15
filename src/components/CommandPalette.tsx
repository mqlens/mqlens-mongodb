import React, { useEffect, useMemo, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { fuzzyScore } from '../lib/fuzzyMatch';
import { cn } from '@/lib/utils';
import {
  Activity,
  Bookmark,
  Filter,
  Layers,
  RefreshCw,
  Search,
  Settings2,
  Terminal,
  Zap,
} from 'lucide-react';

export interface PaletteAction {
  id: string;
  title: string;
  hint?: string;      // right-aligned context, e.g. the target namespace
  keywords?: string;  // extra match terms not shown in the UI
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  scopeLabel?: string;
  onQueryChange?: (query: string) => void;
}

const MAX_VISIBLE_ACTIONS = 80;

type ActionBucket = 'commands' | 'collections' | 'queries';

const BUCKET_META: Record<ActionBucket, { label: string; empty: string }> = {
  commands: { label: 'Commands', empty: 'No matching commands' },
  collections: { label: 'Collections', empty: 'No matching collections' },
  queries: { label: 'Saved queries', empty: 'No matching saved queries' },
};

const bucketFor = (action: PaletteAction): ActionBucket => {
  if (action.id.startsWith('coll:')) return 'collections';
  if (action.id.startsWith('saved:')) return 'queries';
  return 'commands';
};

const iconFor = (action: PaletteAction) => {
  if (action.id.startsWith('coll:')) return Layers;
  if (action.id.startsWith('saved:')) return Bookmark;
  if (action.id.includes('monitoring')) return Activity;
  if (action.id.includes('shell')) return Terminal;
  if (action.id.includes('settings') || action.id.includes('density')) return Settings2;
  if (action.id.includes('refresh')) return RefreshCw;
  return Zap;
};

// Rank by fuzzy score: title matches outrank keyword-only matches. An empty
// query scores everything 0, so the caller's original order is kept.
const scoreAction = (query: string, action: PaletteAction): number | null => {
  const title = fuzzyScore(query, action.title);
  const keywords = action.keywords ? fuzzyScore(query, action.keywords) : null;
  if (title === null && keywords === null) return null;
  return Math.max(title ?? -Infinity, keywords !== null ? keywords - 50 : -Infinity);
};

function PaletteRow({ action }: { action: PaletteAction }) {
  const Icon = iconFor(action);
  return (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{action.title}</span>
      {action.hint ? (
        <span
          className="max-w-[min(52%,20rem)] shrink-0 truncate rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
          title={action.hint}
        >
          {action.hint}
        </span>
      ) : null}
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  actions,
  scopeLabel = '',
  onQueryChange,
}) => {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim();
    if (!q) return actions.slice(0, MAX_VISIBLE_ACTIONS);
    return actions
      .map((a) => ({ a, score: scoreAction(q, a) }))
      .filter((x): x is { a: PaletteAction; score: number } => x.score !== null)
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_VISIBLE_ACTIONS)
      .map((x) => x.a);
  }, [actions, query]);

  const grouped = useMemo(() => {
    const buckets: Record<ActionBucket, PaletteAction[]> = {
      commands: [],
      collections: [],
      queries: [],
    };
    for (const action of visible) {
      buckets[bucketFor(action)].push(action);
    }
    return buckets;
  }, [visible]);

  const hasResults = visible.length > 0;

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  useEffect(() => {
    onQueryChange?.(query);
  }, [onQueryChange, query]);

  const runAction = (action: PaletteAction | undefined) => {
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className={cn(
          'gap-0 overflow-hidden border-border/70 p-0 shadow-2xl sm:rounded-xl',
          'w-[min(44rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]',
          '[&>button]:hidden',
        )}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="command-palette"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command shouldFilter={false} loop className="bg-popover [&_[cmdk-input-wrapper]]:border-0 [&_[cmdk-input-wrapper]]:px-0">
          <div className="border-b border-border/70 bg-muted/20 px-4 py-3">
            <CommandInput
              placeholder="Search commands, collections, saved queries…"
              value={query}
              onValueChange={setQuery}
              data-testid="command-palette-input"
              aria-label="Command palette"
              className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
            />
          </div>

          {scopeLabel.trim() ? (
            <div
              className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2 text-xs"
              title={`Sidebar filter: ${scopeLabel}`}
            >
              <Filter className="size-3.5 shrink-0 text-primary" aria-hidden />
              <span className="font-medium text-foreground/80">Sidebar scope</span>
              <Badge variant="secondary" className="max-w-full truncate font-normal">
                {scopeLabel}
              </Badge>
            </div>
          ) : null}

          <CommandList className="max-h-[min(28rem,52vh)] px-2 py-2">
            {!hasResults ? (
              <CommandEmpty className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                <Search className="size-5 opacity-40" aria-hidden />
                <span>No matching results</span>
                {query.trim().length > 0 && query.trim().length < 2 ? (
                  <span className="text-xs">Type at least 2 characters to search collections</span>
                ) : null}
              </CommandEmpty>
            ) : (
              (['commands', 'collections', 'queries'] as const).map((bucket) => {
                const items = grouped[bucket];
                if (items.length === 0) return null;
                return (
                  <CommandGroup
                    key={bucket}
                    heading={BUCKET_META[bucket].label}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {items.map((a) => (
                      <CommandItem
                        key={a.id}
                        value={a.id}
                        onSelect={() => runAction(a)}
                        className="gap-3 rounded-lg px-2 py-2.5 aria-selected:bg-accent/80"
                      >
                        <PaletteRow action={a} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })
            )}
          </CommandList>

          <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {hasResults ? `${visible.length} result${visible.length === 1 ? '' : 's'}` : 'No results'}
            </span>
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                navigate
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                run
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>esc</Kbd>
                close
              </span>
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
};

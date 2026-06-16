import React, { useMemo, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  filterKeyboardShortcuts,
  formatShortcut,
  groupKeyboardShortcuts,
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_GROUP_ORDER,
} from '@/lib/shortcuts';

export const KeyboardShortcutsSettings: React.FC = () => {
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => filterKeyboardShortcuts(filter), [filter]);
  const grouped = useMemo(() => groupKeyboardShortcuts(filtered), [filtered]);

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Keyboard className="h-4 w-4 text-primary" />
          Keyboard shortcuts
        </CardTitle>
        <CardDescription>
          Global shortcuts for navigation, queries, the sidebar, zoom, and the command palette.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search shortcuts…"
          data-testid="shortcuts-filter"
          aria-label="Search keyboard shortcuts"
        />

        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="shortcuts-empty">
            No shortcuts match your search.
          </p>
        ) : (
          <div className="space-y-6">
            {SHORTCUT_GROUP_ORDER.map((group) => {
              const items = grouped[group];
              if (items.length === 0) return null;
              return (
                <section key={group} data-testid={`shortcuts-group-${group}`}>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {SHORTCUT_GROUP_LABELS[group]}
                  </h3>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {items.map((shortcut) => (
                      <li
                        key={shortcut.id}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                        data-testid={`shortcut-row-${shortcut.id}`}
                      >
                        <span className="text-sm text-foreground">{shortcut.label}</span>
                        <kbd className="shrink-0 rounded-md border border-border bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
                          {formatShortcut(shortcut)}
                        </kbd>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

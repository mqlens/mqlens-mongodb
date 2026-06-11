import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

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
}

const matches = (query: string, action: PaletteAction): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${action.title} ${action.keywords ?? ''}`.toLowerCase();
  return q.split(/\s+/).every((part) => haystack.includes(part));
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, actions }) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => actions.filter((a) => matches(query, a)), [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      // Focus after the panel mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => { setSelected(0); }, [query]);

  if (!open) return null;

  const runAction = (action: PaletteAction | undefined) => {
    if (!action) return;
    onClose();
    action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, visible.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); runAction(visible[selected]); }
  };

  return (
    <div className="mql-palette-backdrop" onMouseDown={onClose} data-testid="command-palette">
      <div className="mql-palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mql-palette-search">
          <Search size={13} className="mql-palette-search-icon" />
          <input
            ref={inputRef}
            className="mql-palette-input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="command-palette-input"
            aria-label="Command palette"
          />
        </div>
        <div className="mql-palette-list" role="listbox">
          {visible.length === 0 && <div className="mql-palette-empty">No matching commands</div>}
          {visible.map((a, i) => (
            <div
              key={a.id}
              role="option"
              aria-selected={i === selected}
              className={`mql-palette-item${i === selected ? ' is-selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runAction(a)}
            >
              <span className="mql-palette-title">{a.title}</span>
              {a.hint && <span className="mql-palette-hint">{a.hint}</span>}
            </div>
          ))}
        </div>
        <div className="mql-palette-footer">
          <span>↑↓ navigate</span><span>⏎ run</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
};

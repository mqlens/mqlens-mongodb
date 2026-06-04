import React, { useMemo, useRef, useState } from 'react';
import { getCompletions, type Surface, type CompletionItem } from '../lib/mongoCompletions';
import type { SchemaMap } from '../lib/useCollectionSchema';

interface QueryInputProps {
  surface: Surface;
  value: string;
  onChange: (v: string) => void;
  fields: string[];
  schema?: SchemaMap;
  placeholder?: string;
  className?: string;
  'data-testid'?: string;
}

const tokenOf = (textBeforeCursor: string) => textBeforeCursor.match(/[\w$.]*$/)?.[0] ?? '';

export const QueryInput: React.FC<QueryInputProps> = ({ surface, value, onChange, fields, schema, placeholder, className, ...rest }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Live editing buffer. In normal controlled use the parent round-trips
  // `value` back, so this stays in sync; tracking it locally also lets the
  // dropdown reflect typed input when an onChange handler does not feed the
  // value back. External `value` changes (not originating from this input)
  // win over the local buffer.
  const [typed, setTyped] = useState(value);
  const lastPropRef = useRef(value);
  // Adopt an external `value` change (one the parent made, not us) into the
  // local buffer. Render-phase derive-from-props pattern.
  if (value !== lastPropRef.current) {
    lastPropRef.current = value;
    if (value !== typed) setTyped(value);
  }
  const text = typed;
  const setBuffer = (v: string) => { setTyped(v); onChange(v); };

  const items = useMemo<CompletionItem[]>(() => {
    if (!open) return [];
    const before = text.slice(0, caret);
    return getCompletions({ surface, textBeforeCursor: before, token: tokenOf(before), fields, schema }).slice(0, 8);
  }, [open, text, caret, surface, fields, schema]);

  const accept = (item: CompletionItem) => {
    const before = text.slice(0, caret);
    const token = tokenOf(before);
    const start = caret - token.length;
    const next = text.slice(0, start) + item.insertText + text.slice(caret);
    setBuffer(next);
    setOpen(false);
    requestAnimationFrame(() => {
      const pos = start + item.insertText.length;
      inputRef.current?.setSelectionRange(pos, pos);
      inputRef.current?.focus();
    });
  };

  return (
    <div className="relative flex flex-1 min-w-0">
      <input
        {...rest}
        ref={inputRef}
        type="text"
        className={className}
        placeholder={placeholder}
        value={text}
        onChange={(e) => { setBuffer(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setActive(0); setOpen(true); }}
        onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
        onKeyUp={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
        onFocus={(e) => { setCaret(e.target.selectionStart ?? 0); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || items.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(items[active]); }
          else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
        }}
      />
      {open && items.length > 0 && (
        <ul
          className="absolute left-0 top-full z-50 mt-1 max-h-56 w-64 overflow-auto rounded-md border border-[var(--border-color)] py-1 text-[11px] shadow-lg"
          style={{ backgroundColor: 'var(--bg-dropdown-solid)' }}
          role="listbox"
        >
          {items.map((it, i) => (
            <li
              key={`${it.kind}:${it.label}`}
              role="option"
              aria-selected={i === active}
              className={`flex justify-between gap-3 px-2 py-1 cursor-pointer ${i === active ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-main)]'}`}
              onMouseDown={(e) => { e.preventDefault(); accept(it); }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{it.label}</span>
              {it.detail && <span className="text-[var(--text-dim)]">{it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

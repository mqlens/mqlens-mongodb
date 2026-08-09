import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * A searchable single-select, built from the Popover and Command primitives the
 * command palette already uses.
 *
 * A native `<select>` is fine for a handful of fixed choices and wrong as soon
 * as the list is drawn from live data: a deployment can have hundreds of
 * collections, and scrolling an unsearchable list to find one is the whole
 * problem. This keeps the app's own look instead of the OS menu's, too.
 */

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line, for disambiguating options that share a label. */
  hint?: string;
  /** Rendered before the label. Callers pass the same icon the rest of the app
   *  uses for that kind of thing, so a list of collections looks like the
   *  sidebar's rather than like a generic menu. */
  icon?: React.ReactNode;
  /** Rendered before the hint, for the same reason. */
  hintIcon?: React.ReactNode;
}

interface ComboboxProps {
  options: ComboboxOption[];
  /** `null` selects the "any" entry, when `emptyOptionLabel` is given. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Shown on the trigger when nothing is chosen. */
  placeholder: string;
  /** Placeholder for the search box. */
  searchPlaceholder: string;
  /** Shown when the search matches nothing. */
  emptyMessage: string;
  /**
   * Adds a leading entry that clears the selection — "All collections" and the
   * like. Omit it for a combobox where a value must be chosen.
   */
  emptyOptionLabel?: string;
  emptyOptionIcon?: React.ReactNode;
  className?: string;
  triggerClassName?: string;
  'data-testid'?: string;
  'aria-label'?: string;
  disabled?: boolean;
}

export const Combobox: React.FC<ComboboxProps> = ({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  emptyOptionLabel,
  emptyOptionIcon,
  className,
  triggerClassName,
  disabled,
  'data-testid': testId,
  'aria-label': ariaLabel,
}) => {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);

  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn('h-6 justify-between gap-1.5 px-2 text-[10px] font-normal', triggerClassName)}
          data-testid={testId}
        >
          {selected?.icon ?? emptyOptionIcon}
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown size={11} className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn('w-[260px] p-0', className)} align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-[11px] text-muted-foreground">
              {emptyMessage}
            </CommandEmpty>
            <CommandGroup>
              {emptyOptionLabel && (
                <CommandItem value={emptyOptionLabel} onSelect={() => choose(null)} className="gap-2 text-xs">
                  <Check size={12} className={cn('shrink-0', value === null ? 'opacity-100' : 'opacity-0')} />
                  {emptyOptionIcon}
                  {emptyOptionLabel}
                </CommandItem>
              )}
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  // Searched on, so the hint has to be part of it — a namespace
                  // is often only distinguishable by its database.
                  value={`${option.label} ${option.hint ?? ''}`}
                  onSelect={() => choose(option.value)}
                  className="gap-2 text-xs"
                >
                  <Check
                    size={12}
                    className={cn('shrink-0', value === option.value ? 'opacity-100' : 'opacity-0')}
                  />
                  {option.icon}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.hint && (
                      <span className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                        {option.hintIcon}
                        {option.hint}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

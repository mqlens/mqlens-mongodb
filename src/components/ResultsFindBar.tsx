/**
 * Find bar for the results pane (#279).
 *
 * Searches only what is already loaded — no re-query, no page change — so it is
 * deliberately separate from the query filter above it.
 */
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ResultsFindBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  matchCount: number;
  /** 0-based index of the active match, or -1 when none is selected. */
  activeIndex: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export const ResultsFindBar: React.FC<ResultsFindBarProps> = ({
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  onNext,
  onPrevious,
  onClose,
}) => {
  const { t } = useTranslation('documents');
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening the bar should put the caret in it; the shortcut that opens it is
  // the same one users expect to type into immediately.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const searched = query.trim() !== '';
  const status = !searched
    ? ''
    : matchCount === 0
      ? t('dataGrid.find.noMatches')
      : t('dataGrid.find.count', {
          current: activeIndex >= 0 ? activeIndex + 1 : 1,
          total: matchCount,
        });

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5"
      data-testid="results-find-bar"
    >
      <Search size={13} className="shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('dataGrid.find.placeholder')}
        aria-label={t('dataGrid.find.placeholder')}
        data-testid="results-find-input"
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span
        className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
        data-testid="results-find-status"
      >
        {status}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        disabled={matchCount === 0}
        onClick={onPrevious}
        title={t('dataGrid.find.previous')}
        aria-label={t('dataGrid.find.previous')}
        data-testid="results-find-prev"
      >
        <ChevronUp size={13} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        disabled={matchCount === 0}
        onClick={onNext}
        title={t('dataGrid.find.next')}
        aria-label={t('dataGrid.find.next')}
        data-testid="results-find-next"
      >
        <ChevronDown size={13} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        onClick={onClose}
        title={t('dataGrid.find.close')}
        aria-label={t('dataGrid.find.close')}
        data-testid="results-find-close"
      >
        <X size={13} />
      </Button>
    </div>
  );
};

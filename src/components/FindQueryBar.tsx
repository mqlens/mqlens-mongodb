import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowUpDown, ChevronDown, ChevronRight, Eraser, Play, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';
import { useThemeOptional } from '@/hooks/use-theme';
import {
  clampQueryBarHeight,
  EDITOR_FONT_BASELINE_PX,
  QUERY_BAR_HEIGHT_DEFAULT,
  QUERY_BAR_OPTION_HEIGHT,
} from '@/lib/themes/ui-scale';
import type { SchemaMap } from '../lib/useCollectionSchema';

export interface FindQueryBarProps {
  filter: string;
  projection: string;
  sort: string;
  onFilterChange: (v: string) => void;
  onProjectionChange: (v: string) => void;
  onSortChange: (v: string) => void;
  /** Mark a field's cell invalid (shows the destructive ring + "Invalid JSON"). */
  filterInvalid?: boolean;
  projectionInvalid?: boolean;
  sortInvalid?: boolean;
  /** Why the filter would not parse. Shown on hover over the badge — the badge
   *  itself has no room for it, and "Invalid JSON" on its own leaves a user
   *  staring at a query that looks perfectly correct. */
  filterError?: string | null;
  fields: string[];
  schema?: SchemaMap;
  /** Emit mongosh-style completions (bare keys + ISODate()/ObjectId()) instead
   *  of EJSON — set by editors that parse shell syntax (the main query bar). */
  shellSyntax?: boolean;
  /** Show only the Query field, with projection / sort / skip / limit tucked
   *  behind an "Options" disclosure. Query is ~95% of the usage, so it gets the
   *  room; the rest auto-reveal when they hold a non-default value. */
  collapsibleOptions?: boolean;
  /** Controlled disclosure state, so a host can persist it across remounts.
   *  Leave undefined to let the bar manage (and auto-reveal) it internally. */
  optionsOpen?: boolean;
  onOptionsOpenChange?: (open: boolean) => void;
  /** Run handler (⌘/Ctrl+Enter in the editors, Enter in skip/limit). */
  onRun?: () => void;
  runDisabled?: boolean;
  onOpenAI?: () => void;
  /** Clear handlers — default to resetting the field to '{}' when omitted. */
  onClearFilter?: () => void;
  onClearProjection?: () => void;
  onClearSort?: () => void;
  /** Skip/Limit cells render only when both the value and its setter are provided. */
  skip?: string;
  limit?: string;
  onSkipChange?: (v: string) => void;
  onLimitChange?: (v: string) => void;
}

const queryColClass = (invalid: boolean) =>
  cn(
    'relative flex min-w-0 flex-1 items-center border-r border-border bg-input/80 transition-colors last:border-r-0',
    'focus-within:z-[1] focus-within:bg-input',
    // The focus outline is an overlay pseudo-element, not `ring-inset`. A ring
    // is an inset box-shadow, which paints UNDER child content — so anything in
    // the field with a background of its own covered it and the outline
    // survived only behind the semi-transparent label badge. Monaco paints its
    // own layers here and wins over class-based background overrides, so the
    // outline has to sit above the content rather than behind it.
    "focus-within:after:pointer-events-none focus-within:after:absolute focus-within:after:inset-0 focus-within:after:content-[''] focus-within:after:border",
    invalid ? 'focus-within:after:border-destructive' : 'focus-within:after:border-primary'
  );

const fieldBadgeClass = (invalid: boolean) =>
  cn(
    'flex min-w-[90px] shrink-0 select-none items-center justify-end border-r border-border px-2.5 text-[9.5px] font-bold uppercase tracking-wider',
    invalid ? 'bg-destructive/5 text-destructive' : 'bg-muted/40 text-muted-foreground'
  );

/**
 * The compact filter / projection / sort (and optional skip / limit) query bar,
 * shared by the document view and the export view so both stay identical.
 */
export const FindQueryBar: React.FC<FindQueryBarProps> = ({
  filter,
  projection,
  sort,
  onFilterChange,
  onProjectionChange,
  onSortChange,
  filterInvalid = false,
  filterError,
  projectionInvalid = false,
  sortInvalid = false,
  fields,
  schema,
  shellSyntax,
  collapsibleOptions = false,
  optionsOpen: optionsOpenProp,
  onOptionsOpenChange,
  onRun,
  runDisabled = false,
  onOpenAI,
  onClearFilter,
  onClearProjection,
  onClearSort,
  skip,
  limit,
  onSkipChange,
  onLimitChange,
}) => {
  // One configurable height (Settings → Appearance) for every row, so the
  // query, projection and sort fields stay symmetric. rem keeps it tracking the
  // interface scale.
  const themeCtx = useThemeOptional();
  const { t } = useTranslation('documents');
  // Two panes can show collection tabs at once, so the region id must be unique
  // or both toggles' aria-controls resolve to the first one.
  const optionsRegionId = `additional-query-options-container-${useId()}`;
  // Option rows keep the compact height regardless of the setting.
  const optionRowStyle = { height: `${QUERY_BAR_OPTION_HEIGHT / EDITOR_FONT_BASELINE_PX}rem` };
  // The configured height is the main query bar's floor. Export keeps the
  // compact floor, but either Query field may grow with wrapped content and the
  // badge stretches with its row.
  const queryRowDesignPx = collapsibleOptions
    ? clampQueryBarHeight(themeCtx?.config.queryBarHeight ?? QUERY_BAR_HEIGHT_DEFAULT)
    : QUERY_BAR_OPTION_HEIGHT;
  const queryRowStyle = {
    minHeight: `${queryRowDesignPx / EDITOR_FONT_BASELINE_PX}rem`,
  };

  const showPagination =
    skip !== undefined && limit !== undefined && !!onSkipChange && !!onLimitChange;

  // An option holding a non-default value reveals the section, so a saved or
  // restored query never hides part of itself behind a collapsed disclosure.
  const hasOptionValues =
    (projection.trim() !== '' && projection.trim() !== '{}') ||
    (sort.trim() !== '' && sort.trim() !== '{}') ||
    (showPagination && ((skip !== '0' && skip !== '') || (limit !== '50' && limit !== '')));
  const [internalOptionsOpen, setInternalOptionsOpen] = useState(hasOptionValues);
  const optionsOpen = optionsOpenProp ?? internalOptionsOpen;
  const setOptionsOpen = (open: boolean) => {
    setInternalOptionsOpen(open);
    onOptionsOpenChange?.(open);
  };
  // Only projection and sort trigger the reveal. Skip/limit are mirrored by the
  // results pager, so they are never actually hidden — and counting them meant
  // changing the page size popped the panel open, which is one-way and so never
  // closed again. The initial state above still considers pagination, because a
  // restored query arrives at mount and an unusual page size is worth showing.
  const hasHiddenOptionValues =
    (projection.trim() !== '' && projection.trim() !== '{}') ||
    (sort.trim() !== '' && sort.trim() !== '{}');
  // Reveal only on the transition into having values — not on every mount, or a
  // remount would undo a deliberate collapse that the host persisted.
  const hadOptionValues = useRef(hasHiddenOptionValues);
  useEffect(() => {
    if (hasHiddenOptionValues && !hadOptionValues.current) setOptionsOpen(true);
    hadOptionValues.current = hasHiddenOptionValues;
  }, [hasHiddenOptionValues]);
  // Rows are CSS-hidden rather than unmounted: Monaco keeps its model (and the
  // fields stay queryable) instead of being torn down on every toggle.
  const optionsVisible = !collapsibleOptions || optionsOpen;

  const runOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onRun?.();
    }
  };

  const clearFilter = onClearFilter ?? (() => onFilterChange(''));
  const clearProjection = onClearProjection ?? (() => onProjectionChange(''));
  const clearSort = onClearSort ?? (() => onSortChange(''));

  const cycleSort = () => {
    if (sort === '{}' || sort.trim() === '') onSortChange('{"_id": -1}');
    else if (sort === '{"_id": -1}') onSortChange('{"_id": 1}');
    else onSortChange('');
  };

  const badge = (reason?: string | null) => (
    <span
      className="inline-flex shrink-0 items-center gap-1 pr-1.5 font-mono text-[10px] text-destructive whitespace-nowrap"
      title={reason ?? undefined}
      // The label itself is translated, so a test that wants the badge cannot
      // look for its text.
      data-testid="query-invalid-badge"
    >
      <AlertCircle size={10} /> {t('findQueryBar.errors.invalidJson')}
    </span>
  );
  const invalidBadge = badge();

  return (
    <div className="border-b border-border bg-card/40">
      <div
        data-testid={collapsibleOptions ? 'query-composer-body' : undefined}
        className={cn(collapsibleOptions ? 'flex items-stretch' : 'flex flex-col')}
      >
      <div className={cn(collapsibleOptions && 'min-w-0 flex-[7] p-2')}>
      <div className={cn('flex w-full', !collapsibleOptions && 'border-b border-border')}>
        <div className={cn(queryColClass(filterInvalid), collapsibleOptions && 'rounded-md border border-border bg-input/60 shadow-sm')}>
          {!collapsibleOptions && (
            <span className={cn(fieldBadgeClass(filterInvalid), 'self-stretch')} style={queryRowStyle}>
              {t('findQueryBar.labels.query')}
            </span>
          )}
          {collapsibleOptions && !filter && (
            <span className="pointer-events-none absolute left-3 top-2 z-10 text-xs italic text-muted-foreground/60">
              {t('findQueryBar.labels.query')}
            </span>
          )}
          <QueryEditor
            singleLine
            large={collapsibleOptions}
            growWithContent
            height={collapsibleOptions ? 84 : undefined}
            surface="filter"
            shellSyntax={shellSyntax}
            onRun={onRun}
            value={filter}
            onChange={onFilterChange}
            fields={fields}
            schema={schema}
            data-testid="query-filter-input"
          />
          {filterInvalid && badge(filterError)}
          <Button
            variant="ghost"
            size="icon"
            className="mr-1 h-6 w-6 shrink-0"
            onClick={clearFilter}
            title={t('findQueryBar.tooltips.clearFilter')}
            data-testid="query-clear-filter"
          >
            <Eraser size={11} />
          </Button>
        </div>
      </div>

      </div>

      <div
        id={optionsRegionId}
        data-testid="query-options-section"
        className={cn(
          collapsibleOptions && 'min-w-0 flex-[3] space-y-2 border-l border-border bg-muted/15 p-2',
          !optionsVisible && 'hidden'
        )}
      >

      <div className={cn('flex w-full', !collapsibleOptions && 'border-b border-border')}>
        <div
          data-testid={collapsibleOptions ? 'projection-option-field' : undefined}
          className={cn(queryColClass(projectionInvalid), collapsibleOptions && 'rounded-md border border-border bg-input/60')}
        >
          <span className={cn(fieldBadgeClass(projectionInvalid), collapsibleOptions && 'min-w-[72px] rounded-l-md px-2')} style={optionRowStyle}>{t('findQueryBar.labels.projection')}</span>
          <QueryEditor
            singleLine
            surface="projection"
            shellSyntax={shellSyntax}
            onRun={onRun}
            value={projection}
            onChange={onProjectionChange}
            fields={fields}
            schema={schema}
            data-testid="projection-query-input"
          />
          {projectionInvalid && invalidBadge}
          <Button
            variant="ghost"
            size="icon"
            className="mr-1 h-6 w-6 shrink-0"
            onClick={clearProjection}
            title={t('findQueryBar.tooltips.clearProjection')}
          >
            <Eraser size={11} />
          </Button>
        </div>
      </div>

      <div className="flex w-full">
        <div
          data-testid={collapsibleOptions ? 'sort-option-field' : undefined}
          className={cn(queryColClass(sortInvalid), collapsibleOptions && 'rounded-md border border-border bg-input/60')}
        >
          <span className={cn(fieldBadgeClass(sortInvalid), collapsibleOptions && 'min-w-[72px] rounded-l-md px-2')} style={optionRowStyle}>{t('findQueryBar.labels.sort')}</span>
          <QueryEditor
            singleLine
            surface="sort"
            shellSyntax={shellSyntax}
            onRun={onRun}
            value={sort}
            onChange={onSortChange}
            fields={fields}
            schema={schema}
            data-testid="sort-query-input"
          />
          {sortInvalid && invalidBadge}
          <Button
            variant="ghost"
            size="icon"
            className="mr-0.5 h-6 w-6 shrink-0 text-warning"
            onClick={cycleSort}
            title={t('findQueryBar.tooltips.quickSortDirection')}
          >
            <ArrowUpDown size={11} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="mr-1 h-6 w-6 shrink-0"
            onClick={clearSort}
            title={t('findQueryBar.tooltips.clearSort')}
          >
            <Eraser size={11} />
          </Button>
        </div>

      </div>

        {showPagination && (
          <div className={cn('grid grid-cols-2 gap-2', !collapsibleOptions && 'flex')}>
          <div className={cn(queryColClass(false), collapsibleOptions && 'rounded-md border border-border bg-input/60')}>
            <span className={cn(fieldBadgeClass(false), collapsibleOptions && 'min-w-[44px] rounded-l-md px-1.5')} style={optionRowStyle}>{t('findQueryBar.labels.skip')}</span>
            <Input
              type="number"
              value={skip}
              onChange={(e) => onSkipChange?.(e.target.value)}
              onKeyDown={runOnEnter}
              placeholder="0"
              min="0"
              style={optionRowStyle}
              className="flex-1 min-w-0 border-0 bg-transparent px-2.5 font-mono text-[11.5px] shadow-none focus-visible:ring-0"
            />
            {skip !== '0' && skip !== '' && (
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 h-6 w-6 shrink-0"
                onClick={() => onSkipChange?.('0')}
                title={t('findQueryBar.tooltips.resetSkip')}
              >
                <Eraser size={11} />
              </Button>
            )}
          </div>

          <div className={cn(queryColClass(false), collapsibleOptions && 'rounded-md border border-border bg-input/60')}>
            <span className={cn(fieldBadgeClass(false), collapsibleOptions && 'min-w-[44px] rounded-l-md px-1.5')} style={optionRowStyle}>{t('findQueryBar.labels.limit')}</span>
            <Input
              type="number"
              value={limit}
              onChange={(e) => onLimitChange?.(e.target.value)}
              onKeyDown={runOnEnter}
              placeholder="50"
              min="1"
              style={optionRowStyle}
              className="flex-1 min-w-0 border-0 bg-transparent px-2.5 font-mono text-[11.5px] shadow-none focus-visible:ring-0"
            />
            {limit !== '50' && limit !== '' && (
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 h-6 w-6 shrink-0"
                onClick={() => onLimitChange?.('50')}
                title={t('findQueryBar.tooltips.resetLimit')}
              >
                <Eraser size={11} />
              </Button>
            )}
          </div>
          </div>
        )}
      </div>
      </div>

      {collapsibleOptions && (
        <div data-testid="query-composer-footer" className="flex items-center justify-between gap-2 border-t border-border bg-muted/20 px-2 py-1.5">
          <button
            type="button"
            data-testid="query-options-toggle"
            aria-expanded={optionsOpen}
            aria-controls={optionsRegionId}
            aria-label={optionsOpen ? t('findQueryBar.tooltips.fewerOptions') : t('findQueryBar.tooltips.moreOptions')}
            onClick={() => setOptionsOpen(!optionsOpen)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {optionsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('findQueryBar.labels.addProjectionSort')}
            {!optionsOpen && hasOptionValues && <span data-testid="query-options-dot" className="h-1.5 w-1.5 rounded-full bg-primary" />}
          </button>
          <div className="flex items-center gap-1.5">
            {onOpenAI && (
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-[11px] text-muted-foreground" onClick={onOpenAI} data-testid="toggle-ai-helper">
                <Sparkles size={11} className="text-primary" />
                {t('findQueryBar.actions.generateWithAI')}
              </Button>
            )}
            <Button type="button" size="sm" className="h-7 min-w-[64px] gap-1.5 text-[11px]" onClick={onRun} disabled={runDisabled} data-testid="query-run-below">
              <Play size={11} fill="currentColor" />
              {t('findQueryBar.actions.run')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

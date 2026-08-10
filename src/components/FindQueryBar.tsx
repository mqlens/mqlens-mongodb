import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowUpDown, ChevronDown, ChevronRight, Eraser } from 'lucide-react';
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
  // The configured height applies only where the field itself is sized by it —
  // QueryEditor keys that off `large`, which is `collapsibleOptions`. Without
  // this gate the export view (no collapsibleOptions) would grow the QUERY label
  // to the configured height while its input stayed compact.
  const queryRowStyle = collapsibleOptions
    ? {
        height: `${
          clampQueryBarHeight(themeCtx?.config.queryBarHeight ?? QUERY_BAR_HEIGHT_DEFAULT) /
          EDITOR_FONT_BASELINE_PX
        }rem`,
      }
    : optionRowStyle;

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
    >
      <AlertCircle size={10} /> {t('findQueryBar.errors.invalidJson')}
    </span>
  );
  const invalidBadge = badge();

  return (
    <div className="flex flex-col border-b border-border bg-muted/20">
      <div className="flex w-full border-b border-border">
        <div className={queryColClass(filterInvalid)}>
          <span className={fieldBadgeClass(filterInvalid)} style={queryRowStyle}>{t('findQueryBar.labels.query')}</span>
          <QueryEditor
            singleLine
            large={collapsibleOptions}
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
          {collapsibleOptions && (
            <button
              type="button"
              data-testid="query-options-toggle"
              aria-expanded={optionsOpen}
              aria-controls={optionsRegionId}
              aria-label={optionsOpen ? t('findQueryBar.tooltips.fewerOptions') : t('findQueryBar.tooltips.moreOptions')}
              onClick={() => setOptionsOpen(!optionsOpen)}
              title={optionsOpen ? t('findQueryBar.tooltips.hideOptions') : t('findQueryBar.tooltips.showOptions')}
              className="mr-1 flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {optionsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {t('findQueryBar.labels.options')}
              {!optionsOpen && hasOptionValues && (
                <span
                  data-testid="query-options-dot"
                  title={t('findQueryBar.tooltips.optionsSet')}
                  className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                />
              )}
            </button>
          )}
        </div>
      </div>

      <div
        id={optionsRegionId}
        data-testid="query-options-section"
        className={cn(!optionsVisible && 'hidden')}
      >

      <div className="flex w-full border-b border-border">
        <div className={queryColClass(projectionInvalid)}>
          <span className={fieldBadgeClass(projectionInvalid)} style={optionRowStyle}>{t('findQueryBar.labels.projection')}</span>
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

      {/* Sort shares a row with skip/limit, the way Compass groups its
          smaller options after giving `project` a row of its own. */}
      <div className="flex w-full">
        <div className={queryColClass(sortInvalid)}>
          <span className={fieldBadgeClass(sortInvalid)} style={optionRowStyle}>{t('findQueryBar.labels.sort')}</span>
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

        {showPagination && (
          <>
          <div className={queryColClass(false)}>
            <span className={fieldBadgeClass(false)} style={optionRowStyle}>{t('findQueryBar.labels.skip')}</span>
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

          <div className={queryColClass(false)}>
            <span className={fieldBadgeClass(false)} style={optionRowStyle}>{t('findQueryBar.labels.limit')}</span>
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
          </>
        )}
      </div>
      </div>
    </div>
  );
};

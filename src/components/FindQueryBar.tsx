import React from 'react';
import { AlertCircle, ArrowUpDown, Eraser } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';
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
  fields: string[];
  schema?: SchemaMap;
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
    'flex min-w-0 flex-1 items-center border-r border-border bg-input/80 transition-colors last:border-r-0',
    'focus-within:z-[1] focus-within:bg-input focus-within:ring-1 focus-within:ring-inset',
    invalid ? 'focus-within:ring-destructive' : 'focus-within:ring-primary'
  );

const fieldBadgeClass = (invalid: boolean) =>
  cn(
    'flex h-7 min-w-[90px] shrink-0 select-none items-center justify-end border-r border-border px-2.5 text-[9.5px] font-bold uppercase tracking-wider',
    invalid ? 'bg-destructive/5 text-destructive' : 'bg-muted/40 text-muted-foreground'
  );

const invalidBadge = (
  <span className="inline-flex shrink-0 items-center gap-1 pr-1.5 font-mono text-[10px] text-destructive whitespace-nowrap">
    <AlertCircle size={10} /> Invalid JSON
  </span>
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
  projectionInvalid = false,
  sortInvalid = false,
  fields,
  schema,
  onRun,
  onClearFilter,
  onClearProjection,
  onClearSort,
  skip,
  limit,
  onSkipChange,
  onLimitChange,
}) => {
  const showPagination =
    skip !== undefined && limit !== undefined && !!onSkipChange && !!onLimitChange;

  const runOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onRun?.();
    }
  };

  const clearFilter = onClearFilter ?? (() => onFilterChange('{}'));
  const clearProjection = onClearProjection ?? (() => onProjectionChange('{}'));
  const clearSort = onClearSort ?? (() => onSortChange('{}'));

  const cycleSort = () => {
    if (sort === '{}') onSortChange('{"_id": -1}');
    else if (sort === '{"_id": -1}') onSortChange('{"_id": 1}');
    else onSortChange('{}');
  };

  return (
    <div className="flex flex-col border-b border-border bg-muted/20">
      <div className="flex w-full border-b border-border">
        <div className={queryColClass(filterInvalid)}>
          <span className={fieldBadgeClass(filterInvalid)}>Query</span>
          <QueryEditor
            singleLine
            surface="filter"
            onRun={onRun}
            value={filter}
            onChange={onFilterChange}
            fields={fields}
            schema={schema}
            data-testid="query-filter-input"
          />
          {filterInvalid && invalidBadge}
          <Button
            variant="ghost"
            size="icon"
            className="mr-1 h-6 w-6 shrink-0"
            onClick={clearFilter}
            title="Clear Filter"
          >
            <Eraser size={11} />
          </Button>
        </div>
      </div>

      <div className="flex w-full border-b border-border">
        <div className={queryColClass(projectionInvalid)}>
          <span className={fieldBadgeClass(projectionInvalid)}>Projection</span>
          <QueryEditor
            singleLine
            surface="projection"
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
            title="Clear Projection"
          >
            <Eraser size={11} />
          </Button>
        </div>

        <div className={queryColClass(sortInvalid)}>
          <span className={fieldBadgeClass(sortInvalid)}>Sort</span>
          <QueryEditor
            singleLine
            surface="sort"
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
            title="Quick Sort Direction"
          >
            <ArrowUpDown size={11} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="mr-1 h-6 w-6 shrink-0"
            onClick={clearSort}
            title="Clear Sort"
          >
            <Eraser size={11} />
          </Button>
        </div>
      </div>

      {showPagination && (
        <div className="flex w-full">
          <div className={queryColClass(false)}>
            <span className={fieldBadgeClass(false)}>Skip</span>
            <Input
              type="number"
              value={skip}
              onChange={(e) => onSkipChange?.(e.target.value)}
              onKeyDown={runOnEnter}
              placeholder="0"
              min="0"
              className="h-7 flex-1 min-w-0 border-0 bg-transparent px-2.5 font-mono text-[11.5px] shadow-none focus-visible:ring-0"
            />
            {skip !== '0' && skip !== '' && (
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 h-6 w-6 shrink-0"
                onClick={() => onSkipChange?.('0')}
                title="Reset Skip"
              >
                <Eraser size={11} />
              </Button>
            )}
          </div>

          <div className={queryColClass(false)}>
            <span className={fieldBadgeClass(false)}>Limit</span>
            <Input
              type="number"
              value={limit}
              onChange={(e) => onLimitChange?.(e.target.value)}
              onKeyDown={runOnEnter}
              placeholder="50"
              min="1"
              className="h-7 flex-1 min-w-0 border-0 bg-transparent px-2.5 font-mono text-[11.5px] shadow-none focus-visible:ring-0"
            />
            {limit !== '50' && limit !== '' && (
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 h-6 w-6 shrink-0"
                onClick={() => onLimitChange?.('50')}
                title="Reset Limit"
              >
                <Eraser size={11} />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

import { describe, expect, it } from 'vitest';
import { detectAggregateWriteStage } from '../aggregateWriteStage';

describe('detectAggregateWriteStage', () => {
  it('reports no write stage for a plain read pipeline', () => {
    expect(
      detectAggregateWriteStage([{ $match: { active: true } }, { $count: 'n' }])
    ).toEqual({ hasWriteStage: false, target: null });
  });

  it('extracts the target from a bare-string $out', () => {
    expect(detectAggregateWriteStage([{ $out: 'archive' }])).toEqual({
      hasWriteStage: true,
      target: 'archive',
    });
  });

  it('extracts the target from an object-form $out', () => {
    expect(
      detectAggregateWriteStage([{ $out: { db: 'reporting', coll: 'summary' } }])
    ).toEqual({ hasWriteStage: true, target: 'summary' });
  });

  it('extracts the target from a bare-string $merge', () => {
    expect(detectAggregateWriteStage([{ $merge: 'rollup' }])).toEqual({
      hasWriteStage: true,
      target: 'rollup',
    });
  });

  it('extracts the target from $merge.into as a string', () => {
    expect(
      detectAggregateWriteStage([{ $merge: { into: 'rollup', whenMatched: 'merge' } }])
    ).toEqual({ hasWriteStage: true, target: 'rollup' });
  });

  it('extracts the target from $merge.into as an object', () => {
    expect(
      detectAggregateWriteStage([{ $merge: { into: { db: 'reporting', coll: 'rollup' } } }])
    ).toEqual({ hasWriteStage: true, target: 'rollup' });
  });

  it('flags a write stage with no target when extraction fails', () => {
    expect(detectAggregateWriteStage([{ $merge: {} }])).toEqual({
      hasWriteStage: true,
      target: null,
    });
  });

  it('finds a write stage anywhere in the pipeline, not just the first stage', () => {
    expect(
      detectAggregateWriteStage([{ $match: { a: 1 } }, { $group: { _id: '$a' } }, { $out: 'x' }])
    ).toEqual({ hasWriteStage: true, target: 'x' });
  });

  it('does not false-positive on $merge appearing as a value, not a sole top-level key', () => {
    expect(
      detectAggregateWriteStage([
        { $lookup: { from: 'other', pipeline: [{ $project: { note: '$merge' } }], as: 'joined' } },
      ])
    ).toEqual({ hasWriteStage: false, target: null });
  });

  it('does not flag a multi-key stage that happens to include $out', () => {
    expect(detectAggregateWriteStage([{ $out: 'x', $extra: 1 } as Record<string, unknown>])).toEqual(
      { hasWriteStage: false, target: null }
    );
  });

  it('handles an empty or missing pipeline', () => {
    expect(detectAggregateWriteStage([])).toEqual({ hasWriteStage: false, target: null });
    expect(detectAggregateWriteStage(null)).toEqual({ hasWriteStage: false, target: null });
    expect(detectAggregateWriteStage(undefined)).toEqual({ hasWriteStage: false, target: null });
  });
});

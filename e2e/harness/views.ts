// Views in the fake backend (#396): a view is its pipeline run over its source
// collection, found by name, each time it is read.
import { aggregate } from './mongo';
import type { Doc } from './seed';
import type { Collection } from './state';

/**
 * A view in `collections` that reads `on` through `pipeline`. Its documents
 * are computed from whatever the source holds when they're read, so a later
 * change to the source shows through, and a source that's gone reads as empty.
 * Writing to it is refused, as MongoDB refuses a write to a view.
 */
export function defineView(collections: Record<string, Collection>, ns: string, on: string, pipeline: Doc[]): Collection {
  const view: Collection = { type: 'view', docs: [], indexes: [], view: { on, pipeline } };
  Object.defineProperty(view, 'docs', {
    enumerable: true,
    get: () => aggregate(collections[on]?.docs ?? [], pipeline),
    set: () => {
      throw `Namespace ${ns} is a view, not a collection`;
    },
  });
  return view;
}

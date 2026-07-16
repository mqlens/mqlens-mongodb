export interface IndexSuggestion {
  namespace: string;
  keys: Record<string, 1 | -1>;
  suggestedName: string;
  reason: string;
}

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin']);

const extractPlan = (json: any): { wp: any; parsed: any; ns: string } | null => {
  if (Array.isArray(json?.stages)) {
    const cursor = json.stages.find((s: any) => s && s.$cursor)?.$cursor?.queryPlanner;
    if (!cursor) return null;
    return { wp: cursor.winningPlan, parsed: cursor.parsedQuery ?? {}, ns: cursor.namespace ?? '' };
  }
  const qp = json?.queryPlanner;
  if (!qp) return null;
  return { wp: qp.winningPlan, parsed: qp.parsedQuery ?? {}, ns: qp.namespace ?? '' };
};

const INDEX_SERVED_STAGES = new Set(['IXSCAN', 'IDHACK', 'COUNT_SCAN', 'DISTINCT_SCAN', 'CLUSTERED_IXSCAN']);

const walk = (stage: any, acc: { served: boolean; hasCollscan: boolean; sort?: Record<string, number> }) => {
  if (!stage || typeof stage !== 'object') return;
  if (INDEX_SERVED_STAGES.has(stage.stage)) acc.served = true;
  if (stage.stage === 'COLLSCAN') acc.hasCollscan = true;
  if (stage.stage === 'SORT' && stage.sortPattern) acc.sort = stage.sortPattern;
  if (stage.inputStage) walk(stage.inputStage, acc);
  if (Array.isArray(stage.inputStages)) stage.inputStages.forEach((s: any) => walk(s, acc));
};

const flattenTopLevelAnd = (parsed: any): [string, any][] => {
  const entries: [string, any][] = [];
  Object.entries(parsed || {}).forEach(([field, cond]) => {
    if (field === '$and' && Array.isArray(cond)) {
      cond.forEach((clause) => {
        if (clause && typeof clause === 'object' && !Array.isArray(clause)) {
          entries.push(...Object.entries(clause));
        }
      });
      return;
    }
    entries.push([field, cond]);
  });
  return entries;
};

const classify = (parsed: any): { eq: string[]; range: string[] } => {
  const eq: string[] = []; const range: string[] = [];
  flattenTopLevelAnd(parsed).forEach(([field, cond]) => {
    if (field.startsWith('$')) return;
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = Object.keys(cond);
      if (ops.includes('$eq')) eq.push(field);
      else if (ops.every((o) => RANGE_OPS.has(o))) range.push(field);
      else return;
    } else { eq.push(field); }
  });
  return { eq, range };
};

export const suggestESRIndex = (explainStr: string): IndexSuggestion | null => {
  let json: any;
  try { json = JSON.parse(explainStr); } catch { return null; }
  const plan = extractPlan(json);
  if (!plan?.wp) return null;
  const acc = { served: false as boolean, hasCollscan: false as boolean, sort: undefined as Record<string, number> | undefined };
  walk(plan.wp, acc);
  if (acc.served || !acc.hasCollscan) return null;
  const { eq, range } = classify(plan.parsed);
  const sortFields = acc.sort ? Object.keys(acc.sort) : [];
  const ordered: string[] = [];
  const keys: Record<string, 1 | -1> = {};
  const push = (f: string, dir: 1 | -1) => { if (!ordered.includes(f)) { ordered.push(f); keys[f] = dir; } };
  eq.forEach((f) => push(f, 1));
  sortFields.forEach((f) => push(f, acc.sort![f] === -1 ? -1 : 1));
  range.forEach((f) => push(f, 1));
  if (ordered.length === 0) return null;
  return {
    namespace: plan.ns,
    keys,
    suggestedName: ordered.map((f) => `${f}_${keys[f]}`).join('_'),
    reason: 'This query performs a full collection scan (COLLSCAN). A compound index ordered by the ESR rule (Equality, Sort, Range) can serve it from an index scan.',
  };
};

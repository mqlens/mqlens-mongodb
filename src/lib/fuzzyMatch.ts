// Case-insensitive fuzzy match: true when every query character appears in the
// target in order (substrings match trivially). Powers the sidebar tree filter,
// so e.g. "cwsmap" finds "cnips_UserWorkspaceMap" in a 100-collection database.
export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = target.toLowerCase();
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return false;
    ti++;
  }
  return true;
}

// Ranking companion to fuzzyMatch: higher is better, null means no match.
// Exact match > prefix > substring > scattered subsequence; shorter targets
// win ties. Powers the command palette result ordering.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 - t.length / 10;
  const idx = t.indexOf(q);
  if (idx >= 0) return 250 - idx - t.length / 10;
  let ti = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return null;
    if (last >= 0 && ti > last + 1) gaps++;
    last = ti;
    ti++;
  }
  return 100 - gaps * 5 - t.length / 10;
}

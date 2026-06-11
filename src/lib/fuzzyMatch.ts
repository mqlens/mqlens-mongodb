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

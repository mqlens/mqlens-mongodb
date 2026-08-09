/** Preset connection color tags (#34). Hex values work in inline styles.
 *  The swatches are unlabelled circles, so `labelKey` is the ONLY thing a
 *  screen-reader user gets — it carries a catalog key rather than English copy
 *  (same `labelKey` indirection as shortcuts.ts) because this module is plain
 *  `.ts` and cannot call a translation hook. */
export const CONNECTION_COLOR_PALETTE = [
  { id: 'red', value: '#ef4444', labelKey: 'colorTags.red' },
  { id: 'orange', value: '#f97316', labelKey: 'colorTags.orange' },
  { id: 'amber', value: '#eab308', labelKey: 'colorTags.amber' },
  { id: 'green', value: '#22c55e', labelKey: 'colorTags.green' },
  { id: 'blue', value: '#3b82f6', labelKey: 'colorTags.blue' },
  { id: 'violet', value: '#8b5cf6', labelKey: 'colorTags.violet' },
  { id: 'pink', value: '#ec4899', labelKey: 'colorTags.pink' },
  { id: 'slate', value: '#64748b', labelKey: 'colorTags.slate' },
] as const;

export type ConnectionColorId = (typeof CONNECTION_COLOR_PALETTE)[number]['id'];

/** Fallback shown in the native color picker when no tag is set. */
export const CONNECTION_COLOR_PICKER_DEFAULT = '#3b82f6';

export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  const short = trimmed.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    const [, r, g, b] = short;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

export function isPresetConnectionColor(value: string): boolean {
  const normalized = normalizeHexColor(value);
  if (!normalized) return false;
  return CONNECTION_COLOR_PALETTE.some((swatch) => swatch.value === normalized);
}

/** Value for `<input type="color">` — always `#rrggbb`. */
export function colorInputValue(tag?: string | null): string {
  if (!tag) return CONNECTION_COLOR_PICKER_DEFAULT;
  return normalizeHexColor(tag) ?? CONNECTION_COLOR_PICKER_DEFAULT;
}

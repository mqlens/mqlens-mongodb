/** Preset connection color tags (#34). Hex values work in inline styles. */
export const CONNECTION_COLOR_PALETTE = [
  { id: 'red', value: '#ef4444', label: 'Red' },
  { id: 'orange', value: '#f97316', label: 'Orange' },
  { id: 'amber', value: '#eab308', label: 'Amber' },
  { id: 'green', value: '#22c55e', label: 'Green' },
  { id: 'blue', value: '#3b82f6', label: 'Blue' },
  { id: 'violet', value: '#8b5cf6', label: 'Violet' },
  { id: 'pink', value: '#ec4899', label: 'Pink' },
  { id: 'slate', value: '#64748b', label: 'Slate' },
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

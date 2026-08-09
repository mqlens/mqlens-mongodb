import type { TFunction } from 'i18next';

/** Validate optional GridFS metadata JSON (empty string is allowed). `t` is a
 *  parameter rather than a hook call so this module stays pure (same pattern as
 *  `tabLabelFor` in App.tsx); the messages land in the prompt dialog's inline
 *  error row, so they are user-facing copy. */
export function validateGridfsMetadataJson(value: string, t: TFunction): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return t('admin:gridfsView.metadataDialog.errors.mustBeObject');
    }
    return null;
  } catch {
    return t('admin:gridfsView.metadataDialog.errors.invalidJson');
  }
}

/** Normalize optional metadata for the upload IPC call. */
export function gridfsMetadataForUpload(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

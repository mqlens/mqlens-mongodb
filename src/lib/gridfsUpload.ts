/** Validate optional GridFS metadata JSON (empty string is allowed). */
export function validateGridfsMetadataJson(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Metadata must be a JSON object';
    }
    return null;
  } catch {
    return 'Invalid JSON';
  }
}

/** Normalize optional metadata for the upload IPC call. */
export function gridfsMetadataForUpload(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

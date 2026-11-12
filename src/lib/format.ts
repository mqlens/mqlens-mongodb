// Format a byte count into a compact human-readable string (e.g. 145 MB).
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  // No decimals for bytes; one decimal otherwise, trimmed.
  const text = i === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[i]}`;
}

// A whole number of seconds in the largest unit that divides it exactly
// (86400 -> "1 day", 5400 -> "90 minutes"), spelled by the platform in `locale`.
export function formatDuration(seconds: number, locale: string): string {
  const units: [Intl.NumberFormatOptions['unit'], number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const [unit, size] = units.find(([, size]) => seconds > 0 && seconds % size === 0) ?? ['second', 1];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / size);
}

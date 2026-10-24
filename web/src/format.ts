const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Human readable size with binary steps (1 KB = 1024 B). */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  return `${num} ${UNITS[unit]}`;
}

export function formatDate(iso: string | undefined, locale?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function formatDay(iso: string | undefined, locale?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

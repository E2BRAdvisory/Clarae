// Sizes and dates as the console shows them (web/src/format.ts), for every host.
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

export function formatDay(iso: string | Date | undefined, locale?: string): string {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a vault deleted at `deletedAt` is purged, if the retention is known. */
export function purgeDate(deletedAt: string | undefined, retentionDays?: number): Date | undefined {
  if (!deletedAt || retentionDays === undefined) return undefined;
  const d = new Date(deletedAt);
  return Number.isNaN(d.getTime()) ? undefined : new Date(d.getTime() + retentionDays * DAY_MS);
}

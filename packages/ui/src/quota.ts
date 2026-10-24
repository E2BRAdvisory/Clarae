export type QuotaLevel = 'ok' | 'warn' | 'critical' | 'full';

/** Share of the quota in use, 0..100 (unlimited quotas, -1, report 0). */
export function quotaPercent(used: number, quota: number): number {
  if (quota <= 0) return 0;
  return Math.min(100, Math.max(0, (used / quota) * 100));
}

/** ok below 80 %, warn from 80 %, critical from 95 %, full at 100 % (matches the server's levels). */
export function quotaLevel(used: number, quota: number): QuotaLevel {
  if (quota <= 0) return 'ok';
  const pct = (used / quota) * 100;
  if (pct >= 100) return 'full';
  if (pct >= 95) return 'critical';
  if (pct >= 80) return 'warn';
  return 'ok';
}

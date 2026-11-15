// The origins the user confirmed on this device, per vault. A `.webapp` file can arrive from the
// sync or from another user of a shared vault, so it must not load a page just because it exists:
// the first time an origin is about to open here, the user says yes (BrowserView). The answers are a
// choice about this device, like the layout of a drawing, so they stay in localStorage and out of
// the vault, whose files travel with the sync. "Clear the data of the applications" forgets them.
import { create } from 'zustand';

const KEY = 'clarae.webapp.origins.';
const MAX_ORIGINS = 500;

/** Where localStorage is not available the answers last as long as the page. */
const session = new Map<string, string[]>();

function read(vaultId: string): string[] {
  try {
    const raw = localStorage.getItem(KEY + vaultId);
    if (raw === null) return session.get(vaultId) ?? [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return session.get(vaultId) ?? [];
  }
}

function write(vaultId: string, origins: string[]): void {
  session.set(vaultId, origins);
  try {
    if (origins.length === 0) localStorage.removeItem(KEY + vaultId);
    else localStorage.setItem(KEY + vaultId, JSON.stringify(origins));
  } catch {
    /* storage unavailable or full: the answers last for the session */
  }
}

/** Bumped on every change, so a component re-reads what it shows. */
const useRevision = create<{ rev: number }>(() => ({ rev: 0 }));
const bump = (): void => useRevision.setState((s) => ({ rev: s.rev + 1 }));

export function isOriginConfirmed(vaultId: string, origin: string): boolean {
  return read(vaultId).includes(origin);
}

export function confirmOrigin(vaultId: string, origin: string): void {
  const list = read(vaultId);
  if (list.includes(origin)) return;
  write(vaultId, [...list, origin].slice(-MAX_ORIGINS));
  bump();
}

/** Forgets every confirmed origin of the vault (the data of its applications were cleared). */
export function forgetOrigins(vaultId: string): void {
  session.delete(vaultId);
  try {
    localStorage.removeItem(KEY + vaultId);
  } catch {
    /* nothing stored */
  }
  bump();
}

export function confirmedOrigins(vaultId: string): string[] {
  return read(vaultId);
}

/** Whether the origin was confirmed, kept up to date. */
export function useOriginConfirmed(vaultId: string, origin: string): boolean {
  useRevision((s) => s.rev);
  return isOriginConfirmed(vaultId, origin);
}

import { create } from 'zustand';
import type { MountRevokedPayload } from '../app/events';

/** A folder or document of the open vault the user wants to share. */
export interface ShareTarget {
  path: string;
  isDir: boolean;
}

interface SharingState {
  /** The share dialog is open for this target ("" + isDir = the whole vault). */
  shareTarget: ShareTarget | null;
  /** A mount whose share the owner ended: the user decides what to do with the copy. */
  revoked: MountRevokedPayload | null;
  openShare(target: ShareTarget): void;
  closeShare(): void;
  setRevoked(p: MountRevokedPayload | null): void;
}

export const useSharing = create<SharingState>((set) => ({
  shareTarget: null,
  revoked: null,
  openShare: (shareTarget) => set({ shareTarget }),
  closeShare: () => set({ shareTarget: null }),
  setRevoked: (revoked) => set({ revoked }),
}));

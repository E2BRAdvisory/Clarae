// What the core says about the people in the files that are watched (ADR-0065): per file, who is there and where
// each one's pointer is. The three events of the core feed it; nothing else writes to it. A room that is not
// watched any more, a vault that changes and a `presence:cleared` all end with nothing left of it (avatars and
// pointers go at once).
import { create } from 'zustand';
import type { PresencePos } from '../app/api';
import { api } from '../app/api';
import { Events, type EventPayload } from '../app/events';

export type PresenceMember = EventPayload<'presence:members'>['members'][number];

export interface Room {
  members: readonly PresenceMember[];
  /** The last position of each member, by session id. */
  cursors: Readonly<Record<string, PresencePos>>;
}

export const NO_MEMBERS: readonly PresenceMember[] = Object.freeze([]);
const NO_CURSORS: Readonly<Record<string, PresencePos>> = Object.freeze({});

/** The key of a file in the store. */
export const roomKey = (vaultId: string, path: string): string => `${vaultId}\u0000${path}`;

/** The position as the core sends it, or null for a kind this UI does not know. */
export function posFromWire(p: EventPayload<'presence:move'>['pos']): PresencePos | null {
  if (p.kind === 'text') return { kind: 'text', line: p.line, col: p.col };
  if (p.kind === 'scene') return { kind: 'scene', x: p.x, y: p.y };
  return null;
}

interface PresenceState {
  rooms: Record<string, Room>;
  setMembers(vaultId: string, path: string, members: readonly PresenceMember[]): void;
  moved(vaultId: string, path: string, sid: string, pos: PresencePos): void;
  cleared(vaultId: string, path: string): void;
  /** Forgets everything (another vault was opened, the host went away). */
  reset(): void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  rooms: {},
  setMembers(vaultId, path, members) {
    const key = roomKey(vaultId, path);
    set((s) => {
      if (members.length === 0) return { rooms: withoutKey(s.rooms, key) };
      const sids = new Set(members.map((m) => m.sid));
      const old = s.rooms[key]?.cursors ?? NO_CURSORS;
      // The pointer of somebody who left goes with them.
      const cursors = Object.fromEntries(Object.entries(old).filter(([sid]) => sids.has(sid)));
      return { rooms: { ...s.rooms, [key]: { members, cursors } } };
    });
  },
  moved(vaultId, path, sid, pos) {
    const key = roomKey(vaultId, path);
    set((s) => {
      const room = s.rooms[key];
      // A move of somebody the core has not announced (yet) is not drawn: no name, no colour.
      if (!room || !room.members.some((m) => m.sid === sid)) return s;
      return {
        rooms: { ...s.rooms, [key]: { ...room, cursors: { ...room.cursors, [sid]: pos } } },
      };
    });
  },
  cleared(vaultId, path) {
    const key = roomKey(vaultId, path);
    set((s) => (key in s.rooms ? { rooms: withoutKey(s.rooms, key) } : s));
  },
  reset() {
    set((s) => (Object.keys(s.rooms).length ? { rooms: {} } : s));
  },
}));

function withoutKey(rooms: Record<string, Room>, key: string): Record<string, Room> {
  if (!(key in rooms)) return rooms;
  const next = { ...rooms };
  delete next[key];
  return next;
}

/** The other people in a file (empty when nobody is, or nothing is watched). */
export function useMembers(vaultId: string, path: string): readonly PresenceMember[] {
  return usePresenceStore((s) => s.rooms[roomKey(vaultId, path)]?.members ?? NO_MEMBERS);
}

/** Their last pointer positions, by session id. */
export function useCursors(vaultId: string, path: string): Readonly<Record<string, PresencePos>> {
  return usePresenceStore((s) => s.rooms[roomKey(vaultId, path)]?.cursors ?? NO_CURSORS);
}

/** Starts listening to the core's presence events; returns the function that stops. */
export function installPresenceFeed(): () => void {
  const offs = [
    api.on(Events.presenceMembers, (p) =>
      usePresenceStore.getState().setMembers(p.vaultId, p.path, p.members ?? []),
    ),
    api.on(Events.presenceMove, (p) => {
      const pos = posFromWire(p.pos);
      if (pos) usePresenceStore.getState().moved(p.vaultId, p.path, p.sid, pos);
    }),
    api.on(Events.presenceCleared, (p) => usePresenceStore.getState().cleared(p.vaultId, p.path)),
  ];
  return () => {
    offs.forEach((off) => off());
    usePresenceStore.getState().reset();
  };
}

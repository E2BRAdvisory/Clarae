// What this person's pointer does, told to the others (ADR-0065): while the file has other people in it, the
// pointer over the view is sent as a position in the document (a text position or a point of the scene, never
// pixels), at most once per SEND_MS (the core throttles again, latest wins). Nothing is sent when nobody else is
// there, and the listener goes with the view.
import { useEffect, useRef } from 'react';
import { api, type PresencePos } from '../app/api';
import { useMembers } from './store';
import { throttleLatest } from './throttle';
import { usePresenceEnabled } from './watch';

/** The pointer is sent at most this often (ms). */
export const SEND_MS = 40;

export interface PointerLike {
  clientX: number;
  clientY: number;
}

export function useCursorSender(opts: {
  vaultId: string;
  path: string;
  /** The element whose pointer moves are the pointer of the document (null while it does not exist). */
  getTarget: () => HTMLElement | null;
  /** The position in the document under a pointer, null when there is none. */
  toPos: (e: PointerLike) => PresencePos | null;
  /** Changes when the target may be another element (the engine of an editor changed). */
  rebind?: unknown;
}): void {
  const { vaultId, path, rebind } = opts;
  const enabled = usePresenceEnabled(vaultId);
  const others = useMembers(vaultId, path).length > 0;
  const latest = useRef(opts);
  // The listener reads the newest `getTarget` and `toPos` without being set up again for them.
  useEffect(() => {
    latest.current = opts;
  });
  const on = enabled && others;
  useEffect(() => {
    if (!on) return;
    const target = latest.current.getTarget();
    if (!target) return;
    const send = throttleLatest((pos: PresencePos) => {
      void api.presence.move(vaultId, path, pos).catch(() => undefined);
    }, SEND_MS);
    const onMove = (e: PointerEvent): void => {
      const pos = latest.current.toPos(e);
      if (pos) send(pos);
    };
    target.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      target.removeEventListener('pointermove', onMove);
      send.cancel();
    };
  }, [on, vaultId, path, rebind]);
}

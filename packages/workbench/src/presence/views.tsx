// The cursor layer of each kind of view that has one (ADR-0065): a note (Source and Live), a drawing, a canvas.
// Reading, bases, PDFs, images and applications have no pointer in the document: only the avatars.
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useCallback, useMemo, useSyncExternalStore, type RefObject } from 'react';
import { editorsVersion, getEditor, onEditorsChange } from '../editor/registry';
import { boardAdapter, sceneAdapter, textAdapter, type BoardView } from './adapters';
import { LiveCursorsOverlay } from './LiveCursorsOverlay';
import { useCursorSender } from './useCursorSender';
import { usePresenceEnabled } from './watch';

/** The pointers over the editor of a pane, whichever engine it shows (the handle is looked up each time). */
export function NoteCursors({
  vaultId,
  path,
  paneId,
}: {
  vaultId: string;
  path: string;
  paneId: string;
}) {
  const enabled = usePresenceEnabled(vaultId);
  // A new engine (Source to Live) is a new element to listen to and a new thing to ask.
  const engine = useSyncExternalStore(onEditorsChange, editorsVersion);
  const adapter = useMemo(() => textAdapter(() => getEditor(paneId)), [paneId]);
  const subscribe = useCallback(
    (listener: () => void) => {
      // Not drawn before the engine has registered; every registration and every layout change draws again.
      const offEditors = onEditorsChange(listener);
      const offLayout = getEditor(paneId)?.onLayout(listener);
      return () => {
        offEditors();
        offLayout?.();
      };
    },
    // `engine` is the cue that the handle behind `paneId` changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneId, engine],
  );
  useCursorSender({
    vaultId,
    path,
    getTarget: () => getEditor(paneId)?.root ?? null,
    toPos: adapter.toPos,
    rebind: engine,
  });
  if (!enabled) return null;
  return (
    <LiveCursorsOverlay
      vaultId={vaultId}
      path={path}
      place={adapter.place}
      subscribe={subscribe}
      fixed
    />
  );
}

/** The pointers over a drawing, in the coordinates of its scene. */
export function SceneCursors({
  vaultId,
  path,
  api,
  host,
}: {
  vaultId: string;
  path: string;
  api: ExcalidrawImperativeAPI | null;
  host: RefObject<HTMLElement | null>;
}) {
  const enabled = usePresenceEnabled(vaultId);
  const adapter = useMemo(() => sceneAdapter(() => api), [api]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!api) return undefined;
      const offChange = api.onChange(listener);
      const offScroll = api.onScrollChange(listener);
      return () => {
        offChange();
        offScroll();
      };
    },
    [api],
  );
  useCursorSender({
    vaultId,
    path,
    getTarget: () => host.current,
    toPos: adapter.toPos,
    rebind: api,
  });
  if (!enabled || !api) return null;
  return (
    <LiveCursorsOverlay vaultId={vaultId} path={path} place={adapter.place} subscribe={subscribe} />
  );
}

/** The pointers over a canvas, in the coordinates of its board. */
export function BoardCursors({
  vaultId,
  path,
  view,
  board,
}: {
  vaultId: string;
  path: string;
  view: BoardView;
  board: RefObject<HTMLElement | null>;
}) {
  const enabled = usePresenceEnabled(vaultId);
  // The view is a prop: every pan and zoom draws again, no subscription is needed.
  const adapter = useMemo(
    () =>
      boardAdapter(
        () => view,
        () => board.current,
      ),
    [view, board],
  );
  useCursorSender({
    vaultId,
    path,
    getTarget: () => board.current,
    toPos: adapter.toPos,
  });
  if (!enabled) return null;
  return <LiveCursorsOverlay vaultId={vaultId} path={path} place={adapter.place} />;
}

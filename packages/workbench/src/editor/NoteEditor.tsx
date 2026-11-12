// The editor of a note. The Live mode is Milkdown (ADR-0049), in a chunk of its own; Source and the
// `.marp` files are CodeMirror (ADR-0004), in another:
//
//   Source, `.marp`   the CodeMirror editor (source/SourceEditor.tsx)
//   Live              the Milkdown editor, fetched when a note first opens in Live; a note that is
//                     over the limits (limits.ts), or that the editor cannot hold without changing it,
//                     shows as Source with a notice
//
// The CodeMirror editor stays mounted under the Live one: its state is the spine of the undo between the
// modes (A-D9). Going Live to Source brings what Live did into it as one transaction of minimal diff,
// so Undo in Source takes it back; the selection and the scroll go over in source lines.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { importWithRetry, lazyView } from '../ui/lazyView';
import type { SourceEditorProps } from './source/SourceEditor';
import type { NoteEditorHandle } from './handle';
import { LIVE_SYNC_EVENT, singleEdit } from './liveSync';
import { liveLimit } from './live/limits';
import type { Limit } from './live/limits';
import type { LeaveState, LiveFallback, MilkdownEditorProps } from './live/MilkdownEditor';
import type { LivePreviewContext } from './context';
import type { LinkResolver } from './types';

/** What shows when the chunk of the Live editor cannot be fetched: the note, as Source. */
function LoadFailed({ onFallback }: Pick<MilkdownEditorProps, 'onFallback'>) {
  useEffect(() => onFallback('load'), [onFallback]);
  return null;
}

// Both editors are lazy chunks. CodeMirror too: the modules it shares with Milkdown (the language and
// view packages, the Markdown serializer) would be in the entry for both, and the entry would carry the
// union of what each of them uses; the budget of the bundle that loads at start cannot pay for that
// (ADR-0020). Here they are in chunks that neither the entry nor the other views need.
const LiveView = lazyView<MilkdownEditorProps>(async () => {
  try {
    const m = await importWithRetry(() => import('./live/MilkdownEditor'));
    return { default: m.MilkdownEditor };
  } catch {
    return { default: LoadFailed };
  }
});

const SourceView = lazyView<SourceEditorProps>(async () => ({
  default: (await importWithRetry(() => import('./source/SourceEditor'))).SourceEditor,
}));

export interface NoteEditorProps extends SourceEditorProps {
  mode: 'live' | 'source';
  /** What the views of the Live editor ask of the application (embeds, links, math, queries). */
  context: LivePreviewContext;
  /** Told when link resolution finishes, so that the Live editor shows its links again. */
  resolver?: LinkResolver;
}

export function NoteEditor(props: NoteEditorProps) {
  const { t } = useTranslation();
  const View = LiveView;
  const Source = SourceView;
  // The Source editor reads what it needs from the props; `mode`, `context` and `resolver` are the Live one's.
  const wantsLive = props.mode === 'live';
  const cm = useRef<NoteEditorHandle | null>(null);
  const leaving = useRef<LeaveState | null>(null);

  // The size of the text is looked at when Live is asked for and when the file is loaded again, not on
  // every key: a note that grows while it is open in Live stays in Live until it is opened again.
  const sizeKey = wantsLive ? props.version : -1;
  const [measured, setMeasured] = useState<{ key: number; limit: Limit | null } | null>(null);
  let size = measured;
  if (size?.key !== sizeKey) {
    size = { key: sizeKey, limit: wantsLive ? liveLimit(props.doc) : null };
    setMeasured(size);
  }
  const limit = size.limit;

  // What made the editor give up (the layer's refusal, a chunk that did not load) holds for the text it
  // was given: a text loaded again, or Live asked for again, tries again.
  const [gaveUp, setGaveUp] = useState<{ reason: LiveFallback; version: number } | null>(null);
  if (gaveUp && (!wantsLive || gaveUp.version !== props.version)) setGaveUp(null);
  const runtime = gaveUp && wantsLive && gaveUp.version === props.version ? gaveUp.reason : null;
  const versionRef = useRef(props.version);
  useEffect(() => {
    versionRef.current = props.version;
  });
  // The child names the version of the text it refused: its effects run before the parent's, so
  // `versionRef` can still be the one of the text before.
  const onFallback = useCallback(
    (reason: LiveFallback, version?: number) =>
      setGaveUp({ reason, version: version ?? versionRef.current }),
    [],
  );

  const live = wantsLive && !limit && !runtime;
  const [ready, setReady] = useState(false);
  if (!live && ready) setReady(false);

  // Live to Source: what Live did goes into the CodeMirror editor as one step of its history.
  useEffect(() => {
    if (live) return;
    const state = leaving.current;
    leaving.current = null;
    const editor = cm.current;
    if (!state || !editor) return;
    if (state.edited) {
      // CodeMirror reads every line ending as LF whatever the file has
      const target = state.text.replace(/\r\n?/g, '\n');
      const base = editor.text();
      if (target !== base) {
        editor.applySourceEdits(base, [singleEdit(base, target)], LIVE_SYNC_EVENT);
      }
    }
    editor.restore(state.snapshot);
  }, [live]);

  const onHandle = useCallback((h: NoteEditorHandle | null) => {
    cm.current = h;
  }, []);
  const restoreFrom = useCallback(() => cm.current?.snapshot(), []);
  const onLeave = useCallback((state: LeaveState) => {
    leaving.current = state;
  }, []);
  const onReady = useCallback(() => setReady(true), []);

  const reason = limit?.reason ?? runtime;
  return (
    <>
      {wantsLive && reason && (
        <div className="banner" role="status">
          {t('editor.liveFallback', {
            reason: t(`editor.liveFallbackReason_${reason}`, { max: limit?.max ?? 0 }),
          })}
        </div>
      )}
      <Suspense fallback={null}>
        <Source
          {...props}
          suspended={live ? (ready ? 'away' : 'wait') : undefined}
          onHandle={onHandle}
        />
      </Suspense>
      {live && (
        <Suspense fallback={null}>
          <View
            id={props.id}
            doc={props.doc}
            version={props.version}
            settings={props.settings}
            context={props.context}
            completion={props.completion}
            paste={props.paste}
            resolver={props.resolver}
            reveal={props.reveal}
            readOnly={props.readOnly}
            {...(props.hotkey ? { hotkey: props.hotkey } : {})}
            onChange={(text) => props.onChange(text)}
            onStats={(stats) => props.onStats(stats)}
            onFallback={onFallback}
            restoreFrom={restoreFrom}
            onReady={onReady}
            onLeave={onLeave}
          />
        </Suspense>
      )}
    </>
  );
}

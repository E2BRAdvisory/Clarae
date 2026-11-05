import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { followLink } from '../app/actions';
import { downloadVaultFile, openExternally } from '../app/openFile';
import { onVaultChanges, staleTargets, type VaultChangeBatch } from '../app/fileChanges';
import { Editor, type LinkResolver } from '../editor/Editor';
import { EditorToolbar } from '../editor/EditorToolbar';
import { getEditor } from '../editor/registry';
import { statsOf } from '../editor/stats';
import type { LinkSpec, LivePreviewContext } from '../editor/context';
import { useNoteDocument } from '../editor/useNoteDocument';
import { renderEmbedInto } from '../embeds/hydrate';
import { classify } from '../embeds/media';
import { renderMath, renderMermaid } from '../embeds/typeset';
import { renderQueryInto } from '../query/env';
import { attachmentDir } from '../settings/locations';
import { backendFor, ReadingView } from '../reading/ReadingView';
import { commandForEvent } from '../commands/registry';
import { useSettings, type NoteMode } from '../state/settings';
import { BaseView } from '../bases/BaseView';
import { DrawingView } from '../drawing/DrawingView';
import { isGraphPath } from '../graph/paths';
import { useMarpDeck } from '../marp/deckStore';
import { useActiveNote } from '../state/activeNote';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { isSafeExternalUrl } from '../util/sanitize';
import { openExternal } from '../util/external';
import { safeDecodeURI } from '../util/uri';
import type { Pane, Tab } from './layout';
import { lazyView } from '../ui/lazyView';
import { useCan } from '../platform';

// The graph (its renderer and the d3 layout) and the canvas are fetched when a tab of theirs first
// opens, which keeps them out of the bundle loaded at startup (ADR-0020).
const GraphView = lazyView(async () => ({
  default: (await import('../graph/GraphView')).GraphView,
}));
const CanvasView = lazyView(async () => ({
  default: (await import('../canvas/CanvasView')).CanvasView,
}));

const MODES: NoteMode[] = ['live', 'source', 'reading'];

/**
 * Resolution cache for [[links]]: fills in the background, then asks views to repaint. It keeps
 * what each target resolved to, so a file change re-checks only the targets it may redirect
 * (fileChanges.staleTargets); the old answer stays on screen until the new one arrives.
 */
function useLinkResolver(vaultId: string, path: string) {
  return useMemo(() => {
    const cache = new Map<string, string>(); // target -> resolved path, '' when unresolved
    const pending = new Set<string>();
    const subs = new Set<() => void>();
    const notify = (): void => subs.forEach((f) => f());
    const resolver: LinkResolver = {
      subscribe(cb) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
    const lookup = (target: string): Promise<string> =>
      api.links.resolve(vaultId, path, target).catch(() => '');
    return {
      resolver,
      resolved: (target: string): boolean | undefined => {
        if (target === '') return true;
        const p = cache.get(target);
        return p === undefined ? undefined : p !== '';
      },
      request: (target: string): void => {
        if (target === '' || cache.has(target) || pending.has(target)) return;
        pending.add(target);
        void lookup(target)
          .then((p) => cache.set(target, p))
          .finally(() => {
            pending.delete(target);
            notify();
          });
      },
      /** Re-resolves the targets a batch of file changes may affect (all of them when unknown). */
      changed: (batch: VaultChangeBatch): void => {
        const stale = staleTargets(cache, batch);
        if (stale === null) {
          cache.clear();
          notify();
          return;
        }
        const todo = stale.filter((t) => !pending.has(t));
        if (todo.length === 0) return;
        todo.forEach((t) => pending.add(t));
        void Promise.all(
          todo.map(async (t) => {
            const p = await lookup(t);
            pending.delete(t);
            if (cache.get(t) === p) return false;
            cache.set(t, p);
            return true;
          }),
        ).then((changed) => {
          if (changed.some(Boolean)) notify();
        });
      },
    };
  }, [vaultId, path]);
}

function AttachmentView({ vaultId, path }: { vaultId: string; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const embed = renderEmbedInto(
      ref.current,
      { target: path, heading: '', block: '', alias: '', embed: true },
      { backend: backendFor(vaultId), fromPath: path, depth: 0, visited: [path] },
    );
    return () => embed.dispose();
  }, [vaultId, path]);
  return <div className="attachment-view" ref={ref} />;
}

/**
 * A tab of a file the application does not show (restored from the workspace, or opened before
 * ADR-0047): it offers what a click in the explorer does, the system's application or a download.
 */
function ExternalFileView({ path }: { path: string }) {
  const { t } = useTranslation();
  const desktop = useCan('openWithSystemApp');
  return (
    <div className="attachment-view external-file">
      <p className="muted">{t('openFile.notShown')}</p>
      <button
        className="primary"
        onClick={() => void (desktop ? openExternally(path) : downloadVaultFile(path))}
      >
        {desktop ? t('openFile.openWithApp') : t('openFile.download')}
      </button>
    </div>
  );
}

interface Props {
  vaultId: string;
  pane: Pane;
  tab: Tab;
  /** The note is visible (active tab of its pane). */
  visible: boolean;
}

export function NoteView({ vaultId, pane, tab, visible }: Props) {
  const { t } = useTranslation();
  if (isGraphPath(tab.path))
    return (
      <Suspense fallback={<div className="note-loading muted">{t('graph.loading')}</div>}>
        <GraphView key={tab.path} vaultId={vaultId} path={tab.path} />
      </Suspense>
    );
  const kind = classify(tab.path);
  if (kind === 'drawing') return <DrawingView key={tab.path} vaultId={vaultId} path={tab.path} />;
  if (kind === 'canvas')
    return (
      <Suspense fallback={<div className="note-loading muted">{t('canvas.loading')}</div>}>
        <CanvasView key={tab.path} vaultId={vaultId} path={tab.path} />
      </Suspense>
    );
  if (kind === 'base') return <BaseView key={tab.path} vaultId={vaultId} path={tab.path} />;
  if (kind === 'other') return <ExternalFileView path={tab.path} />;
  if (kind !== 'note' && kind !== 'presentation')
    return <AttachmentView vaultId={vaultId} path={tab.path} />;
  return (
    <MarkdownNote
      key={tab.path}
      vaultId={vaultId}
      pane={pane}
      tab={tab}
      visible={visible}
      t={t}
      presentation={kind === 'presentation'}
    />
  );
}

/** Pause in typing before the sidebars see the new text. */
const PUBLISH_DELAY_MS = 300;

/**
 * A Markdown file in its editor: a note (live preview, source or reading view), or a Marp
 * presentation (ADR-0047, ADR-0048), whose editor is the plain source at full width; its slides
 * are in the Slideshow tab of the right sidebar.
 */
function MarkdownNote({
  vaultId,
  pane,
  tab,
  visible,
  t,
  presentation = false,
}: Props & { t: (k: string) => string; presentation?: boolean }) {
  const path = tab.path;
  const doc = useNoteDocument(vaultId, path);
  const editorSettings = useSettings((s) => s.editor);
  const link = useLinkResolver(vaultId, path);
  const setTabMode = useAppStore((s) => s.setTabMode);
  const setStats = useAppStore((s) => s.setStats);
  const reveal = useAppStore((s) => s.reveal);
  const activePane = useAppStore((s) => s.layout.activePane);
  const search = useAppStore((s) => s.search);
  // The sidebars (properties, statistics, slides) follow the text after typing pauses, not on every
  // key: they parse the whole note.
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const publishRef = useRef<() => void>(() => undefined);
  useEffect(() => () => clearTimeout(publishTimer.current), []);
  const settingsRef = useRef(editorSettings);
  useEffect(() => {
    settingsRef.current = editorSettings;
  });

  // Notes created, renamed, deleted (or aliases edited): some links may resolve differently now.
  useEffect(
    () =>
      onVaultChanges((batch) => {
        if (batch.vaultId === vaultId) link.changed(batch);
      }),
    [vaultId, link],
  );

  const open = useCallback(
    (spec: LinkSpec, newTab: boolean) => void followLink(path, spec, newTab),
    [path],
  );

  const context = useMemo<LivePreviewContext>(
    () => ({
      resolved: link.resolved,
      requestResolve: link.request,
      renderEmbed: (spec, el) =>
        renderEmbedInto(el, spec, {
          backend: backendFor(vaultId),
          fromPath: path,
          depth: 0,
          visited: [path],
          openLink: open,
        }),
      renderImage(src, alt, el) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) {
          if (!isSafeExternalUrl(src)) return void (el.textContent = alt || src);
          const img = document.createElement('img');
          img.src = src;
          img.alt = alt;
          el.replaceChildren(img);
          return;
        }
        return renderEmbedInto(
          el,
          { target: safeDecodeURI(src), heading: '', block: '', alias: alt, embed: true },
          { backend: backendFor(vaultId), fromPath: path, depth: 0, visited: [path] },
        );
      },
      openLink: open,
      openExternal,
      renderMath: (tex, display, el) => renderMath(el, tex, display),
      renderMermaid: (code, el) => renderMermaid(el, code),
      renderQuery: (source, el) => void renderQueryInto(el, source, vaultId, path),
    }),
    [link, vaultId, path, open],
  );

  const completion = useMemo(
    () => ({
      backend: {
        suggest: (kind: Parameters<typeof api.links.suggest>[1], query: string, notePath: string) =>
          api.links.suggest(vaultId, kind, query, notePath),
        resolve: (from: string, target: string) => api.links.resolve(vaultId, from, target),
      },
      notePath: () => path,
      linkFormat: () => settingsRef.current.linkFormat,
    }),
    [vaultId, path],
  );

  const paste = useMemo(
    () => ({
      saveAttachment: (name: string, b64: string) =>
        api.vault.saveAttachment(vaultId, attachmentDir(settingsRef.current, path), name, b64),
      enabled: () => settingsRef.current.smartPaste,
    }),
    [vaultId, path],
  );

  // The authoritative text: includes edits the editor made since the last load.
  const text = doc.current();

  // The Properties sidebar edits the frontmatter of the note in focus.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  });
  const isActive = visible && activePane === pane.id;
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);
  useEffect(() => {
    if (!isActive || doc.status !== 'ready') {
      publishRef.current = () => undefined;
      return;
    }
    const publish = (): void => {
      if (presentation) {
        const view = getEditor(pane.id);
        useMarpDeck.getState().publish({
          vaultId,
          path,
          paneId: pane.id,
          // The editor's text: CodeMirror reads every line break as \n, whatever the file has.
          source: view
            ? view.state.doc.toString()
            : docRef.current.current().replace(/\r\n?/g, '\n'),
          cursorLine: view
            ? view.state.doc.lineAt(view.state.selection.main.head).number - 1
            : undefined,
          readOnly,
        });
      }
      useActiveNote.getState().publish({
        vaultId,
        path,
        text: docRef.current.current(),
        current: () => docRef.current.current(),
        // A property is written over the saved note: edits that are not on disk (a conflict, a
        // write error) make it fail rather than be dropped by the write and the reload after it.
        prepare: async () => {
          const d = docRef.current;
          if (!(await d.flush())) throw new Error(i18next.t('editor.notSaved'));
          return d.savedHash();
        },
        // Unsaved edits typed meanwhile are kept (they become a conflict), never discarded.
        reload: () => void docRef.current.refresh(),
      });
    };
    publishRef.current = publish;
    publish();
  }, [isActive, doc.status, vaultId, path, text, presentation, pane.id, readOnly]);
  useEffect(
    () => () => {
      useActiveNote.getState().retire(path);
      // Notes typed in the Slideshow tab a moment ago go into the editor (still alive: its own
      // cleanup runs after this one) before the presentation is cleared.
      if (useMarpDeck.getState().path === path) useMarpDeck.getState().flushNotes?.();
      useMarpDeck.getState().clear(path);
    },
    [path],
  );
  // The editor reports its figures when the text or the selection changes: a tab just opened, a
  // pane just focused or a switch out of reading view reports them at once instead.
  useEffect(() => {
    if (!isActive || doc.status !== 'ready' || tab.mode === 'reading') return;
    const view = getEditor(pane.id);
    if (view) setStats(statsOf(view.state));
  }, [isActive, doc.status, tab.mode, pane.id, setStats]);

  const revealHere =
    reveal && reveal.paneId === pane.id && reveal.path === path ? reveal : undefined;

  if (doc.status === 'loading') return <div className="note-loading muted">…</div>;
  if (doc.status === 'error')
    return (
      <div className="note-error" role="alert">
        {doc.error}
      </div>
    );

  const saveLabel = {
    saved: t('editor.saved'),
    dirty: t('editor.unsaved'),
    saving: t('editor.saving'),
    conflict: '',
    error: t('editor.saveError'),
  }[doc.save];

  return (
    <div
      className={`note-view ${editorSettings.readableWidth && !presentation ? 'readable' : ''}`}
      data-mode={tab.mode}
    >
      <div className="note-header">
        <span className="path" title={path}>
          {path.replace(/\.md$/, '')}
        </span>
        <span className={`save-state ${doc.save}`} aria-live="polite">
          {saveLabel}
        </span>
        <div
          className="mode-toggle"
          role="group"
          aria-label={t('editor.mode')}
          hidden={presentation}
        >
          {MODES.map((m) => (
            <button
              key={m}
              className={tab.mode === m ? 'active' : ''}
              aria-pressed={tab.mode === m}
              onClick={() => setTabMode(tab.id, m)}
              title={t(`editor.mode_${m}`)}
            >
              {t(`editor.mode_${m}`)}
            </button>
          ))}
        </div>
      </div>
      {doc.save === 'conflict' && (
        <div className="banner" role="alert">
          <span>{t('editor.conflict')}</span>
          <button onClick={() => void doc.reload()}>{t('editor.reload')}</button>
          <button onClick={() => void doc.overwrite()}>{t('editor.overwrite')}</button>
        </div>
      )}
      {tab.mode === 'reading' && !presentation ? (
        <div className="reading-scroll">
          <ReadingView
            vaultId={vaultId}
            path={path}
            content={text}
            reveal={revealHere}
            onOpenLink={open}
            onSearchTag={(tag) => search(`tag:#${tag.replace(/^#/, '')}`)}
          />
        </div>
      ) : (
        <>
          <EditorToolbar
            vaultId={vaultId}
            paneId={pane.id}
            disabled={readOnly}
            attachmentDir={attachmentDir(editorSettings, path)}
          />
          <Editor
            id={pane.id}
            doc={text}
            version={doc.version}
            mode={presentation || tab.mode === 'reading' ? 'source' : tab.mode}
            settings={editorSettings}
            context={context}
            completion={completion}
            paste={paste}
            resolver={link.resolver}
            hotkey={(e) => {
              const c = commandForEvent(e, useSettings.getState().hotkeys);
              if (!c) return false;
              e.preventDefault();
              void c.run();
              return true;
            }}
            reveal={revealHere}
            readOnly={readOnly}
            onChange={(v) => {
              doc.edit(v); // the save state re-renders this view when it changes, not every key
              clearTimeout(publishTimer.current);
              publishTimer.current = setTimeout(() => publishRef.current(), PUBLISH_DELAY_MS);
            }}
            onStats={(s) => {
              if (isActive) setStats(s);
              if (!presentation || !isActive) return;
              const view = getEditor(pane.id);
              if (view)
                useMarpDeck
                  .getState()
                  .setCursor(view.state.doc.lineAt(view.state.selection.main.head).number - 1);
            }}
          />
        </>
      )}
    </div>
  );
}

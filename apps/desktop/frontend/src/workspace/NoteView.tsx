import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { followLink } from '../app/actions';
import { Events, type FileChangedPayload } from '../app/events';
import { Editor, type LinkResolver } from '../editor/Editor';
import type { LinkSpec, LivePreviewContext } from '../editor/context';
import { useNoteDocument } from '../editor/useNoteDocument';
import { renderEmbedInto } from '../embeds/hydrate';
import { classify } from '../embeds/media';
import { renderMath, renderMermaid } from '../embeds/typeset';
import { backendFor, ReadingView } from '../reading/ReadingView';
import { commandForEvent } from '../commands/registry';
import { useSettings, type NoteMode } from '../state/settings';
import { useActiveNote } from '../state/activeNote';
import { useAppStore } from '../state/store';
import { isSafeExternalUrl } from '../util/sanitize';
import { openExternal } from '../util/external';
import type { Pane, Tab } from './layout';

const MODES: NoteMode[] = ['live', 'source', 'reading'];

/** Resolution cache for [[links]]: fills in the background, then asks views to repaint. */
function useLinkResolver(vaultId: string, path: string) {
  return useMemo(() => {
    const cache = new Map<string, boolean>();
    const pending = new Set<string>();
    const subs = new Set<() => void>();
    const notify = (): void => subs.forEach((f) => f());
    const resolver: LinkResolver = {
      subscribe(cb) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
    return {
      resolver,
      resolved: (target: string): boolean | undefined => (target === '' ? true : cache.get(target)),
      request: (target: string): void => {
        if (target === '' || cache.has(target) || pending.has(target)) return;
        pending.add(target);
        void api.links
          .resolve(vaultId, path, target)
          .then((p) => cache.set(target, p !== ''))
          .catch(() => cache.set(target, false))
          .finally(() => {
            pending.delete(target);
            notify();
          });
      },
      invalidate: (): void => {
        cache.clear();
        notify();
      },
    };
  }, [vaultId, path]);
}

function AttachmentView({ vaultId, path }: { vaultId: string; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current)
      void renderEmbedInto(
        ref.current,
        { target: path, heading: '', block: '', alias: '', embed: true },
        { backend: backendFor(vaultId), fromPath: path, depth: 0, visited: [path] },
      );
  }, [vaultId, path]);
  return <div className="attachment-view" ref={ref} />;
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
  if (classify(tab.path) !== 'note') return <AttachmentView vaultId={vaultId} path={tab.path} />;
  return (
    <MarkdownNote key={tab.path} vaultId={vaultId} pane={pane} tab={tab} visible={visible} t={t} />
  );
}

function MarkdownNote({ vaultId, pane, tab, visible, t }: Props & { t: (k: string) => string }) {
  const path = tab.path;
  const doc = useNoteDocument(vaultId, path);
  const editorSettings = useSettings((s) => s.editor);
  const link = useLinkResolver(vaultId, path);
  const setTabMode = useAppStore((s) => s.setTabMode);
  const setStats = useAppStore((s) => s.setStats);
  const reveal = useAppStore((s) => s.reveal);
  const activePane = useAppStore((s) => s.layout.activePane);
  const search = useAppStore((s) => s.search);
  const [, rerender] = useState(0);
  const settingsRef = useRef(editorSettings);
  useEffect(() => {
    settingsRef.current = editorSettings;
  });

  // Another note was created/renamed/deleted: links may resolve differently now.
  useEffect(
    () =>
      api.on<FileChangedPayload>(Events.vaultFileChanged, (p) => {
        if (p.vaultId === vaultId) link.invalidate();
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
        void renderEmbedInto(el, spec, {
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
        void renderEmbedInto(
          el,
          { target: decodeURI(src), heading: '', block: '', alias: alt, embed: true },
          { backend: backendFor(vaultId), fromPath: path, depth: 0, visited: [path] },
        );
      },
      openLink: open,
      openExternal,
      renderMath: (tex, display, el) => renderMath(el, tex, display),
      renderMermaid: (code, el) => renderMermaid(el, code),
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
        api.vault.saveAttachment(vaultId, settingsRef.current.attachmentsFolder, name, b64),
      enabled: () => settingsRef.current.smartPaste,
    }),
    [vaultId],
  );

  // The authoritative text: includes edits the editor made since the last load.
  const text = doc.current();

  // The Properties sidebar edits the frontmatter of the note in focus.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  });
  const isActive = visible && activePane === pane.id;
  useEffect(() => {
    if (!isActive || doc.status !== 'ready') return;
    useActiveNote.getState().publish({
      vaultId,
      path,
      text,
      prepare: async () => {
        await docRef.current.flush();
        return (await api.vault.readNote(vaultId, path)).hash;
      },
      reload: () => void docRef.current.reload(),
    });
  }, [isActive, doc.status, vaultId, path, text]);
  useEffect(() => () => useActiveNote.getState().retire(path), [path]);

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
      className={`note-view ${editorSettings.readableWidth ? 'readable' : ''}`}
      data-mode={tab.mode}
    >
      <div className="note-header">
        <span className="path" title={path}>
          {path.replace(/\.md$/, '')}
        </span>
        <span className={`save-state ${doc.save}`} aria-live="polite">
          {saveLabel}
        </span>
        <div className="mode-toggle" role="group" aria-label={t('editor.mode')}>
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
      {tab.mode === 'reading' ? (
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
        <Editor
          id={pane.id}
          doc={text}
          version={doc.version}
          mode={tab.mode}
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
          onChange={(v) => {
            doc.edit(v);
            rerender((n) => n + 1);
          }}
          onStats={(s) => isActive && setStats(s)}
        />
      )}
    </div>
  );
}

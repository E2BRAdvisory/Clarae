// The Live editor as a React view (A-W4): the lazy "editor" chunk. It mounts the adapter in a host
// element, keeps it in step with the document the pane holds (a reload from disk, read-only, a reveal)
// and registers its NoteEditorHandle for the rest of the application. It is behind a build switch and
// never replaces the CodeMirror editor, which stays mounted beside it (NoteEditor.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { effectiveTheme, type Theme } from '../../app/theme';
import { i18next } from '../../i18n';
import { slashHost } from '../../slash/host';
import { dialog } from '../../ui/dialogs';
import type { Reveal } from '../../reading/ReadingView';
import type { EditorSettings } from '../../state/settings';
import { useAppStore } from '../../state/store';
import type { LinkResolver } from '../Editor';
import type { CompletionOptions } from '../completionEngine';
import type { LivePreviewContext } from '../context';
import type { PasteDeps } from '../pasteCore';
import { STATS_DELAY_MS } from '../stats';
import { registerEditor, setActiveEditor, unregisterEditor } from '../registry';
import type { ViewSnapshot } from '../handle';
import type { EditorStats } from '../types';
import { openLiveEditor, type Fallback, type LiveEditor } from './MilkdownAdapter';
import type { CrepeLabels } from './crepe';
import type { LiveSettings } from './frame';
import { LiveHost } from './views';

/** What takes a note out of Live: the reasons of the layer, the editor that could not be loaded, a note it does not give back as it is. */
export type LiveFallback = Fallback | 'load' | 'identity';

/** The state of the editor that goes, for the one that comes next. */
export interface LeaveState {
  text: string;
  snapshot: ViewSnapshot;
  /** The user edited the note in this editor: its text is no longer the one the other editor has. */
  edited: boolean;
}

export interface MilkdownEditorProps {
  /** Registry key (pane id). */
  id: string;
  doc: string;
  /** Increment to replace the document with `doc` (after a reload from disk). */
  version: number;
  settings: EditorSettings;
  /** What the views of links, embeds, images and the rest call (the same context CodeMirror gets). */
  context: LivePreviewContext;
  /** The backend of the suggestions (links, tags) and the settings that tune them. */
  completion: CompletionOptions;
  /** Where pasted and dropped files are stored, and whether smart paste is on. */
  paste: PasteDeps;
  /** Told when a link may resolve differently now. */
  resolver?: LinkResolver | undefined;
  reveal?: Reveal | undefined;
  readOnly?: boolean | undefined;
  hotkey?: (event: KeyboardEvent) => boolean;
  onChange(text: () => string): void;
  onStats(stats: EditorStats): void;
  /**
   * The note cannot be held by Live (or it could not load): show it as Source. `version` is the one of
   * the text that was refused (the parent's own copy of it can be a render behind: effects of a child
   * run before the ones of its parent); without it, the version the parent holds.
   */
  onFallback(reason: LiveFallback, version?: number): void;
  /** The view state to put back once the editor shows (the selection and scroll the other editor had). */
  restoreFrom?: () => ViewSnapshot | undefined;
  /** The editor is showing. */
  onReady?: () => void;
  /** The editor goes: what it holds, for the editor that takes its place. */
  onLeave?: (state: LeaveState) => void;
}

const labels = (): CrepeLabels => ({
  copy: i18next.t('editor.crepe.copy'),
  searchLanguage: i18next.t('editor.crepe.searchLanguage'),
  noResult: i18next.t('editor.crepe.noResult'),
  previewEdit: i18next.t('editor.crepe.previewEdit'),
  previewHide: i18next.t('editor.crepe.previewHide'),
  uploadFile: i18next.t('editor.crepe.uploadFile'),
  pasteLink: i18next.t('editor.crepe.pasteLink'),
  confirm: i18next.t('editor.crepe.confirm'),
  captionPlaceholder: i18next.t('editor.crepe.captionPlaceholder'),
  codeBlock: i18next.t('editor.crepe.codeBlock'),
  task: i18next.t('editor.crepe.task'),
  table: {
    addRow: i18next.t('editor.crepe.table.addRow'),
    addColumn: i18next.t('editor.crepe.table.addColumn'),
    deleteRow: i18next.t('editor.crepe.table.deleteRow'),
    deleteColumn: i18next.t('editor.crepe.table.deleteColumn'),
    alignLeft: i18next.t('editor.crepe.table.alignLeft'),
    alignCenter: i18next.t('editor.crepe.table.alignCenter'),
    alignRight: i18next.t('editor.crepe.table.alignRight'),
  },
});

/** Whether the dark theme is the one in force (the `data-theme` of the page, or the system's choice). */
function useDark(): boolean {
  const read = (): boolean =>
    effectiveTheme((document.documentElement.getAttribute('data-theme') ?? 'system') as Theme) ===
    'dark';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = (): void => setDark(read());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', update);
    update();
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', update);
    };
  }, []);
  return dark;
}

export function MilkdownEditor(props: MilkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const dark = useDark();
  const { tabSize, spellcheck, fontSize, wrap, foldHeadings } = props.settings;
  // what the editor follows while it is open
  const settings = useMemo<LiveSettings>(
    () => ({ tabSize, spellcheck, fontSize, wrap, foldHeadings, dark }),
    [tabSize, spellcheck, fontSize, wrap, foldHeadings, dark],
  );
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });
  const editorRef = useRef<LiveEditor | null>(null);
  const versionRef = useRef(props.version);
  // the views call the context of the moment: the note's links resolve against it
  const [views] = useState(() => new LiveHost(props.context));
  useEffect(() => views.use(props.context), [views, props.context]);

  // Opens the editor once per mount; everything else is followed below.
  useEffect(() => {
    const parent = host.current as HTMLDivElement;
    let cancelled = false;
    let statsTimer: ReturnType<typeof setTimeout> | undefined;
    let handle: LiveEditor | null = null;
    const emitStats = (): void => {
      statsTimer = undefined;
      if (handle && !cancelled) latest.current.onStats(handle.stats());
    };
    // The figures walk the whole note: after the typing pauses, not on every key.
    const scheduleStats = (): void => {
      clearTimeout(statsTimer);
      statsTimer = setTimeout(emitStats, STATS_DELAY_MS);
    };
    const p = latest.current;
    void openLiveEditor(parent, p.doc, {
      paneId: p.id,
      readOnly: !!p.readOnly,
      settings: settingsRef.current,
      labels: labels(),
      ariaLabel: i18next.t('editor.ariaLabel'),
      views,
      // the vault, for the AI assistant, which is off (ADR-0050): the gates decide, here only the vault is read
      vaultId: () => useAppStore.getState().vault?.id,
      // where the note is shared, for collaboration, which is off and has no provider (ADR-0050)
      collabRoom: () => {
        const vault = useAppStore.getState().vault;
        const path = latest.current.completion.notePath();
        return vault && path ? { vaultId: vault.id, path } : undefined;
      },
      // the application of the moment: the note, the vault and the settings can change under an open editor
      input: {
        completion: {
          backend: {
            suggest: (kind, query, notePath) =>
              latest.current.completion.backend.suggest(kind, query, notePath),
            resolve: (from, target) => latest.current.completion.backend.resolve(from, target),
          },
          notePath: () => latest.current.completion.notePath(),
          linkFormat: () => latest.current.completion.linkFormat(),
        },
        slash: slashHost,
        paste: {
          saveAttachment: (name, b64) => latest.current.paste.saveAttachment(name, b64),
          enabled: () => latest.current.paste.enabled(),
          onError: (e) => void dialog.error(e),
        },
        autoPair: () => latest.current.settings.autoPair,
      },
      hotkey: () => latest.current.hotkey,
      onChange: (text) => latest.current.onChange(text),
      onUpdate: scheduleStats,
      onFocus: () => setActiveEditor(latest.current.id),
    }).then((r) => {
      if (cancelled) {
        if (r.ok) r.editor.dispose();
        return;
      }
      if (!r.ok) {
        // no version: the file may have been loaded again while the editor was opening, and Source shows
        // what the pane holds now (the version of the parent, which is not a render behind here)
        latest.current.onFallback(r.reason);
        return;
      }
      handle = r.editor;
      editorRef.current = handle;
      // a setting or the theme may have changed while the editor was loading
      handle.applySettings(settingsRef.current);
      const cur = latest.current;
      // The file changed while the editor was loading: it opens on the newer text.
      if (versionRef.current !== cur.version) {
        versionRef.current = cur.version;
        const refused = handle.reload(cur.doc);
        if (refused) {
          cur.onFallback(refused.reason, cur.version);
          return;
        }
      }
      const snapshot = cur.restoreFrom?.();
      if (snapshot) handle.restore(snapshot);
      registerEditor(cur.id, handle);
      setActiveEditor(cur.id);
      if (cur.reveal) handle.reveal(cur.reveal);
      emitStats();
      cur.onReady?.();
    });
    return () => {
      cancelled = true;
      clearTimeout(statsTimer);
      const h = handle;
      if (!h) return;
      try {
        latest.current.onLeave?.({ text: h.text(), snapshot: h.snapshot(), edited: h.edited });
      } catch {
        /* the editor is not in a state to say: the other one keeps what it has */
      }
      unregisterEditor(latest.current.id, h);
      editorRef.current = null;
      h.dispose();
    };
    // Created once per mount; the rest follows through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The document was replaced from outside (reload after an external change).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || versionRef.current === props.version) return;
    versionRef.current = props.version;
    const refused = editor.reload(props.doc);
    // `editor.edited` is already false: what this editor still holds is the text the file left behind
    if (refused) props.onFallback(refused.reason, props.version);
  }, [props.version, props.doc, props]);

  useEffect(() => {
    editorRef.current?.setReadOnly(!!props.readOnly);
  }, [props.readOnly]);

  // The settings and the theme change under an open editor.
  useEffect(() => {
    editorRef.current?.applySettings(settings);
  }, [settings]);

  // Notes created, renamed or deleted: the links the document shows look again.
  useEffect(() => props.resolver?.subscribe(() => views.linksChanged()), [props.resolver, views]);

  // Scroll to a heading, block or line.
  useEffect(() => {
    const r = props.reveal;
    if (r) editorRef.current?.reveal(r);
  }, [props.reveal]);

  return <div className="editor-host live-host" ref={host} data-mode="live" />;
}

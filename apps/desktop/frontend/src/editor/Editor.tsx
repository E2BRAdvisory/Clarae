import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { api, errorCode, type NoteContent } from '../app/api';
import { Events, type FileChangedPayload } from '../app/events';

const SAVE_DEBOUNCE_MS = 500;

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

interface Props {
  vaultId: string;
  path: string;
}

/**
 * Source-mode Markdown editor (CodeMirror 6). Live Preview and Reading view
 * arrive with M1. Saves with a debounce through WriteNote(expectedHash): a
 * hash mismatch means the file changed on disk and the user decides.
 */
export function Editor({ vaultId, path }: Props) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hashRef = useRef<string>('');
  const timerRef = useRef<number | undefined>(undefined);
  const [state, setState] = useState<SaveState>('saved');
  const [loaded, setLoaded] = useState<NoteContent | null>(null);
  const [error, setError] = useState<string>('');

  // Load the note once: the parent keys this component by vault and path, so a
  // different note always mounts a fresh editor with fresh state.
  useEffect(() => {
    let cancelled = false;
    api.vault
      .readNote(vaultId, path)
      .then((note) => {
        if (!cancelled) {
          hashRef.current = note.hash;
          setLoaded(note);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String(e));
          setState('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vaultId, path]);

  const save = async (content: string, force: boolean) => {
    setState('saving');
    try {
      const res = await api.vault.writeNote(vaultId, path, content, force ? '' : hashRef.current);
      hashRef.current = res.hash;
      setState('saved');
    } catch (e) {
      if (errorCode(e) === 'conflict') {
        setState('conflict');
      } else {
        setError(String(e));
        setState('error');
      }
    }
  };

  // Mount CodeMirror once the content is loaded.
  useEffect(() => {
    if (!loaded || !hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: loaded.content,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setState((s) => (s === 'conflict' ? s : 'dirty'));
            window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              setState((s) => {
                if (s === 'conflict') return s;
                void save(update.state.doc.toString(), false);
                return s;
              });
            }, SAVE_DEBOUNCE_MS);
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    view.focus();
    return () => {
      window.clearTimeout(timerRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // External change of this very file (watcher): flag a conflict only when
  // the hash differs from what we last wrote/read.
  useEffect(() => {
    return api.on<FileChangedPayload>(Events.vaultFileChanged, (p) => {
      if (p.vaultId !== vaultId || !p.paths.includes(path)) return;
      void api.vault.readNote(vaultId, path).then((note) => {
        if (note.hash !== hashRef.current) setState('conflict');
      });
    });
  }, [vaultId, path]);

  const reload = () => {
    void api.vault.readNote(vaultId, path).then((note) => {
      hashRef.current = note.hash;
      setLoaded(note); // remounts the editor with the disk content
      setState('saved');
    });
  };

  const overwrite = () => {
    const content = viewRef.current?.state.doc.toString() ?? loaded?.content ?? '';
    void save(content, true);
  };

  const label =
    state === 'saving'
      ? t('editor.saving')
      : state === 'dirty'
        ? t('editor.unsaved')
        : state === 'saved'
          ? t('editor.saved')
          : '';

  return (
    <>
      <div className="editor-header">
        <span className="path">{path}</span>
        <span>{label}</span>
      </div>
      {state === 'conflict' && (
        <div className="banner" role="alert">
          <span>{t('editor.conflict')}</span>
          <button onClick={reload}>{t('editor.reload')}</button>
          <button className="primary" onClick={overwrite}>
            {t('editor.overwrite')}
          </button>
        </div>
      )}
      {state === 'error' && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}
      <div className="editor-host" ref={hostRef} />
    </>
  );
}

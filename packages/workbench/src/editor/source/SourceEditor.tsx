import { useEffect, useRef, useState } from 'react';
import './suspended.css';
import { i18next } from '../../i18n';
import { createStatsTracker } from './stats';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentUnit,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import type { Reveal } from '../../reading/ReadingView';
import type { EditorSettings } from '../../state/settings';
import { ofmCompletionSources } from './completions';
import type { CompletionOptions } from '../completionEngine';
import { External, externalReplace } from './external';
import { LIVE_SYNC_EVENT } from '../liveSync';
import { pagePreviewHover } from './pagePreview';
import { codeMirrorHandle } from './CodeMirrorAdapter';
import type { NoteEditorHandle } from '../handle';
import type { EditorStats } from '../types';
import { smartPaste } from './paste';
import type { PasteDeps } from '../pasteCore';
import { iconElement } from '../../shell/icons';
import { registerEditor, setActiveEditor, unregisterEditor } from '../registry';
import { sourceMode } from './sourceMode';
import { slashCompletionSource } from './slash';
import { slashHost } from '../../slash/host';
import { dialog } from '../../ui/dialogs';

export interface SourceEditorProps {
  /** Registry key (pane id): formatting commands act on the focused editor. */
  id: string;
  doc: string;
  /** Increment to replace the document with `doc` (after a reload from disk). */
  version: number;
  settings: EditorSettings;
  completion: CompletionOptions;
  paste: PasteDeps;
  reveal?: Reveal | undefined;
  readOnly?: boolean;
  /** Gets every key event first; return true when it ran an application command. */
  hotkey?: (event: KeyboardEvent) => boolean;
  /**
   * After every edit by the user, with a getter of the new text: the document is turned into a
   * string only when the getter is called (a debounced save), not on every keystroke, which in a
   * large note would copy megabytes per key. The getter keeps returning the text of that edit.
   */
  onChange(text: () => string): void;
  onStats(stats: EditorStats): void;
  /**
   * The Live editor (Milkdown) is on its way (`wait`) or showing (`away`) and this editor stays under
   * it, because its state is the spine of the undo between the modes (ADR-0049, A-D9). It reports
   * nothing, so while it waits it is read-only (what is typed in that window would be reported by no
   * one and Live would open without it); once Live shows, it is no longer the pane's editor and is out
   * of the accessibility tree.
   */
  suspended?: 'wait' | 'away' | undefined;
  /** The handle of this editor once it exists (null when it goes). */
  onHandle?: (handle: NoteEditorHandle | null) => void;
}

/**
 * Read-only, and while the Live editor is loading (`waiting`) closed to every edit that nobody would
 * report: the typing, and also the commands and the toolbar, which dispatch on the view directly. A
 * file that is loaded again (`External`) and the transfer from Live (`LIVE_SYNC_EVENT`) still go through.
 */
function readOnlyExtensions(readOnly: boolean, waiting: boolean): Extension[] {
  return [
    EditorState.readOnly.of(readOnly || waiting),
    waiting
      ? EditorState.transactionFilter.of((tr) =>
          tr.docChanged && !tr.annotation(External) && !tr.isUserEvent(LIVE_SYNC_EVENT) ? [] : tr,
        )
      : [],
  ];
}

function settingsExtensions(s: EditorSettings, suspended?: 'wait' | 'away'): Extension[] {
  return [
    s.lineNumbers ? lineNumbers() : [],
    s.wrap ? EditorView.lineWrapping : [],
    s.foldHeadings
      ? [
          codeFolding(),
          foldGutter({
            markerDOM: (open) => {
              const el = document.createElement('span');
              el.append(iconElement(open ? 'chevronDown' : 'chevronRight', 16));
              return el;
            },
          }),
        ]
      : [],
    EditorState.tabSize.of(s.tabSize),
    indentUnit.of(' '.repeat(s.tabSize)),
    s.autoPair ? closeBrackets() : [],
    EditorView.contentAttributes.of({
      spellcheck: String(s.spellcheck),
      autocorrect: 'off',
      // An editor that is out of the way, or that waits for the Live one to show, has no name: the one
      // the user types into has it (two editors of one name would be heard as one, and a test or a
      // script that asks for it by name must never meet the one that is going away).
      ...(suspended ? {} : { 'aria-label': i18next.t('editor.ariaLabel') }),
    }),
    EditorView.theme({ '&': { fontSize: `${s.fontSize}px` } }),
  ];
}

/** The Source editor of a note: CodeMirror 6 on the Markdown text, as it is in the file (ADR-0004). */
export function SourceEditor(props: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handleRef = useRef<NoteEditorHandle | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const [settingsC] = useState(() => new Compartment());
  const [readOnlyC] = useState(() => new Compartment());
  const versionRef = useRef(props.version);

  // Create the view once.
  useEffect(() => {
    const p = latest.current;
    // Word counts walk the whole note: they are debounced, line and column are immediate.
    const stats = createStatsTracker((s) => latest.current.onStats(s));
    const view = new EditorView({
      parent: host.current as HTMLElement,
      state: EditorState.create({
        doc: p.doc,
        extensions: [
          Prec.highest(
            keymap.of([{ any: (_view, event) => latest.current.hotkey?.(event) ?? false }]),
          ),
          history(),
          drawSelection(),
          dropCursor(),
          highlightSpecialChars(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          EditorState.allowMultipleSelections.of(true),
          search({ top: true }),
          markdown({ base: markdownLanguage, addKeymap: true }),
          autocompletion({
            override: [
              ...ofmCompletionSources({
                backend: latest.current.completion.backend,
                notePath: () => latest.current.completion.notePath(),
                linkFormat: () => latest.current.completion.linkFormat(),
              }),
              slashCompletionSource(slashHost),
            ],
            activateOnTyping: true,
          }),
          smartPaste({
            saveAttachment: (name, b64) => latest.current.paste.saveAttachment(name, b64),
            enabled: () => latest.current.paste.enabled(),
            onError: (e) => void dialog.error(e),
          }),
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          sourceMode(),
          settingsC.of(settingsExtensions(p.settings, p.suspended)),
          readOnlyC.of(readOnlyExtensions(!!p.readOnly, p.suspended === 'wait')),
          pagePreviewHover(),
          EditorView.updateListener.of((u) => {
            const cur = latest.current;
            if (cur.suspended) return; // the editor that shows reports
            if (
              u.docChanged &&
              !u.transactions.some(
                (tr) => tr.annotation(External) || tr.isUserEvent(LIVE_SYNC_EVENT),
              )
            ) {
              const changed = u.state.doc; // immutable: the text of this edit, whenever it is read
              let text: string | undefined;
              cur.onChange(() => (text ??= changed.toString()));
            }
            if (u.docChanged || u.selectionSet) stats.update(u.state, u.docChanged);
          }),
          EditorView.domEventHandlers({ focus: () => (setActiveEditor(latest.current.id), false) }),
        ],
      }),
    });
    const handle = codeMirrorHandle(view, { paneId: p.id });
    viewRef.current = view;
    handleRef.current = handle;
    registerEditor(p.id, handle);
    setActiveEditor(p.id);
    latest.current.onHandle?.(handle);
    return () => {
      stats.dispose();
      unregisterEditor(p.id, handle);
      latest.current.onHandle?.(null);
      view.destroy();
      viewRef.current = null;
      handleRef.current = null;
    };
    // Created once per mount; everything else is reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: settingsC.reconfigure(settingsExtensions(props.settings, props.suspended)),
    });
  }, [props.settings, props.suspended, settingsC]);

  // While the Live editor shows, this one is not the pane's editor: the registry hands out its handle.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (props.suspended === 'away') unregisterEditor(props.id, handle);
    else registerEditor(props.id, handle);
  }, [props.suspended, props.id]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyC.reconfigure(
        readOnlyExtensions(!!props.readOnly, props.suspended === 'wait'),
      ),
    });
  }, [props.readOnly, props.suspended, readOnlyC]);

  // The document was replaced from outside (reload after an external change).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || versionRef.current === props.version) return;
    versionRef.current = props.version;
    // Kept out of the undo history: Undo must not revert a change that arrived from outside.
    const tr = externalReplace(view.state, props.doc);
    if (tr) view.dispatch(tr);
  }, [props.version, props.doc]);

  // Scroll to a heading, block or line.
  useEffect(() => {
    const r = props.reveal;
    if (r) handleRef.current?.reveal(r);
  }, [props.reveal]);

  return (
    <div
      className="editor-host"
      ref={host}
      data-mode="source"
      data-suspended={props.suspended}
      aria-hidden={props.suspended === 'away' ? true : undefined}
    />
  );
}

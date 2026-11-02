import { useEffect, useRef, useState } from 'react';
import { i18next } from '../i18n';
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
import { extract } from '@memobrain/markdown';
import type { Reveal } from '../reading/ReadingView';
import type { EditorSettings } from '../state/settings';
import { blockWidgets } from './blockWidgets';
import { ofmCompletionSources, type CompletionOptions } from './completions';
import { livePreviewContext, type LivePreviewContext } from './context';
import { External, externalReplace } from './external';
import { linkStatusChanged, livePreview } from './livePreview';
import { pagePreviewHover } from '../preview/hover';
import { smartPaste, type PasteDeps } from './paste';
import { iconElement } from '../shell/icons';
import { registerEditor, setActiveEditor, unregisterEditor } from './registry';
import { sourceMode } from './sourceMode';
import { slashCompletionSource } from '../slash/slash';
import { slashHost } from '../slash/host';
import { dialog } from '../ui/dialogs';

export interface EditorStats {
  words: number;
  chars: number;
  selWords: number;
  selChars: number;
  line: number;
  col: number;
}

export interface LinkResolver {
  subscribe(cb: () => void): () => void;
}

interface Props {
  /** Registry key (pane id): formatting commands act on the focused editor. */
  id: string;
  doc: string;
  /** Increment to replace the document with `doc` (after a reload from disk). */
  version: number;
  mode: 'live' | 'source';
  settings: EditorSettings;
  context: LivePreviewContext;
  completion: CompletionOptions;
  paste: PasteDeps;
  resolver?: LinkResolver;
  reveal?: Reveal | undefined;
  readOnly?: boolean;
  /** Gets every key event first; return true when it ran an application command. */
  hotkey?: (event: KeyboardEvent) => boolean;
  onChange(text: string): void;
  onStats(stats: EditorStats): void;
}

function settingsExtensions(s: EditorSettings): Extension[] {
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
      'aria-label': i18next.t('editor.ariaLabel'),
    }),
    EditorView.theme({ '&': { fontSize: `${s.fontSize}px` } }),
  ];
}

/** The note editor: CodeMirror 6 in Source or Live Preview mode (ADR-0004). */
export function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const [modeC] = useState(() => new Compartment());
  const [settingsC] = useState(() => new Compartment());
  const [contextC] = useState(() => new Compartment());
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
          modeC.of(p.mode === 'live' ? [livePreview(), blockWidgets()] : sourceMode()),
          settingsC.of(settingsExtensions(p.settings)),
          contextC.of(livePreviewContext.of(p.context)),
          readOnlyC.of(EditorState.readOnly.of(!!p.readOnly)),
          pagePreviewHover(),
          EditorView.updateListener.of((u) => {
            const cur = latest.current;
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External)))
              cur.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) stats.update(u.state, u.docChanged);
          }),
          EditorView.domEventHandlers({ focus: () => (setActiveEditor(latest.current.id), false) }),
        ],
      }),
    });
    viewRef.current = view;
    registerEditor(p.id, view);
    setActiveEditor(p.id);
    return () => {
      stats.dispose();
      unregisterEditor(p.id, view);
      view.destroy();
      viewRef.current = null;
    };
    // Created once per mount; everything else is reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mode switch keeps selection and scroll.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: modeC.reconfigure(
        props.mode === 'live' ? [livePreview(), blockWidgets()] : sourceMode(),
      ),
    });
  }, [props.mode, modeC]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: settingsC.reconfigure(settingsExtensions(props.settings)),
    });
  }, [props.settings, settingsC]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: contextC.reconfigure(livePreviewContext.of(props.context)),
    });
  }, [props.context, contextC]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyC.reconfigure(EditorState.readOnly.of(!!props.readOnly)),
    });
  }, [props.readOnly, readOnlyC]);

  // Link resolution finished: rebuild decorations.
  useEffect(() => {
    return props.resolver?.subscribe(() =>
      viewRef.current?.dispatch({ effects: linkStatusChanged.of(null) }),
    );
  }, [props.resolver]);

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
    const view = viewRef.current;
    const r = props.reveal;
    if (!view || !r) return;
    let line = r.line ?? 0;
    if (!line) {
      const note = extract('', view.state.doc.toString());
      if (r.block) line = note.blockIds.find((b) => b.id === r.block)?.line ?? 0;
      else if (r.heading) {
        const norm = (s: string): string =>
          s
            .toLowerCase()
            .replace(/[*_`=~[\]]/g, '')
            .trim();
        line = note.headings.find((h) => norm(h.text) === norm(r.heading ?? ''))?.line ?? 0;
      }
    }
    if (line < 1 || line > view.state.doc.lines) return;
    const pos = view.state.doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
    });
    view.focus();
  }, [props.reveal]);

  return <div className="editor-host" ref={host} data-mode={props.mode} />;
}

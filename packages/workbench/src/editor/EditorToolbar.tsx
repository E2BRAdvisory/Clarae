// The editing toolbar above a note: formatting, headings, lists, blocks and inserts in one row,
// like the "Editing Toolbar" plugin for Obsidian. It acts on the CodeMirror view of its pane.
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { api } from '../app/api';
import { dialog } from '../ui/dialogs';
import { Icon } from '../shell/icons';
import * as fmt from './commands';
import { getEditor } from './registry';

interface Item {
  id: string;
  label: string;
  glyph: ReactNode;
  run: (view: EditorView) => boolean | void;
}

interface Props {
  /** Pane id the editor is registered under. */
  paneId: string;
  disabled?: boolean;
  /** Folder where pasted/picked files are stored. */
  attachmentDir: string;
}

const bytesToBase64 = (buf: ArrayBuffer): string => {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export function EditorToolbar({
  paneId,
  disabled,
  attachmentDir,
  vaultId,
}: Props & { vaultId: string }) {
  const { t } = useTranslation();
  const [headings, setHeadings] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const act = (fn: Item['run']) => () => {
    const v = getEditor(paneId);
    if (!v) return;
    fn(v);
    v.focus();
  };

  const attach = async (f: File): Promise<void> => {
    const v = getEditor(paneId);
    if (!v) return;
    try {
      const saved = await api.vault.saveAttachment(
        vaultId,
        attachmentDir,
        f.name,
        bytesToBase64(await f.arrayBuffer()),
      );
      const name = saved.split('/').pop() ?? saved;
      fmt.insertSnippet(`![[${name}]]`)(v);
      v.focus();
    } catch (e) {
      await dialog.error(e);
    }
  };

  const groups: Item[][] = [
    [
      { id: 'undo', label: t('toolbar.undo'), glyph: <Icon name="undo" />, run: undo },
      { id: 'redo', label: t('toolbar.redo'), glyph: <Icon name="redo" />, run: redo },
      {
        id: 'clear',
        label: t('toolbar.clear'),
        glyph: <Icon name="clearFormat" />,
        run: fmt.clearFormatting,
      },
    ],
    [
      { id: 'h1', label: t('toolbar.h1'), glyph: 'H1', run: fmt.setHeading(1) },
      { id: 'h2', label: t('toolbar.h2'), glyph: 'H2', run: fmt.setHeading(2) },
      { id: 'h3', label: t('toolbar.h3'), glyph: 'H3', run: fmt.setHeading(3) },
    ],
  ];
  const inline: Item[] = [
    { id: 'bold', label: t('toolbar.bold'), glyph: <Icon name="bold" />, run: fmt.toggleBold },
    {
      id: 'italic',
      label: t('toolbar.italic'),
      glyph: <Icon name="italic" />,
      run: fmt.toggleItalic,
    },
    {
      id: 'strike',
      label: t('toolbar.strike'),
      glyph: <Icon name="strike" />,
      run: fmt.toggleStrike,
    },
    {
      id: 'underline',
      label: t('toolbar.underline'),
      glyph: <Icon name="underline" />,
      run: fmt.toggleUnderline,
    },
    {
      id: 'highlight',
      label: t('toolbar.highlight'),
      glyph: <Icon name="highlight" />,
      run: fmt.toggleHighlight,
    },
    {
      id: 'code',
      label: t('toolbar.code'),
      glyph: <Icon name="code" />,
      run: fmt.toggleInlineCode,
    },
    {
      id: 'sub',
      label: t('toolbar.sub'),
      glyph: <Icon name="subscript" />,
      run: fmt.toggleSubscript,
    },
    {
      id: 'sup',
      label: t('toolbar.sup'),
      glyph: <Icon name="superscript" />,
      run: fmt.toggleSuperscript,
    },
  ];
  const links: Item[] = [
    { id: 'link', label: t('toolbar.link'), glyph: <Icon name="link" />, run: fmt.insertLink },
    {
      id: 'wikilink',
      label: t('toolbar.wikilink'),
      glyph: <Icon name="wikilink" />,
      run: fmt.insertWikilink,
    },
    {
      id: 'embed',
      label: t('toolbar.embed'),
      glyph: <Icon name="embed" />,
      run: fmt.insertSnippet('![[|]]'),
    },
  ];
  const blocks: Item[] = [
    { id: 'task', label: t('toolbar.task'), glyph: <Icon name="task" />, run: fmt.toggleTask },
    {
      id: 'bullet',
      label: t('toolbar.bullet'),
      glyph: <Icon name="bullet" />,
      run: fmt.toggleBulletList,
    },
    {
      id: 'numbered',
      label: t('toolbar.numbered'),
      glyph: <Icon name="numbered" />,
      run: fmt.toggleNumberedList,
    },
    { id: 'quote', label: t('toolbar.quote'), glyph: <Icon name="quote" />, run: fmt.toggleQuote },
    {
      id: 'callout',
      label: t('toolbar.callout'),
      glyph: <Icon name="callout" />,
      run: fmt.insertSnippet('> [!note] |\n> '),
    },
    {
      id: 'codeblock',
      label: t('toolbar.codeBlock'),
      glyph: <Icon name="codeBlock" />,
      run: fmt.insertSnippet('```\n|\n```'),
    },
    {
      id: 'table',
      label: t('toolbar.table'),
      glyph: <Icon name="table" />,
      run: fmt.insertSnippet('| Column 1 | Column 2 |\n| --- | --- |\n| | |'),
    },
    {
      id: 'math',
      label: t('toolbar.math'),
      glyph: <Icon name="math" />,
      run: fmt.insertSnippet('$$\n|\n$$'),
    },
    {
      id: 'divider',
      label: t('toolbar.divider'),
      glyph: <Icon name="separator" />,
      run: fmt.insertSeparator,
    },
    {
      id: 'comment',
      label: t('toolbar.comment'),
      glyph: <Icon name="comment" />,
      run: fmt.toggleComment,
    },
  ];

  const button = (it: Item) => (
    <button
      key={it.id}
      type="button"
      className="tb-btn"
      title={it.label}
      aria-label={it.label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={act(it.run)}
    >
      {it.glyph}
    </button>
  );

  return (
    <div className="editor-toolbar" role="toolbar" aria-label={t('toolbar.label')}>
      {groups.map((g, i) => (
        <span key={i} className="tb-group">
          {g.map(button)}
          {i === 1 && (
            <span className="tb-menu">
              <button
                type="button"
                className="tb-btn"
                title={t('toolbar.moreHeadings')}
                aria-label={t('toolbar.moreHeadings')}
                aria-expanded={headings}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setHeadings((o) => !o)}
              >
                H…
              </button>
              {headings && (
                <span className="tb-pop" role="menu">
                  {[4, 5, 6].map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="menuitem"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setHeadings(false);
                        act(fmt.setHeading(n))();
                      }}
                    >
                      H{n}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </span>
      ))}
      <span className="tb-group">{inline.map(button)}</span>
      <span className="tb-group">
        {links.map(button)}
        <button
          type="button"
          className="tb-btn"
          title={t('toolbar.attachment')}
          aria-label={t('toolbar.attachment')}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => file.current?.click()}
        >
          <Icon name="attach" />
        </button>
        <input
          ref={file}
          type="file"
          hidden
          data-testid="toolbar-attachment"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void attach(f);
          }}
        />
      </span>
      <span className="tb-group">{blocks.map(button)}</span>
    </div>
  );
}

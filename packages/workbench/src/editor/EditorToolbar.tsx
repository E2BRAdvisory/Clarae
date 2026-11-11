// The editing toolbar above a note: formatting, headings, lists, blocks and inserts in one row,
// like the "Editing Toolbar" plugin for Obsidian. It acts on the editor of its pane through its handle.
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { dialog } from '../ui/dialogs';
import { Icon } from '../shell/icons';
import { headingCommand, type EditorCommand } from './handle';
import { getEditor } from './registry';

interface Item {
  id: string;
  label: string;
  glyph: ReactNode;
  command: EditorCommand;
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

  const act = (command: EditorCommand) => () => {
    const v = getEditor(paneId);
    if (!v) return;
    v.exec(command);
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
      v.replaceSelection(`![[${name}]]`);
      v.focus();
    } catch (e) {
      await dialog.error(e);
    }
  };

  const groups: Item[][] = [
    [
      { id: 'undo', label: t('toolbar.undo'), glyph: <Icon name="undo" />, command: 'undo' },
      { id: 'redo', label: t('toolbar.redo'), glyph: <Icon name="redo" />, command: 'redo' },
      {
        id: 'clear',
        label: t('toolbar.clear'),
        glyph: <Icon name="clearFormat" />,
        command: 'clear',
      },
    ],
    [
      { id: 'h1', label: t('toolbar.h1'), glyph: 'H1', command: 'heading-1' },
      { id: 'h2', label: t('toolbar.h2'), glyph: 'H2', command: 'heading-2' },
      { id: 'h3', label: t('toolbar.h3'), glyph: 'H3', command: 'heading-3' },
    ],
  ];
  const inline: Item[] = [
    { id: 'bold', label: t('toolbar.bold'), glyph: <Icon name="bold" />, command: 'bold' },
    {
      id: 'italic',
      label: t('toolbar.italic'),
      glyph: <Icon name="italic" />,
      command: 'italic',
    },
    {
      id: 'strike',
      label: t('toolbar.strike'),
      glyph: <Icon name="strike" />,
      command: 'strike',
    },
    {
      id: 'underline',
      label: t('toolbar.underline'),
      glyph: <Icon name="underline" />,
      command: 'underline',
    },
    {
      id: 'highlight',
      label: t('toolbar.highlight'),
      glyph: <Icon name="highlight" />,
      command: 'highlight',
    },
    {
      id: 'code',
      label: t('toolbar.code'),
      glyph: <Icon name="code" />,
      command: 'code',
    },
    {
      id: 'sub',
      label: t('toolbar.sub'),
      glyph: <Icon name="subscript" />,
      command: 'sub',
    },
    {
      id: 'sup',
      label: t('toolbar.sup'),
      glyph: <Icon name="superscript" />,
      command: 'sup',
    },
  ];
  const links: Item[] = [
    { id: 'link', label: t('toolbar.link'), glyph: <Icon name="link" />, command: 'link' },
    {
      id: 'wikilink',
      label: t('toolbar.wikilink'),
      glyph: <Icon name="wikilink" />,
      command: 'wikilink',
    },
    {
      id: 'embed',
      label: t('toolbar.embed'),
      glyph: <Icon name="embed" />,
      command: 'embed',
    },
  ];
  const blocks: Item[] = [
    { id: 'task', label: t('toolbar.task'), glyph: <Icon name="task" />, command: 'task' },
    {
      id: 'bullet',
      label: t('toolbar.bullet'),
      glyph: <Icon name="bullet" />,
      command: 'bullet',
    },
    {
      id: 'numbered',
      label: t('toolbar.numbered'),
      glyph: <Icon name="numbered" />,
      command: 'numbered',
    },
    { id: 'quote', label: t('toolbar.quote'), glyph: <Icon name="quote" />, command: 'quote' },
    {
      id: 'callout',
      label: t('toolbar.callout'),
      glyph: <Icon name="callout" />,
      command: 'callout',
    },
    {
      id: 'codeblock',
      label: t('toolbar.codeBlock'),
      glyph: <Icon name="codeBlock" />,
      command: 'code-block',
    },
    {
      id: 'table',
      label: t('toolbar.table'),
      glyph: <Icon name="table" />,
      command: 'table',
    },
    {
      id: 'math',
      label: t('toolbar.math'),
      glyph: <Icon name="math" />,
      command: 'math',
    },
    {
      id: 'divider',
      label: t('toolbar.divider'),
      glyph: <Icon name="separator" />,
      command: 'separator',
    },
    {
      id: 'comment',
      label: t('toolbar.comment'),
      glyph: <Icon name="comment" />,
      command: 'comment',
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
      onClick={act(it.command)}
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
                        act(headingCommand(n))();
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

// The editing toolbar acts on the editor of its pane only through its NoteEditorHandle: every button
// runs one EditorCommand, and "insert attachment" saves the file and writes the embed at the selection.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { dialog } from '../ui/dialogs';
import { EditorToolbar } from './EditorToolbar';
import type { EditorCommand, NoteEditorHandle } from './handle';
import { registerEditor, unregisterEditor } from './registry';

/** A handle that records what the toolbar asks of it; the toolbar must not need anything else. */
function fakeHandle() {
  const exec = vi.fn<(c: EditorCommand) => boolean>(() => true);
  const focus = vi.fn();
  const replaceSelection = vi.fn(() => true);
  const handle = { exec, focus, replaceSelection } as unknown as NoteEditorHandle;
  return { handle, exec, focus, replaceSelection };
}

// Button label (English) -> the command it runs.
const BUTTONS: Record<string, EditorCommand> = {
  Undo: 'undo',
  Redo: 'redo',
  'Clear formatting': 'clear',
  'Heading 1': 'heading-1',
  'Heading 2': 'heading-2',
  'Heading 3': 'heading-3',
  Bold: 'bold',
  Italic: 'italic',
  Strikethrough: 'strike',
  Underline: 'underline',
  Highlight: 'highlight',
  'Inline code': 'code',
  Subscript: 'sub',
  Superscript: 'sup',
  Link: 'link',
  'Internal link': 'wikilink',
  Embed: 'embed',
  Task: 'task',
  'Bulleted list': 'bullet',
  'Numbered list': 'numbered',
  Quote: 'quote',
  Callout: 'callout',
  'Code block': 'code-block',
  Table: 'table',
  'Math block': 'math',
  'Horizontal rule': 'separator',
  Comment: 'comment',
};

let fake: ReturnType<typeof fakeHandle>;
const PANE = 'tb-pane';

function renderToolbar(props: { disabled?: boolean } = {}) {
  return render(<EditorToolbar paneId={PANE} vaultId="v1" attachmentDir="Files" {...props} />);
}

beforeEach(() => {
  initI18n('en');
  fake = fakeHandle();
  registerEditor(PANE, fake.handle);
});

afterEach(() => {
  cleanup();
  unregisterEditor(PANE, fake.handle);
  vi.restoreAllMocks();
});

describe('EditorToolbar: buttons', () => {
  it.each(Object.entries(BUTTONS))(
    '"%s" runs the %s command and gives the focus back',
    (label, command) => {
      renderToolbar();
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(fake.exec).toHaveBeenCalledTimes(1);
      expect(fake.exec).toHaveBeenCalledWith(command);
      expect(fake.focus).toHaveBeenCalledTimes(1);
    },
  );

  it('has a button for every command it offers and no two buttons run the same one', () => {
    renderToolbar();
    const commands: EditorCommand[] = [];
    for (const label of Object.keys(BUTTONS)) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      commands.push(fake.exec.mock.lastCall?.[0] as EditorCommand);
    }
    expect(new Set(commands).size).toBe(Object.keys(BUTTONS).length);
  });

  it('reaches heading 4 to 6 from the "More headings" menu, which closes after the choice', () => {
    renderToolbar();
    expect(screen.queryByRole('menu')).toBeNull();
    for (const n of [4, 5, 6]) {
      fireEvent.click(screen.getByRole('button', { name: 'More headings' }));
      const menu = screen.getByRole('menu');
      fireEvent.click(within(menu).getByRole('menuitem', { name: `H${n}` }));
      expect(fake.exec).toHaveBeenLastCalledWith(`heading-${n}`);
      expect(screen.queryByRole('menu')).toBeNull();
    }
    expect(fake.exec).toHaveBeenCalledTimes(3);
  });

  it('does nothing, and does not fail, when the pane has no editor', () => {
    unregisterEditor(PANE, fake.handle);
    renderToolbar();
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Bold' }))).not.toThrow();
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('disables every button when it is disabled', () => {
    renderToolbar({ disabled: true });
    for (const b of screen.getAllByRole('button'))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(fake.exec).not.toHaveBeenCalled();
  });
});

describe('EditorToolbar: insert attachment', () => {
  const pick = (file: File): void => {
    renderToolbar();
    fireEvent.change(screen.getByTestId('toolbar-attachment'), { target: { files: [file] } });
  };

  it('saves the file in the attachment folder as base64 and embeds the name it was stored under', async () => {
    const save = vi.spyOn(api.vault, 'saveAttachment').mockResolvedValue('Files/sub/pic (1).png');
    pick(new File(['abc'], 'pic.png', { type: 'image/png' }));
    await waitFor(() => expect(fake.replaceSelection).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith('v1', 'Files', 'pic.png', 'YWJj');
    // The name comes from what the vault answers (it may have renamed the file), not from the file.
    expect(fake.replaceSelection).toHaveBeenCalledWith('![[pic (1).png]]');
    expect(fake.focus).toHaveBeenCalled();
  });

  it('shows the error, and writes nothing, when the file cannot be saved', async () => {
    const failure = new Error('disk full');
    vi.spyOn(api.vault, 'saveAttachment').mockRejectedValue(failure);
    const error = vi.spyOn(dialog, 'error').mockResolvedValue(undefined);
    pick(new File(['x'], 'a.png'));
    await waitFor(() => expect(error).toHaveBeenCalledWith(failure));
    expect(fake.replaceSelection).not.toHaveBeenCalled();
  });

  it('opens the file picker from its button, and saves nothing when no file is chosen', () => {
    const save = vi.spyOn(api.vault, 'saveAttachment');
    renderToolbar();
    const input = screen.getByTestId<HTMLInputElement>('toolbar-attachment');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Insert attachment' }));
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [] } });
    expect(save).not.toHaveBeenCalled();
  });
});

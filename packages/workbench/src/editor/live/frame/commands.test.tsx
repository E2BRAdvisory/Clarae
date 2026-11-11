// What the rest of the application does with the Live editor through its handle (A-W5c): the commands
// that find text and go to a line, and the editing toolbar, which has no other way to the editor.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { commands } from '../../../commands/registry';
import { initI18n } from '../../../i18n';
import { dialog } from '../../../ui/dialogs';
import { EditorToolbar } from '../../EditorToolbar';
import { registerEditor, setActiveEditor, unregisterEditor } from '../../registry';
import { posAfter } from '../testing/helpers';
import { EditorViewOf, openLive } from '../testing/mounted';

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => initI18n('en'));

const PANE = 'frame-pane';
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const c of cleanups.splice(0)) c();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mount(raw: string) {
  const live = await openLive(raw);
  registerEditor(PANE, live.editor);
  setActiveEditor(PANE);
  cleanups.push(() => {
    unregisterEditor(PANE, live.editor);
    live.dispose();
  });
  return live;
}

const command = (id: string) => commands.find((c) => c.id === id);

describe('the commands of the registry', () => {
  it('are in the palette, with a default key, a feature of the registry and a title', () => {
    expect(command('editor:find')).toMatchObject({ feature: 'editor.find', defaults: ['Mod-f'] });
    expect(command('editor:goto-line')).toMatchObject({
      feature: 'editor.find',
      defaults: ['Mod-Alt-g'],
    });
  });

  it('find in note opens the find bar of the active Live editor', async () => {
    const live = await mount('one fox\n');
    await command('editor:find')?.run();
    const bar = live.parent.querySelector('.live-find') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(document.activeElement).toBe(bar.querySelector('input'));
  });

  it('go to line asks for a line and puts the caret at its start', async () => {
    const live = await mount('one\n\ntwo\n\nthree\n\nfour\n');
    const prompt = vi.spyOn(dialog, 'prompt').mockResolvedValue('5');
    await command('editor:goto-line')?.run();
    expect(prompt).toHaveBeenCalledWith('Go to line', '1', 'Line number (1 to 8)');
    expect(live.editor.cursor().line).toBe(5);
  });

  it('go to line does nothing when the dialog is cancelled or the answer is no number', async () => {
    const live = await mount('one\n\ntwo\n\nthree\n');
    live.editor.gotoLine(3);
    const prompt = vi.spyOn(dialog, 'prompt');
    prompt.mockResolvedValueOnce(null);
    await command('editor:goto-line')?.run();
    prompt.mockResolvedValueOnce('abc');
    await command('editor:goto-line')?.run();
    expect(live.editor.cursor().line).toBe(3);
  });
});

describe('the editing toolbar on the Live editor', () => {
  it('formats, undoes and inserts through the handle, and the caret stays in the document', async () => {
    const live = await mount('hello\n');
    const view = EditorViewOf(live.editor);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, 1, posAfter(view.state.doc, 'hello')),
      ),
    );
    render(<EditorToolbar paneId={PANE} vaultId="v1" attachmentDir="" />);
    expect(screen.getByRole('toolbar', { name: 'Editing toolbar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(live.editor.text()).toBe('**hello**\n');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(live.editor.text()).toBe('hello\n');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(live.editor.text()).toBe('**hello**\n');
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(live.editor.text()).toContain('|');
    expect(live.parent.contains(document.activeElement)).toBe(true);
  });
});

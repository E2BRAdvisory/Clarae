import { describe, expect, it } from 'vitest';
import { defaultEditorSettings, resolveSettings } from '../state/settings';
import { unmanaged } from '../state/managed';
import { attachmentDir, folderOf, newNoteDir } from './locations';

describe('locations', () => {
  it('finds the folder of a path', () => {
    expect(folderOf('a/b/c.md')).toBe('a/b');
    expect(folderOf('c.md')).toBe('');
    expect(folderOf(null)).toBe('');
  });

  it('places new notes in the configured folder or next to the active note', () => {
    expect(newNoteDir({ newNoteLocation: 'folder', newNoteFolder: '/Inbox/' }, 'x/y.md')).toBe(
      'Inbox',
    );
    expect(newNoteDir({ newNoteLocation: 'current', newNoteFolder: 'Inbox' }, 'x/y.md')).toBe('x');
    expect(newNoteDir({ newNoteLocation: 'current', newNoteFolder: 'Inbox' }, null)).toBe('');
  });

  it('places attachments by mode', () => {
    const s = (
      attachmentLocation: 'folder' | 'current' | 'subfolder',
      attachmentsFolder: string,
    ) => ({
      attachmentLocation,
      attachmentsFolder,
    });
    expect(attachmentDir(s('folder', 'files/'), 'n/a.md')).toBe('files');
    expect(attachmentDir(s('folder', ''), 'n/a.md')).toBe('');
    expect(attachmentDir(s('current', 'files'), 'n/a.md')).toBe('n');
    expect(attachmentDir(s('subfolder', 'assets'), 'n/a.md')).toBe('n/assets');
    expect(attachmentDir(s('subfolder', ''), 'a.md')).toBe('attachments');
  });
});

describe('managed settings', () => {
  it('lets an administrator set and lock the new location settings', () => {
    const managed = {
      ...unmanaged,
      managed: true,
      config: { editor: { newNoteLocation: 'current', confirmDelete: false } },
      locked: ['editor.newNoteLocation'],
    };
    const user = {
      editor: { newNoteLocation: 'folder' as const, confirmDelete: true },
      appearance: {},
      hotkeys: {},
    };
    const { editor } = resolveSettings(user, managed);
    expect(editor.newNoteLocation).toBe('current'); // locked: the user's choice is ignored
    expect(editor.confirmDelete).toBe(true); // only a default: the user's choice wins
    expect(resolveSettings({ editor: {}, appearance: {}, hotkeys: {} }, unmanaged).editor).toEqual(
      defaultEditorSettings,
    );
  });
});

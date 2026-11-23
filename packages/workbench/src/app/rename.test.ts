import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { dialog } from '../ui/dialogs';
import { api } from './api';
import { promptRename, renameTarget } from './actions';

describe('renameTarget', () => {
  it('puts the extension of a file the application opens back after the typed name', () => {
    expect(renameTarget('Notes/Plan.md', false, 'Roadmap')).toBe('Notes/Roadmap.md');
    expect(renameTarget('Sketch.excalidraw', false, 'Diagram')).toBe('Diagram.excalidraw');
    expect(renameTarget('A/Map.canvas', false, 'Atlas')).toBe('A/Atlas.canvas');
    expect(renameTarget('Deck.marp', false, 'Review')).toBe('Review.marp');
    expect(renameTarget('Road.webapp', false, 'Maps')).toBe('Maps.webapp');
    expect(renameTarget('Media/pic.PNG', false, 'photo')).toBe('Media/photo.PNG');
  });

  it('does not double an extension the input already ends with, in any case', () => {
    expect(renameTarget('Plan.md', false, 'Roadmap.md')).toBe('Roadmap.md');
    expect(renameTarget('Plan.md', false, 'Roadmap.MD')).toBe('Roadmap.md');
    expect(renameTarget('Sketch.excalidraw', false, 'Diagram.excalidraw')).toBe(
      'Diagram.excalidraw',
    );
  });

  it('never changes the extension: another one typed becomes part of the name', () => {
    expect(renameTarget('Plan.md', false, 'Foo.txt')).toBe('Foo.txt.md');
    expect(renameTarget('Sketch.excalidraw', false, 'Foo.md')).toBe('Foo.md.excalidraw');
    expect(renameTarget('Plan.md', false, '.md')).toBe('.md.md');
  });

  it('keeps the whole extension of a legacy drawing stored as a note', () => {
    expect(renameTarget('Old.excalidraw.md', false, 'New')).toBe('New.excalidraw.md');
    expect(renameTarget('Old.excalidraw.md', false, 'New.excalidraw.md')).toBe('New.excalidraw.md');
  });

  it('does nothing for an empty name, spaces only or the same name', () => {
    expect(renameTarget('Plan.md', false, '')).toBeNull();
    expect(renameTarget('Plan.md', false, '   ')).toBeNull();
    expect(renameTarget('Plan.md', false, 'Plan')).toBeNull();
    expect(renameTarget('Plan.md', false, 'Plan.md')).toBeNull();
    expect(renameTarget('Plan.md', false, 'plan.MD')).toBe('plan.md'); // only the case changes
    expect(renameTarget('Docs/Report.docx', false, 'Report.docx')).toBeNull();
  });

  it('renames a folder, and a file opened outside the application, as typed', () => {
    expect(renameTarget('Projects/Old.md', true, 'New.md')).toBe('Projects/New.md');
    expect(renameTarget('Projects', true, 'Work')).toBe('Work');
    expect(renameTarget('Docs/Report.docx', false, 'Final.docx')).toBe('Docs/Final.docx');
    expect(renameTarget('Docs/Report.docx', false, 'Final')).toBe('Docs/Final');
    expect(renameTarget('LICENSE', false, 'COPYING')).toBe('COPYING');
  });
});

describe('promptRename', () => {
  let mock: WailsMock;
  let vaultId: string;

  beforeEach(async () => {
    initI18n('en');
    mock = installWailsMock();
    const info = await api.vault.open('/vaults/Notes');
    vaultId = info.id;
    useAppStore.getState().setVault(info);
    const files = mock.vaults.get(vaultId)?.files;
    files?.set('Plan.md', '# Plan');
    files?.set('Maps/Sketch.excalidraw', '{}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const paths = async (): Promise<string[]> =>
    (await api.vault.listTree(vaultId)).map((e) => e.path);

  it('prefills the name without the extension and renames keeping it', async () => {
    const prompt = vi.spyOn(dialog, 'prompt').mockResolvedValue('Atlas');
    await promptRename({ path: 'Maps/Sketch.excalidraw', isDir: false });
    expect(prompt).toHaveBeenCalledWith(expect.any(String), 'Sketch');
    expect(await paths()).toContain('Maps/Atlas.excalidraw');
    expect(await paths()).not.toContain('Maps/Sketch.excalidraw');
  });

  it('shows the whole name of a folder and of a file opened outside the application', async () => {
    const prompt = vi.spyOn(dialog, 'prompt').mockResolvedValue(null);
    await promptRename({ path: 'Maps', isDir: true });
    await promptRename({ path: 'Docs/Report.docx', isDir: false });
    expect(prompt.mock.calls.map((c) => c[1])).toEqual(['Maps', 'Report.docx']);
  });

  it('does nothing when cancelled, empty or unchanged', async () => {
    const before = await paths();
    const prompt = vi.spyOn(dialog, 'prompt');
    for (const answer of [null, '', '  ', 'Plan', 'Plan.md']) {
      prompt.mockResolvedValueOnce(answer);
      expect(await promptRename({ path: 'Plan.md', isDir: false })).toBeNull();
    }
    expect(await paths()).toEqual(before);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { DialogHost } from '../ui/dialogs';
import { importTemplatesFolder, offerTemplateMigration } from './migration';
import { useNotesSettings } from './settings';

let mock: WailsMock;
let vaultId: string;
const files = () => mock.vaults.get(vaultId)?.files ?? new Map<string, string>();
const daily = (): Record<string, unknown> =>
  JSON.parse(files().get('.clarae/daily.json') ?? '{}') as Record<string, unknown>;

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  await useNotesSettings.getState().load(vaultId);
});

describe('the move of the templates of the old folder', () => {
  it('asks nothing, and writes nothing, when there is nothing to move', async () => {
    render(<DialogHost />);
    await offerTemplateMigration(vaultId);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(files().has('.clarae/daily.json')).toBe(false);
  });

  it('moves the templates when the user agrees, and follows the references', async () => {
    files().set('Templates/Daily.md', '# {{title}}');
    files().set('Templates/Board.excalidraw', '{}');
    files().set('Templates/logo.png', 'png');
    files().set('.clarae/daily.json', JSON.stringify({ dailyTemplate: 'Templates/Daily.md' }));
    useAppStore.getState().openNote('Templates/Daily.md');
    render(<DialogHost />);
    const done = offerTemplateMigration(vaultId);
    expect(await screen.findByText(/There are 2 templates in "Templates"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await done;
    expect(files().get('.clarae/templates/Daily.md')).toBe('# {{title}}');
    expect(files().has('.clarae/templates/Board.excalidraw')).toBe(true);
    expect(files().has('Templates/Daily.md')).toBe(false);
    expect(files().has('Templates/logo.png')).toBe(true);
    expect(daily()).toMatchObject({
      dailyTemplate: '.clarae/templates/Daily.md',
      templatesMigrated: true,
    });
    // The settings in force are the rewritten ones, and the tab followed its file.
    expect(useNotesSettings.getState().settings.dailyTemplate).toBe('.clarae/templates/Daily.md');
    const layout = JSON.stringify(useAppStore.getState().layout);
    expect(layout).not.toContain('"Templates/Daily.md"');
    expect(layout).toContain('.clarae/templates/Daily.md');
    // Not asked again.
    await offerTemplateMigration(vaultId);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('records a refusal and leaves the templates where they are', async () => {
    files().set('Templates/Daily.md', 'd');
    render(<DialogHost />);
    const done = offerTemplateMigration(vaultId);
    await screen.findByText(/There is 1 template in "Templates"/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await done;
    expect(files().has('Templates/Daily.md')).toBe(true);
    expect(daily()['templatesMigrated']).toBe(true);
    await offerTemplateMigration(vaultId);
    expect(screen.queryByRole('dialog')).toBeNull();

    // The command still imports the folder.
    const imported = importTemplatesFolder();
    await screen.findByText(/Move the notes, drawings and presentations/);
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('1 template moved.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await imported;
    expect(files().has('.clarae/templates/Daily.md')).toBe(true);
  });

  it('does not ask once another vault took over', async () => {
    files().set('Templates/Daily.md', 'd');
    render(<DialogHost />);
    await offerTemplateMigration(vaultId, () => false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(files().has('Templates/Daily.md')).toBe(true);
  });
});

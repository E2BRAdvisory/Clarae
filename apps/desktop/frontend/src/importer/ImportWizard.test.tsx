import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { commands } from '../commands/registry';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { ImportWizard } from './ImportWizard';
import { importerMock } from './mock';
import { useImporter } from './store';

beforeEach(async () => {
  initI18n('en');
  installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  useAppStore.getState().setVault(info);
  useImporter.setState({ open: false });
});

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

async function toPreview(): Promise<void> {
  await screen.findByRole('radio', { name: /Evernote/ });
  fireEvent.click(screen.getByRole('radio', { name: /Evernote/ }));
  next();
  await screen.findByLabelText('File or folder to import');
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  await waitFor(() =>
    expect(screen.getByLabelText('File or folder to import')).toHaveValue('/mock/export.enex'),
  );
  next();
  await screen.findByLabelText('Import into folder');
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText(/2 notes and 1 attachments will be created/);
}

describe('import command', () => {
  it('is registered and needs a writable open vault', () => {
    const cmd = commands.find((c) => c.id === 'import:open');
    expect(cmd?.enabled?.()).toBe(true);
    void cmd?.run();
    expect(useImporter.getState().open).toBe(true);
    useAppStore.getState().setVault(null);
    expect(cmd?.enabled?.()).toBe(false);
  });
});

describe('ImportWizard', () => {
  it('walks from the source to the report and opens the report note', async () => {
    useImporter.getState().show();
    render(<ImportWizard />);
    await toPreview();
    expect(screen.getByText('encrypted text was skipped')).toBeInTheDocument();
    expect(importerMock.runs).toHaveLength(0);
    expect(importerMock.previews[0]?.opts.targetFolder).toBe('Imports/enex-2024-03-01');
    expect(importerMock.previews[0]?.opts.useWikilinks).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('Import finished.');
    expect(importerMock.runs[0]).toMatchObject({ sourceId: 'enex', path: '/mock/export.enex' });
    expect(screen.getByText('2 notes created')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open the report note' }));
    expect(useImporter.getState().open).toBe(false);
    const tabs = JSON.stringify(useAppStore.getState().layout);
    expect(tabs).toContain('Imports/enex-2024-03-01/Import report.md');
  });

  it('shows progress and lets the user cancel', async () => {
    importerMock.hold = true;
    useImporter.getState().show();
    render(<ImportWizard />);
    await toPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/1 of 2/);
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByText(/Import cancelled/);
    expect(importerMock.cancelled).toEqual(['job-1']);
  });

  it('goes back to the options when the import fails', async () => {
    importerMock.runError = 'read-only: this folder was shared with you as a viewer';
    useImporter.getState().show();
    render(<ImportWizard />);
    await toPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('read-only');
    expect(screen.getByLabelText('Import into folder')).toBeInTheDocument();
  });

  it('maps the columns of a CSV file and sends the choice', async () => {
    importerMock.preview = {
      ...importerMock.preview,
      columns: ['Title', 'Notes', 'Tags'],
      delimiter: ';',
    };
    importerMock.picked = '/mock/books.csv';
    useImporter.getState().show();
    render(<ImportWizard />);
    fireEvent.click(await screen.findByRole('radio', { name: /^CSV/ }));
    next();
    await screen.findByLabelText('File or folder to import');
    fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
    await waitFor(() =>
      expect(screen.getByLabelText('File or folder to import')).toHaveValue('/mock/books.csv'),
    );
    next();
    const body = await screen.findByLabelText('Column used as the note body');
    fireEvent.change(body, { target: { value: 'Notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText(/will be created/);
    const last = importerMock.previews.at(-1);
    expect(last?.opts.csv).toMatchObject({
      delimiter: ';',
      titleColumn: 'Title',
      bodyColumn: 'Notes',
    });
  });

  it('suggests the right source when the file looks like another one', async () => {
    useImporter.getState().show();
    render(<ImportWizard />);
    fireEvent.click(await screen.findByRole('radio', { name: /Roam/ }));
    next();
    await screen.findByLabelText('File or folder to import');
    importerMock.picked = '/mock/x.enex';
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
    });
    await screen.findByText(/looks like an export from Evernote/);
  });

  it('closes with Escape before the import starts', async () => {
    useImporter.getState().show();
    render(<ImportWizard />);
    const dlg = await screen.findByRole('dialog');
    fireEvent.keyDown(dlg, { key: 'Escape' });
    expect(useImporter.getState().open).toBe(false);
  });
});

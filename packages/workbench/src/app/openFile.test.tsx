import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { openTarget } from '../embeds/media';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { setOpenInterceptor, useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { DialogHost } from '../ui/dialogs';
import { api } from './api';
import { installOpenFile, openFile } from './openFile';

let mock: WailsMock;
let vaultId: string;

const tabs = (): string => JSON.stringify(useAppStore.getState().layout);

beforeEach(async () => {
  initI18n('en');
  configurePlatform({ kind: 'desktop' });
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  const v = mock.vaults.get(vaultId);
  v?.binaries.set('Docs/Report.docx', btoa('docx'));
  v?.binaries.set('Docs/data.zip', btoa('zip'));
  v?.binaries.set('tools/setup.exe', btoa('exe'));
  v?.binaries.set('Media/photo.png', btoa('png'));
  installOpenFile();
});

afterEach(() => {
  setOpenInterceptor(null);
  configurePlatform();
});

describe('openTarget', () => {
  it('keeps notes, canvases, bases, drawings and the media the app shows in a tab', () => {
    for (const p of [
      'a.md',
      'b.canvas',
      'c.base',
      'd.excalidraw',
      'Talks/Deck.marp',
      'Media/photo.PNG',
      'x.jpg',
      'x.jpeg',
      'x.gif',
      'x.svg',
      'x.webp',
      'x.bmp',
      'doc.pdf',
      'song.mp3',
      'clip.mp4',
    ])
      expect(openTarget(p), p).toBe('in-app');
  });

  it('sends any other file outside the app, files without extension included', () => {
    for (const p of [
      'a.zip',
      'b.pptx',
      'c.docx',
      'd.txt',
      'LICENSE',
      'v1.2/Makefile',
      '.gitignore',
    ])
      expect(openTarget(p), p).toBe('external');
  });
});

describe('opening a file by type', () => {
  it('opens a file the app shows in a tab', () => {
    openFile('Media/photo.png');
    expect(tabs()).toContain('Media/photo.png');
    expect(mock.systemOpens).toEqual([]);
  });

  it('hands any other file to the system application on the desktop, without a tab', async () => {
    useAppStore.getState().openNote('Docs/Report.docx'); // every openNote goes through the router
    await waitFor(() => expect(mock.systemOpens).toEqual([`${vaultId}:Docs/Report.docx`]));
    expect(tabs()).not.toContain('Docs/Report.docx');
  });

  it('never runs a program: it offers to show it in the file manager', async () => {
    render(<DialogHost />);
    openFile('tools/setup.exe');
    expect(await screen.findByText(/setup\.exe is a program/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    await waitFor(() => expect(mock.reveals).toEqual([`${vaultId}:tools/setup.exe`]));
    expect(mock.systemOpens).toEqual([]);
  });

  it('asks before downloading in the browser, and downloads on Download', async () => {
    configurePlatform({ kind: 'web' });
    render(<DialogHost />);
    openFile('Docs/data.zip');
    expect(await screen.findByRole('dialog', { name: 'Open File' })).toBeInTheDocument();
    expect(
      screen.getByText('The file data.zip cannot be shown here. Do you want to download it?'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(mock.downloads).toEqual([`${vaultId}:Docs/data.zip`]));
    expect(mock.systemOpens).toEqual([]);
    expect(tabs()).not.toContain('Docs/data.zip');
  });

  it('downloads nothing when the user cancels', async () => {
    configurePlatform({ kind: 'web' });
    render(<DialogHost />);
    openFile('Docs/data.zip');
    await screen.findByRole('dialog', { name: 'Open File' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mock.downloads).toEqual([]);
  });

  it('keeps graph tabs in the app', () => {
    useAppStore.getState().openNote('graph://global');
    expect(tabs()).toContain('graph://global');
  });
});

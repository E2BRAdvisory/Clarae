import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { DialogHost } from '../ui/dialogs';
import { insertDrawing, newDrawing } from './commands';
import { parseScene } from './scene';

let mock: WailsMock;
let vaultId: string;

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
});

describe('drawing commands', () => {
  it('creates an empty drawing next to the active note and opens it', async () => {
    mock.vaults.get(vaultId)?.files.set('Projects/Plan.md', 'x');
    useAppStore.getState().openNote('Projects/Plan.md');
    const path = await newDrawing();
    expect(path).toMatch(/^Projects\/Drawing \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.excalidraw$/);
    const text = mock.vaults.get(vaultId)?.files.get(path) ?? '';
    expect(parseScene(text).elements).toEqual([]);
    const tabs = JSON.stringify(useAppStore.getState().layout);
    expect(tabs).toContain(path);
  });

  it('creates drawings at the vault root when no note is open, without clobbering', async () => {
    const a = await newDrawing();
    const b = await newDrawing();
    expect(a.includes('/')).toBe(false);
    expect(b).not.toBe(a);
  });

  it('tells there is nothing to insert when the vault has no drawing', async () => {
    render(<DialogHost />);
    void insertDrawing();
    expect(await screen.findByText('There are no drawings in this vault yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' })); // dialogs are global: leave none open
  });

  it('lists the drawings to insert', async () => {
    mock.vaults.get(vaultId)?.files.set('Maps/Alpha.excalidraw', '{"elements":[]}');
    mock.vaults.get(vaultId)?.files.set('Beta.excalidraw', '{"elements":[]}');
    render(<DialogHost />);
    void insertDrawing();
    const list = await screen.findByRole('listbox', { name: 'Insert drawing' });
    expect(list.querySelectorAll('li')).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'alp' } });
    await waitFor(() => expect(list.querySelectorAll('button')).toHaveLength(1));
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { DialogHost } from '../ui/dialogs';
import { commands, exportVaultZip } from './registry';

let mock: WailsMock;
let vaultId: string;

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  mock.vaults.get(vaultId)?.files.set('Home.md', '# Home');
  mock.vaults.get(vaultId)?.files.set('Other.md', 'x');
  useAppStore.getState().setVault(info);
});

describe('vault:export-zip', () => {
  it('is registered, titled and only enabled with an open vault', () => {
    const cmd = commands.find((c) => c.id === 'vault:export-zip');
    expect(cmd?.enabled?.()).toBe(true);
    useAppStore.getState().setVault(null);
    expect(cmd?.enabled?.()).toBe(false);
  });

  it('exports the open vault and reports what was written', async () => {
    render(<DialogHost />);
    const done = exportVaultZip();
    await screen.findByText(/2 files saved to \/mock\/exports\/Notes\.zip/);
    expect(mock.exports).toEqual([vaultId]);
    fireEvent.click(screen.getByRole('button', { name: /ok|close/i }));
    await done;
  });

  it('says nothing when the save dialog is cancelled', async () => {
    mock.exportCancelled = true;
    render(<DialogHost />);
    await exportVaultZip();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.exports).toEqual([]);
  });
});

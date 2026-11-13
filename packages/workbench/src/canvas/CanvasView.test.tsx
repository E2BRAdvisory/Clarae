import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { dialog } from '../ui/dialogs';
import { flushAllNotes } from '../workspaces/flush';
import { CanvasView } from './CanvasView';

let mock: WailsMock;
let vaultId = '';
const PATH = 'Board.canvas';

const text = (id: string, x = 0) => ({
  id,
  type: 'text',
  x,
  y: 0,
  width: 100,
  height: 50,
  text: id,
});

async function setup(files: Record<string, string>) {
  initI18n('en');
  mock = installWailsMock();
  vaultId = (await api.vault.open('/vaults/Canvas')).id;
  for (const [p, c] of Object.entries(files)) mock.vaults.get(vaultId)?.files.set(p, c);
  const view = render(<CanvasView vaultId={vaultId} path={PATH} />);
  await screen.findByRole('toolbar');
  return view;
}

const disk = (): { nodes: { id: string; type: string }[] } =>
  JSON.parse(mock.vaults.get(vaultId)?.files.get(PATH) ?? '{}') as {
    nodes: { id: string; type: string }[];
  };

/** A change of the file made elsewhere (a sync, another app), with the watcher's event. */
function remoteWrite(content: unknown) {
  act(() => {
    mock.vaults.get(vaultId)?.files.set(PATH, JSON.stringify(content));
    mock.emit('vault:file-changed', { vaultId, paths: [PATH] });
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CanvasView', () => {
  it('Undo after a remote change does not write the old board over it', async () => {
    const { container } = await setup({ [PATH]: JSON.stringify({ nodes: [], edges: [] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Add a group' }));
    await act(async () => void (await flushAllNotes()));
    expect(disk().nodes).toHaveLength(1);
    const group = disk().nodes[0];

    remoteWrite({ nodes: [group, text('theirs')], edges: [] });
    await waitFor(() => expect(container.querySelector('[data-node="theirs"]')).not.toBeNull());

    // The steps recorded before the change no longer apply to the board.
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).toBeDisabled();
    fireEvent.click(undo);
    fireEvent.keyDown(container.querySelector('.cv-board') ?? document.body, {
      key: 'z',
      ctrlKey: true,
    });
    await act(async () => void (await flushAllNotes()));
    expect(disk().nodes.map((n) => n.id)).toContain('theirs');
    expect(container.querySelector('[data-node="theirs"]')).not.toBeNull();
  });

  it('adds a node after a dialog on top of a change that arrived meanwhile', async () => {
    const { container } = await setup({ [PATH]: JSON.stringify({ nodes: [], edges: [] }) });
    let answer: (v: string | null) => void = () => undefined;
    vi.spyOn(dialog, 'prompt').mockImplementation(
      () => new Promise<string | null>((resolve) => (answer = resolve)),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add a web link' }));
    await waitFor(() => expect(dialog.prompt).toHaveBeenCalled());

    remoteWrite({ nodes: [text('theirs')], edges: [] });
    await waitFor(() => expect(container.querySelector('[data-node="theirs"]')).not.toBeNull());

    act(() => answer('https://example.com'));
    await waitFor(() => expect(container.querySelectorAll('[data-node]')).toHaveLength(2));
    await act(async () => void (await flushAllNotes()));
    const types = disk().nodes.map((n) => n.type);
    expect(disk().nodes.map((n) => n.id)).toContain('theirs');
    expect(types).toContain('link');
  });

  it('does not offer notes in the trash or in hidden folders', async () => {
    await setup({
      [PATH]: JSON.stringify({ nodes: [], edges: [] }),
      'Live.md': '# live',
      '.trash/Old.md': '# old',
      '.clarae/x.md': '',
    });
    const pick = vi.spyOn(dialog, 'pick').mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    await waitFor(() => expect(pick).toHaveBeenCalled());
    const offered = (pick.mock.calls[0]?.[1] ?? []).map((i) => i.value);
    expect(offered).toContain('Live.md');
    expect(offered).not.toContain('.trash/Old.md');
    expect(offered).not.toContain('.clarae/x.md');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../state/store';
import { emptyLayout, openPath } from '../../workspace/layout';
import {
  registerSceneController,
  unregisterSceneController,
  type SceneController,
} from '../actions/active';
import { dropVaultFile } from './commands';

vi.mock('../../app/api', () => ({
  api: {
    vault: {
      readNote: vi.fn(() => Promise.resolve({ content: '# Card\n' })),
    },
  },
}));

const fake = (drawingPath: string) => {
  const apply = vi.fn();
  const c = {
    vaultId: 'v1',
    drawingPath,
    paneId: () => null,
    apply,
    canEdit: () => true,
    viewportCenter: () => ({ x: 0, y: 0 }),
  } as unknown as SceneController;
  return { c, apply };
};

const registered: SceneController[] = [];
afterEach(() => registered.splice(0).forEach(unregisterSceneController));

describe('dropVaultFile', () => {
  it('adds to the drawing dropped on, not to the drawing of the active tab', async () => {
    const board = fake('Board.excalidraw');
    const other = fake('Other.excalidraw'); // the pane the file is dropped on
    for (const { c } of [other, board]) {
      registerSceneController(c);
      registered.push(c);
    }
    useAppStore.setState({
      layout: openPath(emptyLayout(), 'Board.excalidraw', { mode: 'source' }),
    });
    await dropVaultFile('Note.md', { x: 10, y: 20 }, 'Other.excalidraw');
    expect(other.apply).toHaveBeenCalledTimes(1);
    expect(board.apply).not.toHaveBeenCalled();
  });

  it('adds to the editor dropped on when the drawing is open in two panes', async () => {
    const first = fake('Board.excalidraw'); // the pane the file is dropped on
    const second = fake('Board.excalidraw'); // registered last: the one a path alone would find
    for (const { c } of [first, second]) {
      registerSceneController(c);
      registered.push(c);
    }
    useAppStore.setState({
      layout: openPath(emptyLayout(), 'Board.excalidraw', { mode: 'source' }),
    });
    await dropVaultFile('Note.md', { x: 10, y: 20 }, first.c);
    expect(first.apply).toHaveBeenCalledTimes(1);
    expect(second.apply).not.toHaveBeenCalled();
  });
});

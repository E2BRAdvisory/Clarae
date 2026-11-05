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
});

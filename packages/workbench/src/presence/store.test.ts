import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Events } from '../app/events';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { installPresenceFeed, posFromWire, roomKey, usePresenceStore } from './store';

let mock: WailsMock;
let off: () => void;
const ada = { sid: 's1', userId: 'u-ada', name: 'Ada' };
const bob = { sid: 's2', userId: 'u-bob', name: 'Bob' };
const room = () => usePresenceStore.getState().rooms[roomKey('v1', 'Note.md')];

beforeEach(() => {
  mock = installWailsMock();
  usePresenceStore.getState().reset();
  off = installPresenceFeed();
});
afterEach(() => off());

describe('the presence store', () => {
  it('follows the three events of the core', () => {
    mock.presence.members('v1', 'Note.md', [ada, bob]);
    expect(room()?.members).toEqual([ada, bob]);
    mock.presence.move('v1', 'Note.md', 's1', { line: 3, col: 7 });
    mock.presence.move('v1', 'Note.md', 's2', { x: 10.5, y: -4 });
    expect(room()?.cursors).toEqual({
      s1: { kind: 'text', line: 3, col: 7 },
      s2: { kind: 'scene', x: 10.5, y: -4 },
    });
    mock.presence.cleared('v1', 'Note.md');
    expect(room()).toBeUndefined();
  });

  it('drops the pointer of somebody who left, at once', () => {
    mock.presence.members('v1', 'Note.md', [ada, bob]);
    mock.presence.move('v1', 'Note.md', 's1', { line: 1, col: 1 });
    mock.presence.move('v1', 'Note.md', 's2', { line: 2, col: 2 });
    mock.presence.members('v1', 'Note.md', [bob]);
    expect(Object.keys(room()?.cursors ?? {})).toEqual(['s2']);
    mock.presence.members('v1', 'Note.md', []);
    expect(room()).toBeUndefined(); // nobody left: nothing is kept
  });

  it('ignores a move of somebody the core has not announced, and a kind it does not know', () => {
    mock.presence.move('v1', 'Note.md', 's1', { line: 1, col: 1 });
    expect(room()).toBeUndefined();
    mock.presence.members('v1', 'Note.md', [ada]);
    mock.emit(Events.presenceMove, {
      vaultId: 'v1',
      path: 'Note.md',
      sid: 's1',
      pos: { kind: 'hologram', line: 0, col: 0, x: 0, y: 0 },
    });
    expect(room()?.cursors).toEqual({});
    expect(posFromWire({ kind: 'text', line: 2, col: 3, x: 0, y: 0 })).toEqual({
      kind: 'text',
      line: 2,
      col: 3,
    });
  });

  it('keeps the files apart, and forgets everything on reset and when the feed stops', () => {
    mock.presence.members('v1', 'A.md', [ada]);
    mock.presence.members('v1', 'B.md', [bob]);
    mock.presence.cleared('v1', 'A.md');
    expect(usePresenceStore.getState().rooms[roomKey('v1', 'B.md')]?.members).toEqual([bob]);
    off();
    expect(usePresenceStore.getState().rooms).toEqual({});
    expect(mock.listeners(Events.presenceMembers)).toBe(0);
    off = installPresenceFeed();
  });
});

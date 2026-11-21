import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../app/api';
import { configurePlatform } from '../platform';
import { useManaged } from '../state/managed';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { usePresenceStore } from './store';
import { SEND_MS, useCursorSender } from './useCursorSender';

let mock: WailsMock;
let target: HTMLDivElement;
const ada = { sid: 's1', userId: 'u-ada', name: 'Ada' };

function Probe() {
  useCursorSender({
    vaultId: 'v1',
    path: 'Note.md',
    getTarget: () => target,
    toPos: (e) => ({ kind: 'text', line: Math.round(e.clientY), col: Math.round(e.clientX) }),
  });
  return null;
}

const move = (x: number, y: number): void => {
  const e = new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true });
  target.dispatchEvent(e);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  mock = installWailsMock();
  configurePlatform();
  useManaged.setState({ features: {} });
  useSync.setState({ info: { v1: { linked: true, kind: 'shared' } as never } });
  usePresenceStore.getState().reset();
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => {
  cleanup();
  target.remove();
  vi.useRealTimers();
});

describe('sending the pointer', () => {
  it('sends nothing while nobody else is in the file', () => {
    render(<Probe />);
    move(5, 6);
    vi.advanceTimersByTime(200);
    expect(mock.presence.moves).toEqual([]);
  });

  it('sends the position in the document, throttled, the latest one winning', () => {
    render(<Probe />);
    act(() => usePresenceStore.getState().setMembers('v1', 'Note.md', [ada]));
    move(1, 1);
    move(2, 2);
    move(3, 3);
    expect(mock.presence.moves.map((m) => m.pos.line)).toEqual([1]);
    vi.advanceTimersByTime(SEND_MS);
    expect(mock.presence.moves.map((m) => [m.pos.kind, m.pos.line, m.pos.col])).toEqual([
      ['text', 1, 1],
      ['text', 3, 3],
    ]);
  });

  it('stops listening when the others are gone, the profile turns it off, or the view unmounts', () => {
    const { unmount } = render(<Probe />);
    act(() => usePresenceStore.getState().setMembers('v1', 'Note.md', [ada]));
    act(() => usePresenceStore.getState().setMembers('v1', 'Note.md', []));
    move(9, 9);
    vi.advanceTimersByTime(200);
    expect(mock.presence.moves).toEqual([]);
    act(() => usePresenceStore.getState().setMembers('v1', 'Note.md', [ada]));
    act(() => useManaged.setState({ features: { presence: false } }));
    move(9, 9);
    vi.advanceTimersByTime(200);
    expect(mock.presence.moves).toEqual([]);
    act(() => useManaged.setState({ features: {} }));
    move(7, 7);
    unmount();
    vi.advanceTimersByTime(200);
    move(8, 8);
    vi.advanceTimersByTime(200);
    expect(mock.presence.moves.map((m) => m.pos.line)).toEqual([7]); // after unmount, nothing, not even the pending one
    expect(api.presence).toBeDefined();
  });
});

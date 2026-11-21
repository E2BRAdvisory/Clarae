import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Events } from '../app/events';
import { configurePlatform } from '../platform';
import { useManaged } from '../state/managed';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { roomKey, usePresenceStore } from './store';
import { usePresenceEnabled, usePresenceWatch } from './watch';

let mock: WailsMock;

function View({
  vaultId = 'v1',
  path,
  on = true,
}: {
  vaultId?: string;
  path: string | null;
  on?: boolean;
}) {
  usePresenceWatch(vaultId, path, on);
  return null;
}
const settle = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  mock = installWailsMock();
  configurePlatform();
  useManaged.setState({ features: {} });
  useSync.setState({ info: { v1: { linked: true, kind: 'shared' } as never } });
  mock.sync.links.set('v1', { linked: true, kind: 'shared' } as never);
  usePresenceStore.getState().reset();
});
afterEach(cleanup);

describe('watching a file for the life of its view', () => {
  it('watches while the view is mounted and unwatches when it goes', async () => {
    const { unmount } = render(<View path="Note.md" />);
    await settle();
    expect(mock.presence.log).toEqual(['Watch v1 Note.md']);
    expect(mock.presence.watching('v1', 'Note.md')).toBe(1);
    unmount();
    expect(mock.presence.log).toEqual(['Watch v1 Note.md', 'Unwatch v1 Note.md']);
    expect(mock.presence.watching('v1', 'Note.md')).toBe(0);
  });

  it('follows the file: a change of file is an Unwatch of the old one and a Watch of the new one', async () => {
    const { rerender } = render(<View path="A.md" />);
    await settle();
    rerender(<View path="B.md" />);
    await settle();
    expect(mock.presence.log).toEqual(['Watch v1 A.md', 'Unwatch v1 A.md', 'Watch v1 B.md']);
    rerender(<View path={null} />);
    await settle();
    expect(mock.presence.watching('v1', 'B.md')).toBe(0); // nothing in front: nothing watched
  });

  it('keeps a count when the same file is in two views, and ends with the last', async () => {
    const a = render(<View path="Note.md" />);
    const b = render(<View path="Note.md" />);
    await settle();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(2);
    act(() =>
      usePresenceStore
        .getState()
        .setMembers('v1', 'Note.md', [{ sid: 's1', userId: 'u', name: 'Ada' }]),
    );
    a.unmount();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(1);
    expect(usePresenceStore.getState().rooms[roomKey('v1', 'Note.md')]).toBeDefined(); // still on screen
    b.unmount();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(0);
    expect(usePresenceStore.getState().rooms[roomKey('v1', 'Note.md')]).toBeUndefined(); // gone with it
  });

  it('does not watch when it is off, and starts when it is turned on', async () => {
    const { rerender } = render(<View path="Note.md" on={false} />);
    await settle();
    expect(mock.presence.log).toEqual([]);
    rerender(<View path="Note.md" on />);
    await settle();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(1);
  });

  it('asks again when the sync state changes if the core could not watch the file yet', async () => {
    mock.presence.refuseNext = 'not-synced';
    const { unmount } = render(<View path="Note.md" />);
    await settle();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(0);
    // another vault's status is not for this view
    act(() => mock.emit(Events.syncStatus, { vaultId: 'other', phase: 'idle' }));
    await settle();
    expect(mock.presence.log).toEqual(['Watch v1 Note.md']);
    act(() => mock.emit(Events.syncStatus, { vaultId: 'v1', phase: 'idle' }));
    await waitFor(() => expect(mock.presence.watching('v1', 'Note.md')).toBe(1));
    // once watched it does not ask again
    act(() => mock.emit(Events.syncStatus, { vaultId: 'v1', phase: 'idle' }));
    await settle();
    expect(mock.presence.log.filter((l) => l.startsWith('Watch'))).toHaveLength(2);
    unmount();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(0);
    expect(mock.listeners(Events.syncStatus)).toBe(0);
  });

  it('gives the watch back when the view goes away while the core is still answering', async () => {
    const { unmount } = render(<View path="Note.md" />);
    unmount(); // before the answer of Watch arrives
    await settle();
    await settle();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(0);
    expect(mock.presence.log).toEqual(['Watch v1 Note.md', 'Unwatch v1 Note.md']);
  });

  it('does not keep a watch the core refused (a private vault says why)', async () => {
    useSync.setState({ info: { v1: { linked: true, kind: 'private' } as never } });
    mock.sync.links.set('v1', { linked: true, kind: 'private' } as never);
    const { unmount } = render(<View path="Note.md" />);
    await settle();
    expect(mock.presence.watching('v1', 'Note.md')).toBe(0);
    unmount();
    expect(mock.presence.log).toEqual(['Watch v1 Note.md']); // no Unwatch of what was never watched
  });
});

describe('where presence applies', () => {
  function Probe({ vaultId }: { vaultId: string | null }) {
    return <span data-testid="p">{String(usePresenceEnabled(vaultId))}</span>;
  }
  it('needs a vault that is linked and not private', () => {
    const state = (info: Record<string, unknown>) =>
      useSync.setState({ info: { v1: info as never } });
    const { getByTestId, rerender } = render(<Probe vaultId="v1" />);
    expect(getByTestId('p')).toHaveTextContent('true');
    act(() => state({ linked: true, kind: 'private' }));
    expect(getByTestId('p')).toHaveTextContent('false');
    act(() => state({ linked: false, kind: '' }));
    expect(getByTestId('p')).toHaveTextContent('false');
    rerender(<Probe vaultId={null} />);
    expect(getByTestId('p')).toHaveTextContent('false');
  });
});
